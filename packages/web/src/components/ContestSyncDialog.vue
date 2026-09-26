<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { NAlert, NButton, NCheckbox, NModal, NSpace, NSpin, NTag, useMessage } from 'naive-ui';
import type { ContestDetail, ContestPullPreview, ContestPullResult, ContestSyncRow, ContestSyncState, ContestSyncStatus, JobInfo } from '@polyforge/shared';
import { api, errorMessage } from '../lib/api';
import { waitJob } from '../lib/jobs';
import { serverText } from '../lib/serverText';

/**
 * Contest ⇄ Polygon: where every problem stands (one or two requests), then only the
 * problems changed on Polygon are fetched and their changes pulled after confirmation.
 * Conflicts go to the problem's own sync dialog.
 */
const props = defineProps<{ show: boolean; contestId: string; detail: ContestDetail | null }>();
const emit = defineEmits<{ 'update:show': [boolean]; push: []; changed: [] }>();
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
    load();
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

/** A conflict is resolved in the problem's own sync dialog, on the pull tab. */
function resolveIn(problem: string) {
  emit('update:show', false);
  router.push({ name: 'problem', params: { id: problem }, query: { from: `contest:${props.contestId}`, sync: 'pull' } });
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
    <div v-if="loading && !status" class="center"><n-spin /></div>
    <n-alert v-else-if="error" type="error" :show-icon="false">{{ error }}</n-alert>
    <template v-else-if="status">
      <div class="small dim head">
        {{ status.polygonId !== undefined ? t('csync.boundTo', { id: status.polygonId }) : t('csync.notBound') }} · {{ t('csync.cheap') }}
      </div>
      <n-alert v-for="(w, i) in status.warnings" :key="i" type="warning" :show-icon="false" class="alert small">{{ serverText(w) }}</n-alert>

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
          <tr v-for="r in status.rows" :key="r.problem">
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

      <div v-if="busy" class="small dim progress">{{ serverText(job!.progress.message) }}</div>

      <!-- Confirmation: what a pull takes, per problem -->
      <div v-if="preview" class="preview">
        <div v-for="p in preview.problems" :key="p.problem" class="pp">
          <div class="pp-head">
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
        <div class="small dim">{{ t('csync.previewHint') }}</div>
      </div>

      <div v-if="result" class="small result">
        <div v-for="p in result.problems" :key="p.problem" :class="{ bad: p.error }">
          {{ p.index }}: {{ p.error ? serverText(p.error) : t('csync.appliedN', { n: p.applied }) }}
          <span v-for="(w, i) in p.warnings" :key="i" class="dim"> · {{ serverText(w) }}</span>
        </div>
      </div>
    </template>

    <template #footer>
      <n-space justify="end">
        <n-button :disabled="busy || loading" @click="load">{{ t('csync.refresh') }}</n-button>
        <n-button :disabled="busy || !bound.length" :title="t('csync.checkAllHint')" @click="check(bound)">{{ t('csync.checkAll') }}</n-button>
        <n-button :disabled="busy" @click="emit('push'); emit('update:show', false)">{{ t('csync.push') }}</n-button>
        <n-button v-if="!preview" type="primary" :loading="busy" :disabled="!changedOnPolygon.length" @click="check(changedOnPolygon)">
          {{ t('csync.checkChanged', { n: changedOnPolygon.length }) }}
        </n-button>
        <n-button v-else type="primary" :loading="busy" :disabled="!pullable.length" @click="pull">{{ t('csync.pull', { n: takeCount }) }}</n-button>
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
  width: 2.5em;
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
.bad {
  color: #e88080;
}
</style>
