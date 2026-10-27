<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NAlert, NButton, NForm, NFormItem, NInput, NSelect, useMessage } from 'naive-ui';
import { PROBLEM_NAME_RE, TESTSET_NAME_RE, type ImportPackageFormat, type PackageCandidate, type PackageImportResult } from '@polyforge/shared';
import { api, errorMessage } from '../lib/api';
import { serverText } from '../lib/serverText';
import { formatSize } from '../lib/format';
import ToolWindow from './ToolWindow.vue';

const props = defineProps<{ show: boolean; roots?: string[]; problemId?: string; testset?: string }>();
const emit = defineEmits<{ 'update:show': [boolean]; imported: [PackageImportResult] }>();
const { t, locale } = useI18n(); const message = useMessage();
const format = ref<ImportPackageFormat>('luogu-data');
const file = shallowRef<File | null>(null);
const name = ref(''), root = ref(''), entry = ref(''), target = ref('tests');
const candidates = ref<PackageCandidate[]>([]);
const busy = ref(false), reading = ref(false), error = ref('');
const validated = ref(false);
const selectedCandidate = computed(() => candidates.value.find(c => c.entry === entry.value));
const validationError = computed(() => error.value || (selectedCandidate.value?.error ? serverText(selectedCandidate.value.error) : ''));
const input = ref<HTMLInputElement>();
const options = computed(() => (['luogu-data', 'hydro-data', ...(props.problemId ? [] : ['hydro-problem'])] as ImportPackageFormat[]).map(value => ({ value, label: t(`packages.${value}`) })));
const canImport = computed(() => !!file.value && validated.value && !selectedCandidate.value?.error && !!selectedCandidate.value && !busy.value && !reading.value && (props.problemId ? TESTSET_NAME_RE.test(target.value) : PROBLEM_NAME_RE.test(name.value) && !!root.value));
let request = 0;
watch(() => props.show, show => {
  request++; reading.value = false; validated.value = false;
  if (!show) return;
  file.value = null; candidates.value = []; name.value = ''; entry.value = ''; error.value = '';
  root.value = props.roots?.[0] ?? ''; target.value = props.testset ?? 'tests';
  if (props.problemId && format.value === 'hydro-problem') format.value = 'hydro-data';
});
async function inspect() {
  const current = ++request;
  candidates.value = []; error.value = ''; validated.value = false;
  const selected = file.value;
  if (!selected) { reading.value = false; return; }
  reading.value = true;
  try {
    if (!/\.zip$/i.test(selected.name) || selected.size < 22) throw new Error(t('packages.invalidZip'));
    if (selected.size > 256 * 1024 * 1024) throw new Error(t('packages.tooLarge'));
    const header = new Uint8Array(await selected.slice(0, 4).arrayBuffer());
    if (header[0] !== 0x50 || header[1] !== 0x4b || !((header[2] === 3 && header[3] === 4) || (header[2] === 5 && header[3] === 6))) throw new Error(t('packages.invalidZip'));
    if (current !== request) return;
    const list = await api.packageCandidates(selected, { format: format.value });
    if (current !== request) return;
    candidates.value = list; entry.value = list[0]?.entry ?? '';
    validated.value = true;
    if (format.value === 'hydro-problem') {
      if (!list.length) throw new Error(t('packages.noHydroProblem'));
      name.value = list[0].name;
    }
  } catch (e) { if (current === request) error.value = errorMessage(e); }
  finally { if (current === request) reading.value = false; }
}
watch(format, inspect);
function selectFile(event: Event) {
  const selected = (event.target as HTMLInputElement).files?.[0] ?? null;
  if (input.value) input.value.value = '';
  file.value = selected;
  if (selected && !props.problemId) name.value = selected.name.replace(/\.zip$/i, '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'imported-problem';
  void inspect();
}
function selectEntry(value: string) { entry.value = value; name.value = candidates.value.find(c => c.entry === value)?.name ?? name.value; }
async function submit() {
  if (!canImport.value) return;
  busy.value = true; error.value = '';
  try {
    const result = await api.importPackage(file.value!, { format: format.value, name: name.value || undefined, root: root.value || undefined,
      entry: entry.value, testset: target.value, lang: locale.value === 'zh-CN' ? 'zh' : 'en' }, props.problemId);
    message.success(t('packages.imported', { n: result.tests, extras: result.extras.length }));
    if (result.warnings.length) message.warning(result.warnings.map(serverText).join('\n'), { duration: 12000, closable: true });
    emit('update:show', false); emit('imported', result);
  } catch (e) { error.value = errorMessage(e); }
  finally { busy.value = false; }
}
</script>

<template>
  <tool-window :show="show" :title="t(problemId ? 'packages.importData' : 'packages.importLocal')" size="md" :error="validationError" @update:show="value => !busy && emit('update:show', value)">
    <n-form label-placement="left" label-width="auto" @submit.prevent="submit">
      <n-form-item :label="t('packages.format')"><n-select v-model:value="format" :options="options" :disabled="busy" /></n-form-item>
      <n-alert type="info" :show-icon="false" class="pf-dialog-note">{{ t(format === 'hydro-problem' ? 'packages.wholeHint' : 'packages.dataHint') }}</n-alert>
      <n-form-item :label="t('packages.file')"><n-button :disabled="busy || reading" :loading="reading" @click="input?.click()">{{ file?.name ?? t('packages.choose') }}</n-button><input ref="input" type="file" accept=".zip,application/zip" hidden @change="selectFile" /></n-form-item>
      <n-alert v-if="validated && selectedCandidate && !selectedCandidate.error" type="success" :show-icon="false" class="pf-dialog-note">{{ t('packages.validated', { files: selectedCandidate.files, tests: selectedCandidate.tests, size: formatSize(selectedCandidate.size ?? 0) }) }}</n-alert>
      <n-form-item v-if="format === 'hydro-problem' && candidates.length > 1" :label="t('packages.problem')"><n-select :value="entry" :options="candidates.map(c => ({ label: `${c.title} (${c.entry})`, value: c.entry }))" :disabled="busy" @update:value="selectEntry" /></n-form-item>
      <template v-if="!problemId">
        <n-form-item :label="t('create.name')" :feedback="name && !PROBLEM_NAME_RE.test(name) ? t('create.nameRule') : ''"><n-input v-model:value="name" :disabled="busy" /></n-form-item>
        <n-form-item :label="t('create.root')"><n-select v-model:value="root" :options="(roots ?? []).map(value => ({ value, label: value }))" :disabled="busy" /></n-form-item>
        <n-alert v-if="format !== 'hydro-problem'" type="warning" :show-icon="false">{{ t('dataOnly.warning') }}</n-alert>
      </template>
      <template v-else>
        <n-form-item :label="t('packages.testset')"><n-input v-model:value="target" :disabled="busy" /></n-form-item>
        <n-alert type="warning" :show-icon="false">{{ t('packages.replaceData') }}</n-alert>
      </template>
    </n-form>
    <template #footer><n-button :disabled="busy" @click="emit('update:show', false)">{{ t('common.cancel') }}</n-button><n-button type="primary" :loading="busy" :disabled="!canImport" @click="submit">{{ t('import.run') }}</n-button></template>
  </tool-window>
</template>
