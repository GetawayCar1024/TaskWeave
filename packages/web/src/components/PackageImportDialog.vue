<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NAlert, NButton, NCheckbox, NForm, NFormItem, NInput, NInputNumber, NSelect, useMessage } from 'naive-ui';
import { PROBLEM_NAME_RE, TESTSET_NAME_RE, type DetectedPackageFormat, type ImportPackageFormat, type PackageImportResult, type PackageItem, type PackageSelection } from '@taskweave/shared';
import { api, errorMessage } from '../lib/api';
import { serverText } from '../lib/serverText';
import { formatSize } from '../lib/format';
import { labelWidth } from '../lib/labelWidth';
import ToolWindow from './ToolWindow.vue';
import DirPicker from './DirPicker.vue';
import LibraryFolderSelect from './LibraryFolderSelect.vue';

const props = defineProps<{ show: boolean; roots?: string[]; root?: string; folder?: string; problemId?: string; testset?: string }>();
const emit = defineEmits<{ 'update:show': [boolean]; imported: [PackageImportResult] }>();
const { t, locale } = useI18n(); const message = useMessage();
const width = labelWidth(104, 168);
const files = shallowRef<File[]>([]);
const directory = ref(''), showDirectory = ref(false);
/** One problem of a staged upload. Its package unit (a directory or one FPS file) has its own format. */
interface ImportItem {
  key: string; uploadId: string; archive: string; candidate: PackageItem;
  requested: ImportPackageFormat; detected: DetectedPackageFormat;
  name: string; root: string; folder: string; title: Record<string, string>; timeLimit: number | null; memoryLimit: number | null;
  included: boolean; imported: boolean; error?: string;
}
const items = ref<ImportItem[]>([]), currentKey = ref(''), target = ref('tests');
const current = computed(() => items.value.find(item => item.key === currentKey.value));
const busy = ref(false), reading = ref(false), inspecting = ref(false), error = ref('');
const input = ref<HTMLInputElement>();
const lang = () => locale.value === 'zh-CN' ? 'zh' : 'en';
const formats = computed<DetectedPackageFormat[]>(() => props.problemId ? ['data', 'joi', 'fps', 'hydro-problem'] : ['polygon-package', 'hydro-problem', 'fps', 'data', 'joi']);
const formatOptions = computed(() => current.value ? [{ value: 'auto', label: t('packages.autoDetected', { format: t(`packages.${current.value.detected}`) }) },
  ...formats.value.map(value => ({ value, label: t(`packages.${value}`) }))] : []);
const selectedItems = computed(() => props.problemId ? (current.value ? [current.value] : []) : items.value.filter(item => item.included && !item.imported));
const uploads = new Set<string>();
function discardUploads() { for (const id of uploads) void api.discardPackage(id).catch(() => {}); uploads.clear(); }

const selection = (item: ImportItem): PackageSelection => ({ uploadId: item.uploadId, unit: item.candidate.unit, format: item.candidate.format, entry: item.candidate.entry,
  name: props.problemId ? undefined : item.name.trim(), root: item.root || undefined, folder: item.folder, testset: target.value, lang: lang(),
  ...(props.problemId ? {} : { title: item.title, timeLimit: item.timeLimit ?? undefined, memoryLimit: item.memoryLimit ?? undefined }) });
/** Instant checks; names, folders and duplicates are checked by the server for the whole batch. */
function localIssue(item: ImportItem): string {
  if (item.candidate.error) return serverText(item.candidate.error);
  if (props.problemId) return TESTSET_NAME_RE.test(target.value) ? '' : t('packages.testsetRule');
  if (!PROBLEM_NAME_RE.test(item.name.trim())) return t('create.nameRule');
  if (!item.timeLimit || item.timeLimit <= 0 || !Number.isInteger(item.timeLimit)) return t('packages.timeRule');
  if (!item.memoryLimit || item.memoryLimit <= 0) return t('packages.memoryRule');
  return '';
}
const signature = computed(() => JSON.stringify(selectedItems.value.map(selection)));
const checked = ref(''), remote = ref(new Map<string, string>());
const pending = computed(() => selectedItems.value.length > 0 && checked.value !== signature.value);
const issueOf = (item: ImportItem) => localIssue(item) || (checked.value === signature.value ? serverText(remote.value.get(item.key) ?? '') : '');
const issues = computed(() => selectedItems.value.filter(item => issueOf(item)).length);
const canImport = computed(() => selectedItems.value.length > 0 && !busy.value && !reading.value && !inspecting.value && !pending.value && !issues.value);
let validation = 0, timer: ReturnType<typeof setTimeout> | undefined;
function applyErrors(list: ImportItem[], errors: (string | undefined)[], value: string) {
  remote.value = new Map(list.flatMap((item, i) => errors[i] ? [[item.key, errors[i]!] as const] : []));
  checked.value = value;
}
watch(signature, value => {
  clearTimeout(timer);
  const version = ++validation, list = selectedItems.value.filter(item => !localIssue(item));
  if (!props.show || !list.length) { applyErrors([], [], value); return; }
  timer = setTimeout(async () => {
    try {
      const result = await api.validatePackages(list.map(selection), props.problemId);
      if (version === validation) applyErrors(list, result.items.map(item => item.error), value);
    } catch (e) { if (version === validation) error.value = errorMessage(e); }
  }, 250);
});

let request = 0;
watch(() => props.show, show => {
  request++; reading.value = false; discardUploads();
  if (!show) return;
  files.value = []; directory.value = ''; items.value = []; currentKey.value = ''; error.value = ''; target.value = props.testset ?? 'tests';
  checked.value = ''; remote.value = new Map();
});
onBeforeUnmount(() => { request++; clearTimeout(timer); discardUploads(); });
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 56);
function makeItem(uploadId: string, archive: string, candidate: PackageItem, requested: ImportPackageFormat, detected: DetectedPackageFormat, names: Set<string>): ImportItem {
  const base = candidate.name === 'imported-problem' ? slug(archive.replace(/\.(zip|xml|cdf)$/i, '')) || 'imported-problem' : candidate.name;
  let name = base;
  for (let n = 2; names.has(name); n++) name = `${base.slice(0, 56)}-${n}`;
  names.add(name);
  return { key: `${uploadId}:${candidate.unit}:${candidate.format}:${candidate.entry}`, uploadId, archive, candidate, requested, detected, name,
    folder: props.folder ?? '', root: props.root || props.roots?.[0] || '', title: { ...(candidate.titles ?? { [lang()]: candidate.title || name }) },
    timeLimit: candidate.timeLimit ?? 1000, memoryLimit: candidate.memoryLimit ?? 256, included: !candidate.error, imported: false };
}
async function inspect() {
  const version = ++request;
  items.value = []; error.value = ''; currentKey.value = ''; discardUploads();
  const inputs = [...files.value.map(file => ({ name: file.name, file, directory: '' })), ...(directory.value ? [{ name: directory.value.split(/[\\/]/).filter(Boolean).pop() || directory.value, file: null, directory: directory.value }] : [])];
  if (!inputs.length || !props.show) { reading.value = false; return; }
  reading.value = true;
  const names = new Set<string>();
  for (const selected of inputs) try {
    // A CDF is staged too, so the server can explain that LemonLime imports whole contests.
    if (selected.file && (!/\.(zip|xml|cdf)$/i.test(selected.name) || !selected.file.size)) throw new Error(t('packages.invalidInput'));
    if (selected.file && selected.file.size > 256 * 1024 * 1024) throw new Error(t('packages.tooLarge'));
    const upload = selected.file ? await api.stagePackage(selected.file) : await api.stageDirectory(selected.directory);
    if (version !== request) { void api.discardPackage(upload.id).catch(() => {}); return; }
    uploads.add(upload.id);
    items.value.push(...upload.items.map(candidate => makeItem(upload.id, selected.name, candidate, 'auto', candidate.format, names)));
  } catch (e) { if (version === request) error.value += `${selected.name}: ${errorMessage(e)}\n`; }
  if (version === request) { reading.value = false; currentKey.value = items.value[0]?.key ?? ''; }
}
const unitOf = (item: ImportItem) => items.value.filter(other => other.uploadId === item.uploadId && other.candidate.unit === item.candidate.unit);
/** Re-detect this problem's package unit with another format; one unit may hold several problems. */
async function chooseFormat(item: ImportItem, format: ImportPackageFormat) {
  if (format === item.requested) return;
  inspecting.value = true;
  try {
    const found = await api.inspectPackageUnit(item.uploadId, item.candidate.unit, format);
    const siblings = unitOf(item), names = new Set(items.value.filter(other => !siblings.includes(other)).map(other => other.name));
    const next = found.map(candidate => makeItem(item.uploadId, item.archive, candidate, format, item.detected, names));
    if (next.length === 1 && siblings.length === 1) Object.assign(next[0], { name: item.name, root: item.root, folder: item.folder, included: !next[0].candidate.error && (item.included || !!item.candidate.error) });
    const rest = items.value.filter(other => !siblings.includes(other));
    rest.splice(items.value.indexOf(siblings[0]), 0, ...next);
    items.value = rest; currentKey.value = next[0]?.key ?? '';
  } catch (e) { message.error(errorMessage(e)); }
  finally { inspecting.value = false; }
}
function selectFile(event: Event) {
  const selected = [...((event.target as HTMLInputElement).files ?? [])];
  if (input.value) input.value.value = '';
  if (!selected.length) return;
  files.value = selected; directory.value = '';
  void inspect();
}
function selectDirectory(path: string) { files.value = []; directory.value = path; void inspect(); }
const mark = (item: ImportItem) => item.imported ? '✓ ' : !props.problemId && !item.included ? '– ' : issueOf(item) ? '! ' : '';
const itemOptions = computed(() => items.value.map(item => ({ value: item.key, label: `${mark(item)}${item.name.trim() || item.candidate.name} — ${item.archive}${item.candidate.entry ? ' / ' + item.candidate.entry : ''}` })));
const status = computed(() => {
  const item = current.value;
  if (!item) return null;
  if (item.imported) return { type: 'success' as const, text: t('packages.alreadyImported') };
  const issue = issueOf(item);
  if (issue) return { type: 'error' as const, text: issue };
  if (item.error) return { type: 'error' as const, text: t('packages.failed', { error: serverText(item.error) }) };
  return { type: 'success' as const, text: t('packages.validated', { files: item.candidate.files ?? 0, tests: item.candidate.tests ?? 0, size: formatSize(item.candidate.size ?? 0) }) };
});
async function submit() {
  if (!canImport.value) return;
  busy.value = true; error.value = '';
  try {
    const selected = [...selectedItems.value], value = signature.value;
    const result = await api.importPackages(selected.map(selection), props.problemId);
    if (result.rejected) {
      // Nothing was imported: show every problem that needs a change.
      applyErrors(selected, result.items.map(item => item.error), value);
      currentKey.value = selected.find(item => remote.value.has(item.key))?.key ?? currentKey.value;
      return;
    }
    result.items.forEach((item, index) => { selected[index].error = item.error; selected[index].imported = !!item.result; });
    const successful = result.items.flatMap(item => item.result ? [item.result] : []), failed = selected.find(item => !item.imported);
    if (successful.length) {
      message.success(t('packages.batchImported', { n: successful.length })); emit('imported', successful[0]);
      const warnings = [...new Set(successful.flatMap(item => item.warnings))];
      if (warnings.length) message.warning(warnings.map(serverText).join('\n'), { duration: 12000, closable: true });
    }
    if (failed) currentKey.value = failed.key;
    else emit('update:show', false);
  } catch (e) { error.value = errorMessage(e); }
  finally { busy.value = false; }
}
const footer = computed(() => [t('packages.selectedProblems', { n: selectedItems.value.length, total: items.value.length }),
  issues.value ? t('packages.needsAttention', { n: issues.value }) : pending.value ? t('packages.validating') : ''].filter(Boolean).join(' · '));
</script>

<template>
  <tool-window :show="show" :title="t(problemId ? 'packages.importData' : 'packages.importLocal')" size="md" :error="error" :persistent="items.length > 0" @update:show="value => !busy && emit('update:show', value)">
    <template #actions>
      <n-button size="small" :disabled="busy || reading" :loading="reading" @click="input?.click()">{{ t('packages.chooseFile') }}</n-button>
      <n-button size="small" :disabled="busy || reading" @click="showDirectory = true">{{ t('packages.chooseDirectory') }}</n-button>
      <input ref="input" type="file" accept=".zip,.xml,application/zip,application/xml" :multiple="!problemId" hidden @change="selectFile" />
    </template>
    <p v-if="!items.length" class="pf-hint import-empty">{{ reading ? t('packages.reading') : t('packages.empty') }}</p>
    <n-form v-if="current" label-placement="left" :label-width="width" :show-feedback="false" class="import-form" @submit.prevent="submit">
      <n-form-item :label="t('packages.problem')"><n-select v-model:value="currentKey" filterable :options="itemOptions" :disabled="busy" /></n-form-item>
      <n-form-item :label="t('packages.format')">
        <n-select :value="current.requested" :options="formatOptions" :loading="inspecting" :disabled="busy || inspecting || unitOf(current).some(item => item.imported)" @update:value="(value: ImportPackageFormat) => chooseFormat(current!, value)" />
      </n-form-item>
      <n-form-item v-if="!problemId" :label="t('packages.selection')"><n-checkbox v-model:checked="current.included" :disabled="busy || current.imported || !!current.candidate.error">{{ t('packages.includeProblem') }}</n-checkbox></n-form-item>
      <n-alert v-if="status" :type="status.type" :show-icon="false" class="import-status">{{ status.text }}</n-alert>
      <n-alert v-if="current.candidate.warnings?.length" type="warning" :show-icon="false" class="import-status">
        <details :open="current.candidate.warnings.length <= 5" class="import-warnings"><summary>{{ t('packages.warnings', { n: current.candidate.warnings.length }) }}</summary><ul><li v-for="warning in current.candidate.warnings" :key="warning">{{ serverText(warning) }}</li></ul></details>
      </n-alert>
      <template v-if="!problemId">
        <n-form-item :label="t('create.name')"><n-input v-model:value="current.name" :status="PROBLEM_NAME_RE.test(current.name.trim()) ? undefined : 'error'" :disabled="busy || current.imported" /></n-form-item>
        <n-form-item :label="t('create.titleZh')"><n-input v-model:value="current.title.zh" :disabled="busy || current.imported" /></n-form-item>
        <n-form-item :label="t('create.titleEn')"><n-input v-model:value="current.title.en" :disabled="busy || current.imported" /></n-form-item>
        <n-form-item :label="t('packages.defaultTime')"><n-input-number v-model:value="current.timeLimit" :min="1" :max="Number.MAX_SAFE_INTEGER" :precision="0" :disabled="busy || current.imported"><template #suffix>ms</template></n-input-number></n-form-item>
        <n-form-item :label="t('packages.defaultMemory')"><n-input-number v-model:value="current.memoryLimit" :min="0.001" :max="Number.MAX_SAFE_INTEGER" :disabled="busy || current.imported"><template #suffix>MiB</template></n-input-number></n-form-item>
        <n-form-item v-if="(roots ?? []).length > 1" :label="t('create.root')"><n-select v-model:value="current.root" :options="(roots ?? []).map(value => ({ value, label: value }))" :disabled="busy || current.imported" @update:value="current!.folder = ''" /></n-form-item>
        <n-form-item :label="t('library.folder')"><library-folder-select v-model:value="current.folder" kind="problems" :root="current.root" :disabled="busy || current.imported" /></n-form-item>
      </template>
      <template v-else>
        <n-form-item :label="t('packages.testset')"><n-input v-model:value="target" :status="TESTSET_NAME_RE.test(target) ? undefined : 'error'" :disabled="busy" /></n-form-item>
        <n-alert type="warning" :show-icon="false" class="import-status">{{ t('packages.replaceData') }}</n-alert>
      </template>
    </n-form>
    <dir-picker v-model:show="showDirectory" :initial="directory" @pick="selectDirectory" />
    <template #footer-left>{{ footer }}</template>
    <template #footer><n-button :disabled="busy" @click="emit('update:show', false)">{{ t('common.cancel') }}</n-button><n-button type="primary" :loading="busy" :disabled="!canImport" @click="submit">{{ t('import.run') }}</n-button></template>
  </tool-window>
</template>
<style scoped>
.import-empty { margin: 4px 0; }
.import-form :deep(.n-form-item) { margin-bottom: 14px; }
.import-status { margin-bottom: 14px; overflow-wrap: anywhere; }
.import-warnings summary { cursor: pointer; }
.import-warnings ul { padding-left: 18px; margin: 6px 0 0; overflow-wrap: anywhere; }
</style>
