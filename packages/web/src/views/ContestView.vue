<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { checkMessage, serverText } from '../lib/serverText';
import { useI18n } from 'vue-i18n';
import { useRouter, useRoute } from 'vue-router';
import {
  NAlert,
  NButton,
  NDataTable,
  NEmpty,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NModal,
  NProgress,
  NSelect,
  NSpace,
  NSplit,
  NTabs,
  NTabPane,
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
  X,
  RefreshCw,
  Plus,
  Clock3,
  MemoryStick,
  ListOrdered,
} from 'lucide-vue-next';
import { CONTEST_INDEX_RE, PROBLEM_NAME_RE, type ContestAction, type ContestBatchItem, type ContestBatchResult, type ContestDetail, type JobInfo, type ProblemSummary } from '@polyforge/shared';
import AppHeader from '../components/AppHeader.vue';
import AiDrawer from '../components/AiDrawer.vue';
import ContestSyncDialog from '../components/ContestSyncDialog.vue';
import ContestFiles from '../components/ContestFiles.vue';
import { useAi } from '../lib/ai';
import { api, errorMessage } from '../lib/api';
import { problemTitle } from '../lib/format';
import { waitJob } from '../lib/jobs';
import { confirmDeleteContest } from '../lib/deleteProblem';
import { checklist, progress } from '../lib/progress';
import { onWs } from '../lib/ws';
import { desktop } from '../lib/desktop';

const props = defineProps<{ id: string }>();
const { t, locale } = useI18n();
const router = useRouter();
const route = useRoute();
const showFiles = ref(!!route.query.contestFile);
watch(() => route.query.contestFile, file => { if (file) showFiles.value = true; });
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
const sidebarTab = ref('ai');
const aiSplitSize = ref(0.66);
const contentSplitSize = computed({
  get: () => showAi.value ? aiSplitSize.value : 1,
  set: (value: number) => { if (showAi.value) aiSplitSize.value = value; },
});
function onAiKeydown(e: KeyboardEvent) {
  if (desktop && (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'w') {
    e.preventDefault();
    showAi.value = false;
  }
}
const showSync = ref(false);

const off = onWs((e) => {
  ai.onWsEvent(e);
  if (e.type === 'job:progress' || e.type === 'ai:event' || e.type === 'build:done') return;
  clearTimeout(timer);
  timer = setTimeout(load, 300);
});
onMounted(async () => {
  await load();
  result.value = await api.contestLastResult(props.id).catch(() => null);
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
// Numbering is edited as one draft; moving rows keeps each problem's identity.
const letter = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : `Z${i - 25}`);
type Entry = { index: string; problem: string };
const saving = ref(false);
async function saveProblems(list: Entry[]): Promise<boolean> {
  if (saving.value) return false;
  saving.value = true;
  try {
    detail.value = await api.updateContest(props.id, { problems: list });
    return true;
  } catch (e) {
    message.error(serverText(errorMessage(e)));
    return false;
  } finally {
    saving.value = false;
  }
}
const entries = (): Entry[] => detail.value?.problems.map((p) => ({ index: p.index, problem: p.problem })) ?? [];
const ids = () => entries().map((e) => e.problem);
function move(i: number, d: number) {
  const list = entries();
  const j = i + d;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  saveProblems(list);
}
const remove = (i: number) => saveProblems(entries().filter((_, k) => k !== i));
/** The next letter after the ones in use: A, B, … then A1-style suffixes are left to the user. */
function nextIndex(used: Set<string>): string {
  for (let i = 0; ; i++) if (!used.has(letter(i))) return letter(i);
}
const showNumbering = ref(false);
const numberDraft = ref<Entry[]>([]);
const numberingSubmitted = ref(false);
const numberError = computed(() => numberDraft.value.some(e => !CONTEST_INDEX_RE.test(e.index.trim().toUpperCase())) || new Set(numberDraft.value.map(e => e.index.trim().toUpperCase())).size !== numberDraft.value.length);
function openNumbering() { numberDraft.value = entries(); numberingSubmitted.value = false; showNumbering.value = true; }
async function saveNumbering() {
  numberingSubmitted.value = true;
  if (numberError.value) return;
  if (await saveProblems(numberDraft.value.map(e => ({ ...e, index: e.index.trim().toUpperCase() })))) showNumbering.value = false;
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
const edit = reactive({ name: '', zh: '', en: '', polygonId: null as number | null });
const savingEdit = ref(false);
const editNameValid = computed(() => PROBLEM_NAME_RE.test(edit.name.trim()));
function openEdit() {
  const s = summary.value!;
  Object.assign(edit, { name: s.name, zh: s.title.zh ?? '', en: s.title.en ?? '', polygonId: s.polygonId ?? null });
  showEdit.value = true;
}
async function saveEdit() {
  if (!editNameValid.value || savingEdit.value) return;
  savingEdit.value = true;
  try {
    detail.value = await api.updateContest(props.id, { name: edit.name.trim(), title: { ...summary.value!.title, zh: edit.zh, en: edit.en }, polygonId: edit.polygonId });
    showEdit.value = false;
  } catch (e) {
    message.error(serverText(errorMessage(e)));
  } finally {
    savingEdit.value = false;
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
const showExport = ref(false);
const exportFormat = ref<'polygon' | 'lemonlime'>('lemonlime');
const resultByProblem = computed(() => new Map((result.value?.items ?? []).map((x) => [x.problem, x])));
async function run(action: ContestAction) {
  if (action === 'export') { showExport.value = true; return; }
  try {
    // Pushing to Polygon lives in the sync dialog (with its commit message).
    const started = await api.contestBatch(props.id, { action });
    follow(started);
  } catch (e) {
    message.error(errorMessage(e));
  }
}
async function exportContest() {
  try { follow(await api.contestBatch(props.id, { action: 'export', exportFormat: exportFormat.value })); showExport.value = false; }
  catch (e) { message.error(errorMessage(e)); }
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
const readyCount = computed(() => rows.value.filter(r => r.summary && progress(r.summary) === 100).length);
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
  ...(result.value ? [{
    type: 'expand',
    width: 36,
    expandable: (r: Row) => detailLines(resultByProblem.value.get(r.problem)).length > 0,
    renderExpand: (r: Row) =>
      h(
        'div',
        { class: 'details' },
        detailLines(resultByProblem.value.get(r.problem)).map((d) => h('div', { class: d.bad ? 'bad' : '' }, d.text)),
      ),
  } as const] : []),
  {
    title: '#',
    key: 'index',
    width: 84,
    render: (r) => h('strong', { class: 'index-label' }, r.index),
  },
  {
    title: t('contest.problem'),
    key: 'problem',
    minWidth: 240,
    render: (r) =>
      r.summary
        ? h('a', { class: 'problem-link', href: router.resolve({ name: 'problem', params: { id: r.problem }, query: { from: `contest:${props.id}` } }).href, onClick: (e: MouseEvent) => { if (!e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) { e.preventDefault(); openProblem(r); } } }, [
            h('span', { class: 'problem-name' }, problemTitle(r.summary.title, locale.value) || r.summary.name),
            h('span', { class: 'problem-meta mono' }, r.summary.name),
          ])
        : h('span', { class: 'bad' }, `${r.problem} — ${t('contest.missing')}`),
  },
  { title: t('contest.limits'), key: 'limits', width: 132, render: (r) => r.summary ? h('div', { class: 'limit-stack' }, [
    h('span', [h(Clock3, { size: 13 }), `${r.summary.timeLimit / 1000} s`]),
    h('span', [h(MemoryStick, { size: 13 }), `${r.summary.memoryLimit} MB`]),
  ]) : '—' },
  {
    title: t('contest.progress'),
    key: 'progress',
    width: 190,
    render: (r) => {
      if (!r.summary) return null;
      const missing = checklist(r.summary).filter((c) => !c.ok).map((c) => t(c.key === 'synced' ? 'check.syncTodo' : `check.${c.key}`));
      const pct = progress(r.summary);
      return h(NTooltip, { disabled: !missing.length }, {
        trigger: () => h('div', { class: 'readiness', tabindex: 0 }, [
          h('div', { class: 'readiness-label' }, [h('span', pct === 100 ? t('contest.ready') : t('contest.preparing')), h('span', { class: 'readiness-value' }, `${pct}%`)]),
          h(NProgress, { type: 'line', percentage: pct, height: 4, showIndicator: false, status: pct === 100 ? 'success' : 'default' }),
        ]),
        default: () => `${t('contest.todo')}: ${missing.join(', ')}`,
      });
    },
  },
  {
    title: 'Polygon',
    key: 'polygon',
    width: 116,
    render: (r: Row) => (r.summary?.status.polygonId !== undefined ? h(NTag, { size: 'small', bordered: false, class: 'polygon-tag' }, () => `#${r.summary!.status.polygonId}`) : h('span', { class: 'muted' }, t('status.unbound'))),
  },
  ...(result.value ? [{ title: t('contest.result'), key: 'result', minWidth: 180, render: (r: Row) => resultCell(resultByProblem.value.get(r.problem)) }] : []),
  {
    title: '',
    key: 'actions',
    width: 128,
    render: (r) =>
      h('span', { class: 'row-actions' }, [
        h(NButton, { size: 'small', quaternary: true, disabled: r.pos === 0 || running.value || saving.value, onClick: () => move(r.pos, -1), title: t('contest.moveUp'), 'aria-label': t('contest.moveUp') }, () => h(ArrowUp, { size: 15 })),
        h(NButton, { size: 'small', quaternary: true, disabled: r.pos === rows.value.length - 1 || running.value || saving.value, onClick: () => move(r.pos, 1), title: t('contest.moveDown'), 'aria-label': t('contest.moveDown') }, () => h(ArrowDown, { size: 15 })),
        h(NButton, { size: 'small', quaternary: true, type: 'error', disabled: running.value || saving.value, onClick: () => remove(r.pos), title: t('common.remove'), 'aria-label': t('common.remove') }, () => h(X, { size: 15 })),
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
        <n-button size="small" :disabled="!summary" @click="showFiles = true">比赛文件</n-button>
        <n-button size="small" :disabled="!summary" @click="router.push({ name: 'contest-print', params: { id } })">
          <template #icon><file-text /></template>{{ t('contest.statements') }}
        </n-button>
        <n-button size="small" :disabled="!summary" :type="showAi || ai.running.value ? 'primary' : 'default'" :aria-pressed="showAi" @click="showAi = !showAi">
          AI<template v-if="ai.state.changes.length"> · {{ ai.state.changes.length }}</template>
        </n-button>
        <n-button size="small" quaternary :disabled="!summary" :title="t('contest.edit')" @click="openEdit"><pencil :size="15" /></n-button>
        <n-button size="small" quaternary :title="t('contest.delete')" @click="deleteContest"><trash2 :size="15" /></n-button>
      </template>
    </app-header>
    <contest-sync-dialog v-model:show="showSync" :contest-id="id" :detail="detail" @changed="load" />
    <contest-files v-model:show="showFiles" :id="id" :detail="detail" />

    <n-split v-model:size="contentSplitSize" direction="horizontal" :min="0.35" :max="showAi ? 0.8 : 1" :disabled="!showAi" :resize-trigger-size="showAi ? 3 : 0" class="content-split">
      <template #1>
        <main class="body">
          <n-alert v-if="loadError" type="error" :show-icon="false">{{ loadError }}</n-alert>
          <n-alert v-if="summary?.error" type="error" :show-icon="false">{{ summary.error }}</n-alert>
          <template v-if="detail">
            <section class="contest-overview">
              <div><div class="eyebrow"><list-ordered :size="15" />{{ t('contest.lineup') }}</div><h1>{{ title }}</h1></div>
              <div class="contest-count"><strong>{{ rows.length }}</strong><span>{{ t('contest.problemCount') }}</span><span class="count-divider" /><span>{{ t('contest.readyCount', { n: readyCount }) }}</span></div>
            </section>
            <section class="problem-list">
            <div class="toolbar">
              <n-space size="small">
                <n-button v-for="a in ACTIONS" :key="a.action" size="small" :disabled="running || !rows.length" @click="run(a.action)">
                  <template #icon><component :is="a.icon" /></template>{{ t(`contest.action.${a.action}`) }}
                </n-button>
                <n-button size="small" :disabled="running || !rows.length" @click="showSync = true">
                  <template #icon><refresh-cw /></template>{{ t('toolbar.sync') }}
                </n-button>
                <n-button size="small" :disabled="running || !rows.length" @click="router.push({ name: 'contest-print', params: { id }, query: { style: 'oi', down: '1', doc: 'statements' } })">{{ t('oiFeatures.down') }}</n-button>
                <n-button v-if="running" size="small" type="warning" ghost @click="cancel">{{ t('common.cancel') }}</n-button>
              </n-space>
              <div v-if="running && job" class="progress">
                <n-progress type="line" :percentage="job.progress.total ? Math.round((job.progress.done / job.progress.total) * 100) : 0" :height="4" :show-indicator="false" />
                <span class="sub">{{ serverText(job.progress.message) }}</span>
              </div>
            </div>

            <n-data-table
              v-if="rows.length"
              class="contest-table"
              size="small"
              :columns="columns"
              :data="rows"
              :row-key="(r: Row) => r.problem"
              :row-props="rowProps"
              :expanded-row-keys="expanded"
              :bordered="false"
              :single-line="true"
              :scroll-x="result ? 1070 : 890"
              @update:expanded-row-keys="(k: (string | number)[]) => (expanded = k.map(String))"
            />
            <n-empty v-else class="empty-list" :description="t('contest.noProblems')"><template #extra>{{ t('contest.addHint') }}</template></n-empty>

            <div class="add">
              <n-select v-model:value="adding" multiple filterable size="small" :disabled="running || saving" :options="addOptions" :placeholder="t('contest.addPlaceholder')" class="add-select" />
              <n-button size="small" type="primary" :disabled="!adding.length || running || saving" @click="addProblems"><template #icon><plus /></template>{{ t('contest.add') }}</n-button>
              <span class="grow" />
              <n-button size="small" quaternary :disabled="running || saving || rows.length < 1 || showSync" :title="t('contest.renumberHint')" @click="openNumbering">{{ t('improve.numbering') }}</n-button>
            </div>
            </section>
          </template>
        </main>
      </template>
      <template #2>
        <aside v-show="showAi" class="ai-sidebar" :aria-label="t('palette.aiChat')" @keydown="onAiKeydown">
          <n-tabs v-model:value="sidebarTab" class="contest-side-tabs" pane-class="contest-side-pane" type="line" size="small">
            <n-tab-pane name="ai" tab="AI" display-directive="show"><ai-drawer embedded embedded-header :show="showAi && sidebarTab === 'ai'" @update:show="showAi = $event" :ai="ai" :problem-id="`contest:${id}`" /></n-tab-pane>
            <n-tab-pane name="results" :tab="t('improve.results')" display-directive="show">
              <div class="check-results"><div v-for="item in result?.items ?? []" :key="item.problem"><strong>{{ rows.find(r => r.problem === item.problem)?.index ?? item.index }} · {{ item.problem }}</strong><div v-for="(line, i) in detailLines(item)" :key="i" :class="{ bad: line.bad }">{{ line.text }}</div></div></div>
            </n-tab-pane>
          </n-tabs>
        </aside>
      </template>
    </n-split>

    <n-modal v-model:show="showExport" preset="card" :title="t('oiFeatures.exportTitle')" style="width: min(520px, 94vw)">
      <n-select v-model:value="exportFormat" :options="[{ value: 'lemonlime', label: 'LemonLime (.cdf + data + source)' }, { value: 'polygon', label: t('oiFeatures.polygon') }]" />
      <n-alert v-if="exportFormat === 'lemonlime'" type="info" style="margin-top: 12px">{{ t('oiFeatures.exportHint') }}</n-alert>
      <template #footer><n-space justify="end"><n-button @click="showExport = false">{{ t('common.cancel') }}</n-button><n-button type="primary" :disabled="running" @click="exportContest">{{ t('contest.export') }}</n-button></n-space></template>
    </n-modal>
    <n-modal v-model:show="showNumbering" preset="card" :title="t('improve.numbering')" style="width: 560px">
      <div style="max-height: 60vh; overflow: auto">
        <n-form-item v-for="entry in numberDraft" :key="entry.problem" :label="entry.problem">
          <n-input v-model:value="entry.index" :disabled="saving" />
        </n-form-item>
      </div>
      <n-alert v-if="numberingSubmitted && numberError" type="warning">{{ t('improve.numberError') }}</n-alert>
      <template #footer><n-space justify="end">
        <n-button :disabled="saving" @click="numberDraft = numberDraft.map((e, i) => ({ ...e, index: letter(i) }))">{{ t('contest.renumber') }}</n-button>
        <n-button @click="showNumbering = false">{{ t('common.cancel') }}</n-button>
        <n-button type="primary" :disabled="running" :loading="saving" @click="saveNumbering">{{ t('common.save') }}</n-button>
      </n-space></template>
    </n-modal>
    <n-modal v-model:show="showEdit" preset="card" :title="t('contest.edit')" style="width: 460px">
      <n-form label-placement="left" label-width="auto">
        <n-form-item :label="t('create.name')" :feedback="editNameValid ? undefined : t('create.nameRule')" :validation-status="editNameValid ? undefined : 'error'"><n-input v-model:value="edit.name" :disabled="savingEdit" /></n-form-item>
        <n-form-item :label="t('create.titleZh')"><n-input v-model:value="edit.zh" /></n-form-item>
        <n-form-item :label="t('create.titleEn')"><n-input v-model:value="edit.en" /></n-form-item>
        <n-form-item :label="t('contest.polygonId')">
          <n-input-number v-model:value="edit.polygonId" :min="1" :show-button="false" clearable style="width: 100%" />
        </n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showEdit = false">{{ t('common.cancel') }}</n-button>
          <n-button type="primary" :loading="savingEdit" :disabled="!editNameValid" @click="saveEdit">{{ t('common.save') }}</n-button>
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
  height: 100%;
  box-sizing: border-box;
  min-width: 0;
  overflow: auto;
  padding: 22px 26px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.contest-side-tabs { height: 100%; display: flex; flex-direction: column; }
.contest-side-tabs :deep(.n-tabs-nav) { padding: 0 12px; }
.contest-side-tabs :deep(.n-tabs-pane-wrapper) { flex: 1; min-height: 0; }
.contest-side-tabs :deep(.contest-side-pane) { height: 100%; padding: 0; }
.check-results { height: 100%; overflow: auto; padding: 12px; box-sizing: border-box; white-space: pre-wrap; }
.content-split { flex: 1; min-height: 0; }
.ai-sidebar {
  height: 100%;
  min-width: 0;
  overflow: hidden;
  border-left: 1px solid var(--pf-border);
  background: var(--pf-surface);
}
.toolbar {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--pf-border);
}
.progress {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-width: 600px;
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
  padding: 12px 16px;
  border-top: 1px solid var(--pf-border);
  background: var(--pf-toolbar-bg);
  flex-wrap: wrap;
}
.add-select { flex: 1; min-width: 220px; max-width: 460px; }
.contest-overview { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 24px; }
.eyebrow { display: flex; align-items: center; gap: 7px; color: var(--pf-accent); font-size: 12px; font-weight: 600; }
h1 { margin: 6px 0 0; font-size: 22px; font-weight: 650; letter-spacing: -0.5px; overflow-wrap: anywhere; }
.contest-count { display: flex; align-items: baseline; gap: 8px; white-space: nowrap; font-size: 13px; color: var(--pf-text-secondary); }
.contest-count strong { color: var(--pf-text); font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; }
.count-divider { align-self: center; height: 18px; border-left: 1px solid var(--pf-border); margin: 0 6px; }
.problem-list { background: var(--pf-surface); border: 1px solid var(--pf-border); border-radius: 10px; overflow: hidden; box-shadow: var(--pf-shadow); flex-shrink: 0; }
.empty-list { padding: 64px 24px; }
.contest-table :deep(.n-data-table-th) { background: var(--pf-toolbar-bg); color: var(--pf-text-secondary); font-size: 12px; font-weight: 500; padding: 9px 14px; }
.contest-table :deep(.n-data-table-td) { padding: 12px 14px; background: var(--pf-surface); transition: background 150ms; }
.contest-table :deep(.n-data-table-tr:hover .n-data-table-td) { background: var(--pf-selected); }
:deep(.problem-link) { display: flex; flex-direction: column; gap: 3px; color: inherit; text-decoration: none; min-width: 0; }
:deep(.problem-name) { font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
:deep(.problem-link:hover .problem-name) { color: var(--pf-accent); }
:deep(.problem-meta), :deep(.muted) { color: var(--pf-text-secondary); font-size: 12px; }
:deep(.index-input) { --n-color: var(--pf-selected) !important; --n-border: 1px solid transparent !important; --n-text-color: var(--pf-accent) !important; }
:deep(.limit-stack) { display: flex; flex-direction: column; gap: 3px; color: var(--pf-text-secondary); font-size: 12px; font-variant-numeric: tabular-nums; }
:deep(.limit-stack span) { display: flex; align-items: center; gap: 7px; }
:deep(.readiness) { max-width: 160px; }
:deep(.readiness-label) { display: flex; justify-content: space-between; margin-bottom: 5px; font-size: 12px; color: var(--pf-text-secondary); }
:deep(.readiness-value) { color: var(--pf-text); font-variant-numeric: tabular-nums; }
:deep(.row-actions) { gap: 2px; opacity: 0.65; }
:deep(.clickable-row:hover .row-actions), :deep(.row-actions:focus-within) { opacity: 1; }
@media (max-width: 900px) {
  .body { padding: 20px 16px; }
  .contest-overview { align-items: flex-start; flex-direction: column; gap: 12px; }
}
.sub {
  font-size: 12px;
  opacity: 0.6;
}
/* The whole row opens the problem: no underline on the title. */
:deep(.link) {
  cursor: pointer;
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
  color: light-dark(#16804a, #63e2b7);
}
:deep(.warn) {
  color: light-dark(#986415, #e8b060);
}
:deep(.bad) {
  color: light-dark(#c53b3b, #e88080);
}
</style>
