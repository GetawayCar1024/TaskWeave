<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NAlert, NButton, NEmpty, NSpace } from 'naive-ui';
import type { Judge } from '../lib/judge';
import { monaco } from '../lib/monaco';
import { settings } from '../lib/settings';
import { SHARED_TAB, type Tab, type Workspace } from '../lib/workspace';
import StatementPreview from './StatementPreview.vue';
import FilePreview from './FilePreview.vue';
import { EDITOR_BASE_OPTIONS, editorOptions as sharedEditorOptions, tabHints, type EditorTabItem } from '../lib/editorOptions';
import EditorTabBar from './EditorTabBar.vue';
import type { SidebarAction } from './FileSidebar.vue';

const props = defineProps<{ ws: Workspace; judge: Judge; problemId: string }>();
const emit = defineEmits<{ save: [path: string]; close: [path: string]; quickOpen: []; showDiff: [path: string]; run: []; generate: []; action: [SidebarAction]; lint: []; palette: []; convertStatement: [lang: string, mode: 'whole' | 'sections'] }>();

// Statement tabs get a live preview next to the source (DESIGN §6.1).
const statementLang = computed(() => props.ws.activeTab.value?.path.match(/^statement\/([^/]+)\/(statement|legend|input|output|interaction|scoring|notes|tutorial)\.tex$/)?.[1] ?? null);
const wholeStatement = computed(() => props.ws.files.value.some(f => f.path === `statement/${statementLang.value}/statement.tex`));
const previewable = computed(() => /\.(tex|md)$/i.test(props.ws.activeTab.value?.path ?? ''));
const previewHost = ref<HTMLDivElement>();
const syncScroll = ref(true);
const showPreview = ref(localStorage.getItem('polyforge-preview') !== 'off');
watch(showPreview, (v) => localStorage.setItem('polyforge-preview', v ? 'on' : 'off'));
const { t } = useI18n();
const host = ref<HTMLDivElement>();
let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let current: Tab | null = null;
let restoring = false;
const viewStates = new Map<string, monaco.editor.ICodeEditorViewState>();
function rememberView() {
  if (restoring || !current || !editor) return;
  const state = editor.saveViewState();
  if (state) viewStates.set(current.path, state);
}

const editorOptions = () => sharedEditorOptions(props.ws.activeTab.value?.path ?? '');

onMounted(() => {
  editor = monaco.editor.create(host.value!, {
    model: null,
    ...EDITOR_BASE_OPTIONS,
    ...editorOptions(),
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => current && emit('save', current.path));
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => emit('quickOpen'));
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => emit('run'));
  // Ctrl+K is a chord prefix in Monaco and Ctrl+Shift+L selects all occurrences; ours win here.
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => emit('palette'));
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyL, () => emit('lint'));
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyG, () => emit('generate'));
  props.ws.editorRef.value = editor;
  editor.onDidScrollChange(() => {
    const p = previewHost.value;
    if (restoring || !syncScroll.value || !p || !editor) return;
    const height = editor.getScrollHeight() - editor.getLayoutInfo().height;
    const top = height > 0 ? editor.getScrollTop() / height * (p.scrollHeight - p.clientHeight) : 0;
    if (Math.abs(p.scrollTop - top) > 1) p.scrollTop = top;
  });
  editor.onDidChangeCursorSelection(rememberView);
  editor.onDidScrollChange(rememberView);
  show(props.ws.activeTab.value);
});

function scrollPreview() {
  const p = previewHost.value;
  if (restoring || !syncScroll.value || !p || !editor) return;
  const height = p.scrollHeight - p.clientHeight;
  const top = height > 0 ? p.scrollTop / height * (editor.getScrollHeight() - editor.getLayoutInfo().height) : 0;
  if (Math.abs(editor.getScrollTop() - top) > 1) editor.setScrollTop(top);
}

function show(tab: Tab | null) {
  if (!editor) return;
  if (current && current !== tab && !current.model.isDisposed()) current.viewState = editor.saveViewState();
  rememberView();
  restoring = true;
  current = tab;
  editor.setModel(tab && !tab.model.isDisposed() ? tab.model : null);
  if (tab) {
    editor.updateOptions({ ...editorOptions(), readOnly: tab.readOnly });
    const state = viewStates.get(tab.path) ?? tab.viewState;
    if (state) editor.restoreViewState(state);
    editor.focus();
  }
  restoring = false;
}

watch(() => props.ws.activeTab.value, show);
watch(
  () => settings.config,
  () => editor?.updateOptions(editorOptions()),
  { deep: true },
);

onBeforeUnmount(() => {
  props.ws.editorRef.value = null;
  editor?.dispose();
});

const label = (path: string) => (path.startsWith(SHARED_TAB) ? `std:${path.split('/').pop()}` : path.split('/').pop());

const tabItems = computed<EditorTabItem[]>(() => {
  const hints = tabHints(props.ws.state.tabs.map((tab) => tab.path), (p) => label(p) ?? p);
  return props.ws.state.tabs.map((tab) => ({
    path: tab.path,
    label: label(tab.path) ?? tab.path,
    hint: hints.get(tab.path),
    dirty: tab.dirty,
    readOnly: tab.readOnly,
    gone: tab.disk === 'deleted',
  }));
});
</script>

<template>
  <div class="pane">
    <editor-tab-bar
      v-if="ws.state.tabs.length"
      :tabs="tabItems"
      :active="ws.state.active"
      @select="(p: string) => (ws.state.active = p)"
      @close="(p: string) => emit('close', p)"
    >
      <template v-if="statementLang && !ws.activeTab.value?.path.endsWith('/tutorial.tex')" #actions>
        <n-button size="tiny" quaternary @click="emit('convertStatement', statementLang, wholeStatement ? 'sections' : 'whole')">{{ t(wholeStatement ? 'statementMode.toSections' : 'statementMode.toWhole') }}</n-button>
      </template>
    </editor-tab-bar>

    <template v-if="ws.activeTab.value">
      <n-alert v-if="ws.activeTab.value.disk === 'changed'" type="warning" :show-icon="false" class="banner">
        <n-space align="center" justify="space-between">
          <span>{{ t('editor.changedOnDisk') }}</span>
          <n-space size="small">
            <n-button size="tiny" @click="emit('showDiff', ws.activeTab.value.path)">{{ t('editor.showDiff') }}</n-button>
            <n-button size="tiny" @click="ws.reloadFromDisk(ws.activeTab.value.path)">{{ t('editor.useDisk') }}</n-button>
          </n-space>
        </n-space>
      </n-alert>
      <n-alert v-else-if="ws.activeTab.value.disk === 'deleted'" type="error" :show-icon="false" class="banner">
        {{ t('editor.deletedOnDisk') }}
      </n-alert>
      <n-alert v-if="ws.activeTab.value.binary" type="info" :show-icon="false" class="banner">{{ t('editor.binary') }}</n-alert>
      <n-alert v-else-if="ws.activeTab.value.truncated" type="info" :show-icon="false" class="banner">{{ t('editor.truncated') }}</n-alert>
      <n-alert v-else-if="ws.activeTab.value.path.startsWith('@shared/')" type="info" :show-icon="false" class="banner">
        {{ t('editor.sharedReadOnly') }}
      </n-alert>
    </template>

    <div v-show="ws.activeTab.value" class="body">
      <div ref="host" class="host" />
      <div v-if="previewable && showPreview" ref="previewHost" class="preview" @scroll="scrollPreview">
        <statement-preview
          v-if="statementLang"
          :ws="ws"
          :judge="judge"
          :problem-id="problemId"
          :lang="statementLang"
          :mode="ws.activeTab.value?.path.endsWith('/tutorial.tex') ? 'tutorial' : 'statement'"
          @create-tutorial="(lang: string) => emit('action', { kind: 'createTutorials', langs: [lang] })"
        />
        <file-preview v-else-if="ws.activeTab.value" :tab="ws.activeTab.value" :problem-id="problemId" />
      </div>
      <div v-if="previewable" class="preview-toggle">
        <n-button size="tiny" :type="syncScroll ? 'primary' : 'default'" @click="syncScroll = !syncScroll">{{ t('fix.syncScroll') }}</n-button>
        <n-button size="tiny" secondary @click="emit('lint')">{{ t('toolbar.lint') }}</n-button>
        <n-button size="tiny" secondary @click="showPreview = !showPreview">
          {{ showPreview ? t('preview.hide') : t('preview.show') }}
        </n-button>
      </div>
    </div>
    <div v-if="!ws.activeTab.value" class="empty">
      <n-empty :description="t('editor.noFile')">
        <template #extra><span class="hint">Ctrl+P {{ t('editor.quickOpen') }} · Ctrl+S {{ t('common.save') }}</span></template>
      </n-empty>
    </div>
  </div>
</template>

<style scoped>
.pane {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.banner {
  border-radius: 0;
  flex-shrink: 0;
  padding: 2px 4px;
}
.body {
  flex: 1;
  min-height: 0;
  display: flex;
  position: relative;
}
.body .host {
  flex: 1;
  min-width: 0;
}
.preview {
  flex: 1;
  min-width: 0;
  overflow: auto;
  border-left: 1px solid rgba(128, 128, 128, 0.25);
}
.preview-toggle {
  position: absolute;
  right: 18px;
  bottom: 10px;
  z-index: 5;
  display: flex;
  gap: 6px;
}
.host {
  flex: 1;
  min-height: 0;
}
.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.hint {
  font-size: 12px;
  opacity: 0.6;
}
</style>
