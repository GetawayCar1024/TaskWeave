<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NAlert, NButton, NEmpty, NSpace } from 'naive-ui';
import type { Judge } from '../lib/judge';
import { monaco } from '../lib/monaco';
import { settings } from '../lib/settings';
import { SHARED_TAB, type Tab, type Workspace } from '../lib/workspace';
import StatementPreview from './StatementPreview.vue';
import { Lock, X } from 'lucide-vue-next';
import type { SidebarAction } from './FileSidebar.vue';

const props = defineProps<{ ws: Workspace; judge: Judge; problemId: string }>();
const emit = defineEmits<{ save: [path: string]; close: [path: string]; quickOpen: []; showDiff: [path: string]; run: []; generate: []; action: [SidebarAction]; lint: []; palette: [] }>();

// Statement tabs get a live preview next to the source (DESIGN §6.1).
const statementLang = computed(() => props.ws.activeTab.value?.path.match(/^statement\/([^/]+)\/[^/]+\.tex$/)?.[1] ?? null);
const showPreview = ref(localStorage.getItem('polyforge-preview') !== 'off');
watch(showPreview, (v) => localStorage.setItem('polyforge-preview', v ? 'on' : 'off'));
const { t } = useI18n();

const host = ref<HTMLDivElement>();
let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let current: Tab | null = null;

function editorOptions(): monaco.editor.IEditorOptions & monaco.editor.IGlobalEditorOptions {
  const ed = settings.config!.editor;
  return {
    fontSize: ed.font_size,
    tabSize: ed.tab_size,
    wordWrap: ed.word_wrap ? 'on' : 'off',
    minimap: { enabled: ed.minimap },
    theme: settings.config!.ui.theme === 'light' ? 'vs' : 'vs-dark',
  };
}

onMounted(() => {
  editor = monaco.editor.create(host.value!, {
    model: null,
    automaticLayout: true,
    scrollBeyondLastLine: false,
    fontFamily: "Consolas, 'Cascadia Code', 'Courier New', monospace",
    renderWhitespace: 'selection',
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
  show(props.ws.activeTab.value);
});

function show(tab: Tab | null) {
  if (!editor) return;
  if (current && current !== tab && !current.model.isDisposed()) current.viewState = editor.saveViewState();
  current = tab;
  editor.setModel(tab && !tab.model.isDisposed() ? tab.model : null);
  if (tab) {
    editor.updateOptions({ readOnly: tab.readOnly });
    if (tab.viewState) editor.restoreViewState(tab.viewState);
    editor.focus();
  }
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

function onTabMouse(e: MouseEvent, path: string) {
  if (e.button === 1) {
    e.preventDefault();
    emit('close', path);
  }
}
</script>

<template>
  <div class="pane">
    <div class="tabs" v-if="ws.state.tabs.length">
      <div
        v-for="tab in ws.state.tabs"
        :key="tab.path"
        class="tab"
        :class="{ active: tab.path === ws.state.active }"
        :title="tab.path"
        @click="ws.state.active = tab.path"
        @mousedown="onTabMouse($event, tab.path)"
      >
        <span class="name" :class="{ gone: tab.disk === 'deleted' }">{{ label(tab.path) }}</span>
        <lock v-if="tab.readOnly" :size="11" class="ro" />
        <span class="close" :class="{ dirty: tab.dirty }" @click.stop="emit('close', tab.path)">
          <span class="dot" /><x class="x" :size="12" />
        </span>
      </div>
    </div>

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
      <div v-if="statementLang && showPreview" class="preview">
        <statement-preview
          :ws="ws"
          :judge="judge"
          :problem-id="problemId"
          :lang="statementLang"
          :mode="ws.activeTab.value?.path.endsWith('/tutorial.tex') ? 'tutorial' : 'statement'"
          @create-tutorial="(lang: string) => emit('action', { kind: 'createTutorials', langs: [lang] })"
        />
      </div>
      <div v-if="statementLang" class="preview-toggle">
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
.tabs {
  display: flex;
  overflow-x: auto;
  flex-shrink: 0;
  border-bottom: 1px solid rgba(128, 128, 128, 0.25);
  scrollbar-width: thin;
}
.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px 6px 12px;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
  border-right: 1px solid rgba(128, 128, 128, 0.15);
  opacity: 0.7;
  user-select: none;
}
.tab.active {
  opacity: 1;
  background: rgba(128, 128, 128, 0.14);
  box-shadow: inset 0 -2px 0 #63e2b7;
}
.name.gone {
  text-decoration: line-through;
}
.ro {
  opacity: 0.6;
}
.close {
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
}
.close .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}
.close:hover {
  background: rgba(128, 128, 128, 0.3);
}
.close .dot {
  display: none;
}
.close.dirty .dot {
  display: inline-block;
}
.close.dirty .x {
  display: none;
}
.close.dirty:hover .dot {
  display: none;
}
.close.dirty:hover .x {
  display: inline-block;
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
