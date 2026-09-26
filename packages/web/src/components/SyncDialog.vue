<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { serverText } from '../lib/serverText';
import { useI18n } from 'vue-i18n';
import {
  NAlert,
  NButton,
  NCheckbox,
  NInput,
  NInputNumber,
  NModal,
  NProgress,
  NScrollbar,
  NSpace,
  NSpin,
  NSwitch,
  NTabPane,
  NTabs,
  NTag,
  useMessage,
} from 'naive-ui';
import type { ItemContent, JobInfo, PullItem, PullPreview, PushItem, PushPreview } from '@polyforge/shared';
import { api, errorMessage } from '../lib/api';
import { waitJob } from '../lib/jobs';
import type { Workspace } from '../lib/workspace';
import TextDiff from './TextDiff.vue';

/** initialTab: open on the pull tab (sent here from the contest sync to resolve a conflict). */
const props = defineProps<{ show: boolean; ws: Workspace; problemId: string; initialTab?: 'push' | 'pull' }>();
const emit = defineEmits<{ 'update:show': [boolean] }>();
const { t } = useI18n();
const message = useMessage();

const tab = ref<'push' | 'pull'>('push');
/** Push and pull load independently: the pull tab works while the push preview loads. */
const pushLoading = ref(false);
const pullLoading = ref(false);
const error = ref('');

// ---- push ----
const preview = ref<PushPreview | null>(null);
const selected = ref(new Set<string>());
const showUnchanged = ref(false);
const commit = ref(true);
const commitMessage = ref('');
const buildPackage = ref(false);
const pushJob = ref<JobInfo | null>(null);
const pushResult = ref<{ pushed: string[]; warnings: string[] } | null>(null);
const bindId = ref<number | null>(null);

async function loadPush() {
  pushLoading.value = true;
  error.value = '';
  try {
    preview.value = await api.pushPreview(props.problemId);
    selected.value = new Set(
      preview.value.items.filter((i) => i.kind !== 'toml' && (i.status === 'new' || i.status === 'modified' || (i.status === 'deleted' && ['statement', 'sample'].includes(i.kind)))).map((i) => i.key),
    );
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    pushLoading.value = false;
  }
}

const pushItems = computed(() => (preview.value?.items ?? []).filter((i) => showUnchanged.value || i.status !== 'unchanged'));

function toggle(set: Set<string>, key: string, on: boolean) {
  const next = new Set(set);
  if (on) next.add(key);
  else next.delete(key);
  return next;
}

async function doPush() {
  if (!preview.value) return;
  pushResult.value = null;
  try {
    const job = await api.push(props.problemId, { keys: [...selected.value], commit: commit.value, message: commitMessage.value, buildPackage: buildPackage.value });
    pushJob.value = job;
    const done = await waitJob(job, (j) => (pushJob.value = j));
    pushJob.value = done;
    if (done.status === 'done') {
      pushResult.value = done.result as { pushed: string[]; warnings: string[] };
      message.success(t('sync.pushed', { n: pushResult.value.pushed.length }));
    } else {
      error.value = done.error ?? done.status;
    }
    await props.ws.loadDetail();
    await loadPush();
  } catch (e) {
    error.value = errorMessage(e);
  }
}

async function bind() {
  if (!bindId.value) return;
  try {
    await props.ws.patch({ polygonId: bindId.value });
    await loadPush();
  } catch (e) {
    message.error(errorMessage(e));
  }
}

// ---- pull ----
const pullPreview = ref<PullPreview | null>(null);
const take = ref(new Set<string>());
const merge = ref(new Set<string>());
const diffMode = ref<'compare' | 'merged'>('compare');
const showSame = ref(false);
const pulling = ref(false);

async function loadPull() {
  pullLoading.value = true;
  error.value = '';
  try {
    pullPreview.value = await api.pullPreview(props.problemId);
    take.value = new Set(pullPreview.value.items.filter((i) => i.takeRemote).map((i) => i.key));
    // Conflicts that merge without overlapping edits are merged by default.
    merge.value = new Set(pullPreview.value.items.filter((i) => i.status === 'conflict' && i.mergeable && i.mergeConflicts === 0).map((i) => i.key));
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    pullLoading.value = false;
  }
}

const pullItems = computed(() => (pullPreview.value?.items ?? []).filter((i) => showSame.value || i.status !== 'same'));

async function doPull() {
  pulling.value = true;
  try {
    const r = await api.pull(props.problemId, [...take.value], [...merge.value]);
    message.success(t('sync.pulled', { n: r.applied.length + r.merged.length }));
    if (r.warnings.length) message.warning(r.warnings.map(serverText).join('\n'));
    await props.ws.loadDetail();
    // Reload open tabs whose files changed underneath them.
    for (const tabItem of props.ws.state.tabs) if (!tabItem.dirty) await props.ws.reloadFromDisk(tabItem.path);
    await loadPull();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    pulling.value = false;
  }
}

// ---- diff of one item ----
const active = ref<string | null>(null);
const content = ref<ItemContent | null>(null);
const contentLoading = ref(false);

function toggleMerge(key: string) {
  const on = !merge.value.has(key);
  merge.value = toggle(merge.value, key, on);
  if (on) take.value = toggle(take.value, key, false);
}

function setTake(key: string, v: boolean) {
  take.value = toggle(take.value, key, v);
  if (v) merge.value = toggle(merge.value, key, false);
}

// ---- select all / none (only rows that can be checked, among those shown) ----
const pushSelectable = computed(() => pushItems.value.filter((it) => it.kind !== 'toml' && !(it.status === 'deleted' && !['statement', 'sample'].includes(it.kind))).map((it) => it.key));
const pullSelectable = computed(() => pullItems.value.filter((it) => it.status !== 'same' && it.kind !== 'toml').map((it) => it.key));
const allState = (keys: string[], set: Set<string>) => {
  const n = keys.filter((k) => set.has(k)).length;
  return { checked: n > 0 && n === keys.length, indeterminate: n > 0 && n < keys.length };
};
const pushAll = computed(() => allState(pushSelectable.value, selected.value));
const pullAll = computed(() => allState(pullSelectable.value, take.value));
function selectAllPush(on: boolean) {
  const next = new Set(selected.value);
  for (const k of pushSelectable.value) on ? next.add(k) : next.delete(k);
  selected.value = next;
}
function selectAllPull(on: boolean) {
  const next = new Set(take.value);
  for (const k of pullSelectable.value) on ? next.add(k) : next.delete(k);
  take.value = next;
  // Taking an item replaces its merge.
  if (on) merge.value = new Set([...merge.value].filter((k) => !next.has(k)));
}

async function openItem(key: string) {
  active.value = key;
  diffMode.value = merge.value.has(key) ? 'merged' : 'compare';
  content.value = null;
  contentLoading.value = true;
  try {
    content.value = await api.syncContent(props.problemId, key);
  } catch (e) {
    message.error(errorMessage(e));
  } finally {
    contentLoading.value = false;
  }
}

watch(
  () => props.show,
  (s) => {
    if (!s) return;
    active.value = null;
    content.value = null;
    pushResult.value = null;
    error.value = '';
    // Fresh pull preview each time the dialog opens (loaded when the tab is shown).
    pullPreview.value = null;
    tab.value = props.initialTab === 'pull' && bound.value ? 'pull' : 'push';
    if (tab.value === 'pull') loadPull();
    loadPush();
  },
);
watch(tab, (v) => {
  active.value = null;
  content.value = null;
  if (v === 'pull' && !pullPreview.value) loadPull();
});

const PUSH_TYPE: Record<PushItem['status'], 'info' | 'warning' | 'error' | 'default'> = { new: 'info', modified: 'warning', deleted: 'error', unchanged: 'default' };
const PULL_TYPE: Record<PullItem['status'], 'info' | 'warning' | 'error' | 'default' | 'success'> = {
  same: 'default',
  remote: 'info',
  local: 'success',
  conflict: 'error',
  'remote-only': 'info',
  'local-only': 'warning',
};

// Known from the problem right away, before the push preview has loaded.
const bound = computed(() => (preview.value?.polygonId ?? props.ws.state.detail?.summary.status.polygonId) !== undefined);
const pushPercent = computed(() => (pushJob.value?.progress.total ? Math.round((pushJob.value.progress.done / pushJob.value.progress.total) * 100) : 0));
</script>

<template>
  <n-modal :show="show" preset="card" :title="t('sync.title')" style="width: min(1200px, 96vw)" @update:show="emit('update:show', $event)">
    <div class="head">
      <template v-if="preview">
        <span v-if="bound">
          Polygon #{{ preview.polygonId }}
          <span v-if="preview.remoteRevision !== undefined" class="dim"> · rev {{ preview.remoteRevision }}</span>
          <span v-if="preview.lastSync" class="dim"> · {{ t('sync.lastSync') }} {{ new Date(preview.lastSync).toLocaleString() }}</span>
        </span>
        <n-space v-else align="center" size="small">
          <span>{{ t('sync.unbound', { name: preview.name }) }}</span>
          <n-input-number v-model:value="bindId" size="small" :placeholder="t('sync.bindPlaceholder')" :show-button="false" style="width: 150px" />
          <n-button size="small" :disabled="!bindId" @click="bind">{{ t('sync.bind') }}</n-button>
        </n-space>
      </template>
    </div>

    <n-alert v-if="error" type="error" :show-icon="false" class="alert">{{ error }}</n-alert>

    <n-tabs v-model:value="tab" type="line" size="small">
      <n-tab-pane name="push" :tab="t('sync.push')">
        <div v-if="pushLoading && !preview" class="center"><n-spin /></div>
        <template v-else-if="preview">
          <n-alert v-for="(w, i) in preview.warnings" :key="i" type="warning" :show-icon="false" class="alert small">{{ serverText(w) }}</n-alert>
          <div class="body">
            <div class="list">
              <n-space align="center" justify="space-between" class="list-head">
                <n-checkbox
                  :checked="pushAll.checked"
                  :indeterminate="pushAll.indeterminate"
                  :disabled="!pushSelectable.length"
                  @update:checked="selectAllPush"
                >
                  <span class="small">{{ t('sync.selected', { n: selected.size }) }}</span>
                </n-checkbox>
                <n-space align="center" size="small">
                  <span class="small dim">{{ t('sync.showUnchanged') }}</span>
                  <n-switch v-model:value="showUnchanged" size="small" />
                </n-space>
              </n-space>
              <n-scrollbar style="max-height: 52vh">
                <div v-if="!pushItems.length" class="dim small empty">{{ t('sync.nothing') }}</div>
                <div v-for="it in pushItems" :key="it.key" class="row" :class="{ active: active === it.key }" @click="openItem(it.key)">
                  <n-checkbox
                    :checked="selected.has(it.key)"
                    :disabled="it.kind === 'toml' || (it.status === 'deleted' && !['statement', 'sample'].includes(it.kind))"
                    @click.stop
                    @update:checked="(v: boolean) => (selected = toggle(selected, it.key, v))"
                  />
                  <n-tag size="tiny" :type="PUSH_TYPE[it.status]" :bordered="false">{{ t(`sync.push_${it.status}`) }}</n-tag>
                  <span class="label" :title="it.key">{{ serverText(it.label) }}</span>
                </div>
              </n-scrollbar>
            </div>
            <div class="diff-pane">
              <div class="labels"><span>{{ content?.remoteIsLastSync ? t('sync.lastSynced') : 'Polygon' }}</span><span>{{ t('sync.local') }}</span></div>
              <div v-if="contentLoading" class="center"><n-spin /></div>
              <div v-else-if="!content" class="dim small center">{{ t('sync.pickItem') }}</div>
              <div v-else-if="content.binary" class="dim small center">{{ t('sync.binary') }}</div>
              <text-diff v-else :original="content.remote ?? ''" :modified="content.local ?? ''" class="diff" />
            </div>
          </div>
          <div class="foot">
            <n-space align="center">
              <n-checkbox v-model:checked="commit">{{ t('sync.commit') }}</n-checkbox>
              <n-input v-model:value="commitMessage" size="small" :disabled="!commit" :placeholder="t('sync.commitMessage')" style="width: 280px" />
              <n-checkbox v-model:checked="buildPackage">{{ t('sync.buildPackage') }}</n-checkbox>
            </n-space>
            <n-button type="primary" :loading="pushJob?.status === 'running'" :disabled="!selected.size" @click="doPush">
              {{ bound ? t('sync.pushN', { n: selected.size }) : t('sync.createAndPush', { n: selected.size }) }}
            </n-button>
          </div>
          <div v-if="pushJob?.status === 'running'" class="progress">
            <n-progress type="line" :percentage="pushPercent" :height="4" :show-indicator="false" />
            <span class="small dim">{{ serverText(pushJob.progress.message) }}</span>
          </div>
          <n-alert v-if="pushResult?.warnings.length" type="warning" :show-icon="false" class="alert small">
            <div v-for="(w, i) in pushResult.warnings" :key="i">{{ serverText(w) }}</div>
          </n-alert>
        </template>
      </n-tab-pane>

      <n-tab-pane name="pull" :tab="t('sync.pull')" :disabled="!bound">
        <div v-if="pullLoading && !pullPreview" class="center"><n-spin /></div>
        <template v-else-if="pullPreview">
          <n-alert v-for="(w, i) in pullPreview.warnings" :key="i" type="warning" :show-icon="false" class="alert small">{{ serverText(w) }}</n-alert>
          <div class="body">
            <div class="list">
              <n-space align="center" justify="space-between" class="list-head">
                <n-space align="center" size="small">
                  <n-checkbox
                    :checked="pullAll.checked"
                    :indeterminate="pullAll.indeterminate"
                    :disabled="!pullSelectable.length"
                    :title="t('sync.selectAll')"
                    @update:checked="selectAllPull"
                  />
                  <n-button size="tiny" :loading="pullLoading" @click="loadPull">{{ t('sync.refetch') }}</n-button>
                </n-space>
                <n-space align="center" size="small">
                  <span class="small dim">{{ t('sync.showSame') }}</span>
                  <n-switch v-model:value="showSame" size="small" />
                </n-space>
              </n-space>
              <n-scrollbar style="max-height: 52vh">
                <div v-if="!pullItems.length" class="dim small empty">{{ t('sync.inSync') }}</div>
                <div v-for="it in pullItems" :key="it.key" class="row" :class="{ active: active === it.key, conflict: it.status === 'conflict' }" @click="openItem(it.key)">
                  <n-checkbox :checked="take.has(it.key)" :disabled="it.status === 'same' || it.kind === 'toml'" @click.stop @update:checked="(v: boolean) => setTake(it.key, v)" />
                  <n-tag size="tiny" :type="PULL_TYPE[it.status]" :bordered="false">{{ t(`sync.pull_${it.status.replace('-', '_')}`) }}</n-tag>
                  <span class="label" :title="it.key">{{ serverText(it.label) }}</span>
                  <n-button
                    v-if="it.mergeable"
                    size="tiny"
                    class="merge-btn"
                    :type="merge.has(it.key) ? 'primary' : 'default'"
                    :title="it.mergeConflicts ? t('sync.mergeWithConflicts', { n: it.mergeConflicts }) : t('sync.mergeClean')"
                    @click.stop="toggleMerge(it.key)"
                  >
                    {{ t('sync.merge') }}{{ it.mergeConflicts ? ` (${it.mergeConflicts}!)` : '' }}
                  </n-button>
                </div>
              </n-scrollbar>
              <div class="hint small dim">{{ t('sync.pullHint') }}</div>
            </div>
            <div class="diff-pane">
              <div class="labels">
                <span>{{ t('sync.local') }}</span>
                <span v-if="content?.merged !== undefined" class="mode">
                  <n-button size="tiny" text :type="diffMode === 'compare' ? 'primary' : 'default'" @click="diffMode = 'compare'">Polygon</n-button>
                  ·
                  <n-button size="tiny" text :type="diffMode === 'merged' ? 'primary' : 'default'" @click="diffMode = 'merged'">{{ t('sync.mergePreview') }}</n-button>
                </span>
                <span v-else>{{ content?.remoteIsLastSync ? t('sync.lastSynced') : 'Polygon' }}</span>
              </div>
              <div v-if="contentLoading" class="center"><n-spin /></div>
              <div v-else-if="!content" class="dim small center">{{ t('sync.pickItem') }}</div>
              <div v-else-if="content.binary" class="dim small center">{{ t('sync.binary') }}</div>
              <text-diff
                v-else
                :original="content.local ?? ''"
                :modified="diffMode === 'merged' && content.merged !== undefined ? content.merged : content.remote ?? ''"
                class="diff"
              />
            </div>
          </div>
          <div class="foot">
            <span class="small dim">{{ t('sync.takeCount', { n: take.size }) }}<template v-if="merge.size"> · {{ t('sync.mergeCount', { n: merge.size }) }}</template></span>
            <n-button type="primary" :loading="pulling" :disabled="!take.size && !merge.size" @click="doPull">{{ t('sync.apply') }}</n-button>
          </div>
        </template>
      </n-tab-pane>
    </n-tabs>
  </n-modal>
</template>

<style scoped>
.head {
  margin-bottom: 6px;
  font-size: 13px;
}
.alert {
  margin-bottom: 6px;
  padding: 4px 8px;
}
.body {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
  gap: 10px;
  min-height: 52vh;
}
.list-head {
  margin-bottom: 4px;
}
.row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
}
.row:hover {
  background: rgba(128, 128, 128, 0.12);
}
.row.active {
  background: rgba(99, 226, 183, 0.15);
}
.row.conflict .label {
  color: #e88080;
}
.merge-btn {
  margin-left: auto;
  flex-shrink: 0;
}
.label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.diff-pane {
  display: flex;
  flex-direction: column;
  border: 1px solid rgba(128, 128, 128, 0.25);
  border-radius: 4px;
  min-height: 52vh;
}
.labels {
  display: grid;
  grid-template-columns: 1fr 1fr;
  font-size: 12px;
  opacity: 0.7;
  padding: 2px 8px;
}
.diff {
  flex: 1;
}
.foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 10px;
}
.progress {
  margin-top: 6px;
}
.center {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  padding: 24px;
}
.empty {
  padding: 16px;
  text-align: center;
}
.hint {
  margin-top: 6px;
}
.small {
  font-size: 12px;
}
.dim {
  opacity: 0.65;
}
</style>
