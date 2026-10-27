<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { registerExitGuard, exitApproved } from '../lib/exitGuards';
import { unsavedChoice } from '../lib/confirmUnsaved';
import { useI18n } from 'vue-i18n';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import { NAlert, NButton, NDropdown, NInput, NResult, NSelect, NScrollbar, NSpin, NSplit, NTabPane, NTabs, NTooltip, useDialog, useMessage } from 'naive-ui';
import { isSourceFile, statementLanguages } from '@polyforge/shared';
import DirPicker from '../components/DirPicker.vue';
import { loadSettings } from '../lib/settings';
import AppHeader from '../components/AppHeader.vue';
import DiffDialog from '../components/DiffDialog.vue';
import EditorPane from '../components/EditorPane.vue';
import FileSidebar, { type SidebarAction } from '../components/FileSidebar.vue';
import InfoPanel from '../components/InfoPanel.vue';
import FreeSelect from '../components/FreeSelect.vue';
import InvocationWindow from '../components/InvocationWindow.vue';
import { vKeepScroll } from '../lib/keepScroll';
import SyncDialog from '../components/SyncDialog.vue';
import AiDrawer from '../components/AiDrawer.vue';
import CommandPalette, { type Command } from '../components/CommandPalette.vue';
import LintDialog from '../components/LintDialog.vue';
import ShortcutsDialog from '../components/ShortcutsDialog.vue';
import StatusBar from '../components/StatusBar.vue';
import StressDialog from '../components/StressDialog.vue';
import { confirmDeleteProblem } from '../lib/deleteProblem';
import { ArrowLeft, ChevronDown, Command as CommandIcon, Trash2 } from 'lucide-vue-next';
import { patchSettings } from '../lib/settings';
import { useAi } from '../lib/ai';
import QuickOpen from '../components/QuickOpen.vue';
import RunPanel from '../components/RunPanel.vue';
import SelfTestPanel from '../components/SelfTestPanel.vue';
import TestsPanel from '../components/TestsPanel.vue';
import ToolWindow from '../components/ToolWindow.vue';
import PackageImportDialog from '../components/PackageImportDialog.vue';
import ProblemExportDialog from '../components/ProblemExportDialog.vue';
import { api, errorMessage } from '../lib/api';
import { problemTitle } from '../lib/format';
import { useJudge } from '../lib/judge';
import { registerLatexMacros } from '../lib/latexEditor';
import { onWs } from '../lib/ws';
import { SHARED_TAB, useWorkspace } from '../lib/workspace';
import { desktop } from '../lib/desktop';

const props = defineProps<{ id: string }>();
const { t, locale } = useI18n();
const router = useRouter();
const route = useRoute();
const message = useMessage();
const dialog = useDialog();

/** Opened from a contest page (?from=contest:<id>): the back button returns there. */
const backTo = computed(() => {
  const from = route.query.from;
  return typeof from === 'string' && from.startsWith('contest:') ? from.slice('contest:'.length) : null;
});
function goBack() {
  if (backTo.value) router.push({ name: 'contest', params: { id: backTo.value } });
  else router.push({ name: 'problems' });
}

const ws = useWorkspace(props.id);
registerExitGuard(async () => {
  for (const tab of [...ws.state.tabs]) {
    if (!tab.dirty) continue;
    const choice = await unsavedChoice(dialog, t('editor.unsavedTitle'), tab.path, { save: t('common.save'), discard: t('editor.discard'), cancel: t('improve.cancelExit') });
    if (choice === 'cancel') return false;
    if (choice === 'save') {
      const result = await ws.save(tab.path);
      if (result !== 'ok') { if (result === 'conflict') await showDiff(tab.path); return false; }
    }
  }
  return true;
});
const judge = useJudge(props.id, ws);
const ai = useAi(props.id);
const showAi = computed({ get: () => rightTab.value === 'ai', set: (v: boolean) => { void showTools(v ? 'ai' : 'info'); } });
const summary = computed(() => ws.state.detail?.summary);
const dataOnly = computed(() => !!summary.value?.dataOnly);
const showDataOnlyWarning = ref(true);
const showDataImport = ref(false), showExport = ref(false);
const restrictedCommands = new Set(['invocation', 'stress', 'run', 'selftest', 'sync', 'ai', 'ai-review']);
function openExport() {
  if (!ws.state.detail) return;
  if (ws.hasDirty.value) return message.warning(t('tree.saveFirst'));
  showExport.value = true;
}
function openDataImport() {
  if (ws.hasDirty.value) return message.warning(t('tree.saveFirst'));
  showDataImport.value = true;
}
async function importedData() { await ws.loadDetail(); await judge.loadManifest(); }

async function convertStatement(lang: string, mode: 'whole' | 'sections') {
  if (ws.hasDirty.value) return message.warning(t('tree.saveFirst'));
  const run = async () => {
    try {
      const detail = await api.statementMode(props.id, lang, mode);
      for (const tab of [...ws.state.tabs]) if (tab.path.startsWith(`statement/${lang}/`) && /\/(statement|legend|input|output|interaction|scoring|notes)\.tex$/.test(tab.path)) ws.closeTab(tab.path);
      ws.state.detail = detail;
      await ws.openFile(`statement/${lang}/${mode === 'whole' ? 'statement' : 'legend'}.tex`);
    } catch (e) { message.error(errorMessage(e)); }
  };
  dialog.warning({ title: t(mode === 'whole' ? 'statementMode.toWhole' : 'statementMode.toSections'), content: t(mode === 'whole' ? 'statementMode.lossWarning' : 'statementMode.splitHint'), positiveText: t('common.ok'), negativeText: t('common.cancel'), onPositiveClick: run });
}

// ---- right panel / judge actions ----
const rightTab = ref<'info' | 'tests' | 'run' | 'selftest' | 'ai'>('info');
const infoPanel = ref<InstanceType<typeof InfoPanel>>();
const rightSplitSize = ref(0.76);
async function showTools(tab: typeof rightTab.value): Promise<boolean> {
  if (dataOnly.value && ['run', 'selftest', 'ai'].includes(tab)) return false;
  if (rightTab.value === 'info' && tab !== 'info' && infoPanel.value && !await infoPanel.value.canLeave()) return false;
  rightTab.value = tab;
  return true;
}
const runPanel = ref<InstanceType<typeof RunPanel>>();
const showInvocation = ref(false);
const showSync = ref(false);
/** ?sync=push|pull (from the contest sync): open the sync dialog on that tab. */
const syncTab = ref<'push' | 'pull'>();
const showLint = ref(false);
const showStress = ref(false);
const showPalette = ref(false);
const showShortcuts = ref(false);

const aiDrawer = ref<InstanceType<typeof AiDrawer>>();
function openAiReview() {
  showAi.value = true;
  aiDrawer.value?.openTab('review');
}

const moreOptions = computed(() => [
  { key: 'move', label: t('improve.move') },
  { key: 'clear-cache', label: t('fix.clearCache') },
  { key: 'lint', label: `${t('toolbar.lint')}  (Ctrl+Shift+L)` },
  { key: 'export', label: t('packages.exportProblem'), disabled: !ws.state.detail },
  { key: 'import-data', label: t('packages.importData') },
  { key: 'selftest', label: t('panel.selftest'), disabled: dataOnly.value },
  { type: 'divider', key: 'd1' },
  { key: 'palette', label: `${t('palette.title')}  (Ctrl+K)` },
  { key: 'shortcuts', label: `${t('shortcuts.title')}  (Ctrl+/)` },
]);

const movePicker = ref(false);
async function moveTo(root: string) {
  if (ws.hasDirty.value) return message.warning(t('improve.moveBusy'));
  try { await api.moveProblem(props.id, root); await ws.loadDetail(); await loadSettings(); message.success(t('improve.moveDone')); }
  catch (e) { message.error(errorMessage(e)); }
}
function onMore(key: string) {
  if (key === 'move') { if (ws.hasDirty.value) message.warning(t('improve.moveBusy')); else movePicker.value = true; return; }

  if (key === 'clear-cache') {
    dialog.warning({ title: t('fix.clearCache'), content: t('fix.clearCacheHint'), positiveText: t('common.ok'), negativeText: t('common.cancel'), onPositiveClick: async () => {
      try { await api.clearCache(props.id); await judge.loadManifest(); message.success(t('fix.cacheCleared')); }
      catch (e) { message.error(errorMessage(e)); }
    } });
  }
  if (key === 'lint') showLint.value = true;
  else if (key === 'export') openExport();
  else if (key === 'import-data') openDataImport();
  else if (key === 'selftest') showTools('selftest');
  else if (key === 'palette') showPalette.value = true;
  else if (key === 'shortcuts') showShortcuts.value = true;
}

function deleteProblem() {
  confirmDeleteProblem(dialog, message, props.id).then((ok) => {
    if (ok) goBack();
  });
}

const commands = computed<Command[]>(() => {
  const g = { judge: t('palette.gJudge'), sync: 'Polygon', ai: 'AI', file: t('palette.gFile'), view: t('palette.gView') };
  const missingTutorials = ws.state.detail ? statementLanguages(ws.files.value).missingTutorial : [];
  const items: Command[] = [
    { id: 'generate', label: t('toolbar.generate'), shortcut: 'Ctrl+Shift+G', group: g.judge, run: generate },
    { id: 'invocation', label: t('toolbar.invocation'), group: g.judge, run: () => void (showInvocation.value = true) },
    { id: 'stress', label: t('toolbar.stress'), group: g.judge, run: () => void (showStress.value = true) },
    { id: 'run', label: t('run.run'), shortcut: 'Ctrl+Enter', group: g.judge, run: runCurrent },
    { id: 'selftest', label: t('panel.selftest'), group: g.judge, run: () => void (showTools('selftest')) },
    { id: 'tests', label: t('panel.tests'), group: g.view, run: () => void (showTools('tests')) },
    { id: 'sync', label: t('sync.title'), shortcut: 'Ctrl+Shift+U', group: g.sync, run: () => void (showSync.value = true) },
    { id: 'export', label: t('packages.exportProblem'), group: g.file, run: openExport },
    { id: 'import-data', label: t('packages.importData'), group: g.file, run: openDataImport },
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
  return items.map(c => ({ ...c, disabled: c.disabled || dataOnly.value && restrictedCommands.has(c.id) }));
});

async function generate() {
  if (!await showTools('tests')) return;
  try {
    await judge.generate();
  } catch (e) {
    message.error(errorMessage(e));
  }
}

async function runCurrent() {
  if (dataOnly.value) return;
  if (!await showTools('run')) return;
  // The panel may mount on this tick; wait for it.
  setTimeout(() => runPanel.value?.run(), 0);
}

async function runOnTest(n: number) {
  if (dataOnly.value) return;
  if (!await showTools('run')) return;
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
    else if (!dataOnly.value && isSourceFile(path) && ws.languageFor(path)) judge.build(path).catch(() => {});
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

const languageDialog = ref(false);
const languageCode = ref('');
const languageTutorial = ref(false);
const languageOptions = computed(() => ['zh', 'en', 'ru', 'es', 'fr', 'de', 'ja', 'ko'].map(value => ({ label: value, value })));
async function createLanguage() {
  const lang = languageCode.value.trim().toLowerCase();
  if (!/^[a-z]{2,8}$/.test(lang) || lang === 'images') return;
  const langs = statementLanguages(ws.files.value);
  if ((languageTutorial.value ? langs.tutorial : langs.statement).includes(lang)) return message.warning(t('improve.languageExists'));
  try {
    if (languageTutorial.value) await ws.createFile(`statement/${lang}/tutorial.tex`, '');
    else await ws.createDir(`statement/${lang}`);
    await ws.loadDetail();
    await ws.openFile(`statement/${lang}/${languageTutorial.value ? 'tutorial' : 'legend'}.tex`);
    languageDialog.value = false;
  } catch (e) { message.error(errorMessage(e)); }
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
      case 'newLanguage': { languageTutorial.value = a.tutorial; languageCode.value = ''; languageDialog.value = true; break; }
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
        const checker = a.ref.startsWith('checkers/');
        const lemon = a.ref.startsWith('lemon/checkers/');
        const to = await ask(t('tree.copyStd'), lemon ? 'lemon-checker.cpp' : checker ? 'checker.cpp' : `files/${a.ref}`);
        if (!to) break;
        await ws.copyShared(a.ref, to);
        if (checker) await ws.patch({ checker: to });
        if (lemon) await ws.patch({ lemonChecker: to });
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

/** Files closed in this session, newest last (Ctrl+Shift+T reopens them). */
const closedTabs = ref<string[]>([]);
watch(
  () => ws.state.tabs.map((t) => t.path),
  (now, before) => {
    const gone = (before ?? []).filter((p) => !now.includes(p));
    closedTabs.value = [...closedTabs.value.filter((p) => !now.includes(p) && !gone.includes(p)), ...gone].slice(-30);
  },
);
async function reopenClosed() {
  while (closedTabs.value.length) {
    const path = closedTabs.value[closedTabs.value.length - 1];
    closedTabs.value = closedTabs.value.slice(0, -1);
    // Skip files deleted in the meantime.
    if (!ws.files.value.some((f) => f.path === path) && !path.startsWith(SHARED_TAB)) continue;
    try {
      await ws.openFile(path);
      return;
    } catch {
      /* try the one before */
    }
  }
}

/**
 * Ctrl+W closes the current file, Ctrl+Shift+T reopens the last closed one: desktop app
 * only (in a browser these keys belong to the browser and a page cannot take them).
 */
const wLocked = computed(() => !!desktop && ws.state.tabs.length > 0);
const tLocked = computed(() => !!desktop && closedTabs.value.length > 0);

function onKeydown(e: KeyboardEvent) {
  if (e.defaultPrevented || !(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === 'w' && !e.shiftKey && desktop && showAi.value && (e.target as HTMLElement).closest?.('.ai-sidebar')) {
    e.preventDefault();
  } else if (k === 'w' && !e.shiftKey && wLocked.value && ws.state.active) {
    e.preventDefault();
    closeTab(ws.state.active);
  } else if (k === 'w' && !e.shiftKey && desktop) {
    e.preventDefault();
  } else if (k === 't' && e.shiftKey && tLocked.value) {
    e.preventDefault();
    void reopenClosed();
  } else if (k === 's') {
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
    if (!dataOnly.value) showSync.value = true;
  } else if (k === 'g' && e.shiftKey) {
    e.preventDefault();
    generate();
  }
}

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (exitApproved) return;
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
  const asked = typeof route.query.file === 'string' ? route.query.file : undefined;
  const first = [asked, 'statement/zh/statement.tex', 'statement/en/statement.tex', 'statement/zh/legend.tex', 'statement/en/legend.tex', cfg?.validator?.source, 'problem.toml'].find(
    (p) => p && ws.files.value.some((f) => f.path === p),
  );
  if (!dataOnly.value && (route.query.sync === 'pull' || route.query.sync === 'push')) {
    syncTab.value = route.query.sync;
    showSync.value = true;
  }
  if (first) {
    await ws.openFile(first).catch(() => {});
    const line = Number(route.query.line);
    const ed = ws.editorRef.value;
    if (first === asked && line > 0 && ed) {
      ed.revealLineInCenter(line);
      ed.setPosition({ lineNumber: line, column: 1 });
    }
  }
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
        <n-button size="small" quaternary @click="goBack"><template #icon><arrow-left /></template>{{ backTo ? t('nav.backToContest') : t('nav.problems') }}</n-button>
      </template>
      <template v-if="summary">
        <strong class="title">{{ problemTitle(summary.title, locale) || summary.name }}</strong>
        <span class="mono dim">{{ summary.name }}</span>
        <span class="dim">{{ summary.timeLimit / 1000 }}s / {{ summary.memoryLimit }}MB</span>
      </template>
      <template #right>
        <n-tooltip>
          <template #trigger>
            <n-button size="small" @click="generate"><span v-if="judge.running('generate')" class="pf-run-dot" />{{ t(dataOnly ? 'dataOnly.refresh' : 'toolbar.generate') }}</n-button>
          </template>
          Ctrl+Shift+G
        </n-tooltip>
        <!-- No :loading here: a loading button ignores clicks, and the window must stay reachable while its job runs. -->
        <n-button size="small" :disabled="dataOnly" :type="judge.running('invocation') ? 'primary' : 'default'" :secondary="judge.running('invocation')" @click="showInvocation = true"><span v-if="judge.running('invocation')" class="pf-run-dot" />{{ t('toolbar.invocation') }}</n-button>
        <n-button size="small" :disabled="dataOnly" :type="judge.running('stress') ? 'primary' : 'default'" :secondary="judge.running('stress')" @click="showStress = true"><span v-if="judge.running('stress')" class="pf-run-dot" />{{ t('toolbar.stress') }}</n-button>
        <n-tooltip>
          <template #trigger>
            <n-button size="small" :disabled="dataOnly" @click="showSync = true">{{ t('toolbar.sync') }}</n-button>
          </template>
          Ctrl+Shift+U
        </n-tooltip>
        <n-dropdown trigger="click" :options="moreOptions" @select="onMore">
          <n-button size="small" icon-placement="right"><template #icon><chevron-down /></template>{{ t('toolbar.more') }}</n-button>
        </n-dropdown>
        <n-tooltip>
          <template #trigger>
            <n-button size="small" quaternary @click="showPalette = true"><command-icon :size="15" /></n-button>
          </template>
          {{ t('palette.title') }} (Ctrl+K)
        </n-tooltip>
        <n-button size="small" quaternary :title="t('problem.delete')" @click="deleteProblem"><trash2 :size="15" /></n-button>
      </template>
    </app-header>

    <n-alert v-if="dataOnly && showDataOnlyWarning" closable type="warning" :show-icon="false" class="mode-banner" @close="showDataOnlyWarning = false">{{ t('dataOnly.warning') }}</n-alert>

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
        <file-sidebar v-keep-scroll="`files:${id}`" :ws="ws" @action="onAction" />
      </template>
      <template #2>
        <n-split direction="horizontal" v-model:size="rightSplitSize" :min="0.35" :max="0.9" class="split">
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
               @convert-statement="convertStatement"
            />
          </template>
          <template #2>
            <n-tabs :value="rightTab" @update:value="showTools" type="line" size="small" class="right-tabs" pane-class="right-pane">
              <n-tab-pane key="info" name="info" :tab="t('panel.info')">
                <info-panel ref="infoPanel" :ws="ws" :judge="judge" />
              </n-tab-pane>
              <n-tab-pane key="tests" name="tests" :tab="t('panel.tests')">
                <n-scrollbar v-keep-scroll="`tests:${id}`" style="height: 100%"><tests-panel :ws="ws" :judge="judge" :problem-id="id" @run-on-test="runOnTest" /></n-scrollbar>
              </n-tab-pane>
              <n-tab-pane key="run" name="run" :disabled="dataOnly" :tab="t('panel.run')" display-directive="show">
                <n-scrollbar v-keep-scroll="`run:${id}`" style="height: 100%"><run-panel ref="runPanel" :ws="ws" :judge="judge" :problem-id="id" /></n-scrollbar>
              </n-tab-pane>
              <n-tab-pane key="selftest" name="selftest" :disabled="dataOnly" :tab="t('panel.selftest')">
                <n-scrollbar v-keep-scroll="`selftest:${id}`" style="height: 100%"><self-test-panel :ws="ws" :judge="judge" /></n-scrollbar>
              </n-tab-pane>
              <n-tab-pane key="ai" name="ai" :disabled="dataOnly" tab="AI" display-directive="show">
                <aside class="ai-sidebar" :aria-label="t('palette.aiChat')">
                  <ai-drawer ref="aiDrawer" embedded :show="showAi" :ai="ai" :problem-id="id" :ws="ws" />
                </aside>
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
      @open="(w) => (w === 'sync' ? (!dataOnly && (showSync = true)) : w === 'ai' ? (!dataOnly && (showAi = true)) : showTools('tests'))"
    />
    <quick-open v-model:show="quickOpen" :files="allFiles" @open="(p: string) => ws.openFile(p)" />
    <command-palette v-model:show="showPalette" :commands="commands" />
    <shortcuts-dialog v-model:show="showShortcuts" />
    <lint-dialog v-model:show="showLint" :ws="ws" :problem-id="id" />
    <stress-dialog v-model:show="showStress" :ws="ws" :judge="judge" :problem-id="id" />
    <invocation-window v-model:show="showInvocation" :ws="ws" :judge="judge" :problem-id="id" />
    <sync-dialog v-model:show="showSync" :ws="ws" :problem-id="id" :initial-tab="syncTab" />
    <package-import-dialog v-model:show="showDataImport" :problem-id="id" @imported="importedData" />
    <problem-export-dialog v-model:show="showExport" :detail="ws.state.detail" />
    <diff-dialog v-model:show="diff.show" :path="diff.path" :disk="diff.disk" :mine="diff.mine" @keep-mine="keepMine" @use-disk="useDisk" />

    <dir-picker v-model:show="movePicker" :initial="summary?.root" @pick="moveTo" />
    <tool-window v-model:show="languageDialog" :title="t('improve.language')" size="sm">
      <free-select v-model:value="languageCode" :options="languageOptions" :placeholder="t('improve.selectLanguage')" />
      <template #footer>
        <n-button @click="languageDialog = false">{{ t('common.cancel') }}</n-button>
        <n-button type="primary" :disabled="!/^[a-z]{2,8}$/.test(languageCode) || languageCode === 'images'" @click="createLanguage">{{ t('common.create') }}</n-button>
      </template>
    </tool-window>
    <tool-window v-model:show="prompt.show" :title="prompt.title" size="sm" @after-leave="prompt.resolve(null)">
      <n-input v-model:value="prompt.value" class="mono" autofocus @keyup.enter="finishPrompt(true)" />
      <template #footer>
        <n-button @click="finishPrompt(false)">{{ t('common.cancel') }}</n-button>
        <n-button type="primary" @click="finishPrompt(true)">{{ t('common.ok') }}</n-button>
      </template>
    </tool-window>
  </div>
</template>

<style scoped>
.mode-banner { border-radius: 0; flex-shrink: 0; font-size: 12px; }
.page {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.split {
  flex: 1;
  min-height: 0;
}
.ai-sidebar {
  height: 100%;
  min-width: 0;
  overflow: hidden;
  border-left: 1px solid var(--pf-border);
  background: var(--pf-surface);
}
.right-tabs {
  background: var(--pf-surface);
  border-left: 1px solid var(--pf-border);
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
