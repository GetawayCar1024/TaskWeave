<script setup lang="ts">
import { ignoreWhitespace } from '../lib/diffOptions';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { serverText } from '../lib/serverText';
import { useI18n } from 'vue-i18n';
import { NButton, NCheckbox, NInput, NSelect, NSpace, NTag, useMessage } from 'naive-ui';
import {
  invocationRefs,
  parseIndexList,
  testsetsOf,
  type Invocation,
  type InvocationCell,
  type InvocationSelection,
  type InvocationSolution,
  type InvocationSummary,
  type InvocationTestRef,
  type TestFileResponse,
  type TestInfo,
  type Verdict,
} from '@polyforge/shared';
import { api, errorMessage } from '../lib/api';
import type { Judge } from '../lib/judge';
import { vKeepScroll } from '../lib/keepScroll';
import { monaco } from '../lib/monaco';
import { useResizable } from '../lib/resize';
import { tagType } from '../lib/tags';
import { Check, ChevronDown, ChevronUp, X } from 'lucide-vue-next';
import { fmtMem, verdictClass } from '../lib/verdict';
import type { Workspace } from '../lib/workspace';
import ToolWindow from './ToolWindow.vue';

/** 批量评测: solutions × tests of any testsets. The job keeps running when the window is closed. */
const props = defineProps<{ show: boolean; ws: Workspace; judge: Judge; problemId: string }>();
const emit = defineEmits<{ 'update:show': [boolean] }>();
const { t } = useI18n();
const message = useMessage();

const solutions = computed(() => props.ws.state.detail?.config?.solutions ?? []);
const picked = ref<string[]>([]);
watch(solutions, (list) => {
  picked.value = picked.value.filter((p) => list.some((s) => s.source === p));
});
const history = ref<InvocationSummary[]>([]);
const inv = ref<Invocation | null>(null);
const job = computed(() => props.judge.state.jobs.invocation);
const running = computed(() => job.value?.status === 'running');
/** The invocation of the running job (to get back to it from an older one). */
const liveId = computed(() => (running.value ? history.value.find((h) => h.status === 'running')?.id ?? null : null));

watch(
  () => props.show,
  async (s) => {
    if (!s) return;
    if (picked.value.length === 0) picked.value = solutions.value.map((x) => x.source);
    for (const ts of testsets.value) if (ts !== 'tests' && !(ts in props.judge.state.manifests)) void props.judge.loadManifest(ts);
    await Promise.all([loadHistory(), loadInvocation()]);
  },
);

async function loadHistory() {
  history.value = await api.invocations(props.problemId).catch(() => []);
}

let pending: ReturnType<typeof setTimeout> | null = null;
async function loadInvocation() {
  const id = props.judge.state.invocationId;
  if (!id) return (inv.value = null);
  try {
    const next = await api.invocation(props.problemId, id);
    if (props.judge.state.invocationId === id) inv.value = next;
  } catch {
    inv.value = null;
  }
}
// Live refresh while running, throttled.
watch(
  () => [props.judge.state.invocationVersion, props.judge.state.invocationId],
  () => {
    if (!props.show || pending) return;
    pending = setTimeout(async () => {
      pending = null;
      await loadInvocation();
      if (!running.value || !liveId.value) loadHistory();
    }, 250);
  },
);
onBeforeUnmount(() => pending && clearTimeout(pending));

// ---- test selection: any tests of any testsets ----
const testsets = computed(() => (props.ws.state.detail?.config ? testsetsOf(props.ws.state.detail.config).map((x) => x.name) : ['tests']));
const activeTs = ref('tests');
watch(testsets, (list) => !list.includes(activeTs.value) && (activeTs.value = 'tests'));
watch(activeTs, (ts) => ts !== 'tests' && !(ts in props.judge.state.manifests) && props.judge.loadManifest(ts));
const manifestOf = (ts: string) => (ts === 'tests' ? props.judge.state.manifest : props.judge.state.manifests[ts]) ?? null;
const testsOf = (ts: string): TestInfo[] => manifestOf(ts)?.tests ?? [];

/** Per testset: every test (also those generated later), or the chosen indices. */
const sel = ref<Record<string, 'all' | Set<number>>>({ tests: 'all' });
const selOf = (ts: string) => sel.value[ts] ?? new Set<number>();
const isOn = (ts: string, i: number) => {
  const s = selOf(ts);
  return s === 'all' || s.has(i);
};
function setTs(ts: string, value: 'all' | number[]) {
  const all = testsOf(ts);
  sel.value = { ...sel.value, [ts]: value === 'all' || (all.length > 0 && value.length === all.length && all.every((x) => value.includes(x.index))) ? 'all' : new Set(value) };
}
/** Number of selected tests; null = the whole testset, which is not generated yet. */
function countOf(ts: string): number | null {
  const s = selOf(ts);
  if (s === 'all') return manifestOf(ts) ? testsOf(ts).length : null;
  const known = new Set(testsOf(ts).map((x) => x.index));
  return [...s].filter((i) => known.has(i)).length;
}
const tsState = (ts: string) => {
  const s = selOf(ts);
  const n = countOf(ts);
  return { all: s === 'all', some: s !== 'all' && (n ?? 0) > 0 };
};

const activeTests = computed(() => testsOf(activeTs.value));
let lastClicked: number | null = null;
function toggleTest(i: number, e: MouseEvent) {
  const ts = activeTs.value;
  const cur = new Set(activeTests.value.filter((x) => isOn(ts, x.index)).map((x) => x.index));
  if (e.shiftKey && lastClicked !== null) {
    // Shift-click: set the whole range to the new state of the clicked test.
    const on = !cur.has(i);
    const [lo, hi] = [Math.min(lastClicked, i), Math.max(lastClicked, i)];
    for (const x of activeTests.value) if (x.index >= lo && x.index <= hi) on ? cur.add(x.index) : cur.delete(x.index);
  } else if (cur.has(i)) cur.delete(i);
  else cur.add(i);
  lastClicked = i;
  setTs(ts, [...cur]);
}
/** Tests of the shown testset by group (subtask); ungrouped tests form one block. */
const blocks = computed(() => {
  const m = new Map<string, TestInfo[]>();
  for (const x of activeTests.value) {
    const k = x.group ?? '';
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(x);
  }
  return [...m].map(([group, tests]) => {
    const on = tests.filter((x) => isOn(activeTs.value, x.index)).length;
    return { group, tests, all: on === tests.length, some: on > 0 };
  });
});
function toggleGroup(block: { tests: TestInfo[]; all: boolean }) {
  const ts = activeTs.value;
  const cur = new Set(activeTests.value.filter((x) => isOn(ts, x.index)).map((x) => x.index));
  for (const x of block.tests) block.all ? cur.delete(x.index) : cur.add(x.index);
  setTs(ts, [...cur]);
}
const rangeText = ref('');
function applyRange() {
  const known = new Set(activeTests.value.map((x) => x.index));
  setTs(activeTs.value, parseIndexList(rangeText.value).filter((i) => known.has(i)));
}
function selectEverything(on: boolean) {
  sel.value = Object.fromEntries(testsets.value.map((ts) => [ts, on ? 'all' : new Set<number>()]));
}

const selection = computed<InvocationSelection>(() =>
  testsets.value.flatMap((ts) => {
    const s = selOf(ts);
    if (s === 'all') return [{ testset: ts }];
    const known = new Set(testsOf(ts).map((x) => x.index));
    const list = [...s].filter((i) => known.has(i)).sort((a, b) => a - b);
    return list.length ? [{ testset: ts, tests: list }] : [];
  }),
);
const testCount = computed(() => testsets.value.reduce((a, ts) => a + (countOf(ts) ?? 0), 0));
const pendingWhole = computed(() => testsets.value.filter((ts) => countOf(ts) === null));
const canStart = computed(() => picked.value.length > 0 && selection.value.length > 0);

async function start() {
  try {
    await props.judge.startInvocation(picked.value, undefined, undefined, selection.value);
    await Promise.all([loadInvocation(), loadHistory()]);
  } catch (e) {
    message.error(errorMessage(e));
  }
}

const historyOptions = computed(() =>
  history.value.map((h) => {
    const sets = h.testsets?.join(' + ') ?? (h.testset && h.testset !== 'tests' ? h.testset : '');
    const state = h.status === 'running' ? t('tool.status.running') : h.status !== 'done' ? t(`tool.status.${h.status}`) : h.ok ? t('inv.pass') : t('inv.fail');
    return { label: `${new Date(h.createdAt).toLocaleString()} · ${sets ? `${sets} · ` : ''}${h.solutions}×${h.tests} · ${state}`, value: h.id };
  }),
);

const shortName = (s: string) => s.split('/').pop()!;

// ---- setup area (collapsible to give the matrix room) ----
const SETUP_KEY = 'polyforge-inv-setup-collapsed';
const setupCollapsed = ref(localStorage.getItem(SETUP_KEY) === '1');
watch(setupCollapsed, (v) => localStorage.setItem(SETUP_KEY, v ? '1' : '0'));
/** Height of the test chips, set by dragging their bottom border. */
const chipsSize = useResizable('polyforge-inv-chips-height', { edge: 'bottom', initial: 120, min: 40, max: () => window.innerHeight * 0.4 });

// ---- matrix ----
const refs = computed<InvocationTestRef[]>(() => (inv.value ? invocationRefs(inv.value) : []));
/** Show testset names: tests of several testsets, or of another one than "tests". */
const qualified = computed(() => refs.value.some((r) => r.testset !== (refs.value[0]?.testset ?? 'tests')) || refs.value.some((r) => r.testset !== 'tests'));
const groupOf = computed(() => {
  const m = new Map<string, string | undefined>();
  for (const ts of new Set(refs.value.map((r) => r.testset))) for (const x of testsOf(ts)) m.set(`${ts}:${x.index}`, x.group);
  return m;
});
const testLabel = (r: InvocationTestRef) => (qualified.value ? `${r.testset} #${r.index}` : `#${r.index}`);

const onlyIssues = ref(false);
/** A test where some solution did not pass, or broke its tag. */
const rowHasIssue = (ti: number) =>
  inv.value?.solutions.some((s, si) => {
    const c = inv.value!.cells[si]?.[ti];
    return !!s.expectation?.unexpected.includes(ti) || !!s.expectation?.slow?.includes(ti) || (!!c && c.verdict !== 'OK');
  }) ?? false;
/** Rows to draw: test positions, with a heading before each testset when several are shown. */
const rows = computed(() => {
  const out: ({ kind: 'ts'; testset: string; n: number } | { kind: 'test'; ti: number; ref: InvocationTestRef })[] = [];
  let last = '';
  const multi = new Set(refs.value.map((r) => r.testset)).size > 1;
  refs.value.forEach((r, ti) => {
    if (onlyIssues.value && !rowHasIssue(ti)) return;
    if (multi && r.testset !== last) out.push({ kind: 'ts', testset: r.testset, n: refs.value.filter((x) => x.testset === r.testset).length });
    last = r.testset;
    out.push({ kind: 'test', ti, ref: r });
  });
  return out;
});

/** Verdict counts of a solution (non-OK first), for its header. */
function verdictCounts(si: number): { v: Verdict; n: number }[] {
  const m = new Map<Verdict, number>();
  for (const c of inv.value?.cells[si] ?? []) if (c) m.set(c.verdict, (m.get(c.verdict) ?? 0) + 1);
  return [...m].map(([v, n]) => ({ v, n })).sort((a, b) => (a.v === 'OK' ? 1 : 0) - (b.v === 'OK' ? 1 : 0) || b.n - a.n);
}
const doneCells = (si: number) => (inv.value?.cells[si] ?? []).filter(Boolean).length;
function expectationText(s: InvocationSolution): string {
  if (!s.expectation) return '';
  const parts: string[] = [];
  if (s.expectation.unexpected.length) parts.push(t('inv.unexpectedN', { n: s.expectation.unexpected.length }));
  if (s.expectation.missing) parts.push(t('inv.missing', { v: s.expectation.missing.join('/') }));
  if (s.expectation.slow?.length) parts.push(t('inv.slowN', { n: s.expectation.slow.length }));
  return parts.join('\n');
}

// ---- scores (points / subtasks) ----
const scoreGroups = computed(() => {
  const first = inv.value?.solutions.find((x) => x.score?.groups.length);
  return first?.score?.groups.map((g) => ({ key: `${g.testset ?? ''}/${g.name}`, testset: g.testset, name: g.name, max: g.max })) ?? [];
});
const scoreTestsets = computed(() => inv.value?.solutions.find((x) => x.score?.testsets?.length)?.score?.testsets?.map((x) => ({ testset: x.testset, max: x.max })) ?? []);
const hasScores = computed(() => !!inv.value?.solutions.some((x) => x.score));
function scoreClass(score: number, max: number) {
  return score >= max && max > 0 ? 'good' : score > 0 ? 'warn' : 'bad';
}

function cellTitle(c: InvocationCell | null): string {
  if (!c) return '';
  return [`${c.verdict}  CPU: ${c.timeMs} ms  Wall: ${c.wallMs ?? '?'} ms  ${fmtMem(c.memoryKb)}`, c.points !== undefined ? `${t('tests.points')}: ${c.points}` : '', serverText(c.message)].filter(Boolean).join('\n');
}
function cellClass(si: number, ti: number): string[] {
  const s = inv.value?.solutions[si];
  const c = inv.value?.cells[si]?.[ti];
  const out: string[] = c ? [verdictClass(c.verdict)] : ['empty'];
  if (s?.expectation?.unexpected.includes(ti)) out.push('unexpected');
  if (s?.expectation?.slow?.includes(ti)) out.push('slow');
  return out;
}

// ---- cell detail ----
const detail = ref<{ si: number; ti: number; cell: InvocationCell; files: Record<string, TestFileResponse | null> } | null>(null);

async function openCell(si: number, ti: number) {
  const cell = inv.value?.cells[si]?.[ti];
  const r = refs.value[ti];
  if (!inv.value || !cell || !r) return;
  detail.value = { si, ti, cell, files: {} };
  const [input, answer, output] = await Promise.all([
    api.testFile(props.problemId, r.index, 'in', r.testset).catch(() => null),
    api.testFile(props.problemId, r.index, 'ans', r.testset).catch(() => null),
    cell.hasOutput ? api.invocationOutput(props.problemId, inv.value.id, si, r.index, r.testset).catch(() => null) : Promise.resolve(null),
  ]);
  if (detail.value?.si !== si || detail.value.ti !== ti) return;
  detail.value.files = { input, output, answer };
  await nextTick();
  showDiff(answer?.content ?? '', output?.content ?? '');
}

// Answer (left) vs output (right), whitespace-insensitive like token checkers.
const diffHost = ref<HTMLDivElement>();
let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;
let diffModels: monaco.editor.ITextModel[] = [];
function disposeDiff() {
  diffEditor?.dispose();
  diffEditor = null;
  diffModels.forEach((m) => m.dispose());
  diffModels = [];
}
function showDiff(answer: string, output: string) {
  disposeDiff();
  if (!diffHost.value) return;
  diffModels = [monaco.editor.createModel(answer, 'plaintext'), monaco.editor.createModel(output, 'plaintext')];
  diffEditor = monaco.editor.createDiffEditor(diffHost.value, {
    automaticLayout: true,
    readOnly: true,
    originalEditable: false,
    ignoreTrimWhitespace: ignoreWhitespace.value,
    renderWhitespace: 'all',
    renderSideBySide: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
  });
  diffEditor.setModel({ original: diffModels[0], modified: diffModels[1] });
}
watch(detail, (d) => !d && disposeDiff());
onBeforeUnmount(disposeDiff);
watch(ignoreWhitespace, (value) => diffEditor?.updateOptions({ ignoreTrimWhitespace: value }));
</script>

<template>
  <tool-window
    :show="show"
    :title="t('toolbar.invocation')"
    width="min(1320px, 96vw)"
    fill
    :status="job?.status ?? null"
    :progress="job?.progress ?? null"
    :error="inv?.error"
    @update:show="emit('update:show', $event)"
  >
    <template #actions>
      <n-button v-if="liveId && liveId !== judge.state.invocationId" size="small" type="info" secondary @click="judge.state.invocationId = liveId">
        <span class="pf-run-dot" />{{ t('inv.followLive') }}
      </n-button>
      <n-select
        size="small"
        style="width: 320px"
        :value="judge.state.invocationId"
        :options="historyOptions"
        :placeholder="t('inv.history')"
        :consistent-menu-width="false"
        @update:value="(v: string) => (judge.state.invocationId = v)"
      />
      <n-button size="small" quaternary :title="setupCollapsed ? t('inv.expandSetup') : t('inv.collapseSetup')" @click="setupCollapsed = !setupCollapsed">
        <component :is="setupCollapsed ? ChevronDown : ChevronUp" :size="16" />
      </n-button>
    </template>

    <div v-show="!setupCollapsed" class="setup">
      <section class="pane solutions-pane">
        <div class="pane-title">
          <n-checkbox
            :checked="picked.length > 0 && picked.length === solutions.length"
            :indeterminate="picked.length > 0 && picked.length < solutions.length"
            :disabled="!solutions.length"
            @update:checked="(v: boolean) => (picked = v ? solutions.map((x) => x.source) : [])"
          >
            <strong>{{ t('inv.solutions') }}</strong>
          </n-checkbox>
          <span class="dim small">{{ picked.length }} / {{ solutions.length }}</span>
        </div>
        <div v-keep-scroll="`inv-solutions:${problemId}`" class="sol-list">
          <label v-for="s in solutions" :key="s.source" class="sol-item" :class="{ on: picked.includes(s.source) }">
            <n-checkbox
              :checked="picked.includes(s.source)"
              @update:checked="(v: boolean) => (picked = v ? [...picked, s.source] : picked.filter((p) => p !== s.source))"
            />
            <span class="mono sol-name" :title="s.source">{{ shortName(s.source) }}</span>
            <n-tag size="tiny" :type="tagType(s.tag)" :bordered="false">{{ s.tag }}</n-tag>
          </label>
        </div>
      </section>

      <section class="pane tests-pane">
        <div class="pane-title">
          <n-checkbox
            :checked="testsets.every((ts) => tsState(ts).all)"
            :indeterminate="!testsets.every((ts) => tsState(ts).all) && testsets.some((ts) => tsState(ts).all || tsState(ts).some)"
            @update:checked="selectEverything"
          >
            <strong>{{ t('inv.tests') }}</strong>
          </n-checkbox>
          <span class="dim small">{{ t('inv.selectedTests', { n: testCount }) }}<template v-if="pendingWhole.length"> + {{ pendingWhole.join(', ') }}</template></span>
        </div>
        <!-- Testsets: the checkbox selects all / none, the name shows its tests below. -->
        <div v-if="testsets.length > 1" class="ts-bar">
          <div v-for="ts in testsets" :key="ts" class="ts-item" :class="{ active: ts === activeTs }" @click="activeTs = ts">
            <n-checkbox
              size="small"
              :checked="tsState(ts).all"
              :indeterminate="tsState(ts).some"
              @click.stop
              @update:checked="(v: boolean) => setTs(ts, v ? 'all' : [])"
            />
            <span class="mono">{{ ts }}</span>
            <span class="dim small">{{ countOf(ts) ?? t('inv.allTests') }}<template v-if="manifestOf(ts)"> / {{ testsOf(ts).length }}</template></span>
          </div>
        </div>
        <div class="test-tools">
          <n-button size="tiny" secondary :disabled="!manifestOf(activeTs)" @click="setTs(activeTs, 'all')">{{ t('inv.selAll') }}</n-button>
          <n-button size="tiny" secondary @click="setTs(activeTs, [])">{{ t('inv.selNone') }}</n-button>
          <n-button size="tiny" secondary :disabled="!activeTests.some((x) => x.sample)" @click="setTs(activeTs, activeTests.filter((x) => x.sample).map((x) => x.index))">{{ t('inv.selSamples') }}</n-button>
          <n-button size="tiny" secondary :disabled="!activeTests.length" @click="setTs(activeTs, activeTests.filter((x) => !isOn(activeTs, x.index)).map((x) => x.index))">{{ t('inv.selInvert') }}</n-button>
          <n-input v-model:value="rangeText" size="tiny" class="mono" :placeholder="t('inv.rangePlaceholder')" style="width: 120px" @keyup.enter="applyRange" />
          <span class="dim small hint">{{ t('inv.shiftHint') }}</span>
        </div>
        <div v-if="!activeTests.length" class="dim small not-generated">{{ manifestOf(activeTs) ? t('inv.emptyTestset') : t('inv.noTestsYet') }}</div>
        <div v-else class="chips-wrap">
        <div v-keep-scroll="`inv-tests:${problemId}:${activeTs}`" class="chips" :style="{ maxHeight: `${chipsSize.size.value}px` }">
          <div v-for="bl in blocks" :key="bl.group" class="block">
            <n-checkbox v-if="bl.group" :checked="bl.all" :indeterminate="bl.some && !bl.all" size="small" class="block-head" @update:checked="toggleGroup(bl)">
              {{ t('inv.group', { g: bl.group }) }}
            </n-checkbox>
            <span
              v-for="x in bl.tests"
              :key="x.index"
              class="chip mono"
              :class="{ on: isOn(activeTs, x.index), sample: x.sample, bad: x.valid === false || !!x.error }"
              :title="x.source"
              @click="toggleTest(x.index, $event)"
              >{{ x.index }}</span
            >
          </div>
        </div>
          <div class="pf-resize-handle bottom" :class="{ active: chipsSize.dragging.value }" :title="t('improve.resize')" @pointerdown="chipsSize.start" @dblclick="chipsSize.reset" />
        </div>
      </section>
    </div>

    <div v-if="!inv" class="pf-empty">{{ t('inv.none') }}</div>
    <template v-else>
      <div class="matrix-bar">
        <span class="small dim">{{ new Date(inv.createdAt).toLocaleString() }} · TL {{ inv.timeLimit }} ms · ML {{ inv.memoryLimit }} MB</span>
        <span class="grow" />
        <n-checkbox v-model:checked="onlyIssues" size="small">{{ t('inv.onlyIssues') }}</n-checkbox>
      </div>
      <div v-keep-scroll="`inv-matrix:${problemId}:${inv.id}`" class="matrix-wrap">
        <table class="matrix">
          <thead>
            <tr>
              <th class="corner">{{ t('inv.test') }}</th>
              <th v-for="(s, si) in inv.solutions" :key="si" class="sol-head" :class="{ mismatch: s.expectation && !s.expectation.ok, ce: s.compile && !s.compile.ok }" :title="s.source">
                <div class="sol-line">
                  <span class="mono sol">{{ shortName(s.source) }}</span>
                  <n-tag v-if="s.tag" size="tiny" :type="tagType(s.tag)" :bordered="false">{{ s.tag }}</n-tag>
                </div>
                <div class="sol-line small">
                  <span v-if="s.compile && !s.compile.ok" class="bad">{{ t('inv.compileError') }}</span>
                  <span v-else-if="s.expectation" :class="s.expectation.ok ? 'good' : 'bad'" class="expect" :title="expectationText(s)">
                    <check v-if="s.expectation.ok" :size="13" /><x v-else :size="13" />{{ s.expectation.ok ? t('inv.expectOk') : t('inv.expectBad') }}
                  </span>
                  <span v-else class="dim">{{ doneCells(si) }} / {{ refs.length }}</span>
                </div>
                <div class="counts">
                  <span v-for="c in verdictCounts(si)" :key="c.v" class="count" :class="verdictClass(c.v)">{{ c.v }} {{ c.n }}</span>
                </div>
                <div v-if="s.score" class="score" :class="scoreClass(s.score.total, s.score.max)">
                  {{ s.score.total }}<span class="dim"> / {{ s.score.max }}</span>
                </div>
                <div v-if="s.maxTimeMs !== undefined" class="small dim">{{ s.maxTimeMs }} ms · {{ fmtMem(s.maxMemoryKb ?? 0) }}</div>
              </th>
            </tr>
          </thead>
          <tbody>
            <template v-for="row in rows" :key="row.kind === 'ts' ? `ts:${row.testset}` : row.ti">
              <tr v-if="row.kind === 'ts'" class="ts-row">
                <td class="sticky ts-label mono">{{ row.testset }} <span class="dim">({{ row.n }})</span></td>
                <td :colspan="inv.solutions.length" class="ts-fill" />
              </tr>
              <tr v-else>
                <td class="sticky idx">
                  <span class="mono">{{ testLabel(row.ref) }}</span>
                  <span v-if="groupOf.get(`${row.ref.testset}:${row.ref.index}`)" class="gtag">{{ groupOf.get(`${row.ref.testset}:${row.ref.index}`) }}</span>
                </td>
                <td
                  v-for="(s, si) in inv.solutions"
                  :key="si"
                  class="cell"
                  :class="cellClass(si, row.ti)"
                  :title="cellTitle(inv.cells[si]?.[row.ti] ?? null)"
                  @click="openCell(si, row.ti)"
                >
                  <template v-if="inv.cells[si]?.[row.ti]">
                    <span class="v">{{ inv.cells[si][row.ti]!.verdict }}</span>
                    <span v-if="inv.cells[si][row.ti]!.verdict !== 'SKIP'" class="t">{{ inv.cells[si][row.ti]!.timeMs }}</span>
                  </template>
                  <span v-else class="dim">·</span>
                </td>
              </tr>
            </template>
            <tr v-if="!rows.length && onlyIssues">
              <td class="sticky dim small" :colspan="inv.solutions.length + 1">{{ t('inv.noIssues') }}</td>
            </tr>
          </tbody>
          <tfoot v-if="hasScores">
            <tr v-for="g in scoreGroups" :key="'g' + g.key">
              <td class="sticky dim small">
                <template v-if="g.testset">{{ g.testset }} · </template>{{ t('inv.group', { g: g.name }) }} <span class="dim">({{ g.max }})</span>
              </td>
              <td v-for="(s, si) in inv.solutions" :key="si" class="small foot">
                <template v-for="gs in s.score?.groups.filter((x) => `${x.testset ?? ''}/${x.name}` === g.key) ?? []" :key="gs.name">
                  <span :class="scoreClass(gs.score, gs.max)" :title="gs.blockedBy ? t('inv.blocked', { g: gs.blockedBy.join(', ') }) : ''">{{ gs.score }}</span>
                  <span v-if="gs.blockedBy" class="dim"> *</span>
                </template>
              </td>
            </tr>
            <tr v-for="ts in scoreTestsets" :key="'ts' + ts.testset">
              <td class="sticky small">{{ t('inv.testsetTotal', { ts: ts.testset }) }} <span class="dim">({{ ts.max }})</span></td>
              <td v-for="(s, si) in inv.solutions" :key="si" class="small foot">
                <template v-for="x in s.score?.testsets?.filter((y) => y.testset === ts.testset) ?? []" :key="x.testset">
                  <span :class="scoreClass(x.total, x.max)">{{ x.total }}</span>
                </template>
              </td>
            </tr>
            <tr>
              <td class="sticky small"><strong>{{ t('inv.total') }}</strong></td>
              <td v-for="(s, si) in inv.solutions" :key="si" class="small foot">
                <strong v-if="s.score" :class="scoreClass(s.score.total, s.score.max)">{{ s.score.total }}</strong>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </template>

    <template #footer-left>
      <span class="legend"><span class="lg unexpected" />{{ t('inv.legendUnexpected') }}</span>
      <span class="legend"><span class="lg slow" />{{ t('inv.legendSlow') }}</span>
    </template>
    <template #footer>
      <n-button v-if="running" @click="judge.cancel('invocation')">{{ t('inv.stop') }}</n-button>
      <n-button type="primary" :disabled="!canStart || running" @click="start">
        {{ t('inv.startNM', { s: picked.length, n: pendingWhole.length ? `${testCount}+` : testCount }) }}
      </n-button>
    </template>
  </tool-window>

  <tool-window
    :show="!!detail"
    size="full"
    :title="detail && inv ? `${shortName(inv.solutions[detail.si].source)} · ${testLabel(refs[detail.ti])}` : ''"
    @update:show="(v: boolean) => !v && (detail = null)"
  >
    <template v-if="detail">
      <n-space align="center" size="small">
        <span class="pf-verdict-pill" :class="verdictClass(detail.cell.verdict)">{{ detail.cell.verdict }}</span>
        <span>{{ detail.cell.timeMs }} ms · {{ fmtMem(detail.cell.memoryKb) }}</span>
        <span v-if="detail.cell.exitCode" class="dim">{{ t('run.exitCode', { code: detail.cell.exitCode }) }}</span>
      </n-space>
      <div v-if="detail.cell.message" class="msg mono">{{ serverText(detail.cell.message) }}</div>
      <div class="three">
        <div>
          <div class="label">{{ t('inv.input') }}<span v-if="detail.files.input?.truncated" class="dim"> ({{ t('run.truncated') }})</span></div>
          <pre class="mono box">{{ detail.files.input?.content ?? '' }}</pre>
        </div>
        <div>
          <div class="labels">
            <span>{{ t('inv.answer') }}</span>
            <span>{{ t('inv.output') }}<span v-if="!detail.cell.hasOutput" class="dim"> — {{ t('inv.noOutput') }}</span></span>
          </div>
          <label class="diff-options"><input v-model="ignoreWhitespace" type="checkbox" />{{ t('improve.ignoreWhitespace') }}</label>
          <div ref="diffHost" class="box diff" />
        </div>
      </div>
    </template>
  </tool-window>
</template>

<style scoped>
.setup {
  display: grid;
  grid-template-columns: minmax(200px, 300px) minmax(0, 1fr);
  gap: 12px;
  margin-bottom: 10px;
  flex-shrink: 0;
}
.pane {
  border: 1px solid var(--pf-border);
  border-radius: 8px;
  padding: 8px 10px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.pane-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
}
.sol-list {
  display: flex;
  flex-direction: column;
  max-height: 168px;
  overflow: auto;
}
.sol-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}
.sol-item:hover {
  background: var(--pf-selected);
}
.sol-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ts-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ts-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px 2px 6px;
  border: 1px solid var(--pf-border);
  border-radius: 999px;
  cursor: pointer;
  font-size: 12px;
}
.ts-item.active {
  border-color: var(--pf-accent);
  background: var(--pf-selected);
}
.test-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.hint {
  margin-left: auto;
}
.not-generated {
  padding: 8px 2px;
}
.chips-wrap {
  position: relative;
}
.chips {
  overflow: auto;
}
.block {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 3px;
  margin-bottom: 4px;
}
.block-head {
  margin-right: 6px;
  font-size: 12px;
}
.chip {
  min-width: 28px;
  padding: 1px 4px;
  text-align: center;
  font-size: 11px;
  border-radius: 4px;
  border: 1px solid var(--pf-border);
  cursor: pointer;
  user-select: none;
  color: var(--pf-text-secondary);
}
.chip.on {
  color: var(--pf-text);
  background: var(--pf-selected);
  border-color: var(--pf-accent);
}
.chip.sample {
  text-decoration: underline;
}
.chip.bad {
  border-color: #e88080;
}
.matrix-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  flex-shrink: 0;
}
.grow {
  flex: 1;
}
/* Scrolls both ways; the header row and the test column stay in place. */
.matrix-wrap {
  flex: 1;
  min-height: 120px;
  overflow: auto;
  border: 1px solid var(--pf-border);
  border-radius: 8px;
}
.matrix {
  border-collapse: separate;
  border-spacing: 0;
  font-size: 12px;
  min-width: 100%;
}
.matrix th,
.matrix td {
  border-bottom: 1px solid var(--pf-border);
}
.matrix thead th {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--pf-surface);
  font-weight: 500;
  padding: 6px 8px;
  text-align: center;
  vertical-align: top;
  min-width: 96px;
  border-bottom: 2px solid var(--pf-border);
}
.matrix thead th.corner {
  left: 0;
  z-index: 3;
  text-align: left;
  vertical-align: bottom;
  color: var(--pf-text-secondary);
}
.sol-head.mismatch {
  box-shadow: inset 0 3px 0 #e05a6a;
}
.sol-head.ce {
  box-shadow: inset 0 3px 0 #a0a0a8;
}
.sol-line {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  white-space: nowrap;
}
.sol {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.expect {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.counts {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 2px;
  margin: 3px 0 2px;
}
.count {
  padding: 0 4px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 600;
}
.score {
  font-size: 13px;
  font-weight: 600;
}
.sticky {
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--pf-surface);
}
.idx {
  white-space: nowrap;
  padding: 2px 10px 2px 8px;
  color: var(--pf-text-secondary);
  border-right: 1px solid var(--pf-border);
}
.ts-row td {
  background: var(--pf-toolbar-bg);
  padding: 4px 8px;
  font-weight: 600;
  font-size: 12px;
}
.gtag {
  margin-left: 6px;
  padding: 0 5px;
  font-size: 10px;
  border-radius: 6px;
  background: rgba(128, 128, 128, 0.18);
}
.cell {
  text-align: center;
  padding: 3px 6px;
  cursor: pointer;
  white-space: nowrap;
  position: relative;
  border-left: 1px solid var(--pf-surface);
}
.cell:hover {
  filter: brightness(0.94);
}
.cell.empty {
  background: transparent;
}
.cell .v {
  font-weight: 700;
}
.cell .t {
  margin-left: 4px;
  opacity: 0.75;
  font-variant-numeric: tabular-nums;
}
.cell.unexpected {
  box-shadow: inset 0 0 0 2px #e05a6a;
}
.cell.unexpected::after {
  content: '!';
  position: absolute;
  top: 0;
  right: 3px;
  font-size: 10px;
  font-weight: 700;
  color: #e05a6a;
}
.cell.slow {
  outline: 2px dashed #e0a030;
  outline-offset: -2px;
}
.foot {
  text-align: center;
  padding: 3px 6px;
}
tfoot td {
  background: var(--pf-toolbar-bg);
}
.legend {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-right: 14px;
}
.lg {
  width: 14px;
  height: 10px;
  border-radius: 2px;
}
.lg.unexpected {
  box-shadow: inset 0 0 0 2px #e05a6a;
}
.lg.slow {
  outline: 2px dashed #e0a030;
  outline-offset: -2px;
}
.msg {
  margin: 8px 0;
  font-size: 12px;
  white-space: pre-wrap;
}
.three {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
  gap: 8px;
}
.labels {
  display: grid;
  grid-template-columns: 1fr 1fr;
  font-size: 12px;
  opacity: 0.7;
}
.box.diff {
  padding: 0;
  overflow: hidden;
}
.label {
  font-size: 12px;
  opacity: 0.7;
}
.box {
  margin: 0;
  padding: 6px;
  font-size: 12px;
  background: rgba(128, 128, 128, 0.12);
  border-radius: 4px;
  height: 50vh;
  overflow: auto;
}
.good {
  color: light-dark(#16804a, #63e2b7);
}
.warn {
  color: light-dark(#986415, #e8b060);
}
.bad {
  color: light-dark(#c53b3b, #e88080);
}
.dim {
  opacity: 0.65;
}
.small {
  font-size: 12px;
}
@media (max-width: 760px) {
  .setup {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
