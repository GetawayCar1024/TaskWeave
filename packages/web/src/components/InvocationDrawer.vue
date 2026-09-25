<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { serverText } from '../lib/serverText';
import { useI18n } from 'vue-i18n';
import {
  NAlert,
  NButton,
  NCheckbox,
  NCheckboxGroup,
  NDrawer,
  NDrawerContent,
  NInput,
  NModal,
  NProgress,
  NScrollbar,
  NSelect,
  NSpace,
  NTag,
  useMessage,
} from 'naive-ui';
import { parseIndexList, testsetsOf, type Invocation, type InvocationCell, type InvocationSummary, type TestFileResponse, type TestInfo } from '@polyforge/shared';
import { api, errorMessage } from '../lib/api';
import type { Judge } from '../lib/judge';
import { monaco } from '../lib/monaco';
import { tagType } from '../lib/tags';
import { Check, X } from 'lucide-vue-next';
import { fmtMem, verdictBg } from '../lib/verdict';
import type { Workspace } from '../lib/workspace';

const props = defineProps<{ show: boolean; ws: Workspace; judge: Judge; problemId: string }>();
const emit = defineEmits<{ 'update:show': [boolean] }>();
const { t } = useI18n();
const message = useMessage();

const solutions = computed(() => props.ws.state.detail?.config?.solutions ?? []);
const picked = ref<string[]>([]);
const history = ref<InvocationSummary[]>([]);
const inv = ref<Invocation | null>(null);
const job = computed(() => props.judge.state.jobs.invocation);
const running = computed(() => job.value?.status === 'running');

watch(
  () => props.show,
  async (s) => {
    if (!s) return;
    if (picked.value.length === 0) picked.value = solutions.value.map((x) => x.source);
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
    inv.value = await api.invocation(props.problemId, id);
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
      if (!running.value) loadHistory();
    }, 250);
  },
);

// ---- test selection (as on Polygon: a testset, then any subset of its tests) ----
const testset = ref('tests');
const testsets = computed(() => (props.ws.state.detail?.config ? testsetsOf(props.ws.state.detail.config).map((x) => x.name) : ['tests']));
watch(testsets, (list) => !list.includes(testset.value) && (testset.value = 'tests'));
watch(testset, (ts) => ts !== 'tests' && props.judge.loadManifest(ts), { immediate: true });
const manifestTests = computed<TestInfo[]>(() => (testset.value === 'tests' ? props.judge.state.manifest : props.judge.state.manifests[testset.value])?.tests ?? []);

const selected = ref(new Set<number>());
let allByDefault = true;
// New or regenerated tests: keep the selection, and select everything while "all" was chosen.
watch(
  () => [testset.value, manifestTests.value.map((x) => x.index).join(',')],
  () => {
    const all = manifestTests.value.map((x) => x.index);
    selected.value = new Set(allByDefault ? all : all.filter((i) => selected.value.has(i)));
  },
  { immediate: true },
);
function setSelection(list: number[]) {
  selected.value = new Set(list);
  allByDefault = list.length === manifestTests.value.length;
}
let lastClicked: number | null = null;
function toggleTest(i: number, e: MouseEvent) {
  const next = new Set(selected.value);
  if (e.shiftKey && lastClicked !== null) {
    // Shift-click: set the whole range to the state of the clicked test.
    const on = !next.has(i);
    const [lo, hi] = [Math.min(lastClicked, i), Math.max(lastClicked, i)];
    for (const x of manifestTests.value) if (x.index >= lo && x.index <= hi) on ? next.add(x.index) : next.delete(x.index);
  } else if (next.has(i)) next.delete(i);
  else next.add(i);
  lastClicked = i;
  setSelection([...next]);
}
/** Tests grouped by their group (subtask); ungrouped tests form one block. */
const blocks = computed(() => {
  const m = new Map<string, TestInfo[]>();
  for (const x of manifestTests.value) {
    const k = x.group ?? '';
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(x);
  }
  return [...m].map(([group, tests]) => ({ group, tests, all: tests.every((x) => selected.value.has(x.index)), some: tests.some((x) => selected.value.has(x.index)) }));
});
function toggleGroup(block: { tests: TestInfo[]; all: boolean }) {
  const next = new Set(selected.value);
  for (const x of block.tests) block.all ? next.delete(x.index) : next.add(x.index);
  setSelection([...next]);
}
const rangeText = ref('');
function applyRange() {
  const known = new Set(manifestTests.value.map((x) => x.index));
  setSelection(parseIndexList(rangeText.value).filter((i) => known.has(i)));
}
const chosenTests = computed<number[] | undefined>(() => {
  if (!manifestTests.value.length || selected.value.size === manifestTests.value.length) return undefined;
  return [...selected.value].sort((x, y) => x - y);
});
const testCount = computed(() => chosenTests.value?.length ?? manifestTests.value.length);

async function start() {
  try {
    await props.judge.startInvocation(picked.value, chosenTests.value, testset.value);
    await loadInvocation();
  } catch (e) {
    message.error(errorMessage(e));
  }
}

const historyOptions = computed(() =>
  history.value.map((h) => ({
    label: `${new Date(h.createdAt).toLocaleString()} · ${h.testset && h.testset !== 'tests' ? `${h.testset} · ` : ''}${h.solutions}×${h.tests} ${h.status === 'running' ? '…' : h.ok ? t('inv.pass') : t('inv.fail')}`,
    value: h.id,
  })),
);

const shortName = (s: string) => s.split('/').pop()!;

// ---- scores (points / subtasks) ----
const scoreGroups = computed(() => {
  const first = inv.value?.solutions.find((x) => x.score?.groups.length);
  return first?.score?.groups.map((g) => ({ name: g.name, max: g.max })) ?? [];
});
const hasScores = computed(() => !!inv.value?.solutions.some((x) => x.score));
const groupOfTest = computed(() => new Map(manifestTests.value.map((x) => [x.index, x.group])));
function scoreClass(score: number, max: number) {
  return score >= max && max > 0 ? 'good' : score > 0 ? 'warn' : 'bad';
}

function cellTitle(c: InvocationCell | null): string {
  if (!c) return '';
  return [`${c.verdict}  ${c.timeMs} ms  ${fmtMem(c.memoryKb)}`, serverText(c.message)].filter(Boolean).join('\n');
}

function cellClass(si: number, ti: number): string[] {
  const s = inv.value?.solutions[si];
  const out: string[] = [];
  if (s?.expectation?.unexpected.includes(ti)) out.push('unexpected');
  if (s?.expectation?.slow?.includes(ti)) out.push('slow');
  return out;
}

// ---- cell detail ----
const detail = ref<{ si: number; ti: number; cell: InvocationCell; files: Record<string, TestFileResponse | null> } | null>(null);

async function openCell(si: number, ti: number) {
  const cell = inv.value?.cells[si]?.[ti];
  if (!inv.value || !cell) return;
  const test = inv.value.tests[ti];
  detail.value = { si, ti, cell, files: {} };
  const [input, answer, output] = await Promise.all([
    api.testFile(props.problemId, test, 'in', inv.value.testset).catch(() => null),
    api.testFile(props.problemId, test, 'ans', inv.value.testset).catch(() => null),
    cell.hasOutput ? api.invocationOutput(props.problemId, inv.value.id, si, test).catch(() => null) : Promise.resolve(null),
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
    ignoreTrimWhitespace: true,
    renderSideBySide: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
  });
  diffEditor.setModel({ original: diffModels[0], modified: diffModels[1] });
}
watch(detail, (d) => !d && disposeDiff());
onBeforeUnmount(disposeDiff);
</script>

<template>
  <n-drawer :show="show" placement="bottom" height="62%" resizable @update:show="emit('update:show', $event)">
    <n-drawer-content :title="t('toolbar.invocation')" closable :native-scrollbar="false">
      <div class="pick">
        <section class="pick-solutions">
          <div class="pick-title">{{ t('inv.solutions') }}</div>
          <n-checkbox-group v-model:value="picked">
            <div class="sol-list">
              <n-checkbox v-for="s in solutions" :key="s.source" :value="s.source">
                <span class="mono">{{ shortName(s.source) }}</span>
                <n-tag size="tiny" :type="tagType(s.tag)" :bordered="false" style="margin-left: 4px">{{ s.tag }}</n-tag>
              </n-checkbox>
            </div>
          </n-checkbox-group>
        </section>
        <section class="pick-tests">
          <div class="pick-title">
            {{ t('inv.tests') }}
            <n-select v-if="testsets.length > 1" v-model:value="testset" size="tiny" :options="testsets.map((x) => ({ label: x, value: x }))" style="width: 110px" />
            <span class="dim small">{{ t('inv.selectedCount', { n: selected.size, total: manifestTests.length }) }}</span>
            <span class="grow" />
            <n-button size="tiny" quaternary @click="setSelection(manifestTests.map((x) => x.index))">{{ t('inv.selAll') }}</n-button>
            <n-button size="tiny" quaternary @click="setSelection([])">{{ t('inv.selNone') }}</n-button>
            <n-button size="tiny" quaternary @click="setSelection(manifestTests.filter((x) => x.sample).map((x) => x.index))">{{ t('inv.selSamples') }}</n-button>
            <n-button size="tiny" quaternary @click="setSelection(manifestTests.filter((x) => !selected.has(x.index)).map((x) => x.index))">{{ t('inv.selInvert') }}</n-button>
            <n-input v-model:value="rangeText" size="tiny" class="mono" placeholder="1-5, 8" style="width: 90px" @keyup.enter="applyRange" />
          </div>
          <div v-if="!manifestTests.length" class="dim small">{{ t('inv.noTestsYet') }}</div>
          <n-scrollbar v-else style="max-height: 110px">
            <div v-for="bl in blocks" :key="bl.group" class="block">
              <n-checkbox v-if="bl.group" :checked="bl.all" :indeterminate="bl.some && !bl.all" size="small" class="block-head" @update:checked="toggleGroup(bl)">
                {{ t('inv.group', { g: bl.group }) }}
              </n-checkbox>
              <span
                v-for="x in bl.tests"
                :key="x.index"
                class="chip mono"
                :class="{ on: selected.has(x.index), sample: x.sample, bad: x.valid === false || !!x.error }"
                :title="x.source"
                @click="toggleTest(x.index, $event)"
                >{{ x.index }}</span
              >
            </div>
          </n-scrollbar>
        </section>
      </div>
      <div class="run-bar">
        <n-button size="small" type="primary" :disabled="!picked.length || (manifestTests.length > 0 && selected.size === 0)" :loading="running" @click="start">
          {{ t('inv.startN', { n: testCount }) }}
        </n-button>
        <n-button v-if="running" size="small" @click="judge.cancel('invocation')">{{ t('common.cancel') }}</n-button>
        <span class="grow" />
        <n-select
          size="small"
          style="width: 300px"
          :value="judge.state.invocationId"
          :options="historyOptions"
          :placeholder="t('inv.history')"
          @update:value="(v: string) => (judge.state.invocationId = v)"
        />
      </div>

      <div v-if="running && job" class="progress">
        <n-progress type="line" :percentage="job.progress.total ? Math.round((job.progress.done / job.progress.total) * 100) : 0" :height="4" :show-indicator="false" />
        <span class="dim small">{{ serverText(job.progress.message) }} {{ job.progress.total ? `${job.progress.done}/${job.progress.total}` : '' }}</span>
      </div>
      <n-alert v-if="inv?.error" type="error" :show-icon="false" class="alert"><pre class="log">{{ serverText(inv.error) }}</pre></n-alert>

      <div v-if="!inv" class="dim small empty">{{ t('inv.none') }}</div>
      <n-scrollbar v-else x-scrollable style="max-height: calc(62vh - 330px)">
        <table class="matrix">
          <thead>
            <tr>
              <th class="sticky">#</th>
              <th v-for="(s, si) in inv.solutions" :key="si" :title="s.source">
                <div class="mono sol">{{ shortName(s.source) }}</div>
                <n-tag v-if="s.tag" size="tiny" :type="tagType(s.tag)" :bordered="false">{{ s.tag }}</n-tag>
                <span v-if="s.compile && !s.compile.ok" class="bad small"> CE</span>
                <span v-else-if="s.expectation" :class="s.expectation.ok ? 'good' : 'bad'" class="small">
                  <check v-if="s.expectation.ok" :size="13" class="mark-icon" /><x v-else :size="13" class="mark-icon" />
                  <span v-if="s.expectation.missing" :title="t('inv.missing', { v: s.expectation.missing.join('/') })">!</span>
                </span>
                <div v-if="s.score" class="score" :class="scoreClass(s.score.total, s.score.max)">
                  {{ s.score.total }}<span class="dim"> / {{ s.score.max }}</span>
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(test, ti) in inv.tests" :key="test">
              <td class="sticky idx">{{ test }}<span v-if="groupOfTest.get(test)" class="gtag">{{ groupOfTest.get(test) }}</span></td>
              <td
                v-for="(s, si) in inv.solutions"
                :key="si"
                class="cell"
                :class="cellClass(si, ti)"
                :style="inv.cells[si]?.[ti] ? { background: verdictBg(inv.cells[si][ti]!.verdict) } : {}"
                :title="cellTitle(inv.cells[si]?.[ti] ?? null)"
                @click="openCell(si, ti)"
              >
                <template v-if="inv.cells[si]?.[ti]">
                  <span class="v">{{ inv.cells[si][ti]!.verdict }}</span>
                  <span v-if="inv.cells[si][ti]!.verdict !== 'SKIP'" class="t">{{ inv.cells[si][ti]!.timeMs }}</span>
                </template>
                <span v-else class="dim">·</span>
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr v-for="g in scoreGroups" :key="'g' + g.name">
              <td class="sticky dim small">{{ t('inv.group', { g: g.name }) }} <span class="dim">({{ g.max }})</span></td>
              <td v-for="(s, si) in inv.solutions" :key="si" class="small foot">
                <template v-for="gs in s.score?.groups.filter((x) => x.name === g.name) ?? []" :key="gs.name">
                  <span :class="scoreClass(gs.score, gs.max)" :title="gs.blockedBy ? t('inv.blocked', { g: gs.blockedBy.join(', ') }) : ''">{{ gs.score }}</span>
                  <span v-if="gs.blockedBy" class="dim"> *</span>
                </template>
              </td>
            </tr>
            <tr v-if="hasScores">
              <td class="sticky small"><strong>{{ t('inv.total') }}</strong></td>
              <td v-for="(s, si) in inv.solutions" :key="si" class="small foot">
                <strong v-if="s.score" :class="scoreClass(s.score.total, s.score.max)">{{ s.score.total }}</strong>
              </td>
            </tr>
            <tr>
              <td class="sticky dim small">{{ t('inv.max') }}</td>
              <td v-for="(s, si) in inv.solutions" :key="si" class="small dim foot">
                <template v-if="s.maxTimeMs !== undefined">{{ s.maxTimeMs }} ms<br />{{ fmtMem(s.maxMemoryKb ?? 0) }}</template>
              </td>
            </tr>
          </tfoot>
        </table>
        <div class="legend small dim">{{ t('inv.legend', { tl: inv.timeLimit }) }}</div>
      </n-scrollbar>
    </n-drawer-content>
  </n-drawer>

  <n-modal
    :show="!!detail"
    preset="card"
    style="width: 90vw"
    :title="detail && inv ? `${shortName(inv.solutions[detail.si].source)} · #${inv.tests[detail.ti]}` : ''"
    @update:show="(v: boolean) => !v && (detail = null)"
  >
    <template v-if="detail">
      <n-space align="center" size="small">
        <n-tag :bordered="false" :style="{ background: verdictBg(detail.cell.verdict) }">{{ detail.cell.verdict }}</n-tag>
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
          <div ref="diffHost" class="box diff" />
        </div>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.pick {
  display: grid;
  grid-template-columns: minmax(180px, 280px) minmax(0, 1fr);
  gap: 16px;
  margin-bottom: 8px;
}
.pick-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  opacity: 0.85;
  margin-bottom: 4px;
}
.sol-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 130px;
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
  min-width: 26px;
  padding: 1px 4px;
  text-align: center;
  font-size: 11px;
  border-radius: 3px;
  border: 1px solid rgba(128, 128, 128, 0.35);
  cursor: pointer;
  user-select: none;
  opacity: 0.55;
}
.chip.on {
  opacity: 1;
  background: rgba(99, 226, 183, 0.2);
  border-color: rgba(99, 226, 183, 0.6);
}
.chip.sample {
  text-decoration: underline;
}
.chip.bad {
  border-color: #e88080;
}
.run-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.grow {
  flex: 1;
}
.score {
  font-size: 12px;
  font-weight: 600;
}
.gtag {
  margin-left: 4px;
  padding: 0 4px;
  font-size: 10px;
  border-radius: 6px;
  background: rgba(128, 128, 128, 0.25);
  opacity: 0.8;
}
.warn {
  color: #e8b060;
}
.progress {
  margin-bottom: 6px;
}
.alert {
  margin-bottom: 6px;
}
.log {
  margin: 0;
  white-space: pre-wrap;
  font-size: 12px;
}
.matrix {
  border-collapse: separate;
  border-spacing: 2px;
  font-size: 12px;
}
.matrix th {
  font-weight: 500;
  padding: 2px 6px;
  text-align: center;
  vertical-align: bottom;
  min-width: 76px;
}
.sol {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sticky {
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--n-color, #18181c);
}
.idx {
  text-align: right;
  padding-right: 8px;
  opacity: 0.7;
}
.cell {
  text-align: center;
  padding: 2px 6px;
  border-radius: 3px;
  cursor: pointer;
  white-space: nowrap;
  border: 1px solid transparent;
}
.cell .v {
  font-weight: 600;
}
.cell .t {
  margin-left: 4px;
  opacity: 0.75;
}
.cell.unexpected {
  border-color: #e88080;
  box-shadow: inset 0 0 0 1px #e88080;
}
.cell.slow {
  border-color: #f0c040;
}
.foot {
  text-align: center;
}
.legend {
  margin-top: 6px;
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
  color: #63e2b7;
}
.mark-icon {
  vertical-align: -2px;
  margin-left: 2px;
}
.bad {
  color: #e88080;
}
.dim {
  opacity: 0.6;
}
.small {
  font-size: 12px;
}
.empty {
  padding: 24px;
  text-align: center;
}
</style>
