<script setup lang="ts">
import FreeSelect from './FreeSelect.vue';
import 'katex/dist/katex.min.css';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRoute } from 'vue-router';
import { NAlert, NButton, NInput, NModal, NSelect, useDialog, useMessage } from 'naive-ui';
import { ArrowLeft, FileText, FolderOpen, Plus, Upload } from 'lucide-vue-next';
import { commonContestLanguages, type ContestDetail, type FileContent, type FileNode } from '@polyforge/shared';
import { api, errorMessage, token } from '../lib/api';
import { unsavedChoice } from '../lib/confirmUnsaved';
import { registerExitGuard } from '../lib/exitGuards';
import { desktop } from '../lib/desktop';
import { buildMacros, renderLatex, type MacroTable } from '../lib/latex';
import { getDefs } from '../lib/defs';
import CodeEditor from './CodeEditor.vue';
import EditorTabBar from './EditorTabBar.vue';
import { tabHints, type EditorTabItem } from '../lib/editorOptions';
import { languageForPath } from '../lib/monaco';
import { useI18n } from 'vue-i18n';
import StatementDoc from './StatementDoc.vue';
import notesTemplate from '../vendor/cnoi/notes.md?raw';
import englishNotesTemplate from '../lib/cnoi-notes.en.md?raw';

const props = defineProps<{ id: string; show: boolean; detail: ContestDetail | null }>();
const emit = defineEmits<{ 'update:show': [boolean] }>();
const message = useMessage(); const dialog = useDialog(); const route = useRoute(); const { t, locale } = useI18n();
// Open files are tabs, like the problem editor; each keeps its own unsaved text.
interface OpenFile { path: string; text: string; original: string; loaded: FileContent }
const paths = ref<string[]>([]); const openFiles = ref<OpenFile[]>([]); const selected = ref('');
const current = computed(() => openFiles.value.find(f => f.path === selected.value) ?? null);
const text = computed({ get: () => current.value?.text ?? '', set: (value: string) => { if (current.value) current.value.text = value; } });
const loaded = computed(() => current.value?.loaded ?? null);
const isDirty = (f: OpenFile) => f.text !== f.original;
const newName = ref(''); const busy = ref(false);
// Shares the problem editor's preview switch.
const showPreview = ref(localStorage.getItem('polyforge-preview') !== 'off');
watch(showPreview, v => localStorage.setItem('polyforge-preview', v ? 'on' : 'off'));
const syncScroll = ref(true);
const editorRef = ref<InstanceType<typeof CodeEditor>>(); const previewHost = ref<HTMLDivElement>();
const opening = ref(false);
const lang = ref<string | null>(null); const upload = ref<HTMLInputElement>();
const doc = ref<'statements' | 'tutorials'>('statements');
const currentDetail = ref<ContestDetail | null>(null);
const contest = computed(() => currentDetail.value ?? props.detail);
const langs = computed(() => commonContestLanguages(contest.value?.problems ?? [], doc.value));
watch(langs, values => { if (!lang.value || !values.includes(lang.value)) lang.value = values.includes('zh') ? 'zh' : values[0] ?? null; }, { immediate: true });
const fileLang = ref('zh');
// Stored metadata also survives renaming; infer the language for snapshots created by older versions.
const snapshotLang = computed(() => text.value.match(/^%\s*polyforge-language:\s*([a-z]{2,8})\s*$/m)?.[1]
  ?? selected.value.match(/^(?:statements|tutorials)-([a-z]{2,8})-\d+-/)?.[1]);
const isNotes = computed(() => /^notes(?:\.[a-z]{2,8})?\.tex$/.test(selected.value));
const notesLang = computed(() => selected.value.match(/^notes\.([a-z]{2,8})\.tex$/)?.[1] ?? 'default');
const notesLanguages = computed(() => [
  { value: 'default', label: t('contest.notesDefault') },
  ...[...new Set(['zh', 'en', ...paths.value.flatMap(p => p.match(/^notes\.([a-z]{2,8})\.tex$/)?.[1] ?? [])])].map(value => ({ value, label: value })),
]);
const previewLang = computed(() => isNotes.value && notesLang.value !== 'default' ? notesLang.value : snapshotLang.value ?? fileLang.value);
const previewLanguages = computed(() => [...new Set(['zh', 'en', previewLang.value])].map(value => ({ value, label: value })));
const macros = ref<MacroTable>(new Map());
const dirty = computed(() => !!current.value && isDirty(current.value));
const anyDirty = computed(() => openFiles.value.some(isDirty));
const readonly = computed(() => !!loaded.value?.binary || !!loaded.value?.truncated);
const language = computed(() => languageForPath(selected.value));
const previewable = computed(() => /\.(tex|md)$/i.test(selected.value));
const tabItems = computed<EditorTabItem[]>(() => {
  const name = (p: string) => p.split('/').pop() ?? p;
  const hints = tabHints(openFiles.value.map(f => f.path), name);
  return openFiles.value.map(f => ({ path: f.path, label: name(f.path), hint: hints.get(f.path), dirty: isDirty(f), readOnly: !!f.loaded.binary || !!f.loaded.truncated }));
});
function editorScrolled() {
  const editor = editorRef.value?.editor(); const p = previewHost.value;
  if (!syncScroll.value || !editor || !p) return;
  const height = editor.getScrollHeight() - editor.getLayoutInfo().height;
  const top = height > 0 ? editor.getScrollTop() / height * (p.scrollHeight - p.clientHeight) : 0;
  if (Math.abs(p.scrollTop - top) > 1) p.scrollTop = top;
}
function previewScrolled() {
  const editor = editorRef.value?.editor(); const p = previewHost.value;
  if (!syncScroll.value || !editor || !p) return;
  const height = p.scrollHeight - p.clientHeight;
  const top = height > 0 ? p.scrollTop / height * (editor.getScrollHeight() - editor.getLayoutInfo().height) : 0;
  if (Math.abs(editor.getScrollTop() - top) > 1) editor.setScrollTop(top);
}
const rendered = computed(() => renderLatex(text.value, { macros: macros.value, imageUrl: name => {
  const base = selected.value.slice(0, selected.value.lastIndexOf('/') + 1);
  return `/api/contests/${encodeURIComponent(props.id)}/file/raw?path=${encodeURIComponent(base + name)}&token=${encodeURIComponent(token)}`;
} }).html);
async function refresh() {
  const flatten = (nodes: FileNode[]): string[] => nodes.flatMap(n => n.type === 'dir' ? flatten(n.children ?? []) : [n.path]);
  paths.value = flatten(await api.contestFiles(props.id));
}
async function refreshDetail() { currentDetail.value = await api.contest(props.id); }
watch(() => props.detail, value => { if (value) currentDetail.value = value; });
async function save(path = selected.value): Promise<boolean> {
  const file = openFiles.value.find(f => f.path === path);
  try {
    if (!file || file.loaded.binary || file.loaded.truncated) return false;
    const value = file.text;
    const { hash } = await api.saveContestFile(props.id, path, value, file.loaded.hash);
    file.loaded.hash = hash;
    file.original = value; return true;
  } catch (e) { message.error(errorMessage(e)); return false; }
}
async function confirmFile(file: OpenFile) {
  if (!isDirty(file)) return true;
  selected.value = file.path;
  const answer = await unsavedChoice(dialog, t('contest.filesSaveTitle'), file.path, { save: t('common.save'), discard: t('contest.filesDiscard'), cancel: t('common.cancel') });
  if (answer === 'save') return save(file.path);
  if (answer === 'discard') { file.text = file.original; return true; }
  return false;
}
async function canLeave() {
  for (const file of [...openFiles.value]) if (!(await confirmFile(file))) return false;
  return true;
}
registerExitGuard(canLeave);
onBeforeRouteLeave(canLeave);
const beforeUnload = (e: BeforeUnloadEvent) => { if (anyDirty.value) { e.preventDefault(); e.returnValue = ''; } };
window.addEventListener('beforeunload', beforeUnload);
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload));
// Like the problem editor: Ctrl+S saves outside the editor too; Ctrl+W closes the tab (desktop app).
const onKeydown = (e: KeyboardEvent) => {
  if (!props.show || e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.shiftKey) return;
  const k = e.key.toLowerCase();
  if (k === 's') { e.preventDefault(); if (current.value && dirty.value && !busy.value) void save(); }
  else if (k === 'w' && desktop) { e.preventDefault(); if (selected.value) void closeTab(selected.value); }
};
window.addEventListener('keydown', onKeydown);
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
async function open(path: string) {
  if (busy.value || opening.value) return;
  if (openFiles.value.some(f => f.path === path)) { selected.value = path; return; }
  opening.value = true;
  try {
    const file = await api.contestFile(props.id, path);
    if (!openFiles.value.some(f => f.path === path)) openFiles.value.push({ path, text: file.content, original: file.content, loaded: file });
    selected.value = path;
  }
  catch (e) { message.error(errorMessage(e)); }
  finally { opening.value = false; }
}
async function closeTab(path: string) {
  const file = openFiles.value.find(f => f.path === path);
  if (!file || busy.value || !(await confirmFile(file))) return;
  const i = openFiles.value.indexOf(file);
  openFiles.value.splice(i, 1);
  if (selected.value === path) selected.value = openFiles.value[Math.min(i, openFiles.value.length - 1)]?.path ?? '';
}
async function close() { if (!busy.value && await canLeave()) emit('update:show', false); }
const downloading = ref(false);
async function downloadCurrent() {
  if (downloading.value || !selected.value) return;
  downloading.value = true;
  try { const file = await api.downloadContestFile(props.id, selected.value); message.success(t('export.saved', { file })); }
  catch (e) { message.error(errorMessage(e)); }
  finally { downloading.value = false; }
}
async function create() {
  if (!newName.value.trim()) return;
  try { const name = newName.value.trim(); await api.uploadContestFile(props.id, name, ''); newName.value = ''; await refresh(); await open(name); }
  catch (e) { message.error(errorMessage(e)); }
}
async function openNotes(lang: string) {
  if (lang !== 'default' && !/^[a-z]{2,8}$/.test(lang)) return;
  const name = lang === 'default' ? 'notes.tex' : `notes.${lang}.tex`;
  try {
    if (!paths.value.includes(name)) { await api.uploadContestFile(props.id, name, ''); await refresh(); }
    await open(name);
  } catch (e) { message.error(errorMessage(e)); }
}
async function uploadFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  try {
    for (const file of Array.from(input.files ?? [])) {
      const base64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); });
      await api.uploadContestFile(props.id, file.name, base64);
    }
    await refresh();
  } catch (e) { message.error(errorMessage(e)); }
  input.value = '';
}
async function generate(doc: 'statements' | 'tutorials') {
  const chosenLang = lang.value;
  if (!chosenLang || busy.value) return;
  if (!(await canLeave())) return;
  busy.value = true;
  try {
    await refreshDetail();
    if (!commonContestLanguages(contest.value?.problems ?? [], doc).includes(chosenLang)) { message.warning(t('contest.filesLangNotCommon')); return; }
    const r = await api.generateContestDocument(props.id, chosenLang, doc);
    await refresh(); busy.value = false; await open(r.path);
  }
  catch (e) { message.error(errorMessage(e)); }
  finally { busy.value = false; }
}
function remove() {
  const path = selected.value;
  const notes = /^notes(?:\.[a-z]{2,8})?\.tex$/.test(path);
  dialog.warning({ title: notes ? t('contest.filesClearNotes') : t('contest.filesDeleteFile'), content: path, positiveText: t('common.ok'), negativeText: t('common.cancel'), onPositiveClick: async () => {
    try {
      await api.deleteContestFile(props.id, path);
      const file = openFiles.value.find(f => f.path === path);
      if (file && notes) { file.text = file.original = ''; file.loaded = await api.contestFile(props.id, path); }
      else if (file) { file.original = file.text; await closeTab(path); }
      await refresh();
    }
    catch (e) { message.error(errorMessage(e)); }
  } });
}
function insertTemplate() {
  // The document renderer supplies the heading below the contents table.
  const insert = () => { text.value = (previewLang.value === 'zh' ? notesTemplate : englishNotesTemplate).replace(/^\*\*[^\n]*\n\s*/, ''); };
  if (text.value.trim()) dialog.warning({ title: t('contest.filesReplaceTemplate'), content: t('contest.filesReplaceTemplateBody'), positiveText: t('contest.filesReplace'), negativeText: t('common.cancel'), onPositiveClick: insert });
  else insert();
}
watch(() => props.show, async show => {
  if (!show) return;
  try {
    await Promise.all([refresh(), refreshDetail()]);
    // Tabs survive closing the workspace; refresh the clean ones from disk.
    for (const file of [...openFiles.value]) {
      if (isDirty(file)) continue;
      const fresh = await api.contestFile(props.id, file.path).catch(() => null);
      if (!fresh) { openFiles.value.splice(openFiles.value.indexOf(file), 1); continue; }
      if (!isDirty(file)) { file.loaded = fresh; file.text = file.original = fresh.content; }
    }
    if (!openFiles.value.some(f => f.path === selected.value)) selected.value = openFiles.value[0]?.path ?? '';
    const translated = `notes.${locale.value === 'zh-CN' ? 'zh' : 'en'}.tex`;
    await open(typeof route.query.contestFile === 'string' ? route.query.contestFile : selected.value || (paths.value.includes(translated) ? translated : 'notes.tex')); }
  catch (e) { message.error(errorMessage(e)); }
}, { immediate: true });
watch(() => route.query.contestFile, file => { if (props.show && typeof file === 'string') void open(file); });
watch(previewLang, async (value, _old, onCleanup) => {
  let cancelled = false; onCleanup(() => { cancelled = true; });
  const defs = await getDefs();
  if (!cancelled) macros.value = buildMacros(defs, value);
}, { immediate: true });
</script>

<template>
  <n-modal :show="show" :mask-closable="false" :auto-focus="false" @update:show="close">
    <div class="contest-workspace" role="dialog" :aria-label="t('contest.files')">
      <header class="workspace-header">
        <n-button quaternary size="small" :disabled="busy" @click="close"><template #icon><ArrowLeft :size="16" /></template>{{ t('nav.backToContest') }}</n-button>
        <strong>{{ contest?.summary.title.zh || contest?.summary.title.en || contest?.summary.name }}</strong>
        <span class="workspace-label">{{ t('contest.files') }}</span>
      </header>
    <div class="files-layout">
      <aside class="files-sidebar">
        <div class="files-heading"><FolderOpen :size="15" /><span>files/</span><span class="file-count">{{ paths.length }}</span></div>
        <div class="create-actions">
          <n-input v-model:value="newName" :placeholder="t('contest.filesNewName')" :aria-label="t('contest.filesNewNameLabel')" size="small" :disabled="busy" @keydown.enter="create" />
          <div class="file-buttons"><n-button size="small" :disabled="busy || !newName.trim()" @click="create"><template #icon><Plus :size="15" /></template>{{ t('contest.filesNew') }}</n-button>
          <n-button size="small" :disabled="busy" @click="upload?.click()"><template #icon><Upload :size="15" /></template>{{ t('contest.filesUpload') }}</n-button></div>
          <input ref="upload" type="file" multiple hidden @change="uploadFiles" />
        </div>
        <div class="file-list"><button v-for="path in paths" :key="path" :disabled="busy" :class="{ active: path === selected }" :title="path" :aria-current="path === selected ? 'true' : undefined" @click="open(path)"><FileText :size="15" /><span class="file-label"><span class="file-name">{{ path.split('/').pop() }}</span><small v-if="path.includes('/')">{{ path.slice(0, path.lastIndexOf('/')) }}</small></span><span v-if="openFiles.some(f => f.path === path && isDirty(f))" class="dirty-dot" :title="t('contest.filesUnsaved')" /></button></div>
      </aside>
      <section class="editor">
        <editor-tab-bar v-if="openFiles.length" :tabs="tabItems" :active="selected || null" @select="p => (selected = p)" @close="closeTab">
          <template v-if="current" #actions>
            <n-button size="tiny" quaternary :loading="downloading" @click="downloadCurrent">{{ t('contest.filesDownload') }}</n-button>
             <n-button size="tiny" quaternary type="error" :disabled="busy" @click="remove">{{ isNotes ? t('contest.filesClear') : t('contest.filesDelete') }}</n-button>
            <n-button size="tiny" type="primary" :disabled="readonly || !dirty || busy" :title="'Ctrl+S'" @click="save()">{{ t('common.save') }}</n-button>
          </template>
        </editor-tab-bar>
        <div v-if="isNotes && current" class="notes-help"><free-select :value="notesLang" :aria-label="t('contest.notesLanguage')" size="small" style="width: 140px" :options="notesLanguages" :disabled="busy" @update:value="openNotes" /><n-button size="tiny" secondary :disabled="busy" @click="insertTemplate">{{ previewLang === 'zh' ? t('contest.filesInsertNotes') : t('contest.filesInsertNotesEn') }}</n-button></div>
        <div v-if="opening && !current" class="empty-editor">{{ t('contest.filesLoading') }}</div>
        <n-alert v-else-if="current && readonly" type="info" :show-icon="false" class="banner">{{ t('contest.filesReadonly') }}</n-alert>
        <div v-else-if="current" class="body">
          <code-editor ref="editorRef" :key="selected" v-model="text" class="host" :language="language" :path="selected" :read-only="busy" @save="save()" @scroll="editorScrolled" />
          <div v-if="previewable && showPreview" ref="previewHost" class="preview" @scroll="previewScrolled"><statement-doc :lang="previewLang" title="" :sections="{ legend: rendered }" :samples="[]" /></div>
          <div v-if="previewable" class="preview-toggle">
            <n-button size="tiny" :type="syncScroll ? 'primary' : 'default'" @click="syncScroll = !syncScroll">{{ t('fix.syncScroll') }}</n-button>
            <n-button size="tiny" secondary @click="showPreview = !showPreview">{{ showPreview ? t('preview.hide') : t('preview.show') }}</n-button>
          </div>
        </div>
        <div v-else class="empty-editor"><FileText :size="32" :stroke-width="1.25" /><span>{{ t('contest.filesPick') }}</span><span class="hint">Ctrl+S {{ t('common.save') }}</span></div>
      </section>
      <aside class="info-sidebar">
        <div class="files-heading">{{ t('contest.filesInfo') }}</div>
        <div class="info-scroll">
          <section class="info-card">
            <h3>{{ contest?.summary.title.zh || contest?.summary.title.en || contest?.summary.name }}</h3>
            <dl><dt>{{ t('contest.filesShortName') }}</dt><dd>{{ contest?.summary.name }}</dd>
              <dt v-if="contest?.summary.title.en">{{ t('contest.filesTitleEn') }}</dt><dd v-if="contest?.summary.title.en">{{ contest.summary.title.en }}</dd>
              <dt>{{ t('contest.filesProblemCount') }}</dt><dd>{{ contest?.problems.length ?? 0 }}</dd>
              <dt v-if="contest?.summary.polygonId">Polygon</dt><dd v-if="contest?.summary.polygonId">#{{ contest.summary.polygonId }}</dd>
            </dl>
            <p class="directory" :title="contest?.summary.dir">{{ contest?.summary.dir }}</p>
          </section>
          <section class="info-card document-settings">
            <h3>{{ t('contest.filesWholeDoc') }}</h3>
            <label>{{ t('contest.filesDocContent') }}</label><n-select v-model:value="doc" :aria-label="t('contest.filesDocContent')" size="small" :disabled="busy" :options="[{ value: 'statements', label: t('contest.filesStatements') }, { value: 'tutorials', label: t('contest.filesTutorials') }]" />
            <label>{{ t('contest.filesDocLang') }}</label><n-select v-model:value="lang" :aria-label="t('contest.filesDocLang')" size="small" :disabled="busy || !langs.length" :placeholder="t('contest.filesNoCommonLang')" :options="langs.map(value => ({ value, label: value }))" />
            <p class="help">{{ langs.length ? t('contest.filesLangHelp') : doc === 'statements' ? t('contest.filesNoCommonStatements') : t('contest.filesNoCommonTutorials') }}</p>
            <n-button block type="primary" size="small" :loading="busy" :disabled="busy || !lang" @click="generate(doc)">{{ doc === 'statements' ? t('contest.filesGenStatements') : t('contest.filesGenTutorials') }}</n-button>
          </section>
          <section v-if="selected" class="info-card document-settings">
            <h3>{{ t('contest.filesCurrent') }}</h3><p class="directory">files/{{ selected }}</p>
            <label>{{ t('contest.filesPreviewLang') }}</label><n-select :value="previewLang" :aria-label="t('contest.filesPreviewLang')" size="small" :disabled="!!snapshotLang || (isNotes && notesLang !== 'default') || busy" :options="previewLanguages" @update:value="value => fileLang = value" />
            <p class="help">{{ snapshotLang ? t('contest.filesSnapshotLangHelp') : t('contest.filesPreviewLangHelp') }}</p>
          </section>
        </div>
      </aside>
    </div>
    </div>
  </n-modal>
</template>

<style scoped>
.contest-workspace { width: 100vw; height: 100dvh; display: flex; flex-direction: column; background: var(--pf-surface); color: var(--pf-text); }
.workspace-header { display: flex; align-items: center; gap: 14px; min-height: 48px; padding: 0 16px; border-bottom: 1px solid var(--pf-border); background: var(--pf-toolbar-bg); }
.workspace-header strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.workspace-label { color: var(--pf-text-secondary); font-size: 12px; flex-shrink: 0; }
.create-actions { display: flex; flex-direction: column; gap: 8px; padding: 10px; border-bottom: 1px solid var(--pf-border); }
.file-buttons { display: flex; gap: 6px; }
.file-buttons > * { flex: 1; }
.files-layout { display: grid; grid-template-columns: 230px minmax(0, 1fr) 280px; flex: 1; min-height: 0; overflow: hidden; }
aside { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--pf-border); background: var(--pf-toolbar-bg); }
.files-heading { display: flex; align-items: center; gap: 7px; min-height: 41px; padding: 0 12px; border-bottom: 1px solid var(--pf-border); color: var(--pf-text-secondary); font-size: 12px; }
.file-count { margin-left: auto; font-variant-numeric: tabular-nums; }
.file-list { overflow: auto; padding: 5px; }
.file-list button { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px; border: 0; border-radius: 5px; background: none; color: inherit; text-align: left; cursor: pointer; }
.file-list button > svg { flex-shrink: 0; color: var(--pf-text-secondary); }
.file-list button:hover { background: var(--pf-selected); }
.file-list button:focus-visible { outline: 2px solid var(--pf-accent); outline-offset: -2px; }
.file-list button.active { background: var(--pf-selected); color: var(--pf-accent); }
.file-list button:disabled { opacity: .5; cursor: wait; }
.file-label { min-width: 0; flex: 1; }
.file-name, .file-label small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-name { font-size: 12px; }
.file-label small { margin-top: 2px; color: var(--pf-text-secondary); font-size: 10px; }
.editor { display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--pf-surface); }
.dirty-dot { display: inline-block; flex-shrink: 0; width: 6px; height: 6px; border-radius: 50%; background: var(--pf-accent); }
.body { flex: 1; min-height: 0; display: flex; position: relative; }
.body .host { flex: 1; min-width: 0; min-height: 0; }
.banner { border-radius: 0; flex-shrink: 0; padding: 2px 4px; }
.preview-toggle { position: absolute; right: 18px; bottom: 10px; z-index: 5; display: flex; gap: 6px; }
.hint { font-size: 12px; opacity: 0.6; }
.notes-help { display: flex; align-items: center; flex-wrap: wrap; justify-content: space-between; gap: 6px 10px; padding: 8px 10px; background: var(--pf-toolbar-bg); border-bottom: 1px solid var(--pf-border); font-size: 11px; color: var(--pf-text-secondary); }
.preview { flex: 1; min-width: 0; overflow: auto; background: var(--pf-surface); color: var(--pf-text); padding: 20px; border-left: 1px solid var(--pf-border); }
.empty-editor { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--pf-text-secondary); font-size: 13px; }
.info-sidebar { border-right: 0; border-left: 1px solid var(--pf-border); }
.info-scroll { padding: 10px; overflow: auto; }
.info-card { padding: 12px; border: 1px solid var(--pf-border); border-radius: 7px; background: var(--pf-surface); margin-bottom: 10px; }
.info-card h3 { margin: 0 0 12px; font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.info-card dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px 12px; margin: 0; font-size: 12px; }
.info-card dt, .document-settings label { color: var(--pf-text-secondary); }
.info-card dd { margin: 0; overflow-wrap: anywhere; }
.directory { font-size: 11px; color: var(--pf-text-secondary); overflow-wrap: anywhere; margin: 10px 0 0; }
.document-settings { display: flex; flex-direction: column; gap: 8px; }
.document-settings h3 { margin-bottom: 2px; }
.document-settings label { font-size: 12px; }
.help { font-size: 11px; line-height: 1.6; color: var(--pf-text-secondary); margin: 2px 0; }
@media (max-width: 1050px) { .files-layout { grid-template-columns: 180px minmax(0, 1fr) 240px; } }
@media (max-width: 760px) { .files-layout { grid-template-columns: 150px minmax(0, 1fr); overflow: auto; grid-template-rows: minmax(420px, 65vh) auto; } .info-sidebar { grid-column: 1 / -1; border: 0; border-top: 1px solid var(--pf-border); } .info-scroll { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; } .workspace-header { padding: 0 8px; gap: 8px; } }
</style>
