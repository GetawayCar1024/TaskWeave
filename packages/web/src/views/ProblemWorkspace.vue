<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { onBeforeRouteLeave, useRouter } from 'vue-router';
import { NButton, NInput, NModal, NResult, NSpace, NSpin, NSplit, NTooltip, useDialog, useMessage } from 'naive-ui';
import AppHeader from '../components/AppHeader.vue';
import DiffDialog from '../components/DiffDialog.vue';
import EditorPane from '../components/EditorPane.vue';
import FileSidebar, { type SidebarAction } from '../components/FileSidebar.vue';
import InfoPanel from '../components/InfoPanel.vue';
import QuickOpen from '../components/QuickOpen.vue';
import { api, errorMessage } from '../lib/api';
import { problemTitle } from '../lib/format';
import { onWs } from '../lib/ws';
import { SHARED_TAB, useWorkspace } from '../lib/workspace';

const props = defineProps<{ id: string }>();
const { t, locale } = useI18n();
const router = useRouter();
const message = useMessage();
const dialog = useDialog();

const ws = useWorkspace(props.id);
const summary = computed(() => ws.state.detail?.summary);

// ---- save / conflicts ----
const diff = ref({ show: false, path: '', disk: null as string | null, mine: '' });

async function save(path: string) {
  try {
    const r = await ws.save(path);
    if (r === 'conflict') await showDiff(path);
    else if (r === 'readonly') message.warning(t('editor.readOnly'));
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

const offWs = onWs((e) => void ws.onWsEvent(e));
onMounted(async () => {
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('beforeunload', onBeforeUnload);
  await ws.init();
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
  { key: 'generate', milestone: 'M2' },
  { key: 'invocation', milestone: 'M2' },
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
            <editor-pane :ws="ws" @save="save" @close="closeTab" @quick-open="quickOpen = true" @show-diff="showDiff" />
          </template>
          <template #2>
            <info-panel :ws="ws" />
          </template>
        </n-split>
      </template>
    </n-split>

    <quick-open v-model:show="quickOpen" :files="allFiles" @open="(p: string) => ws.openFile(p)" />
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
