<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { NAlert, NButton, NCheckbox, NInput, NModal, NSpace, NSpin, NTabPane, NTabs, NTag, NSelect, useMessage } from 'naive-ui';
import type { ContestBatchResult, ContestDetail, ContestPullPreview, ContestPullResult, ContestSyncRow, ContestSyncState, ContestSyncStatus, JobInfo } from '@polyforge/shared';
import { api, errorMessage } from '../lib/api';
import { waitJob } from '../lib/jobs';
import { serverText } from '../lib/serverText';

/**
 * Contest ⇄ Polygon, like a problem's sync dialog with a push and a pull tab. The status
 * of every problem takes one or two requests; a pull fetches only the problems changed
 * on Polygon and applies their changes after confirmation (conflicts go to the problem's
 * own dialog); a push sends the chosen problems' local changes.
 */
const props = defineProps<{ show: boolean; contestId: string; detail: ContestDetail | null }>();
const emit = defineEmits<{ 'update:show': [boolean]; changed: [] }>();
const tab = ref<'push' | 'pull'>('push');
const { t } = useI18n();
const router = useRouter();
const message = useMessage();

const status = ref<ContestSyncStatus | null>(null);
const loading = ref(false);
const error = ref('');
const preview = ref<ContestPullPreview | null>(null);
/** problem → keys to take */
const take = ref<Record<string, Set<string>>>({});
const job = ref<JobInfo | null>(null);
const result = ref<ContestPullResult | null>(null);
const busy = computed(() => job.value?.status === 'running');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    status.value = await api.contestSyncStatus(props.contestId);
  } catch (e) {
    error.value = serverText(errorMessage(e));
  } finally {
    loading.value = false;
  }
}
watch(
  () => props.show,
  (s) => {
    if (!s) return;
    preview.value = null;
    result.value = null;
    pushResult.value = null;
    tab.value = 'push';
    load().then(() => {
      // Push by default what has local changes and is unchanged on Polygon; creating a Polygon
      // problem for an unbound one is left to an explicit tick.
      pushPick.value = new Set((status.value?.rows ?? []).filter((r) => r.state === 'local').map((r) => r.problem));
    });
  },
);

const STATE_TYPE: Record<ContestSyncState, 'default' | 'success' | 'info' | 'warning' | 'error'> = {
  same: 'success',
  local: 'info',
  remote: 'warning',
  both: 'error',
  unbound: 'default',
  unreachable: 'error',
  missing: 'error',
};
const titleOf = (problem: string) => {
  const s = props.detail?.problems.find((p) => p.problem === problem)?.summary;
  return s?.title.zh || s?.title.en || problem;
};
const changedOnPolygon = computed(() => (status.value?.rows ?? []).filter((r) => r.state === 'remote' || r.state === 'both'));
const bound = computed(() => (status.value?.rows ?? []).filter((r) => r.polygonId !== undefined && r.state !== 'unreachable'));
const letterDiffs = computed(() => (status.value?.rows ?? []).filter((r) => r.polygonIndex));

function remoteCell(r: ContestSyncRow) {
  if (r.remoteRevision === undefined) return '—';
  const rev = r.syncedRevision === undefined || r.syncedRevision === r.remoteRevision ? `r${r.remoteRevision}` : `r${r.syncedRevision} → r${r.remoteRevision}`;
  return r.remoteUncommitted ? `${rev} · ${t('csync.uncommitted')}` : rev;
}

async function check(rows: ContestSyncRow[]) {
  if (!rows.length) return;
  preview.value = null;
  result.value = null;
  try {
    const started = await api.contestPullPreview(props.contestId, rows.map((r) => r.problem));
    job.value = started;
    const done = await waitJob(started, (j) => (job.value = j));
    job.value = done;
    if (done.status !== 'done') throw new Error(done.error ?? done.status);
    preview.value = done.result as ContestPullPreview;
    take.value = Object.fromEntries(preview.value.problems.map((p) => [p.problem, new Set(p.items.filter((i) => i.take).map((i) => i.key))]));
  } catch (e) {
    message.error(serverText(errorMessage(e)));
  }
}

function setTake(problem: string, key: string, on: boolean) {
  const next = new Set(take.value[problem]);
  if (on) next.add(key);
  else next.delete(key);
  take.value = { ...take.value, [problem]: next };
}
/** Select all / none of one problem's items in the pull confirmation. */
function problemAll(p: ContestPullPreview['problems'][number]) {
  const n = p.items.filter((i) => take.value[p.problem]?.has(i.key)).length;
  return { checked: n > 0 && n === p.items.length, indeterminate: n > 0 && n < p.items.length };
}
function setProblemAll(p: ContestPullPreview['problems'][number], on: boolean) {
  take.value = { ...take.value, [p.problem]: new Set(on ? p.items.map((i) => i.key) : []) };
}
/** Problems a batch pull may touch: no conflict and no error (even with nothing to take: records Polygon's state). */
const pullable = computed(() => (preview.value?.problems ?? []).filter((p) => !p.conflicts.length && !p.error));
const takeCount = computed(() => pullable.value.reduce((n, p) => n + (take.value[p.problem]?.size ?? 0), 0));

async function pull() {
  try {
    const started = await api.contestPull(props.contestId, { problems: pullable.value.map((p) => ({ problem: p.problem, take: [...(take.value[p.problem] ?? [])] })) });
    job.value = started;
    const done = await waitJob(started, (j) => (job.value = j));
    job.value = done;
    if (done.status !== 'done') throw new Error(done.error ?? done.status);
    result.value = done.result as ContestPullResult;
    const applied = result.value.problems.reduce((n, p) => n + p.applied, 0);
    message.success(t('csync.pulled', { n: applied }));
    preview.value = null;
    emit('changed');
    await load();
  } catch (e) {
    message.error(serverText(errorMessage(e)));
  }
}

// ---- push ----
const pushPick = ref(new Set<string>());
const commitMessage = ref('');
const commit = ref(true);
const buildPackage = ref(false);
const packageType = ref<'standard' | 'full'>('standard');
watch(commit, v => { if (!v) buildPackage.value = false; });
const pushResult = ref<ContestBatchResult | null>(null);
const pushable = (r: ContestSyncRow) => r.state !== 'missing' && r.state !== 'unreachable';
function setPush(problem: string, on: boolean) {
  const next = new Set(pushPick.value);
  if (on) next.add(problem);
  else next.delete(problem);
  pushPick.value = next;
}
const pushSelectable = computed(() => (status.value?.rows ?? []).filter(pushable).map((r) => r.problem));
const pushAll = computed(() => {
  const n = pushSelectable.value.filter((p) => pushPick.value.has(p)).length;
  return { checked: n > 0 && n === pushSelectable.value.length, indeterminate: n > 0 && n < pushSelectable.value.length };
});
function selectAllPush(on: boolean) {
  pushPick.value = on ? new Set(pushSelectable.value) : new Set();
}

async function push() {
  const indices = (status.value?.rows ?? []).filter((r) => pushPick.value.has(r.problem)).map((r) => r.index);
  if (!indices.length) return;
  pushResult.value = null;
  try {
    const started = await api.contestBatch(props.contestId, { action: 'polygon-push', indices, message: commitMessage.value.trim() || undefined, commit: commit.value, buildPackage: commit.value && buildPackage.value, packageType: packageType.value });
    job.value = started;
    const done = await waitJob(started, (j) => (job.value = j));
    job.value = done;
    if (done.status !== 'done') throw new Error(done.error ?? done.status);
    pushResult.value = done.result as ContestBatchResult;
    const ok = pushResult.value.items.filter((i) => i.ok).length;
    message.success(t('csync.pushedN', { n: ok }));
    emit('changed');
    await load();
    pushPick.value = new Set([...pushPick.value].filter((p) => status.value?.rows.find((r) => r.problem === p)?.state === 'local'));
  } catch (e) {
    message.error(serverText(errorMessage(e)));
  }
}

/** Open a problem's own sync dialog (push or pull tab), e.g. to resolve a conflict. */
function openSync(problem: string, which: 'push' | 'pull') {
  emit('update:show', false);
  router.push({ name: 'problem', params: { id: problem }, query: { from: `contest:${props.contestId}`, sync: which } });
}
const resolveIn = (problem: string) => openSync(problem, 'pull');
/** A click on a row (not on its checkbox) opens that problem's sync dialog on the same tab. */
function rowClick(e: MouseEvent, r: ContestSyncRow) {
  if (r.state === 'missing' || (e.target as HTMLElement).closest('.n-checkbox, button, a')) return;
  openSync(r.problem, tab.value);
}

async function useLetters() {
  if (!props.detail) return;
  const map = new Map(letterDiffs.value.map((r) => [r.problem, r.polygonIndex!]));
  try {
    await api.updateContest(props.contestId, { problems: props.detail.problems.map((p) => ({ index: map.get(p.problem) ?? p.index, problem: p.problem })) });
    message.success(t('csync.lettersUpdated'));
    emit('changed');
    await load();
  } catch (e) {
    message.error(serverText(errorMessage(e)));
  }
}

/** Add a problem of the Polygon contest: import it first unless a local copy is bound already. */
async function addRemote(x: ContestSyncStatus['remoteOnly'][number]) {
  if (!props.detail) return;
  try {
    let id = x.localProblem;
    if (!id) {
      const started = await api.importPolygon({ polygonId: x.polygonId });
      job.value = started;
      const done = await waitJob(started, (j) => (job.value = j));
      job.value = done;
      if (done.status !== 'done') throw new Error(done.error ?? done.status);
      id = (done.result as { id: string }).id;
    }
    // In letter order, like the Polygon contest.
    const problems = [...props.detail.problems.map((p) => ({ index: p.index, problem: p.problem })), { index: x.index, problem: id }].sort((a, b) =>
      a.index.localeCompare(b.index, 'en', { numeric: true }),
    );
    await api.updateContest(props.contestId, { problems });
    message.success(t('csync.added', { index: x.index }));
    emit('changed');
    await load();
  } catch (e) {
    message.error(serverText(errorMessage(e)));
  }
}
</script>

<template>
  <n-modal :show="show" preset="card" :title="t('csync.title')" style="width: min(980px, 96vw)" @update:show="emit('update:show', $event)">
    <n-space v-if="!status">
      <n-button :type="tab === 'push' ? 'primary' : 'default'" @click="tab = 'push'">{{ t('sync.push') }}</n-button>
      <n-button :type="tab === 'pull' ? 'primary' : 'default'" @click="tab = 'pull'">{{ t('sync.pull') }}</n-button>
    </n-space>
    <div v-if="loading && !status" class="center"><n-spin /></div>
    <n-alert v-else-if="error" type="error" :show-icon="false">{{ error }}</n-alert>
    <template v-else-if="status">
      <div class="small dim head">
        {{ status.polygonId !== undefined ? t('csync.boundTo', { id: status.polygonId }) : t('csync.notBound') }}
      </div>
      <n-alert v-for="(w, i) in status.warnings" :key="i" type="warning" :show-icon="false" class="alert small">{{ serverText(w) }}</n-alert>

      <n-tabs v-model:value="tab" type="line" size="small">
        <n-tab-pane name="push" :tab="t('sync.push')">
          <table class="rows">
            <thead>
              <tr>
                <th class="pick">
                  <n-checkbox
                    :checked="pushAll.checked"
                    :indeterminate="pushAll.indeterminate"
                    :disabled="!pushSelectable.length || busy"
                    :title="t('sync.selectAll')"
                    @update:checked="selectAllPush"
                  />
                </th>
                <th>#</th>
                <th>{{ t('contest.problem') }}</th>
                <th>{{ t('csync.local') }}</th>
                <th>{{ t('csync.state') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in status.rows" :key="r.problem" class="row-link" :title="t('csync.openProblemSync')" @click="rowClick($event, r)">
                <td class="pick">
                  <n-checkbox :checked="pushPick.has(r.problem)" :disabled="!pushable(r) || busy" @update:checked="(v: boolean) => setPush(r.problem, v)" />
                </td>
                <td class="idx">{{ r.index }}</td>
                <td>
                  {{ titleOf(r.problem) }} <span class="mono dim">{{ r.problem }}</span>
                </td>
                <td class="small">
                  <template v-if="r.polygonId === undefined">{{ t('csync.willCreate') }}</template>
                  <template v-else-if="r.localChanges">{{ t('csync.localChanges', { n: r.localChanges }) }}</template>
                  <span v-else class="dim">{{ t('csync.noChanges') }}</span>
                  <span v-if="r.tomlChanged" class="dim"> · problem.toml</span>
                </td>
                <td>
                  <n-tag size="small" :type="STATE_TYPE[r.state]" :bordered="false">{{ t(`csync.s_${r.state}`) }}</n-tag>
                  <span v-if="r.state === 'remote' || r.state === 'both'" class="small warn"> {{ t('csync.pullFirst') }}</span>
                </td>
              </tr>
            </tbody>
          </table>
          <div class="commit">
            <n-checkbox v-model:checked="commit">{{ t('sync.commit') }}</n-checkbox>
            <n-checkbox v-model:checked="buildPackage" :disabled="!commit">{{ t('sync.buildPackage') }}</n-checkbox>
            <n-select v-if="buildPackage" v-model:value="packageType" :options="[{label:'Standard',value:'standard'},{label:'Full',value:'full'}]" size="small" style="width:120px" />
            <n-input v-model:value="commitMessage" size="small" :placeholder="t('sync.commitMessage')" :disabled="busy" />
          </div>
          <div v-if="pushResult" class="small result">
            <div v-for="it in pushResult.items" :key="it.index" :class="{ bad: !it.ok }">
              {{ it.index }}: {{ serverText(it.message) }}
              <span v-for="(d, i) in it.details ?? []" :key="i" class="dim"> · {{ serverText(d) }}</span>
            </div>
          </div>
        </n-tab-pane>

        <n-tab-pane name="pull" :tab="t('sync.pull')">
      <table class="rows">
        <thead>
          <tr>
            <th>#</th>
            <th>{{ t('contest.problem') }}</th>
            <th>{{ t('csync.local') }}</th>
            <th>Polygon</th>
            <th>{{ t('csync.state') }}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in status.rows" :key="r.problem" class="row-link" :title="t('csync.openProblemSync')" @click="rowClick($event, r)">
            <td class="idx">{{ r.index }}</td>
            <td>
              {{ titleOf(r.problem) }} <span class="mono dim">{{ r.problem }}</span>
            </td>
            <td class="small">
              <template v-if="r.polygonId === undefined">—</template>
              <template v-else-if="r.localChanges">{{ t('csync.localChanges', { n: r.localChanges }) }}</template>
              <span v-else class="dim">{{ t('csync.noChanges') }}</span>
              <span v-if="r.tomlChanged" class="dim"> · problem.toml</span>
            </td>
            <td class="small mono">{{ remoteCell(r) }}</td>
            <td><n-tag size="small" :type="STATE_TYPE[r.state]" :bordered="false">{{ t(`csync.s_${r.state}`) }}</n-tag></td>
            <td class="small dim">
              <span v-if="r.polygonIndex">{{ t('csync.polygonLetter', { index: r.polygonIndex }) }}</span>
              <span v-if="r.notInPolygonContest">{{ t('csync.notInPolygonContest') }}</span>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-if="letterDiffs.length || status.remoteOnly.length" class="structure">
        <div v-if="letterDiffs.length" class="line">
          <span>{{ t('csync.letterDiffs', { list: letterDiffs.map((r) => `${r.index} → ${r.polygonIndex}`).join(', ') }) }}</span>
          <n-button size="tiny" :disabled="busy" @click="useLetters">{{ t('csync.useLetters') }}</n-button>
        </div>
        <div v-for="x in status.remoteOnly" :key="x.polygonId" class="line">
          <span>{{ t('csync.remoteOnly', { index: x.index, name: x.name, id: x.polygonId }) }}</span>
          <n-button size="tiny" :disabled="busy" @click="addRemote(x)">{{ x.localProblem ? t('csync.addLocal', { id: x.localProblem }) : t('csync.importAdd') }}</n-button>
        </div>
      </div>

      <!-- Confirmation: what a pull takes, per problem -->
      <div v-if="preview" class="preview">
        <div v-for="p in preview.problems" :key="p.problem" class="pp">
          <div class="pp-head">
            <n-checkbox
              v-if="p.items.length"
              :checked="problemAll(p).checked"
              :indeterminate="problemAll(p).indeterminate"
              :disabled="!!p.conflicts.length"
              :title="t('sync.selectAll')"
              @update:checked="(v: boolean) => setProblemAll(p, v)"
            />
            <strong>{{ p.index }} · {{ titleOf(p.problem) }}</strong>
            <n-tag v-if="p.error" size="tiny" type="error" :bordered="false">{{ serverText(p.error) }}</n-tag>
            <span v-else-if="!p.items.length && !p.conflicts.length" class="small dim">{{ t('csync.nothingNew') }}</span>
          </div>
          <div v-for="it in p.items" :key="it.key" class="item">
            <n-checkbox
              :checked="take[p.problem]?.has(it.key)"
              :disabled="!!p.conflicts.length"
              @update:checked="(v: boolean) => setTake(p.problem, it.key, v)"
            />
            <n-tag size="tiny" :bordered="false" :type="it.status === 'local-only' ? 'warning' : 'info'">{{ t(`sync.pull_${it.status.replace('-', '_')}`) }}</n-tag>
            <span>{{ serverText(it.label) }}</span>
          </div>
          <div v-if="p.conflicts.length" class="conflicts small">
            <span>{{ t('csync.conflicts', { list: p.conflicts.map((c) => serverText(c)).join('、') }) }}</span>
            <n-button size="tiny" type="warning" @click="resolveIn(p.problem)">{{ t('csync.resolveIn') }}</n-button>
          </div>
        </div>
      </div>

      <div v-if="result" class="small result">
        <div v-for="p in result.problems" :key="p.problem" :class="{ bad: p.error }">
          {{ p.index }}: {{ p.error ? serverText(p.error) : t('csync.appliedN', { n: p.applied }) }}
          <span v-for="(w, i) in p.warnings" :key="i" class="dim"> · {{ serverText(w) }}</span>
        </div>
      </div>
        </n-tab-pane>
      </n-tabs>
      <div v-if="busy" class="small dim progress">{{ serverText(job!.progress.message) }}</div>
    </template>

    <template #footer>
      <n-space justify="end">
        <n-button :disabled="busy || loading" @click="load">{{ t('csync.refresh') }}</n-button>
        <template v-if="tab === 'push'">
          <n-button type="primary" :loading="busy" :disabled="!pushPick.size" @click="push">{{ t('csync.pushN', { n: pushPick.size }) }}</n-button>
        </template>
        <template v-else>
        <n-button :disabled="busy || !bound.length" :title="t('csync.checkAllHint')" @click="check(bound)">{{ t('csync.checkAll') }}</n-button>
        <n-button v-if="!preview" type="primary" :loading="busy" :disabled="!changedOnPolygon.length" @click="check(changedOnPolygon)">
          {{ t('csync.checkChanged', { n: changedOnPolygon.length }) }}
        </n-button>
        <n-button v-else type="primary" :loading="busy" :disabled="!pullable.length" @click="pull">{{ t('csync.pull', { n: takeCount }) }}</n-button>
        </template>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
.center {
  display: flex;
  justify-content: center;
  padding: 40px;
}
.head {
  margin-bottom: 8px;
}
.alert {
  margin-bottom: 6px;
}
.rows {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.rows th,
.rows td {
  text-align: left;
  padding: 5px 8px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.2);
}
.rows .idx {
  font-weight: bold;
  width: 4em;
  white-space: nowrap;
}
.row-link {
  cursor: pointer;
}
.row-link:hover td {
  background: rgba(128, 128, 128, 0.08);
}
.structure,
.preview,
.result {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.pp {
  border: 1px solid rgba(128, 128, 128, 0.25);
  border-radius: 4px;
  padding: 6px 10px;
}
.pp-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.conflicts {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  color: #e88080;
}
.progress {
  margin-top: 8px;
}
.pick {
  width: 28px;
}
.commit {
  margin-top: 10px;
  max-width: 480px;
}
.warn {
  color: #e8b060;
}
.bad {
  color: #e88080;
}
</style>
