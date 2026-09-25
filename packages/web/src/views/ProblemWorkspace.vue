<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { onBeforeRouteLeave, useRouter } from 'vue-router';
import { NButton, NInput, NModal, NResult, NScrollbar, NSpace, NSpin, NSplit, NTabPane, NTabs, NTooltip, useDialog, useMessage } from 'naive-ui';
import { isSourceFile } from '@polyforge/shared';
import AppHeader from '../components/AppHeader.vue';
import DiffDialog from '../components/DiffDialog.vue';
import EditorPane from '../components/EditorPane.vue';
import FileSidebar, { type SidebarAction } from '../components/FileSidebar.vue';
import InfoPanel from '../components/InfoPanel.vue';
import InvocationDrawer from '../components/InvocationDrawer.vue';
import QuickOpen from '../components/QuickOpen.vue';
import RunPanel from '../components/RunPanel.vue';
import SelfTestPanel from '../components/SelfTestPanel.vue';
import TestsPanel from '../components/TestsPanel.vue';
import { api, errorMessage } from '../lib/api';
import { problemTitle } from '../lib/format';
import { useJudge } from '../lib/judge';
import { registerLatexMacros } from '../lib/latexEditor';
import { onWs } from '../lib/ws';
import { SHARED_TAB, useWorkspace } from '../lib/workspace';

const props = defineProps<{ id: string }>();
const { t, locale } = useI18n();
const router = useRouter();
const message = useMessage();
const dialog = useDialog();

const ws = useWorkspace(props.id);
const judge = useJudge(props.id, ws);
const summary = computed(() => ws.state.detail?.summary);

// ---- right panel / judge actions ----
const rightTab = ref<'info' | 'tests' | 'run' | 'selftest'>('info');
const runPanel = ref<InstanceType<typeof RunPanel>>();
const showInvocation = ref(false);

async function generate() {
  rightTab.value = 'tests';
  try {
    await judge.generate();
  } catch (e) {
    message.error(errorMessage(e));
  }
}

function runCurrent() {
  rightTab.value = 'run';
  // The panel may mount on this tick; wait for it.
  setTimeout(() => runPanel.value?.run(), 0);
}

function runOnTest(n: number) {
  rightTab.value = 'run';
  setTimeout(() => runPanel.value?.runOnTest(n), 0);
}

watch(() => ws.state.active, (p) => p && judge.refreshMarkers(p));

// ---- save / conflicts ----
const diff = ref({ show: false, path: '', disk: null as string | null, mine: '' });

async function save(path: string) {
  try {
    const r = await ws.save(path);
    if (r === 'conflict') await showDiff(path);
    else if (r === 'readonly') message.warning(t('editor.readOnly'));
    // Ctrl+S also compiles in the background; errors show as squiggles (DESIGN §6.1).
    else if (isSourceFile(path) && ws.languageFor(path)) judge.build(path).catch(() => {});
  } catch (e) {
    message.error(errorMessage(e));
  }
}

async function showDiff(path: string) {
  const tab = ws.state.tabs.find((x) => x.path === path);
  if (!tab) return;
  diff.value = { show: true, path, disk: null, mine: tab.model.getValue() };
  try {
    diff.value.disk = (await api.readFile(props.id, path)).content;
  } catch {
    diff.value.disk = '';
  }
}

async function keepMine() {
  const path = diff.value.path;
  diff.value.show = false;
  try {
    await ws.save(path, true);
    message.success(t('common.saved'));
  } catch (e) {
    message.error(errorMessage(e));
  }
}

async function useDisk() {
  diff.value.show = false;
  await ws.reloadFromDisk(diff.value.path);
}

function closeTab(path: string) {
  const tab = ws.state.tabs.find((x) => x.path === path);
  if (!tab?.dirty) return ws.closeTab(path);
  dialog.warning({
    title: t('editor.unsavedTitle'),
    content: t('editor.unsavedClose', { name: path.split('/').pop() }),
    positiveText: t('common.save'),
    negativeText: t('editor.discard'),
    onPositiveClick: async () => {
      const r = await ws.save(path);
      if (r === 'ok') ws.closeTab(path);
      else if (r === 'conflict') await showDiff(path);
    },
    onNegativeClick: () => ws.closeTab(path),
  });
}

// ---- prompt (new file / rename) ----
const prompt = ref({ show: false, title: '', value: '', resolve: (_v: string | null) => {} });
function ask(title: string, value: string): Promise<string | null> {
  return new Promise((resolve) => (prompt.value = { show: true, title, value, resolve }));
}
function finishPrompt(ok: boolean) {
  const v = prompt.value.value.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  prompt.value.show = false;
  prompt.value.resolve(ok && v ? v : null);
}

async function onAction(a: SidebarAction) {
  try {
    switch (a.kind) {
      case 'newFile': {
        const p = await ask(t('tree.newFile'), a.dir);
        if (p) await ws.createFile(p);
        break;
      }
      case 'newDir': {
        const p = await ask(t('tree.newDir'), a.dir);
        if (p) await ws.createDir(p);
        break;
      }
      case 'rename': {
        const p = await ask(t('tree.rename'), a.path);
        if (p && p !== a.path) await ws.rename(a.path, p);
        break;
      }
      case 'delete':
        dialog.error({
          title: t('tree.delete'),
          content: t('tree.confirmDelete', { path: a.path }),
          positiveText: t('tree.delete'),
          negativeText: t('common.cancel'),
          onPositiveClick: () => ws.remove(a.path).catch((e) => message.error(errorMessage(e))),
        });
        break;
      case 'copyPath':
        await navigator.clipboard.writeText(summary.value ? `${summary.value.dir}\\${a.path.replace(/\//g, '\\')}` : a.path);
        message.success(t('tree.copied'));
        break;
      case 'copyStd': {
        const to = await ask(t('tree.copyStd'), 'checker.cpp');
        if (!to) break;
        await ws.copyShared(a.ref, to);
        await ws.patch({ checker: to });
        const shared = ws.state.tabs.find((x) => x.path.startsWith(SHARED_TAB));
        if (shared) ws.closeTab(shared.path);
        await ws.openFile(to);
        break;
      }
      case 'patch':
        await ws.patch(a.req);
        break;
    }
  } catch (e) {
    message.error(e instanceof Error && e.message === 'dirty' ? t('tree.saveFirst') : errorMessage(e));
  }
}

// ---- shortcuts ----
const quickOpen = ref(false);
const allFiles = computed(() => ws.files.value.map((f) => f.path));

function onKeydown(e: KeyboardEvent) {
  if (e.defaultPrevented || !(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === 's') {
    e.preventDefault();
    if (ws.state.active) save(ws.state.active);
  } else if (k === 'p') {
    e.preventDefault();
    quickOpen.value = true;
  } else if (k === 'enter') {
    e.preventDefault();
    runCurrent();
  } else if (k === 'g' && e.shiftKey) {
    e.preventDefault();
    generate();
  }
}

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (ws.hasDirty.value) e.preventDefault();
}

onBeforeRouteLeave(() => {
  if (!ws.hasDirty.value) return true;
  return new Promise<boolean>((resolve) => {
    dialog.warning({
      title: t('editor.unsavedTitle'),
      content: t('editor.unsavedLeave'),
      positiveText: t('editor.discard'),
      negativeText: t('common.cancel'),
      onPositiveClick: () => resolve(true),
      onNegativeClick: () => resolve(false),
      onClose: () => resolve(false),
    });
  });
});

const offWs = onWs((e) => {
  void ws.onWsEvent(e);
  judge.onWsEvent(e);
});
onMounted(async () => {
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('beforeunload', onBeforeUnload);
  registerLatexMacros();
  await Promise.all([ws.init(), judge.init()]);
  // Open the most useful file first.
  const cfg = ws.state.detail?.config;
  const first = ['statement/zh/legend.tex', 'statement/en/legend.tex', cfg?.validator?.source, 'problem.toml'].find(
    (p) => p && ws.files.value.some((f) => f.path === p),
  );
  if (first) ws.openFile(first).catch(() => {});
});
onBeforeUnmount(() => {
  offWs();
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('beforeunload', onBeforeUnload);
  ws.dispose();
});

const soon = [
  { key: 'sync', milestone: 'M3' },
  { key: 'ai', milestone: 'M4' },
];
</script>

<template>
  <div class="page">
    <app-header>
      <template #left>
        <n-button size="small" quaternary @click="router.push({ name: 'problems' })">◀ {{ t('nav.problems') }}</n-button>
      </template>
      <template v-if="summary">
        <strong class="title">{{ problemTitle(summary.title, locale) || summary.name }}</strong>
        <span class="mono dim">{{ summary.id }}</span>
        <span class="dim">{{ summary.timeLimit / 1000 }}s / {{ summary.memoryLimit }}MB</span>
      </template>
      <template #right>
        <n-tooltip>
          <template #trigger>
            <n-button size="small" :loading="judge.running('generate')" @click="generate">{{ t('toolbar.generate') }}</n-button>
          </template>
          Ctrl+Shift+G
        </n-tooltip>
        <n-button size="small" :loading="judge.running('invocation')" @click="showInvocation = true">{{ t('toolbar.invocation') }}</n-button>
        <n-tooltip v-for="b in soon" :key="b.key">
          <template #trigger>
            <n-button size="small" disabled>{{ t(`toolbar.${b.key}`) }}</n-button>
          </template>
          {{ t('toolbar.comingIn', { m: b.milestone }) }}
        </n-tooltip>
      </template>
    </app-header>

    <div v-if="ws.state.loadError && !ws.state.detail" class="center">
      <n-result status="404" :title="t('workspace.notFound')" :description="ws.state.loadError">
        <template #footer>
          <n-button @click="router.push({ name: 'problems' })">{{ t('nav.problems') }}</n-button>
        </template>
      </n-result>
    </div>
    <div v-else-if="!ws.state.detail" class="center"><n-spin /></div>
    <n-split v-else direction="horizontal" :default-size="0.17" :min="0.1" :max="0.4" class="split">
      <template #1>
        <file-sidebar :ws="ws" @action="onAction" />
      </template>
      <template #2>
        <n-split direction="horizontal" :default-size="0.76" :min="0.4" :max="0.9" class="split">
          <template #1>
            <editor-pane
              :ws="ws"
              :judge="judge"
              :problem-id="id"
              @save="save"
              @close="closeTab"
              @quick-open="quickOpen = true"
              @show-diff="showDiff"
              @run="runCurrent"
              @generate="generate"
            />
          </template>
          <template #2>
            <n-tabs v-model:value="rightTab" type="line" size="small" class="right-tabs" pane-class="right-pane">
              <n-tab-pane name="info" :tab="t('panel.info')">
                <info-panel :ws="ws" :judge="judge" />
              </n-tab-pane>
              <n-tab-pane name="tests" :tab="t('panel.tests')">
                <n-scrollbar style="height: 100%"><tests-panel :ws="ws" :judge="judge" :problem-id="id" @run-on-test="runOnTest" /></n-scrollbar>
              </n-tab-pane>
              <n-tab-pane name="run" :tab="t('panel.run')" display-directive="show">
                <n-scrollbar style="height: 100%"><run-panel ref="runPanel" :ws="ws" :judge="judge" :problem-id="id" /></n-scrollbar>
              </n-tab-pane>
              <n-tab-pane name="selftest" :tab="t('panel.selftest')">
                <n-scrollbar style="height: 100%"><self-test-panel :ws="ws" :judge="judge" /></n-scrollbar>
              </n-tab-pane>
            </n-tabs>
          </template>
        </n-split>
      </template>
    </n-split>

    <quick-open v-model:show="quickOpen" :files="allFiles" @open="(p: string) => ws.openFile(p)" />
    <invocation-drawer v-model:show="showInvocation" :ws="ws" :judge="judge" :problem-id="id" />
    <diff-dialog v-model:show="diff.show" :path="diff.path" :disk="diff.disk" :mine="diff.mine" @keep-mine="keepMine" @use-disk="useDisk" />

    <n-modal v-model:show="prompt.show" preset="card" :title="prompt.title" style="width: 480px" @after-leave="prompt.resolve(null)">
      <n-input v-model:value="prompt.value" class="mono" autofocus @keyup.enter="finishPrompt(true)" />
      <template #footer>
        <n-space justify="end">
          <n-button @click="finishPrompt(false)">{{ t('common.cancel') }}</n-button>
          <n-button type="primary" @click="finishPrompt(true)">{{ t('common.ok') }}</n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.page {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.split {
  flex: 1;
  min-height: 0;
}
.right-tabs {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.right-tabs :deep(.n-tabs-nav) {
  padding: 0 8px;
}
.right-tabs :deep(.right-pane) {
  flex: 1;
  min-height: 0;
  padding: 0;
}
.center {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.title {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dim {
  opacity: 0.6;
  font-size: 12px;
  white-space: nowrap;
}
</style>
