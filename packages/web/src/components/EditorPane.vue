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
import { isSourceFile } from '@polyforge/shared';
import { Lock, X } from 'lucide-vue-next';
import type { SidebarAction } from './FileSidebar.vue';

const props = defineProps<{ ws: Workspace; judge: Judge; problemId: string }>();
const emit = defineEmits<{ save: [path: string]; close: [path: string]; quickOpen: []; showDiff: [path: string]; run: []; generate: []; action: [SidebarAction]; lint: []; palette: [] }>();

// Statement tabs get a live preview next to the source (DESIGN §6.1).
const statementLang = computed(() => props.ws.activeTab.value?.path.match(/^statement\/([^/]+)\/(legend|input|output|interaction|scoring|notes|tutorial)\.tex$/)?.[1] ?? null);
const previewable = computed(() => /\.(tex|md)$/i.test(props.ws.activeTab.value?.path ?? ''));
const previewHost = ref<HTMLDivElement>();
const syncScroll = ref(true);
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
    wordWrap: ed.word_wrap || !isSourceFile(props.ws.activeTab.value?.path ?? '') ? 'on' : 'off',
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
  editor.onDidScrollChange(() => {
    const p = previewHost.value;
    if (!syncScroll.value || !p || !editor) return;
    const height = editor.getScrollHeight() - editor.getLayoutInfo().height;
    const top = height > 0 ? editor.getScrollTop() / height * (p.scrollHeight - p.clientHeight) : 0;
    if (Math.abs(p.scrollTop - top) > 1) p.scrollTop = top;
  });
  show(props.ws.activeTab.value);
});

function scrollPreview() {
  const p = previewHost.value;
  if (!syncScroll.value || !p || !editor) return;
  const height = p.scrollHeight - p.clientHeight;
  const top = height > 0 ? p.scrollTop / height * (editor.getScrollHeight() - editor.getLayoutInfo().height) : 0;
  if (Math.abs(editor.getScrollTop() - top) > 1) editor.setScrollTop(top);
}

function show(tab: Tab | null) {
  if (!editor) return;
  if (current && current !== tab && !current.model.isDisposed()) current.viewState = editor.saveViewState();
  current = tab;
  editor.setModel(tab && !tab.model.isDisposed() ? tab.model : null);
  if (tab) {
    editor.updateOptions({ ...editorOptions(), readOnly: tab.readOnly });
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

/**
 * Tabs with the same name (statement/zh/input.tex, statement/en/input.tex) get the
 * shortest part of their folder that tells them apart, as a dim hint: "zh", "en".
 */
const hints = computed(() => {
  const out = new Map<string, string>();
  const groups = new Map<string, string[]>();
  for (const t of props.ws.state.tabs) {
    const name = label(t.path) ?? t.path;
    groups.set(name, [...(groups.get(name) ?? []), t.path]);
  }
  for (const paths of groups.values()) {
    if (paths.length < 2) continue;
    const dirs = paths.map((p) => p.split('/').slice(0, -1));
    const max = Math.max(...dirs.map((d) => d.length));
    for (let depth = 1; depth <= max; depth++) {
      const tails = dirs.map((d) => d.slice(-depth).join('/'));
      if (new Set(tails).size === tails.length || depth === max) {
        paths.forEach((p, i) => out.set(p, tails[i] || '/'));
        break;
      }
    }
  }
  return out;
});

function onTabAuxClick(e: MouseEvent, path: string) {
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
        @mousedown.middle.prevent
        @auxclick="onTabAuxClick($event, tab.path)"
      >
        <span class="name" :class="{ gone: tab.disk === 'deleted' }">{{ label(tab.path) }}</span>
        <span v-if="hints.get(tab.path)" class="hint">{{ hints.get(tab.path) }}</span>
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
.tabs {
  display: flex;
  overflow-x: auto;
  flex-shrink: 0;
  border-bottom: 1px solid var(--pf-border);
  background: var(--pf-toolbar-bg);
  padding: 5px 6px 0;
  gap: 3px;
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
  border-radius: 7px 7px 0 0;
  opacity: 0.7;
  user-select: none;
}
.tab.active {
  opacity: 1;
  background: var(--pf-selected);
  box-shadow: inset 0 -2px 0 var(--pf-accent);
}
.tab:hover { background: var(--pf-selected); opacity: 1; }
.name.gone {
  text-decoration: line-through;
}
.hint {
  margin-left: 4px;
  font-size: 11px;
  opacity: 0.55;
}
.ro {
  opacity: 0.6;
}
.close {
  border: 0;
  padding: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
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
