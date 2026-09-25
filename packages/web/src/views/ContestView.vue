<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import {
  NAlert,
  NButton,
  NDataTable,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NModal,
  NPopconfirm,
  NProgress,
  NSelect,
  NSpace,
  NTag,
  NTooltip,
  useMessage,
  type DataTableColumns,
} from 'naive-ui';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  CircleAlert,
  ClipboardCheck,
  FileText,
  FlaskConical,
  Package,
  Pencil,
  Play,
  Trash2,
  Upload,
  X,
} from 'lucide-vue-next';
import type { ContestAction, ContestBatchItem, ContestBatchResult, ContestDetail, JobInfo, ProblemSummary } from '@polyforge/shared';
import AppHeader from '../components/AppHeader.vue';
import { api, errorMessage } from '../lib/api';
import { problemTitle } from '../lib/format';
import { waitJob } from '../lib/jobs';
import { checklist, progress } from '../lib/progress';
import { onWs } from '../lib/ws';

const props = defineProps<{ id: string }>();
const { t, locale } = useI18n();
const router = useRouter();
const message = useMessage();

const detail = ref<ContestDetail | null>(null);
const allProblems = ref<ProblemSummary[]>([]);
const loadError = ref('');

async function load() {
  try {
    const [d, list] = await Promise.all([api.contest(props.id), api.problems()]);
    detail.value = d;
    allProblems.value = list.problems;
    loadError.value = '';
  } catch (e) {
    loadError.value = errorMessage(e);
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
const off = onWs((e) => {
  if (e.type === 'job:progress' || e.type === 'ai:event' || e.type === 'build:done') return;
  clearTimeout(timer);
  timer = setTimeout(load, 300);
});
onMounted(async () => {
  await load();
  // Re-attach to a batch that is still running (e.g. after a reload).
  const running = (await api.jobs(`contest:${props.id}`).catch(() => [])).find((j) => j.status === 'running');
  if (running) follow(running);
});
onUnmounted(() => {
  off();
  clearTimeout(timer);
});

const summary = computed(() => detail.value?.summary);
const title = computed(() => (summary.value ? problemTitle(summary.value.title, locale.value) || summary.value.name : ''));

// ---- problem list editing (letters follow the order) ----
const letter = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : `Z${i - 25}`);
async function saveProblems(ids: string[]) {
  try {
    detail.value = await api.updateContest(props.id, { problems: ids.map((problem, i) => ({ index: letter(i), problem })) });
  } catch (e) {
    message.error(errorMessage(e));
  }
}
const ids = () => detail.value?.problems.map((p) => p.problem) ?? [];
function move(i: number, d: number) {
  const list = ids();
  const j = i + d;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  saveProblems(list);
}
const remove = (i: number) => saveProblems(ids().filter((_, k) => k !== i));
const adding = ref<string[]>([]);
const addOptions = computed(() => {
  const inContest = new Set(ids());
  return allProblems.value.filter((p) => !inContest.has(p.id)).map((p) => ({ label: `${problemTitle(p.title, locale.value) || p.name} (${p.id})`, value: p.id }));
});
async function addProblems() {
  await saveProblems([...ids(), ...adding.value]);
  adding.value = [];
}

// ---- contest settings ----
const showEdit = ref(false);
const edit = reactive({ zh: '', en: '', polygonId: null as number | null });
function openEdit() {
  const s = summary.value!;
  Object.assign(edit, { zh: s.title.zh ?? '', en: s.title.en ?? '', polygonId: s.polygonId ?? null });
  showEdit.value = true;
}
async function saveEdit() {
  try {
    detail.value = await api.updateContest(props.id, { title: { ...summary.value!.title, zh: edit.zh, en: edit.en }, polygonId: edit.polygonId });
    showEdit.value = false;
  } catch (e) {
    message.error(errorMessage(e));
  }
}
async function deleteContest() {
  try {
    await api.deleteContest(props.id);
    router.push({ name: 'problems', query: { tab: 'contests' } });
  } catch (e) {
    message.error(errorMessage(e));
  }
}

// ---- batch actions ----
const ACTIONS: { action: ContestAction; icon: typeof Play }[] = [
  { action: 'generate', icon: FlaskConical },
  { action: 'invocation', icon: Play },
  { action: 'checks', icon: ClipboardCheck },
  { action: 'export', icon: Package },
];
const job = ref<JobInfo | null>(null);
const running = computed(() => job.value?.status === 'running');
const result = ref<ContestBatchResult | null>(null);
const resultByIndex = computed(() => new Map((result.value?.items ?? []).map((x) => [x.index, x])));
const pushMessage = ref('');

async function run(action: ContestAction) {
  try {
    const started = await api.contestBatch(props.id, { action, message: action === 'polygon-push' ? pushMessage.value.trim() || undefined : undefined });
    follow(started);
  } catch (e) {
    message.error(errorMessage(e));
  }
}
async function follow(started: JobInfo) {
  job.value = started;
  result.value = null;
  const done = await waitJob(started, (j) => (job.value = j));
  job.value = done;
  if (done.status === 'failed') return message.error(done.error ?? 'failed');
  if (done.status !== 'done') return;
  const r = done.result as ContestBatchResult;
  result.value = r;
  const bad = r.items.filter((x) => !x.ok).length;
  if (bad) message.warning(t('contest.batchBad', { n: bad }));
  else message.success(t(`contest.done.${r.action}`));
  if (r.file) api.downloadContestExport(props.id, r.file).catch((e) => message.error(errorMessage(e)));
  load();
}
const cancel = () => job.value && api.cancelJob(job.value.id).catch(() => {});

// ---- table ----
type Row = ContestDetail['problems'][number] & { pos: number };
const rows = computed<Row[]>(() => (detail.value?.problems ?? []).map((p, pos) => ({ ...p, pos })));
const expanded = ref<string[]>([]);

function resultCell(r: ContestBatchItem | undefined) {
  if (!r) return null;
  const icon = h(r.ok ? Check : r.details?.length ? CircleAlert : X, { size: 14, class: r.ok ? (r.details?.length ? 'warn' : 'good') : 'bad' });
  return h('span', { class: 'result' }, [icon, h('span', { class: 'result-text', title: r.message }, r.message)]);
}

const columns = computed<DataTableColumns<Row>>(() => [
  {
    type: 'expand',
    expandable: (r) => !!resultByIndex.value.get(r.index)?.details?.length,
    renderExpand: (r) =>
      h(
        'div',
        { class: 'details' },
        (resultByIndex.value.get(r.index)?.details ?? []).map((d) => h('div', { class: d.startsWith('error') ? 'bad' : '' }, d)),
      ),
  },
  { title: '#', key: 'index', width: 44, render: (r) => h('strong', r.index) },
  {
    title: t('contest.problem'),
    key: 'problem',
    render: (r) =>
      r.summary
        ? h('a', { class: 'link', onClick: () => router.push({ name: 'problem', params: { id: r.problem } }) }, [
            h('span', problemTitle(r.summary.title, locale.value) || r.summary.name),
            h('span', { class: 'mono sub' }, ` ${r.problem}`),
          ])
        : h('span', { class: 'bad' }, `${r.problem} — ${t('contest.missing')}`),
  },
  { title: t('contest.limits'), key: 'limits', width: 110, render: (r) => (r.summary ? `${r.summary.timeLimit / 1000}s / ${r.summary.memoryLimit}MB` : '') },
  {
    title: t('contest.progress'),
    key: 'progress',
    width: 150,
    render: (r) => {
      if (!r.summary) return null;
      const missing = checklist(r.summary).filter((c) => !c.ok).map((c) => t(`check.${c.key}`));
      const pct = progress(r.summary);
      return h(NTooltip, { disabled: !missing.length }, {
        trigger: () => h(NProgress, { type: 'line', percentage: pct, height: 6, showIndicator: false, status: pct === 100 ? 'success' : 'default' }),
        default: () => `${t('contest.todo')}: ${missing.join(', ')}`,
      });
    },
  },
  {
    title: 'Polygon',
    key: 'polygon',
    width: 90,
    render: (r) => (r.summary?.status.polygonId !== undefined ? h('span', { class: 'mono sub' }, `#${r.summary.status.polygonId}`) : h('span', { class: 'sub' }, '—')),
  },
  { title: t('contest.result'), key: 'result', minWidth: 160, render: (r) => resultCell(resultByIndex.value.get(r.index)) },
  {
    title: '',
    key: 'actions',
    width: 110,
    render: (r) =>
      h('span', { class: 'row-actions' }, [
        h(NButton, { size: 'tiny', quaternary: true, disabled: r.pos === 0 || running.value, onClick: () => move(r.pos, -1), title: t('contest.moveUp') }, () => h(ArrowUp, { size: 13 })),
        h(NButton, { size: 'tiny', quaternary: true, disabled: r.pos === rows.value.length - 1 || running.value, onClick: () => move(r.pos, 1), title: t('contest.moveDown') }, () => h(ArrowDown, { size: 13 })),
        h(NButton, { size: 'tiny', quaternary: true, disabled: running.value, onClick: () => remove(r.pos), title: t('common.remove') }, () => h(X, { size: 13 })),
      ]),
  },
]);
</script>

<template>
  <div class="page">
    <app-header>
      <template #left>
        <n-button size="small" quaternary @click="router.push({ name: 'problems', query: { tab: 'contests' } })">
          <template #icon><arrow-left /></template>{{ t('nav.contests') }}
        </n-button>
      </template>
      <strong v-if="summary">{{ title }}</strong>
      <span v-if="summary" class="mono sub">{{ summary.name }}</span>
      <n-tag v-if="summary?.polygonId" size="small" :bordered="false">Polygon #{{ summary.polygonId }}</n-tag>
      <template #right>
        <n-button size="small" :disabled="!summary" @click="router.push({ name: 'contest-print', params: { id } })">
          <template #icon><file-text /></template>{{ t('contest.statements') }}
        </n-button>
        <n-button size="small" quaternary :disabled="!summary" :title="t('contest.edit')" @click="openEdit"><pencil :size="15" /></n-button>
        <n-popconfirm @positive-click="deleteContest">
          <template #trigger><n-button size="small" quaternary :title="t('contest.delete')"><trash2 :size="15" /></n-button></template>
          {{ t('contest.deleteConfirm') }}
        </n-popconfirm>
      </template>
    </app-header>

    <main class="body">
      <n-alert v-if="loadError" type="error" :show-icon="false">{{ loadError }}</n-alert>
      <n-alert v-if="summary?.error" type="error" :show-icon="false">{{ summary.error }}</n-alert>
      <template v-if="detail">
        <div class="toolbar">
          <n-space size="small">
            <n-button v-for="a in ACTIONS" :key="a.action" size="small" :disabled="running || !rows.length" @click="run(a.action)">
              <template #icon><component :is="a.icon" /></template>{{ t(`contest.action.${a.action}`) }}
            </n-button>
            <n-popconfirm :show-icon="false" @positive-click="run('polygon-push')">
              <template #trigger>
                <n-button size="small" :disabled="running || !rows.length">
                  <template #icon><upload /></template>{{ t('contest.action.polygon-push') }}
                </n-button>
              </template>
              <div class="push-confirm">
                <div>{{ t('contest.pushConfirm', { n: rows.length }) }}</div>
                <n-input v-model:value="pushMessage" size="small" :placeholder="t('sync.commitMessage')" />
              </div>
            </n-popconfirm>
            <n-button v-if="running" size="small" type="warning" ghost @click="cancel">{{ t('common.cancel') }}</n-button>
          </n-space>
          <div v-if="running && job" class="progress">
            <n-progress type="line" :percentage="job.progress.total ? Math.round((job.progress.done / job.progress.total) * 100) : 0" :height="4" :show-indicator="false" />
            <span class="sub">{{ job.progress.message }}</span>
          </div>
        </div>

        <n-data-table
          size="small"
          :columns="columns"
          :data="rows"
          :row-key="(r: Row) => r.index"
          :expanded-row-keys="expanded"
          :bordered="false"
          @update:expanded-row-keys="(k: (string | number)[]) => (expanded = k.map(String))"
        />

        <div class="add">
          <n-select v-model:value="adding" multiple filterable size="small" :options="addOptions" :placeholder="t('contest.addPlaceholder')" style="max-width: 480px" />
          <n-button size="small" :disabled="!adding.length" @click="addProblems">{{ t('contest.add') }}</n-button>
        </div>
      </template>
    </main>

    <n-modal v-model:show="showEdit" preset="card" :title="t('contest.edit')" style="width: 460px">
      <n-form label-placement="left" label-width="auto">
        <n-form-item :label="t('create.titleZh')"><n-input v-model:value="edit.zh" /></n-form-item>
        <n-form-item :label="t('create.titleEn')"><n-input v-model:value="edit.en" /></n-form-item>
        <n-form-item :label="t('contest.polygonId')">
          <n-input-number v-model:value="edit.polygonId" :min="1" :show-button="false" clearable style="width: 100%" />
        </n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showEdit = false">{{ t('common.cancel') }}</n-button>
          <n-button type="primary" @click="saveEdit">{{ t('common.save') }}</n-button>
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
.body {
  flex: 1;
  overflow: auto;
  padding: 12px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.toolbar {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.progress {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-width: 600px;
}
.push-confirm {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 320px;
}
.add {
  display: flex;
  gap: 8px;
  align-items: center;
}
.sub {
  font-size: 12px;
  opacity: 0.6;
}
:deep(.link) {
  cursor: pointer;
}
:deep(.link:hover) {
  text-decoration: underline;
}
:deep(.result) {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
}
:deep(.result-text) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
:deep(.row-actions) {
  display: inline-flex;
}
:deep(.details) {
  font-size: 12px;
  font-family: Consolas, monospace;
  opacity: 0.85;
  white-space: pre-wrap;
}
:deep(.good) {
  color: #63e2b7;
}
:deep(.warn) {
  color: #e8b060;
}
:deep(.bad) {
  color: #e88080;
}
</style>
