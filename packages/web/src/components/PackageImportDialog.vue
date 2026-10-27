<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NAlert, NButton, NCheckbox, NForm, NFormItem, NInput, NInputNumber, NSelect, useMessage } from 'naive-ui';
import { PROBLEM_NAME_RE, TESTSET_NAME_RE, type ImportPackageFormat, type PackageCandidate, type PackageImportResult } from '@polyforge/shared';
import { api, errorMessage } from '../lib/api';
import { serverText } from '../lib/serverText';
import { formatSize } from '../lib/format';
import ToolWindow from './ToolWindow.vue';

const props = defineProps<{ show: boolean; roots?: string[]; problemId?: string; testset?: string }>();
const emit = defineEmits<{ 'update:show': [boolean]; imported: [PackageImportResult] }>();
const { t, locale } = useI18n(); const message = useMessage();
const format = ref<ImportPackageFormat>('data');
const files = shallowRef<File[]>([]);
interface ImportItem {
  key: string; uploadId: string; archive: string; candidate: PackageCandidate;
  name: string; root: string; title: Record<string, string>; timeLimit: number; memoryLimit: number;
  included: boolean; imported: boolean; error?: string;
}
const items = ref<ImportItem[]>([]), currentKey = ref(''), target = ref('tests');
const currentItem = computed(() => items.value.find(item => item.key === currentKey.value));
const busy = ref(false), reading = ref(false), error = ref('');
const validationError = computed(() => error.value || serverText(currentItem.value?.error ?? currentItem.value?.candidate.error ?? ''));
const input = ref<HTMLInputElement>();
const options = computed(() => (props.problemId ? ['data', 'joi'] : ['polygon-package', 'hydro-problem', 'data', 'joi']).map(value => ({ value, label: t(`packages.${value}`) })));
const selectedItems = computed(() => props.problemId ? (currentItem.value ? [currentItem.value] : []) : items.value.filter(item => item.included && !item.imported));
const canImport = computed(() => selectedItems.value.length > 0 && !busy.value && !reading.value && selectedItems.value.every(item => !item.candidate.error && !item.imported &&
  (props.problemId ? TESTSET_NAME_RE.test(target.value) : PROBLEM_NAME_RE.test(item.name.trim()) && !!item.root && item.timeLimit > 0 && item.memoryLimit > 0)));
const uploads = new Set<string>();
function discardUploads() { for (const id of uploads) void api.discardPackage(id).catch(() => {}); uploads.clear(); }
let request = 0;
watch(() => props.show, show => {
  request++; reading.value = false; discardUploads();
  if (!show) return;
  files.value = []; items.value = []; currentKey.value = ''; error.value = ''; target.value = props.testset ?? 'tests';
  if (props.problemId && !['data', 'joi'].includes(format.value)) format.value = 'data';
});
onBeforeUnmount(() => { request++; discardUploads(); });
async function inspect() {
  const version = ++request;
  items.value = []; error.value = ''; currentKey.value = ''; discardUploads();
  if (!files.value.length || !props.show) { reading.value = false; return; }
  reading.value = true;
  const names = new Set<string>();
  for (const selected of files.value) try {
    if (!/\.zip$/i.test(selected.name) || selected.size < 22) throw new Error(t('packages.invalidZip'));
    if (selected.size > 256 * 1024 * 1024) throw new Error(t('packages.tooLarge'));
    const header = new Uint8Array(await selected.slice(0, 4).arrayBuffer());
    if (header[0] !== 0x50 || header[1] !== 0x4b || !((header[2] === 3 && header[3] === 4) || (header[2] === 5 && header[3] === 6))) throw new Error(t('packages.invalidZip'));
    if (version !== request) return;
    const upload = await api.stagePackage(selected, format.value);
    if (version !== request) { void api.discardPackage(upload.id).catch(() => {}); return; }
    uploads.add(upload.id);
    for (const candidate of upload.candidates) {
      const base = candidate.name === 'imported-problem' ? selected.name.replace(/\.zip$/i, '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'imported-problem' : candidate.name;
      let name = base;
      for (let n = 2; names.has(name); n++) name = `${base.slice(0, 56)}-${n}`;
      names.add(name);
      items.value.push({ key: `${upload.id}:${candidate.entry}`, uploadId: upload.id, archive: selected.name, candidate, name,
        root: props.roots?.[0] ?? '', title: { ...(candidate.titles ?? { [locale.value === 'zh-CN' ? 'zh' : 'en']: candidate.title || name }) },
        timeLimit: candidate.timeLimit ?? 1000, memoryLimit: candidate.memoryLimit ?? 256, included: !candidate.error, imported: false });
    }
  } catch (e) { if (version === request) error.value += `${selected.name}: ${errorMessage(e)}\n`; }
  if (version === request) { reading.value = false; currentKey.value = items.value[0]?.key ?? ''; }
}
watch(format, inspect);
function selectFile(event: Event) {
  const selected = [...((event.target as HTMLInputElement).files ?? [])];
  if (input.value) input.value.value = '';
  files.value = selected;
  void inspect();
}
async function submit() {
  if (!canImport.value) return;
  busy.value = true; error.value = '';
  try {
    const selected = [...selectedItems.value];
    const result = await api.importPackages(selected.map(item => ({ uploadId: item.uploadId, format: format.value, entry: item.candidate.entry,
      name: props.problemId ? undefined : item.name.trim(), root: item.root || undefined, testset: target.value,
      ...(props.problemId ? {} : { title: item.title, timeLimit: item.timeLimit, memoryLimit: item.memoryLimit }),
      lang: locale.value === 'zh-CN' ? 'zh' : 'en' })), props.problemId);
    result.items.forEach((value, index) => { selected[index].error = value.error; selected[index].imported = !!value.result; });
    const successful = result.items.flatMap(item => item.result ? [item.result] : []), failed = selected.find(item => !item.imported);
    if (failed) currentKey.value = failed.key;
    else { emit('update:show', false); await nextTick(); }
    if (successful.length) {
      message.success(t('packages.batchImported', { n: successful.length })); emit('imported', successful[0]);
      const warnings = [...new Set(successful.flatMap(item => item.warnings))];
      if (warnings.length) message.warning(warnings.map(serverText).join('\n'), { duration: 12000, closable: true });
    }
  } catch (e) { error.value = errorMessage(e); }
  finally { busy.value = false; }
}
</script>

<template>
  <tool-window :show="show" :title="t(problemId ? 'packages.importData' : 'packages.importLocal')" size="md" :error="validationError" @update:show="value => !busy && emit('update:show', value)">
    <n-form label-placement="left" label-width="auto" @submit.prevent="submit">
      <n-form-item :label="t('packages.format')"><n-select v-model:value="format" :options="options" :disabled="busy" /></n-form-item>
      <n-form-item :label="t('packages.file')"><n-button :disabled="busy || reading" :loading="reading" @click="input?.click()">{{ files.length ? t('packages.fileCount', { n: files.length }) : t('packages.choose') }}</n-button><input ref="input" type="file" accept=".zip,application/zip" multiple hidden @change="selectFile" /></n-form-item>
      <template v-if="currentItem">
        <n-form-item :label="t('packages.problem')"><n-select v-model:value="currentKey" filterable :options="items.map(item => ({ label: `${item.imported ? '✓ ' : ''}${item.name} — ${item.archive}${item.candidate.entry ? ' / ' + item.candidate.entry : ''}`, value: item.key }))" :disabled="busy" /></n-form-item>
        <n-form-item v-if="!problemId" :label="t('packages.selection')"><n-checkbox v-model:checked="currentItem.included" :disabled="busy || currentItem.imported || !!currentItem.candidate.error">{{ currentItem.imported ? t('packages.alreadyImported') : t('packages.includeProblem') }}</n-checkbox></n-form-item>
        <n-alert v-if="!currentItem.candidate.error" type="success" :show-icon="false" class="pf-dialog-note">{{ t('packages.validated', { files: currentItem.candidate.files, tests: currentItem.candidate.tests, size: formatSize(currentItem.candidate.size ?? 0) }) }}</n-alert>
        <template v-if="!problemId">
          <n-form-item :label="t('create.name')" :feedback="currentItem.name && !PROBLEM_NAME_RE.test(currentItem.name.trim()) ? t('create.nameRule') : ''"><n-input v-model:value="currentItem.name" :disabled="busy || currentItem.imported" /></n-form-item>
          <n-form-item :label="t('create.titleZh')"><n-input v-model:value="currentItem.title.zh" :disabled="busy || currentItem.imported" /></n-form-item>
          <n-form-item :label="t('create.titleEn')"><n-input v-model:value="currentItem.title.en" :disabled="busy || currentItem.imported" /></n-form-item>
          <n-form-item :label="t('packages.defaultTime')"><n-input-number v-model:value="currentItem.timeLimit" :min="1" :max="Number.MAX_SAFE_INTEGER" :disabled="busy || currentItem.imported"><template #suffix>ms</template></n-input-number></n-form-item>
          <n-form-item :label="t('packages.defaultMemory')"><n-input-number v-model:value="currentItem.memoryLimit" :min="0.001" :max="Number.MAX_SAFE_INTEGER" :disabled="busy || currentItem.imported"><template #suffix>MiB</template></n-input-number></n-form-item>
          <n-form-item :label="t('create.root')"><n-select v-model:value="currentItem.root" :options="(roots ?? []).map(value => ({ value, label: value }))" :disabled="busy || currentItem.imported" /></n-form-item>
        </template>
      </template>
      <template v-if="problemId">
        <n-form-item :label="t('packages.testset')"><n-input v-model:value="target" :disabled="busy" /></n-form-item>
        <n-alert type="warning" :show-icon="false">{{ t('packages.replaceData') }}</n-alert>
      </template>
    </n-form>
    <template #footer-left>{{ t('packages.selectedProblems', { n: selectedItems.length, total: items.length }) }}</template>
    <template #footer><n-button :disabled="busy" @click="emit('update:show', false)">{{ t('common.cancel') }}</n-button><n-button type="primary" :loading="busy" :disabled="!canImport" @click="submit">{{ t('import.run') }}</n-button></template>
  </tool-window>
</template>
