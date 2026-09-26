<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, reactive, ref } from 'vue';
import { checkMessage, serverText } from '../lib/serverText';
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
  useDialog,
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
import AiDrawer from '../components/AiDrawer.vue';
import { useAi } from '../lib/ai';
import { api, errorMessage } from '../lib/api';
import { problemTitle } from '../lib/format';
import { waitJob } from '../lib/jobs';
import { confirmDeleteContest } from '../lib/deleteProblem';
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
/** The contest AI: sessions over all problems of the contest. */
const ai = useAi(`contest:${props.id}`);
const showAi = ref(false);

const off = onWs((e) => {
  ai.onWsEvent(e);
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

// ---- problem list editing ----
// Letters are edited directly (A, B, …, or A1, A2); moving a problem keeps the letters
// in place and swaps the problems; "renumber" assigns A, B, C… by position.
const letter = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : `Z${i - 25}`);
type Entry = { index: string; problem: string };
async function saveProblems(list: Entry[]): Promise<boolean> {
  try {
    detail.value = await api.updateContest(props.id, { problems: list });
    version.value++;
    return true;
  } catch (e) {
    message.error(serverText(errorMessage(e)));
    return false;
  }
}
/** Bumped on every save / reload so the letter inputs drop unsaved text. */
const version = ref(0);
const entries = (): Entry[] => detail.value?.problems.map((p) => ({ index: p.index, problem: p.problem })) ?? [];
const ids = () => entries().map((e) => e.problem);
function move(i: number, d: number) {
  const list = entries();
  const j = i + d;
  if (j < 0 || j >= list.length) return;
  [list[i].problem, list[j].problem] = [list[j].problem, list[i].problem];
  saveProblems(list);
}
const remove = (i: number) => saveProblems(entries().filter((_, k) => k !== i));
const renumber = () => saveProblems(entries().map((e, i) => ({ index: letter(i), problem: e.problem })));
/** The next letter after the ones in use: A, B, … then A1-style suffixes are left to the user. */
function nextIndex(used: Set<string>): string {
  for (let i = 0; ; i++) if (!used.has(letter(i))) return letter(i);
}
async function setIndex(pos: number, value: string) {
  const index = value.trim().toUpperCase();
  const list = entries();
  if (!index || index === list[pos].index) return;
  list[pos].index = index;
  if (!(await saveProblems(list))) version.value++;
}
const adding = ref<string[]>([]);
const addOptions = computed(() => {
  const inContest = new Set(ids());
  return allProblems.value.filter((p) => !inContest.has(p.id)).map((p) => ({ label: `${problemTitle(p.title, locale.value) || p.name} (${p.id})`, value: p.id }));
});
async function addProblems() {
  const list = entries();
  const used = new Set(list.map((e) => e.index));
  for (const problem of adding.value) {
    const index = nextIndex(used);
    used.add(index);
    list.push({ index, problem });
  }
  if (await saveProblems(list)) adding.value = [];
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
const dialog = useDialog();
function deleteContest() {
  confirmDeleteContest(dialog, message, props.id, title.value).then((ok) => {
    if (ok) router.push({ name: 'problems', query: { tab: 'contests' } });
  });
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

/** Result details in the UI language: local checks by code, other lines by pattern. */
function detailLines(r: ContestBatchItem | undefined): { text: string; bad: boolean }[] {
  if (!r) return [];
  if (r.checks) return r.checks.map((c) => ({ text: `${t(`checkLevel.${c.level}`)}：${checkMessage(c)}${c.file ? `（${c.file}）` : ''}`, bad: c.level === 'error' }));
  return (r.details ?? []).map((d) => ({ text: serverText(d), bad: d.startsWith('error') }));
}

function resultCell(r: ContestBatchItem | undefined) {
  if (!r) return null;
  const icon = h(r.ok ? Check : r.details?.length ? CircleAlert : X, { size: 14, class: r.ok ? (r.details?.length ? 'warn' : 'good') : 'bad' });
  return h('span', { class: 'result' }, [icon, h('span', { class: 'result-text', title: serverText(r.message) }, serverText(r.message))]);
}

/** Clicking anywhere on a row opens the problem, except on its controls (letter, buttons, expand). */
const openProblem = (r: Row) => router.push({ name: 'problem', params: { id: r.problem }, query: { from: `contest:${props.id}` } });
const rowProps = (r: Row) => ({
  class: r.summary ? 'clickable-row' : undefined,
  onClick: (e: MouseEvent) => {
    if (!r.summary || (e.target as HTMLElement).closest('input, button, a, .n-button, .n-input, .n-data-table-expand-trigger, .n-data-table-td--expand')) return;
    openProblem(r);
  },
});

const columns = computed<DataTableColumns<Row>>(() => [
  {
    type: 'expand',
    expandable: (r) => detailLines(resultByIndex.value.get(r.index)).length > 0,
    renderExpand: (r) =>
      h(
        'div',
        { class: 'details' },
        detailLines(resultByIndex.value.get(r.index)).map((d) => h('div', { class: d.bad ? 'bad' : '' }, d.text)),
      ),
  },
  {
    title: '#',
    key: 'index',
    width: 70,
    render: (r) =>
      h(NInput, {
        // Uncontrolled: starts from the saved letter, saved on Enter / blur, remounted after a save.
        key: `${r.index}|${r.problem}|${version.value}`,
        size: 'small',
        defaultValue: r.index,
        class: 'index-input',
        disabled: running.value,
        title: t('contest.editIndex'),
        onChange: (v: string) => setIndex(r.pos, v),
      }),
  },
  {
    title: t('contest.problem'),
    key: 'problem',
    render: (r) =>
      r.summary
        ? h('a', { class: 'link', onClick: () => openProblem(r) }, [
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
      const missing = checklist(r.summary).filter((c) => !c.ok).map((c) => t(c.key === 'synced' ? 'check.syncTodo' : `check.${c.key}`));
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
        <n-button size="small" :disabled="!summary" :type="ai.running.value ? 'primary' : 'default'" @click="showAi = true">
          AI<template v-if="ai.state.changes.length"> · {{ ai.state.changes.length }}</template>
        </n-button>
        <n-button size="small" quaternary :disabled="!summary" :title="t('contest.edit')" @click="openEdit"><pencil :size="15" /></n-button>
        <n-button size="small" quaternary :title="t('contest.delete')" @click="deleteContest"><trash2 :size="15" /></n-button>
      </template>
    </app-header>
    <ai-drawer v-model:show="showAi" :ai="ai" :problem-id="`contest:${id}`" />

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
            <span class="sub">{{ serverText(job.progress.message) }}</span>
          </div>
        </div>

        <n-data-table
          size="small"
          :columns="columns"
          :data="rows"
          :row-key="(r: Row) => r.index"
          :row-props="rowProps"
          :expanded-row-keys="expanded"
          :bordered="false"
          @update:expanded-row-keys="(k: (string | number)[]) => (expanded = k.map(String))"
        />

        <div class="add">
          <n-select v-model:value="adding" multiple filterable size="small" :options="addOptions" :placeholder="t('contest.addPlaceholder')" style="max-width: 480px" />
          <n-button size="small" :disabled="!adding.length" @click="addProblems">{{ t('contest.add') }}</n-button>
          <span class="grow" />
          <n-button size="small" quaternary :disabled="running || rows.length < 2" :title="t('contest.renumberHint')" @click="renumber">{{ t('contest.renumber') }}</n-button>
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
:deep(.clickable-row) {
  cursor: pointer;
}
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
.grow {
  flex: 1;
}
:deep(.index-input input) {
  font-weight: bold;
  text-align: center;
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
