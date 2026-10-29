<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NAlert, NButton, NCheckbox, NForm, NFormItem, NInput, NSelect, useMessage } from 'naive-ui';
import { PROBLEM_NAME_RE, type ContestPackageImportRequest, type ContestPackageUpload, type ContestPackageValidation, type ContestSummary, type LemonTaskCandidate } from '@taskweave/shared';
import { api, errorMessage } from '../lib/api';
import { serverText } from '../lib/serverText';
import { labelWidth } from '../lib/labelWidth';
import ToolWindow from './ToolWindow.vue';
import DirPicker from './DirPicker.vue';
import LibraryFolderSelect from './LibraryFolderSelect.vue';

/** LemonLime packages are whole contests: the contest and all of its problems are imported together. */
const props = defineProps<{ show: boolean; roots: string[]; folder?: string; problemRoot?: string; problemFolder?: string }>();
const emit = defineEmits<{ 'update:show': [boolean]; imported: [ContestSummary] }>();
const { t, locale } = useI18n(); const message = useMessage();
const width = labelWidth(104, 136);
const input = ref<HTMLInputElement>(), showDirectory = ref(false), directory = ref('');
const upload = shallowRef<ContestPackageUpload | null>(null), entry = ref('');
const contest = computed(() => upload.value?.contests.find(item => item.entry === entry.value));
const form = reactive({ name: '', titleZh: '', titleEn: '', folder: '', root: '', problemFolder: '' });
interface Row { key: string; candidate: LemonTaskCandidate; include: boolean; name: string; title: string }
const rows = ref<Row[]>([]);
const busy = ref(false), reading = ref(false), error = ref('');
const lang = () => locale.value === 'zh-CN' ? 'zh' : 'en';
const letter = (i: number): string => (i >= 26 ? letter(Math.floor(i / 26) - 1) : '') + String.fromCharCode(65 + i % 26);
const letters = computed(() => new Map(rows.value.filter(row => row.include).map((row, i) => [row.key, letter(i)])));

let staged = '';
function discard() { if (staged) void api.discardPackage(staged).catch(() => {}); staged = ''; }
let version = 0;
watch(() => props.show, show => {
  version++; reading.value = false; discard();
  if (!show) return;
  upload.value = null; entry.value = ''; directory.value = ''; error.value = ''; rows.value = [];
  Object.assign(form, { name: '', titleZh: '', titleEn: '', folder: props.folder ?? '', root: props.problemRoot || props.roots[0] || '', problemFolder: props.problemFolder ?? '' });
});
onBeforeUnmount(() => { version++; clearTimeout(timer); discard(); });
watch(contest, value => {
  if (!value) { rows.value = []; return; }
  form.name = value.name; form.titleZh = lang() === 'zh' ? value.title : ''; form.titleEn = lang() === 'zh' ? '' : value.title;
  const names = new Set<string>();
  rows.value = value.tasks.map(task => {
    let name = task.name;
    for (let n = 2; names.has(name); n++) name = `${task.name.slice(0, 56)}-${n}`;
    names.add(name);
    return { key: task.key, candidate: task, include: !task.error, name, title: task.title };
  });
});
async function stage(file: File | null, path = '') {
  const current = ++version;
  discard(); upload.value = null; entry.value = ''; error.value = ''; reading.value = true;
  try {
    if (file && (!/\.(zip|cdf)$/i.test(file.name) || !file.size)) throw new Error(t('contestImport.invalidInput'));
    if (file && file.size > 256 * 1024 * 1024) throw new Error(t('packages.tooLarge'));
    const result = file ? await api.stageContestPackage(file) : await api.stageContestDirectory(path);
    if (current !== version) { void api.discardPackage(result.id).catch(() => {}); return; }
    staged = result.id; upload.value = result;
    entry.value = result.contests.find(item => !item.error)?.entry ?? result.contests[0]?.entry ?? '';
  } catch (e) { if (current === version) error.value = errorMessage(e); }
  finally { if (current === version) reading.value = false; }
}
function selectFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (input.value) input.value.value = '';
  if (file) { directory.value = ''; void stage(file); }
}
function selectDirectory(path: string) { directory.value = path; void stage(null, path); }

const request = computed<ContestPackageImportRequest | null>(() => upload.value && contest.value && !contest.value.error ? {
  uploadId: upload.value.id, entry: contest.value.entry, name: form.name.trim(), title: { zh: form.titleZh.trim(), en: form.titleEn.trim() }, folder: form.folder,
  root: form.root || undefined, problemFolder: form.problemFolder, lang: lang(), tasks: rows.value.map(row => ({ key: row.key, include: row.include, name: row.name.trim(), title: row.title.trim() })),
} : null);
const signature = computed(() => JSON.stringify(request.value));
const checked = ref(''), validation = ref<ContestPackageValidation>({ errors: [], tasks: {} });
const validated = computed(() => checked.value === signature.value);
let timer: ReturnType<typeof setTimeout> | undefined, checks = 0;
function validate(value: string, delay = 250) {
  clearTimeout(timer);
  const current = ++checks, req = request.value;
  if (!req) { validation.value = { errors: [], tasks: {} }; checked.value = value; return; }
  timer = setTimeout(async () => {
    try { const result = await api.validateContestPackage(req); if (current === checks) { validation.value = result; checked.value = value; } }
    catch (e) { if (current === checks) error.value = errorMessage(e); }
  }, delay);
}
watch(signature, value => validate(value));
const rowIssue = (row: Row) => !row.include ? '' : row.candidate.error ? serverText(row.candidate.error)
  : !PROBLEM_NAME_RE.test(row.name.trim()) ? t('create.nameRule') : validated.value ? serverText(validation.value.tasks[row.key] ?? '') : '';
const issues = computed(() => [...(validated.value ? validation.value.errors.map(serverText) : []),
  ...rows.value.flatMap(row => rowIssue(row) ? [`${letters.value.get(row.key)} · ${row.name.trim() || row.candidate.name}：${rowIssue(row)}`] : [])]);
const warnings = computed(() => rows.value.filter(row => row.include).flatMap(row => (row.candidate.warnings ?? []).map(warning => `${letters.value.get(row.key)} · ${serverText(warning)}`)));
const included = computed(() => rows.value.filter(row => row.include).length);
const canImport = computed(() => !!request.value && !busy.value && !reading.value && validated.value && included.value > 0 && !issues.value.length);
const footer = computed(() => !rows.value.length ? '' : [t('packages.selectedProblems', { n: included.value, total: rows.value.length }),
  issues.value.length ? t('packages.needsAttention', { n: issues.value.length }) : validated.value ? '' : t('packages.validating')].filter(Boolean).join(' · '));

async function submit() {
  if (!canImport.value || !request.value) return;
  busy.value = true; error.value = '';
  try {
    const result = await api.importContestPackage(request.value);
    message.success(t('contestImport.done', { n: result.problems.length }));
    if (result.warnings.length) message.warning(result.warnings.map(serverText).join('\n'), { duration: 12000, closable: true });
    discard(); emit('update:show', false); emit('imported', result.contest);
  } catch (e) { error.value = errorMessage(e); validate(signature.value, 0); }
  finally { busy.value = false; }
}
</script>

<template>
  <tool-window :show="show" :title="t('contestImport.title')" size="lg" :error="error" :persistent="!!upload" @update:show="value => !busy && emit('update:show', value)">
    <template #actions>
      <n-button size="small" :disabled="busy || reading" :loading="reading" @click="input?.click()">{{ t('contestImport.chooseFile') }}</n-button>
      <n-button size="small" :disabled="busy || reading" @click="showDirectory = true">{{ t('packages.chooseDirectory') }}</n-button>
      <input ref="input" type="file" accept=".zip,.cdf,application/zip" hidden @change="selectFile" />
    </template>
    <p v-if="!upload" class="pf-hint">{{ reading ? t('packages.reading') : t('contestImport.empty') }}</p>
    <template v-else>
      <n-form label-placement="left" :label-width="width" :show-feedback="false" class="contest-form" @submit.prevent="submit">
        <n-form-item :label="t('packages.format')"><span>{{ t('packages.lemonlime') }}</span></n-form-item>
        <n-form-item v-if="upload.contests.length > 1" :label="t('contestImport.contest')">
          <n-select v-model:value="entry" :disabled="busy" :options="upload.contests.map(item => ({ value: item.entry, label: `${item.title} — ${item.entry}` }))" />
        </n-form-item>
        <n-alert v-if="contest?.error" type="error" :show-icon="false" class="contest-note">{{ serverText(contest.error) }}</n-alert>
        <template v-if="contest && !contest.error">
          <div class="contest-grid">
            <n-form-item :label="t('create.name')"><n-input v-model:value="form.name" :status="PROBLEM_NAME_RE.test(form.name.trim()) ? undefined : 'error'" :disabled="busy" /></n-form-item>
            <n-form-item :label="t('contestImport.contestFolder')"><library-folder-select v-model:value="form.folder" kind="contests" :disabled="busy" /></n-form-item>
            <n-form-item :label="t('create.titleZh')"><n-input v-model:value="form.titleZh" :disabled="busy" /></n-form-item>
            <n-form-item :label="t('create.titleEn')"><n-input v-model:value="form.titleEn" :disabled="busy" /></n-form-item>
            <n-form-item v-if="roots.length > 1" :label="t('contestImport.problemRoot')"><n-select v-model:value="form.root" :disabled="busy" :options="roots.map(value => ({ value, label: value }))" @update:value="form.problemFolder = ''" /></n-form-item>
            <n-form-item :label="t('contestImport.problemFolder')"><library-folder-select v-model:value="form.problemFolder" kind="problems" :root="form.root" :disabled="busy" /></n-form-item>
          </div>
        </template>
      </n-form>
      <div v-if="contest && !contest.error" class="tasks">
        <div class="task head"><span /><span>{{ t('contestImport.index') }}</span><span>{{ t('create.name') }}</span><span>{{ t('contestImport.problemTitle') }}</span><span>{{ t('contestImport.source') }}</span><span class="count">{{ t('contestImport.tests') }}</span></div>
        <div v-for="row in rows" :key="row.key" class="task" :class="{ excluded: !row.include }">
          <n-checkbox v-model:checked="row.include" :disabled="busy || !!row.candidate.error" :aria-label="t('packages.includeProblem')" />
          <span class="mono">{{ letters.get(row.key) ?? '–' }}</span>
          <n-input v-model:value="row.name" size="small" :status="rowIssue(row) ? 'error' : undefined" :disabled="busy || !row.include" />
          <n-input v-model:value="row.title" size="small" :disabled="busy || !row.include" />
          <span class="mono dim" :title="row.candidate.sourceName">{{ row.candidate.sourceName || '–' }}</span>
          <span class="count">{{ row.candidate.tests ?? '–' }}</span>
        </div>
      </div>
      <n-alert v-if="issues.length" type="error" :show-icon="false" class="contest-note">
        <div class="note-title">{{ t('contestImport.issues') }}</div><ul><li v-for="issue in issues" :key="issue">{{ issue }}</li></ul>
      </n-alert>
      <n-alert v-if="warnings.length" type="warning" :show-icon="false" class="contest-note">
        <details :open="warnings.length <= 5"><summary>{{ t('packages.warnings', { n: warnings.length }) }}</summary><ul><li v-for="warning in warnings" :key="warning">{{ warning }}</li></ul></details>
      </n-alert>
    </template>
    <dir-picker v-model:show="showDirectory" :initial="directory" @pick="selectDirectory" />
    <template #footer-left>{{ footer }}</template>
    <template #footer><n-button :disabled="busy" @click="emit('update:show', false)">{{ t('common.cancel') }}</n-button><n-button type="primary" :loading="busy" :disabled="!canImport" @click="submit">{{ t('import.run') }}</n-button></template>
  </tool-window>
</template>

<style scoped>
.contest-form :deep(.n-form-item) { margin-bottom: 12px; }
.contest-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 16px; }
.tasks { display: flex; flex-direction: column; border: 1px solid var(--pf-border); border-radius: 6px; margin: 4px 0 14px; max-height: 340px; overflow: auto; }
.task { display: grid; grid-template-columns: 28px 44px minmax(0, 1.2fr) minmax(0, 1.6fr) minmax(0, 0.9fr) 56px; align-items: center; gap: 10px; padding: 6px 10px; }
.task + .task { border-top: 1px solid var(--pf-border); }
.task.head { font-size: 12px; color: var(--pf-text-secondary); position: sticky; top: 0; background: var(--pf-surface, inherit); z-index: 1; }
.task.excluded > :not(:first-child) { opacity: 0.55; }
.count { text-align: right; }
.dim { color: var(--pf-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.contest-note { margin-bottom: 12px; overflow-wrap: anywhere; }
.contest-note ul { margin: 4px 0 0; padding-left: 18px; }
.note-title { font-weight: 600; }
details summary { cursor: pointer; }
</style>
