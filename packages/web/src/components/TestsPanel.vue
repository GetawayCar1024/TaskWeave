<script setup lang="ts">
import { computed, h, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NAlert, NButton, NDataTable, NProgress, NScrollbar, NSpace, NTabPane, NTabs, NTag, useMessage, type DataTableColumns } from 'naive-ui';
import type { TestFileResponse, TestInfo } from '@polyforge/shared';
import { api, errorMessage } from '../lib/api';
import { formatSize } from '../lib/format';
import { Check, Cog, Pencil, X } from 'lucide-vue-next';
import type { Judge } from '../lib/judge';
import type { Workspace } from '../lib/workspace';

const props = defineProps<{ ws: Workspace; judge: Judge; problemId: string }>();
const emit = defineEmits<{ runOnTest: [number] }>();
const { t } = useI18n();
const message = useMessage();

const job = computed(() => props.judge.state.jobs.generate);
const running = computed(() => job.value?.status === 'running');
const manifest = computed(() => props.judge.state.manifest);
const selected = ref<number | null>(null);

async function generate() {
  try {
    await props.judge.generate();
  } catch (e) {
    message.error(errorMessage(e));
  }
}

const columns = computed<DataTableColumns<TestInfo>>(() => [
  { title: '#', key: 'index', width: 44 },
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
    width: 64,
    render: (r) =>
      h('span', { class: 'flags' }, [
        r.sample ? h(NTag, { size: 'tiny', type: 'info', bordered: false }, () => t('tests.sample')) : null,
        r.group ? h(NTag, { size: 'tiny', bordered: false }, () => `G${r.group}`) : null,
      ]),
  },
  { title: t('tests.size'), key: 'inputSize', width: 70, render: (r) => (r.inputSize !== undefined ? formatSize(r.inputSize) : '—') },
  {
    title: '',
    key: 'status',
    width: 30,
    render: (r) => {
      if (r.error) return h(X, { size: 14, class: 'bad', title: r.error });
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
  if (n === null) return;
  const kinds: ('in' | 'ans' | 'overview')[] = ['in', 'ans', 'overview'];
  const res = await Promise.all(kinds.map((k) => api.testFile(props.problemId, n, k).catch(() => null)));
  if (selected.value !== n) return;
  files.value = Object.fromEntries(kinds.map((k, i) => [k, res[i]]));
}
watch([selected, () => manifest.value?.generatedAt], loadFiles);
</script>

<template>
  <div class="panel">
    <n-space align="center" justify="space-between">
      <n-space size="small">
        <n-button size="small" type="primary" :loading="running" @click="generate">{{ t('toolbar.generate') }}</n-button>
        <n-button v-if="running" size="small" @click="judge.cancel('generate')">{{ t('common.cancel') }}</n-button>
      </n-space>
      <span v-if="manifest" class="dim small">{{ t('tests.count', { n: manifest.tests.length }) }} · {{ new Date(manifest.generatedAt).toLocaleTimeString() }}</span>
    </n-space>
    <div v-if="running && job" class="progress">
      <n-progress
        type="line"
        :percentage="job.progress.total ? Math.round((job.progress.done / job.progress.total) * 100) : 0"
        :show-indicator="false"
        :height="4"
      />
      <span class="dim small">{{ job.progress.message }}</span>
    </div>
    <n-alert v-if="job?.status === 'failed'" type="error" :show-icon="false" class="alert">
      <pre class="log">{{ job.error }}</pre>
    </n-alert>
    <n-alert v-if="manifest && manifest.errors.length" type="warning" :show-icon="false" class="alert">
      <div v-for="(e, i) in manifest.errors.slice(0, 20)" :key="i" class="small err-line">{{ e }}</div>
      <div v-if="manifest.errors.length > 20" class="small dim">… {{ manifest.errors.length - 20 }}</div>
    </n-alert>

    <div v-if="!manifest" class="dim small empty">{{ t('tests.none') }}</div>
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
        <n-button size="tiny" @click="emit('runOnTest', current.index)">{{ t('tests.runHere') }}</n-button>
      </n-space>
      <div v-if="current.validatorMessage" class="bad small">{{ current.validatorMessage }}</div>
      <div v-if="current.error" class="bad small">{{ current.error }}</div>
      <n-tabs v-model:value="tab" size="small" type="segment">
        <n-tab-pane v-for="k in ['in', 'ans', 'overview'] as const" :key="k" :name="k" :tab="t(`tests.file.${k}`)">
          <n-scrollbar style="max-height: 240px">
            <pre v-if="files[k]" class="content mono">{{ files[k]!.content }}<span v-if="files[k]!.truncated" class="dim">
… ({{ formatSize(files[k]!.size) }})</span></pre>
            <div v-else class="dim small">{{ t('tests.noFile') }}</div>
          </n-scrollbar>
        </n-tab-pane>
      </n-tabs>
    </div>
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
.log {
  margin: 0;
  white-space: pre-wrap;
  font-size: 12px;
  max-height: 200px;
  overflow: auto;
}
.err-line {
  word-break: break-all;
}
.detail {
  border-top: 1px solid rgba(128, 128, 128, 0.25);
  padding-top: 6px;
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
.empty {
  padding: 16px 0;
  text-align: center;
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
  color: #63e2b7;
}
:deep(.bad) {
  color: #e88080;
}
:deep(.flags) {
  display: inline-flex;
  gap: 2px;
}
:deep(.row-selected td) {
  background: rgba(99, 226, 183, 0.12) !important;
}
</style>
