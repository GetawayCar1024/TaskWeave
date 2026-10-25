<script setup lang="ts">
import { computed, h, ref, watch } from 'vue';
import { serverText } from '../lib/serverText';
import { useI18n } from 'vue-i18n';
import { NAlert, NButton, NDataTable, NInput, NProgress, NScrollbar, NSelect, NSpace, NSwitch, NTabPane, NTabs, NTag, useDialog, useMessage, type DataTableColumns } from 'naive-ui';
import { compressRanges, parseIndexList, testsetsOf, type TestFileResponse, type TestInfo } from '@polyforge/shared';
import TestsetDialog from './TestsetDialog.vue';
import ToolWindow from './ToolWindow.vue';
import { api, errorMessage } from '../lib/api';
import { formatSize } from '../lib/format';
import { Check, Cog, Layers, Pencil, Plus, Trash2, X } from 'lucide-vue-next';
import type { Judge } from '../lib/judge';
import type { Workspace } from '../lib/workspace';

const props = defineProps<{ ws: Workspace; judge: Judge; problemId: string }>();
const emit = defineEmits<{ runOnTest: [number] }>();
const { t } = useI18n();
const t2 = t;
const message = useMessage();

const job = computed(() => props.judge.state.jobs.generate);
const running = computed(() => job.value?.status === 'running');
// Testset shown in the panel; "tests" unless the problem has more.
const testset = ref('tests');
const testsets = computed(() => (props.ws.state.detail?.config ? testsetsOf(props.ws.state.detail.config).map((x) => x.name) : ['tests']));
watch(testsets, (list) => !list.includes(testset.value) && (testset.value = 'tests'));
watch(testset, (ts) => ts !== 'tests' && props.judge.loadManifest(ts), { immediate: true });
const manifest = computed(() => (testset.value === 'tests' ? props.judge.state.manifest : props.judge.state.manifests[testset.value] ?? null));
const pointsOn = computed(() => !!props.ws.state.detail?.config?.tests.points);
const showTestsets = ref(false);

// ---- add a manual test / sample ----
const showAdd = ref(false);
const addInput = ref('');
const addAsSample = ref(false);
const addStmtIn = ref('');
const addStmtOut = ref('');
const interactive = computed(() => !!props.ws.state.detail?.config?.problem.interactive);
const adding = ref(false);
/** Test to select once the regenerated manifest contains it. */
let selectAfterGenerate: number | null = null;
function openAdd() {
  addInput.value = '';
  addStmtIn.value = '';
  addStmtOut.value = '';
  addAsSample.value = false;
  showAdd.value = true;
}
async function addTest() {
  adding.value = true;
  try {
    const sample = addAsSample.value;
    const r = await api.addManualTest(props.problemId, { input: addInput.value, sample, testset: testset.value, statementInput: sample ? addStmtIn.value : undefined, statementOutput: sample ? addStmtOut.value : undefined });
    message.success(t(sample ? 'tests.sampleAdded' : 'tests.testAdded', { n: r.index }));
    showAdd.value = false;
    selectAfterGenerate = r.index;
    await props.judge.generate(testset.value);
  } catch (e) {
    message.error(errorMessage(e));
  } finally {
    adding.value = false;
  }
}

/**
 * What a sample shows in the statement: tests/manual/NN.statement.in / .statement.out
 * next to a manual test, tests/_statement/NN.in / NN.out for a test made by the script
 * (any problem, not only interactive ones). Created from the test's input / answer.
 */
async function editStatementFile(t: TestInfo, which: 'in' | 'out') {
  const existing = which === 'in' ? t.statementInput : t.statementOutput;
  const nn = String(t.index).padStart(2, '0');
  const ts = testset.value;
  const rel = existing ?? (t.origin === 'manual' ? `${t.source.replace(/\.[^./]*$/, '')}.statement.${which}` : `tests/_statement/${ts === 'tests' ? '' : `${ts}/`}${nn}.${which}`);
  try {
    if (!existing) {
      const from = interactive.value && which === 'out' ? null : await api.testFile(props.problemId, t.index, which === 'in' ? 'in' : 'ans', ts).catch(() => null);
      if (from?.truncated) throw new Error(t2('tests.previewTruncated'));
      await api.writeFile(props.problemId, rel, from?.content ?? '');
      selectAfterGenerate = t.index;
      await props.judge.loadManifest(ts);
    }
    await props.ws.openFile(rel);
  } catch (e) {
    message.error(errorMessage(e));
  }
}

const dialog = useDialog();
/**
 * Remove a test after confirmation: a manual test's files are deleted; a script test's
 * line is deleted from the script (with every test that line makes).
 */
function removeTest(test: TestInfo) {
  const siblings = test.origin === 'script' ? (manifest.value?.tests ?? []).filter((x) => x.origin === 'script' && x.source === test.source).map((x) => x.index) : [test.index];
  const content =
    test.origin === 'manual'
      ? t('tests.removeManual', { file: test.source })
      : t('tests.removeScript', { cmd: test.source }) + (siblings.length > 1 ? '\n' + t('tests.removeMulti', { list: siblings.join(', ') }) : '');
  dialog.warning({
    title: t('tests.removeTitle', { n: test.index }),
    content,
    positiveText: t('tests.remove'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      try {
        const r = await api.removeTest(props.problemId, test.index, test.source, testset.value);
        message.success(r.kind === 'manual' ? t('tests.removedManual') : t('tests.removedScript', { n: r.removed.length }));
      } catch (e) {
        message.error(errorMessage(e));
      }
    },
  });
}

const testsetConfig = () => (props.ws.state.detail?.config ? testsetsOf(props.ws.state.detail.config).find((x) => x.name === testset.value) : undefined);
/**
 * Mark / unmark a test of the shown testset as a sample (samples in problem.toml). A new
 * sample starts hidden from the statement (large_samples) until "show in statement" is on.
 */
async function setSample(index: number, on: boolean) {
  const ts = testsetConfig();
  const cur = parseIndexList(ts?.samples ?? '');
  const large = parseIndexList(ts?.largeSamples ?? '');
  try {
    await props.ws.patch({ testsets: { [testset.value]: {
      samples: compressRanges(on ? [...cur, index] : cur.filter((i) => i !== index)),
      largeSamples: compressRanges(on ? [...large, index] : large.filter((i) => i !== index)),
    } } });
    selectAfterGenerate = index;
    await props.judge.loadManifest(testset.value);
  } catch (e) {
    message.error(errorMessage(e));
  }
}
async function setSampleVisible(index: number, visible: boolean) {
  const cur = parseIndexList(testsetConfig()?.largeSamples ?? '');
  try {
    await props.ws.patch({ testsets: { [testset.value]: { largeSamples: compressRanges(visible ? cur.filter(i => i !== index) : [...cur, index]) } } });
    await props.judge.loadManifest(testset.value);
  } catch (e) { message.error(errorMessage(e)); }
}
const selected = ref<number | null>(null);

/** The statement input / output button: opens (creating) the override, or when active restores the default. */
function statementButton(test: TestInfo, which: 'in' | 'out') {
  const rel = which === 'in' ? test.statementInput : test.statementOutput;
  if (!rel) return editStatementFile(test, which);
  dialog.warning({
    title: t('tests.resetStatementTitle'),
    content: t('tests.resetStatementBody', { file: rel }),
    positiveText: t('tests.resetStatementOk'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      try {
        await props.ws.remove(rel);
        await props.judge.loadManifest(testset.value);
      } catch (e) { message.error(errorMessage(e)); }
    },
  });
}
function openGenerated(kind: 'in' | 'ans' | 'overview') {
  const dir = testset.value === 'tests' ? 'tests' : `testsets/${testset.value}`;
  const suffix = kind === 'overview' ? 'overview.txt' : kind;
  props.ws.openFile(`.polyforge/${dir}/${selected.value}.${suffix}`).catch(e => message.error(errorMessage(e)));
}

async function generate() {
  try {
    await props.judge.generate(testset.value);
  } catch (e) {
    message.error(errorMessage(e));
  }
}

const columns = computed<DataTableColumns<TestInfo>>(() => [
  { title: '#', key: 'index', width: 36 },
  {
    title: t('tests.source'),
    key: 'source',
    ellipsis: { tooltip: true },
    render: (r) =>
      h('span', { class: 'mono origin', title: r.origin === 'manual' ? t('tests.manual') : t('tests.generated') }, [
        h(r.origin === 'manual' ? Pencil : Cog, { size: 12, class: 'origin-icon' }),
        r.origin === 'manual' ? r.source.replace(/^tests\/manual\//, '') : r.source,
      ]),
  },
  {
    title: '',
    key: 'flags',
    width: 84,
    render: (r) =>
      h('span', { class: 'flags' }, [
        r.sample ? h(NTag, { size: 'tiny', type: 'info', bordered: false }, () => t('tests.sample')) : null,
        r.group
          ? h(NTag, { size: 'tiny', bordered: false, title: pointsOn.value && r.points !== undefined ? `${t('tests.group')} ${r.group} · ${t('tests.points')} ${r.points}` : `${t('tests.group')} ${r.group}` }, () =>
              pointsOn.value && r.points !== undefined ? `${r.group} · ${r.points}` : r.group,
            )
          : null,
      ]),
  },
  { title: t('tests.size'), key: 'inputSize', width: 62, render: (r) => (r.inputSize !== undefined ? formatSize(r.inputSize) : '—') },
  {
    title: '',
    key: 'status',
    width: 30,
    render: (r) => {
      if (r.error) return h(X, { size: 14, class: 'bad', title: serverText(r.error) });
      if (r.valid === false) return h(X, { size: 14, class: 'bad', title: r.validatorMessage });
      if (r.answerSize === undefined) return h('span', { class: 'dim', title: t('tests.noAnswer') }, '?');
      return h(Check, { size: 14, class: 'good' });
    },
  },
]);

const rowProps = (r: TestInfo) => ({
  style: 'cursor: pointer',
  class: r.index === selected.value ? 'row-selected' : '',
  onClick: () => (selected.value = r.index),
});

const current = computed(() => manifest.value?.tests.find((x) => x.index === selected.value) ?? null);
const files = ref<Record<string, TestFileResponse | null>>({});
const tab = ref<'in' | 'ans' | 'overview'>('in');

async function loadFiles() {
  files.value = {};
  const n = selected.value;
  const ts = testset.value;
  if (n === null) return;
  const kinds: ('in' | 'ans' | 'overview')[] = ['in', 'ans', 'overview'];
  const res = await Promise.all(kinds.map((k) => api.testFile(props.problemId, n, k, testset.value).catch(() => null)));
  if (selected.value !== n || testset.value !== ts) return;
  files.value = Object.fromEntries(kinds.map((k, i) => [k, res[i]]));
}
watch([selected, testset, () => manifest.value?.generatedAt], loadFiles);
// Keep a test selected so the detail area is never blank: the first one by default.
watch(
  () => manifest.value?.tests,
  (tests) => {
    if (!tests?.length) return (selected.value = null);
    if (selectAfterGenerate !== null && tests.some((x) => x.index === selectAfterGenerate)) {
      selected.value = selectAfterGenerate;
      selectAfterGenerate = null;
      return;
    }
    if (!tests.some((x) => x.index === selected.value)) selected.value = tests[0].index;
  },
  { immediate: true },
);
</script>

<template>
  <div class="panel">
    <n-space align="center" justify="space-between">
      <n-space size="small">
        <n-button size="small" type="primary" :loading="running" @click="generate">{{ t('toolbar.generate') }}</n-button>
        <n-button v-if="running" size="small" @click="judge.cancel('generate')">{{ t('common.cancel') }}</n-button>
        <n-select
          v-if="testsets.length > 1"
          v-model:value="testset"
          size="small"
          :options="testsets.map((x) => ({ label: x, value: x }))"
          style="width: 110px"
        />
        <n-button size="small" quaternary :title="t('testsets.title')" @click="showTestsets = true"><template #icon><layers :size="15" /></template>{{ t('testsets.title') }}</n-button>
        <n-button size="small" quaternary :disabled="running" @click="openAdd"><template #icon><plus /></template>{{ t('tests.addTest') }}</n-button>
      </n-space>
      <span v-if="manifest" class="dim small">{{ t('tests.count', { n: manifest.tests.length }) }} · {{ new Date(manifest.generatedAt).toLocaleTimeString() }}</span>
    </n-space>
    <div v-if="running && job" class="progress">
      <n-progress
        type="line"
        :percentage="job.progress.total ? Math.round((job.progress.done / job.progress.total) * 100) : 0"
        :show-indicator="false"
        :height="4"
        :processing="true"
      />
      <span class="pf-hint">{{ serverText(job.progress.message) }}<template v-if="job.progress.total"> · {{ job.progress.done }}/{{ job.progress.total }}</template></span>
    </div>
    <n-alert v-if="job?.status === 'failed'" type="error" :show-icon="false" class="alert">
      <pre class="pf-log">{{ serverText(job.error) }}</pre>
    </n-alert>
    <n-alert v-if="manifest && manifest.errors.length" type="warning" :show-icon="false" class="alert">
      <div v-for="(e, i) in manifest.errors.slice(0, 20)" :key="i" class="small err-line">{{ serverText(e) }}</div>
      <div v-if="manifest.errors.length > 20" class="small dim">… {{ manifest.errors.length - 20 }}</div>
    </n-alert>

    <div v-if="!manifest" class="pf-empty">{{ t('tests.none') }}</div>
    <n-data-table
      v-else
      size="small"
      :columns="columns"
      :data="manifest.tests"
      :row-key="(r: TestInfo) => r.index"
      :row-props="rowProps"
      :max-height="260"
      virtual-scroll
      :bordered="false"
    />

    <div v-if="current" class="detail">
      <n-space align="center" justify="space-between" class="detail-head">
        <strong>{{ t('tests.test') }} #{{ current.index }}</strong>
        <n-space size="small" align="center">
          <label class="sample-toggle">
            <n-switch size="small" :value="!!current.sample" :disabled="running" @update:value="(v: boolean) => setSample(current!.index, v)" />
            {{ t('tests.sample') }}
          </label>
          <template v-if="current.sample">
            <label class="sample-toggle"><n-switch size="small" :value="!current.largeSample" :disabled="running" @update:value="(v: boolean) => setSampleVisible(current!.index, v)" />{{ t('oiFeatures.inlineSample') }}</label>
            <n-tag v-if="current.largeSample" size="small" type="info">{{ t('oiFeatures.largeSample') }}</n-tag>
            <n-button v-for="w in ['in', 'out'] as const" :key="w" size="tiny" :type="(w === 'in' ? current.statementInput : current.statementOutput) ? 'info' : 'default'"
              :title="(w === 'in' ? current.statementInput : current.statementOutput) ? t('tests.statementActiveHint', { file: w === 'in' ? current.statementInput : current.statementOutput }) : t('tests.statementCreateHint')"
              @click="statementButton(current, w)">{{ t(w === 'in' ? 'tests.statementInputBtn' : 'tests.statementOutputBtn') }}</n-button>
          </template>
          <n-button v-if="testset === 'tests'" size="tiny" @click="emit('runOnTest', current.index)">{{ t('tests.runHere') }}</n-button>
          <n-button size="tiny" quaternary :disabled="running" :title="t('tests.remove')" @click="removeTest(current)"><trash2 :size="13" /></n-button>
        </n-space>
      </n-space>
      <div v-if="current.validatorMessage" class="bad small">{{ current.validatorMessage }}</div>
      <div v-if="current.error" class="bad small">{{ serverText(current.error) }}</div>
      <n-tabs v-model:value="tab" size="small" type="segment">
        <n-tab-pane v-for="k in ['in', 'ans', 'overview'] as const" :key="k" :name="k" :tab="t(`tests.file.${k}`)">
          <n-button v-if="files[k]" size="tiny" @click="openGenerated(k)">{{ t('tree.open') }}</n-button>
          <n-scrollbar style="max-height: 240px">
            <pre v-if="files[k]" class="content mono">{{ files[k]!.content }}<span v-if="files[k]!.truncated" class="dim">
… ({{ formatSize(files[k]!.size) }})</span></pre>
            <div v-else class="dim small">{{ t('tests.noFile') }}</div>
          </n-scrollbar>
        </n-tab-pane>
      </n-tabs>
    </div>
    <div v-else-if="manifest" class="pf-empty">{{ t('tests.pickOne') }}</div>
    <testset-dialog v-model:show="showTestsets" :ws="ws" :judge="judge" :initial="testset" />
    <tool-window v-model:show="showAdd" :title="t('tests.addTest')" size="md">
      <n-input
        v-model:value="addInput"
        type="textarea"
        class="mono"
        :autosize="{ minRows: 6, maxRows: 16 }"
        :placeholder="t('tests.addInputPlaceholder')"
        autofocus
      />
      <template v-if="addAsSample">
        <div class="add-label small">{{ t('tests.statementInput') }}</div>
        <n-input
          v-model:value="addStmtIn"
          type="textarea"
          class="mono"
          :autosize="{ minRows: 2, maxRows: 10 }"
          :placeholder="interactive ? t('tests.statementInteractive') : t('tests.statementInputOptional')"
        />
        <div class="add-label small">{{ t('tests.statementOutput') }}</div>
        <n-input
          v-model:value="addStmtOut"
          type="textarea"
          class="mono"
          :autosize="{ minRows: 2, maxRows: 10 }"
          :placeholder="interactive ? t('tests.statementInteractive') : t('tests.statementOutputOptional')"
        />
      </template>
      <div class="add-foot pf-hint">{{ t('tests.addHint') }}</div>
      <template #footer-left>
        <label class="sample-toggle"><n-switch v-model:value="addAsSample" size="small" /> {{ t('tests.markSample') }}</label>
      </template>
      <template #footer>
        <n-button @click="showAdd = false">{{ t('common.cancel') }}</n-button>
        <n-button type="primary" :loading="adding" :disabled="!addInput.trim() || (interactive && addAsSample && (!addStmtIn.trim() || !addStmtOut.trim()))" @click="addTest">{{ t('tests.add') }}</n-button>
      </template>
    </tool-window>
  </div>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
}
.progress {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.alert {
  padding: 4px 8px;
}

.err-line {
  word-break: break-all;
}
.detail {
  border-top: 1px solid var(--pf-border);
  padding-top: 6px;
}
.sample-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
.add-label {
  margin: 10px 0 4px;
}
.add-foot {
  margin-top: 6px;
}
.detail-head {
  margin-bottom: 4px;
}
.content {
  margin: 0;
  font-size: 12px;
  white-space: pre;
}
.small {
  font-size: 12px;
}
.dim {
  opacity: 0.6;
}

:deep(.origin) {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
:deep(.origin-icon) {
  opacity: 0.6;
  flex-shrink: 0;
}
:deep(.good) {
  color: light-dark(#16804a, #63e2b7);
}
:deep(.bad) {
  color: light-dark(#c53b3b, #e88080);
}
:deep(.flags) {
  display: inline-flex;
  gap: 2px;
}
:deep(.row-selected td) {
  background: var(--pf-selected) !important;
}
</style>
