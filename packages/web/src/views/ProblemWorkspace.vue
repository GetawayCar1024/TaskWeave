<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { onBeforeRouteLeave, useRouter } from 'vue-router';
import { NButton, NDropdown, NInput, NModal, NResult, NScrollbar, NSpace, NSpin, NSplit, NTabPane, NTabs, NTooltip, useDialog, useMessage } from 'naive-ui';
import { isSourceFile, statementLanguages } from '@polyforge/shared';
import AppHeader from '../components/AppHeader.vue';
import DiffDialog from '../components/DiffDialog.vue';
import EditorPane from '../components/EditorPane.vue';
import FileSidebar, { type SidebarAction } from '../components/FileSidebar.vue';
import InfoPanel from '../components/InfoPanel.vue';
import InvocationDrawer from '../components/InvocationDrawer.vue';
import SyncDialog from '../components/SyncDialog.vue';
import AiDrawer from '../components/AiDrawer.vue';
import CommandPalette, { type Command } from '../components/CommandPalette.vue';
import LintDialog from '../components/LintDialog.vue';
import ShortcutsDialog from '../components/ShortcutsDialog.vue';
import StatusBar from '../components/StatusBar.vue';
import StressDialog from '../components/StressDialog.vue';
import { waitJob } from '../lib/jobs';
import { ArrowLeft, ChevronDown, Command as CommandIcon } from 'lucide-vue-next';
import { patchSettings } from '../lib/settings';
import type { PackageResult } from '../lib/types';
import { useAi } from '../lib/ai';
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
const ai = useAi(props.id);
const showAi = ref(false);
const summary = computed(() => ws.state.detail?.summary);

// ---- right panel / judge actions ----
const rightTab = ref<'info' | 'tests' | 'run' | 'selftest'>('info');
const runPanel = ref<InstanceType<typeof RunPanel>>();
const showInvocation = ref(false);
const showSync = ref(false);
const showLint = ref(false);
const showStress = ref(false);
const showPalette = ref(false);
const showShortcuts = ref(false);
const exporting = ref(false);

async function exportPackage() {
  exporting.value = true;
  try {
    const done = await waitJob(await api.exportPackage(props.id));
    if (done.status !== 'done') throw new Error(done.error ?? done.status);
    const r = done.result as PackageResult;
    await api.downloadExport(props.id, r.file);
    message.success(t('export.done', { file: r.file, n: r.tests }));
    if (r.warnings.length) message.warning(r.warnings.slice(0, 5).join('\n'), { duration: 8000 });
  } catch (e) {
    message.error(errorMessage(e));
  } finally {
    exporting.value = false;
  }
}

const aiDrawer = ref<InstanceType<typeof AiDrawer>>();
function openAiReview() {
  showAi.value = true;
  aiDrawer.value?.openTab('review');
}

const moreOptions = computed(() => [
  { key: 'lint', label: `${t('toolbar.lint')}  (Ctrl+Shift+L)` },
  { key: 'export', label: t('toolbar.export'), disabled: exporting.value },
  { key: 'selftest', label: t('panel.selftest') },
  { type: 'divider', key: 'd1' },
  { key: 'palette', label: `${t('palette.title')}  (Ctrl+K)` },
  { key: 'shortcuts', label: `${t('shortcuts.title')}  (Ctrl+/)` },
]);

function onMore(key: string) {
  if (key === 'lint') showLint.value = true;
  else if (key === 'export') exportPackage();
  else if (key === 'selftest') rightTab.value = 'selftest';
  else if (key === 'palette') showPalette.value = true;
  else if (key === 'shortcuts') showShortcuts.value = true;
}

const commands = computed<Command[]>(() => {
  const g = { judge: t('palette.gJudge'), sync: 'Polygon', ai: 'AI', file: t('palette.gFile'), view: t('palette.gView') };
  const missingTutorials = ws.state.detail ? statementLanguages(ws.files.value).missingTutorial : [];
  return [
    { id: 'generate', label: t('toolbar.generate'), shortcut: 'Ctrl+Shift+G', group: g.judge, run: generate },
    { id: 'invocation', label: t('toolbar.invocation'), group: g.judge, run: () => void (showInvocation.value = true) },
    { id: 'stress', label: t('toolbar.stress'), group: g.judge, run: () => void (showStress.value = true) },
    { id: 'run', label: t('run.run'), shortcut: 'Ctrl+Enter', group: g.judge, run: runCurrent },
    { id: 'selftest', label: t('panel.selftest'), group: g.judge, run: () => void (rightTab.value = 'selftest') },
    { id: 'tests', label: t('panel.tests'), group: g.view, run: () => void (rightTab.value = 'tests') },
    { id: 'sync', label: t('sync.title'), shortcut: 'Ctrl+Shift+U', group: g.sync, run: () => void (showSync.value = true) },
    { id: 'export', label: t('toolbar.export'), group: g.sync, run: exportPackage },
    { id: 'ai', label: t('palette.aiChat'), group: g.ai, run: () => void (showAi.value = true) },
    { id: 'ai-review', label: t('palette.aiReview'), group: g.ai, run: openAiReview },
    { id: 'lint', label: t('toolbar.lint'), shortcut: 'Ctrl+Shift+L', group: g.file, run: () => void (showLint.value = true) },
    {
      id: 'tutorials',
      label: t('tree.createTutorials'),
      group: g.file,
      disabled: !missingTutorials.length,
      run: () => onAction({ kind: 'createTutorials', langs: missingTutorials }),
    },
    { id: 'open-config', label: t('palette.openConfig'), group: g.file, run: () => ws.openFile('problem.toml') },
    { id: 'new-file', label: t('tree.newFile'), group: g.file, run: () => onAction({ kind: 'newFile', dir: '' }) },
    { id: 'quick-open', label: t('editor.quickOpen'), shortcut: 'Ctrl+P', group: g.file, run: () => void (quickOpen.value = true) },
    {
      id: 'theme',
      label: t('palette.toggleTheme'),
      group: g.view,
      run: () => patchSettings((c) => (c.ui.theme = c.ui.theme === 'light' ? 'dark' : 'light')),
    },
    {
      id: 'locale',
      label: t('palette.toggleLocale'),
      group: g.view,
      run: () => patchSettings((c) => (c.ui.locale = c.ui.locale === 'en' ? 'zh-CN' : 'en')),
    },
    { id: 'shortcuts', label: t('shortcuts.title'), shortcut: 'Ctrl+/', group: g.view, run: () => void (showShortcuts.value = true) },
    { id: 'problems', label: t('nav.problems'), group: g.view, run: () => void router.push({ name: 'problems' }) },
    { id: 'settings', label: t('nav.settings'), group: g.view, run: () => void router.push({ name: 'settings' }) },
  ];
});

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
      case 'createTutorials': {
        // One tutorial per statement language; existing files are only opened.
        let first: string | null = null;
        for (const lang of a.langs) {
          const p = `statement/${lang}/tutorial.tex`;
          if (!ws.files.value.some((f) => f.path === p)) await ws.createFile(p, '');
          first ??= p;
        }
        if (first) await ws.openFile(first);
        break;
      }
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
  } else if (k === 'k') {
    e.preventDefault();
    showPalette.value = true;
  } else if (k === '/') {
    e.preventDefault();
    showShortcuts.value = true;
  } else if (k === 'l' && e.shiftKey) {
    e.preventDefault();
    showLint.value = true;
  } else if (k === 'u' && e.shiftKey) {
    e.preventDefault();
    showSync.value = true;
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
  ai.onWsEvent(e);
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

</script>

<template>
  <div class="page">
    <app-header>
      <template #left>
        <n-button size="small" quaternary @click="router.push({ name: 'problems' })"><template #icon><arrow-left /></template>{{ t('nav.problems') }}</n-button>
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
        <n-button size="small" :loading="judge.running('stress')" @click="showStress = true">{{ t('toolbar.stress') }}</n-button>
        <n-tooltip>
          <template #trigger>
            <n-button size="small" @click="showSync = true">{{ t('toolbar.sync') }}</n-button>
          </template>
          Ctrl+Shift+U
        </n-tooltip>
        <n-button size="small" :type="ai.running.value ? 'primary' : 'default'" @click="showAi = true">
          AI<template v-if="ai.state.changes.length"> · {{ ai.state.changes.length }}</template>
        </n-button>
        <n-dropdown trigger="click" :options="moreOptions" @select="onMore">
          <n-button size="small" :loading="exporting" icon-placement="right"><template #icon><chevron-down /></template>{{ t('toolbar.more') }}</n-button>
        </n-dropdown>
        <n-tooltip>
          <template #trigger>
            <n-button size="small" quaternary @click="showPalette = true"><command-icon :size="15" /></n-button>
          </template>
          {{ t('palette.title') }} (Ctrl+K)
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
              @action="onAction"
              @lint="showLint = true"
              @palette="showPalette = true"
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

    <status-bar
      v-if="ws.state.detail"
      :ws="ws"
      :judge="judge"
      :ai="ai"
      @open="(w) => (w === 'sync' ? (showSync = true) : w === 'ai' ? (showAi = true) : (rightTab = 'tests'))"
    />
    <quick-open v-model:show="quickOpen" :files="allFiles" @open="(p: string) => ws.openFile(p)" />
    <command-palette v-model:show="showPalette" :commands="commands" />
    <shortcuts-dialog v-model:show="showShortcuts" />
    <lint-dialog v-model:show="showLint" :ws="ws" :problem-id="id" />
    <stress-dialog v-model:show="showStress" :ws="ws" :problem-id="id" />
    <invocation-drawer v-model:show="showInvocation" :ws="ws" :judge="judge" :problem-id="id" />
    <sync-dialog v-model:show="showSync" :ws="ws" :problem-id="id" />
    <ai-drawer ref="aiDrawer" v-model:show="showAi" :ai="ai" :problem-id="id" :ws="ws" />
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
