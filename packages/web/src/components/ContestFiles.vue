<script setup lang="ts">
import 'katex/dist/katex.min.css';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRoute } from 'vue-router';
import { NAlert, NButton, NInput, NModal, NSelect, useDialog, useMessage } from 'naive-ui';
import { ArrowLeft, FileText, FolderOpen, Plus, Upload } from 'lucide-vue-next';
import { commonContestLanguages, type ContestDetail, type FileContent, type FileNode } from '@polyforge/shared';
import { api, errorMessage, token } from '../lib/api';
import { unsavedChoice } from '../lib/confirmUnsaved';
import { registerExitGuard } from '../lib/exitGuards';
import { buildMacros, renderLatex, type MacroTable } from '../lib/latex';
import { getDefs } from '../lib/defs';
import CodeEditor from './CodeEditor.vue';
import StatementDoc from './StatementDoc.vue';
import notesTemplate from '../vendor/cnoi/notes.md?raw';
import englishNotesTemplate from '../lib/cnoi-notes.en.md?raw';

const props = defineProps<{ id: string; show: boolean; detail: ContestDetail | null }>();
const emit = defineEmits<{ 'update:show': [boolean] }>();
const message = useMessage(); const dialog = useDialog(); const route = useRoute();
const paths = ref<string[]>([]); const selected = ref(''); const text = ref(''); const original = ref('');
const loaded = ref<FileContent | null>(null); const newName = ref(''); const busy = ref(false); const preview = ref(false);
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
const previewLang = computed(() => snapshotLang.value ?? fileLang.value);
const previewLanguages = computed(() => [...new Set(['zh', 'en', previewLang.value])].map(value => ({ value, label: value })));
const macros = ref<MacroTable>(new Map());
const dirty = computed(() => text.value !== original.value);
const readonly = computed(() => !!loaded.value?.binary || !!loaded.value?.truncated);
const language = computed(() => selected.value.endsWith('.tex') ? 'latex' : selected.value.endsWith('.md') ? 'markdown' : 'plaintext');
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
async function save(): Promise<boolean> {
  try {
    if (!selected.value || readonly.value) return false;
    const value = text.value;
    const { hash } = await api.saveContestFile(props.id, selected.value, value, loaded.value?.hash);
    if (loaded.value) loaded.value.hash = hash;
    original.value = value; return true;
  } catch (e) { message.error(errorMessage(e)); return false; }
}
async function canLeave() {
  if (!dirty.value) return true;
  const answer = await unsavedChoice(dialog, '保存比赛文件？', selected.value, { save: '保存', discard: '不保存', cancel: '取消' });
  return answer === 'save' ? save() : answer === 'discard';
}
registerExitGuard(canLeave);
onBeforeRouteLeave(canLeave);
const beforeUnload = (e: BeforeUnloadEvent) => { if (dirty.value) { e.preventDefault(); e.returnValue = ''; } };
window.addEventListener('beforeunload', beforeUnload);
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload));
async function open(path: string) {
  if (busy.value || opening.value) return;
  if (!(await canLeave())) return;
  opening.value = true;
  try { const file = await api.contestFile(props.id, path); loaded.value = file; selected.value = path; text.value = original.value = file.content; }
  catch (e) { message.error(errorMessage(e)); }
  finally { opening.value = false; }
}
async function close() { if (!busy.value && await canLeave()) { text.value = original.value; emit('update:show', false); } }
async function create() {
  if (!newName.value.trim()) return;
  try { const name = newName.value.trim(); await api.uploadContestFile(props.id, name, ''); newName.value = ''; await refresh(); await open(name); }
  catch (e) { message.error(errorMessage(e)); }
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
    if (!commonContestLanguages(contest.value?.problems ?? [], doc).includes(chosenLang)) { message.warning('所选语言并非所有题目共有，请补齐内容后再生成。'); return; }
    const r = await api.generateContestDocument(props.id, chosenLang, doc);
    text.value = original.value; await refresh(); busy.value = false; await open(r.path);
  }
  catch (e) { message.error(errorMessage(e)); }
  finally { busy.value = false; }
}
function remove() {
  dialog.warning({ title: selected.value === 'notes.tex' ? '清空注意事项？' : '删除文件？', content: selected.value, positiveText: '确定', negativeText: '取消', onPositiveClick: async () => {
    try { await api.deleteContestFile(props.id, selected.value); text.value = original.value = ''; selected.value = ''; loaded.value = null; await refresh(); }
    catch (e) { message.error(errorMessage(e)); }
  } });
}
function insertTemplate() {
  // The document renderer supplies the heading below the contents table.
  const insert = () => { text.value = (previewLang.value === 'zh' ? notesTemplate : englishNotesTemplate).replace(/^\*\*[^\n]*\n\s*/, ''); };
  if (text.value.trim()) dialog.warning({ title: '替换为注意事项模板？', content: '将替换编辑器中的内容，保存后生效。', positiveText: '替换', negativeText: '取消', onPositiveClick: insert });
  else insert();
}
watch(() => props.show, async show => {
  if (!show) return;
  try { await Promise.all([refresh(), refreshDetail()]); if (!dirty.value) await open(typeof route.query.contestFile === 'string' ? route.query.contestFile : selected.value || 'notes.tex'); }
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
    <div class="contest-workspace" role="dialog" aria-label="比赛文件">
      <header class="workspace-header">
        <n-button quaternary size="small" :disabled="busy" @click="close"><template #icon><ArrowLeft :size="16" /></template>返回比赛</n-button>
        <strong>{{ contest?.summary.title.zh || contest?.summary.title.en || contest?.summary.name }}</strong>
        <span class="workspace-label">比赛文件</span>
      </header>
    <div class="files-layout">
      <aside class="files-sidebar">
        <div class="files-heading"><FolderOpen :size="15" /><span>files/</span><span class="file-count">{{ paths.length }}</span></div>
        <div class="create-actions">
          <n-input v-model:value="newName" placeholder="新文件名，如 announcement.md" aria-label="新文件名" size="small" :disabled="busy" @keydown.enter="create" />
          <div class="file-buttons"><n-button size="small" :disabled="busy || !newName.trim()" @click="create"><template #icon><Plus :size="15" /></template>新建</n-button>
          <n-button size="small" :disabled="busy" @click="upload?.click()"><template #icon><Upload :size="15" /></template>上传</n-button></div>
          <input ref="upload" type="file" multiple hidden @change="uploadFiles" />
        </div>
        <div class="file-list"><button v-for="path in paths" :key="path" :disabled="busy" :class="{ active: path === selected }" :title="path" :aria-current="path === selected ? 'true' : undefined" @click="open(path)"><FileText :size="15" /><span class="file-label"><span class="file-name">{{ path.split('/').pop() }}</span><small v-if="path.includes('/')">{{ path.slice(0, path.lastIndexOf('/')) }}</small></span><span v-if="path === selected && dirty" class="dirty-dot" title="未保存" /></button></div>
      </aside>
      <section class="editor">
        <div v-if="selected" class="editor-toolbar">
          <div class="selected-file" :title="selected"><strong>{{ selected }}</strong><span v-if="dirty" class="dirty-dot" title="未保存" /></div>
          <div class="editor-actions">
          <n-button size="tiny" :disabled="readonly" :type="preview ? 'primary' : 'default'" :secondary="preview" @click="preview = !preview">{{ preview ? '编辑' : '预览' }}</n-button>
          <n-button size="tiny" @click="api.downloadContestFile(id, selected).catch(e => message.error(errorMessage(e)))">下载</n-button>
          <n-button size="tiny" quaternary type="error" :disabled="busy" @click="remove">{{ selected === 'notes.tex' ? '清空' : '删除' }}</n-button>
          <n-button size="tiny" type="primary" :disabled="readonly || !dirty || busy" @click="save">保存</n-button>
          </div>
        </div>
        <div v-if="selected === 'notes.tex'" class="notes-help"><span>注意事项显示在目录下，留空则隐藏。模板中的环境与规则请按本场比赛修改。</span><n-button size="tiny" secondary :disabled="busy" @click="insertTemplate">{{ previewLang === 'zh' ? '插入注意事项模板' : '插入英文注意事项模板' }}</n-button></div>
        <div v-if="opening" class="empty-editor">正在加载文件…</div>
        <n-alert v-else-if="readonly" type="info">此文件仅支持下载；二进制或过大的文件不能直接编辑。</n-alert>
        <div v-else-if="selected && preview" class="preview"><statement-doc :lang="previewLang" title="" :sections="{ legend: rendered }" :samples="[]" /></div>
        <code-editor v-else-if="selected" :key="selected" v-model="text" :language="language" :read-only="busy" @save="save" />
        <div v-else class="empty-editor"><FileText :size="32" :stroke-width="1.25" /><span>选择文件以编辑或预览</span></div>
      </section>
      <aside class="info-sidebar">
        <div class="files-heading">比赛信息</div>
        <div class="info-scroll">
          <section class="info-card">
            <h3>{{ contest?.summary.title.zh || contest?.summary.title.en || contest?.summary.name }}</h3>
            <dl><dt>短名称</dt><dd>{{ contest?.summary.name }}</dd>
              <dt v-if="contest?.summary.title.en">英文标题</dt><dd v-if="contest?.summary.title.en">{{ contest.summary.title.en }}</dd>
              <dt>题目数量</dt><dd>{{ contest?.problems.length ?? 0 }}</dd>
              <dt v-if="contest?.summary.polygonId">Polygon</dt><dd v-if="contest?.summary.polygonId">#{{ contest.summary.polygonId }}</dd>
            </dl>
            <p class="directory" :title="contest?.summary.dir">{{ contest?.summary.dir }}</p>
          </section>
          <section class="info-card document-settings">
            <h3>整场文档</h3>
            <label>内容</label><n-select v-model:value="doc" aria-label="文档内容" size="small" :disabled="busy" :options="[{ value: 'statements', label: '题面' }, { value: 'tutorials', label: '题解' }]" />
            <label>语言</label><n-select v-model:value="lang" aria-label="文档语言" size="small" :disabled="busy || !langs.length" placeholder="无共同语言" :options="langs.map(value => ({ value, label: value }))" />
            <p class="help">{{ langs.length ? '仅显示所有题目都有内容的语言。生成后将保存为比赛文件，不修改原题。' : `所有题目尚无共同的${doc === 'statements' ? '题面' : '题解'}语言，请先补齐内容。` }}</p>
            <n-button block type="primary" size="small" :loading="busy" :disabled="busy || !lang" @click="generate(doc)">{{ doc === 'statements' ? '生成整场题面' : '生成整场题解' }}</n-button>
          </section>
          <section v-if="selected" class="info-card document-settings">
            <h3>当前文件</h3><p class="directory">files/{{ selected }}</p>
            <label>预览语言</label><n-select :value="previewLang" aria-label="预览语言" size="small" :disabled="!!snapshotLang || busy" :options="previewLanguages" @update:value="value => fileLang = value" />
            <p class="help">{{ snapshotLang ? '预览使用生成文件的语言，宏定义随文件语言展开。' : '用于宏定义与注意事项模板，与整场文档生成语言独立。' }}</p>
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
.editor-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-height: 41px; box-sizing: border-box; padding: 7px 10px; border-bottom: 1px solid var(--pf-border); }
.selected-file { display: flex; align-items: center; gap: 8px; min-width: 80px; flex: 1; font-size: 12px; }
.selected-file strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.dirty-dot { display: inline-block; flex-shrink: 0; width: 6px; height: 6px; border-radius: 50%; background: var(--pf-accent); }
.editor-actions { display: flex; align-items: center; gap: 6px; }
.notes-help { display: flex; align-items: center; flex-wrap: wrap; justify-content: space-between; gap: 6px 10px; padding: 8px 10px; background: var(--pf-toolbar-bg); border-bottom: 1px solid var(--pf-border); font-size: 11px; color: var(--pf-text-secondary); }
.editor .code-editor { flex: 1; min-height: 0; }
.preview { flex: 1; overflow: auto; background: white; color: #111; padding: 20px; }
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
@media (max-width: 1050px) { .files-layout { grid-template-columns: 180px minmax(0, 1fr) 240px; } .selected-file { flex-basis: 100%; } }
@media (max-width: 760px) { .files-layout { grid-template-columns: 150px minmax(0, 1fr); overflow: auto; grid-template-rows: minmax(420px, 65vh) auto; } .info-sidebar { grid-column: 1 / -1; border: 0; border-top: 1px solid var(--pf-border); } .info-scroll { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; } .workspace-header { padding: 0 8px; gap: 8px; } }
</style>
