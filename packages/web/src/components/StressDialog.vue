<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { serverText } from '../lib/serverText';
import { useI18n } from 'vue-i18n';
import { NAlert, NButton, NForm, NFormItem, NInput, NInputNumber, NModal, NProgress, NSelect, NSpace, NTag, useMessage } from 'naive-ui';
import type { JobInfo, StressResult } from '@polyforge/shared';
import { api, errorMessage } from '../lib/api';
import { waitJob } from '../lib/jobs';
import { verdictType } from '../lib/verdict';
import type { Workspace } from '../lib/workspace';

/** 对拍: random tests until a solution disagrees with the reference. */
const props = defineProps<{ show: boolean; ws: Workspace; problemId: string }>();
const emit = defineEmits<{ 'update:show': [boolean] }>();
const { t } = useI18n();
const message = useMessage();

const config = computed(() => props.ws.state.detail?.config ?? null);
const generators = computed(() => {
  const names = new Set<string>();
  for (const g of config.value?.generators ?? []) names.add(g.source.split('/').pop()!.replace(/\.[^.]+$/, ''));
  for (const f of props.ws.files.value) if (/^generators\/[^/]+\.(cpp|cc|py|java)$/.test(f.path)) names.add(f.path.split('/').pop()!.replace(/\.[^.]+$/, ''));
  return [...names].sort().map((n) => ({ label: n, value: n }));
});
const solutions = computed(() => (config.value?.solutions ?? []).map((s) => ({ label: `${s.source} (${s.tag})`, value: s.source })));

const form = reactive({ generator: '', args: '10 1000', solution: '', reference: '', maxIterations: 1000, timeLimitSec: 60 });
const job = ref<JobInfo | null>(null);
const result = ref<StressResult | null>(null);
const error = ref('');

watch(
  () => props.show,
  (s) => {
    if (!s) return;
    form.generator ||= generators.value[0]?.value ?? '';
    const ma = config.value?.solutions.find((x) => x.tag === 'MA')?.source ?? '';
    form.reference ||= ma;
    form.solution ||= config.value?.solutions.find((x) => x.source !== ma)?.source ?? '';
  },
);

const running = computed(() => job.value?.status === 'running');

async function start() {
  result.value = null;
  error.value = '';
  try {
    job.value = await api.stress(props.problemId, { ...form, reference: form.reference || undefined });
    const done = await waitJob(job.value, (j) => (job.value = j));
    job.value = done;
    if (done.status === 'done') {
      result.value = done.result as StressResult;
      if (result.value.found) await props.ws.loadDetail();
    } else if (done.status === 'failed') error.value = done.error ?? '';
  } catch (e) {
    error.value = errorMessage(e);
  }
}

async function cancel() {
  if (job.value) await api.cancelJob(job.value.id).catch((e) => message.error(errorMessage(e)));
}

const saving = ref(false);
async function saveCounterexample() {
  const c = result.value?.counterexample;
  if (!c || c.savedAs) return;
  saving.value = true;
  try {
    const saved = await api.addManualTest(props.problemId, { input: c.input });
    c.savedAs = saved.path;
    await props.ws.loadDetail();
  } catch (e) { message.error(errorMessage(e)); }
  finally { saving.value = false; }
}
</script>

<template>
  <n-modal :show="show" preset="card" :title="t('stress.title')" style="width: min(960px, 94vw)" @update:show="emit('update:show', $event)">
    <n-form label-placement="left" label-width="auto" size="small">
      <n-form-item :label="t('stress.generator')">
        <n-space>
          <n-select v-model:value="form.generator" :options="generators" filterable tag style="width: 200px" />
          <n-input v-model:value="form.args" class="mono" style="width: 320px" :placeholder="t('stress.argsPlaceholder')" />
        </n-space>
      </n-form-item>
      <div class="hint">{{ t('stress.argsHint') }}</div>
      <n-form-item :label="t('stress.solution')">
        <n-select v-model:value="form.solution" :options="solutions" filterable tag />
      </n-form-item>
      <n-form-item :label="t('stress.reference')">
        <n-select v-model:value="form.reference" :options="solutions" filterable tag />
      </n-form-item>
      <n-form-item :label="t('stress.limits')">
        <n-space align="center">
          <n-input-number v-model:value="form.maxIterations" :min="1" :max="100000" style="width: 140px"><template #suffix>{{ t('stress.times') }}</template></n-input-number>
          <n-input-number v-model:value="form.timeLimitSec" :min="1" :max="3600" style="width: 120px"><template #suffix>s</template></n-input-number>
        </n-space>
      </n-form-item>
    </n-form>

    <div v-if="running && job" class="progress">
      <n-progress type="line" :percentage="job.progress.total ? Math.round((job.progress.done / job.progress.total) * 100) : 0" :height="6" :show-indicator="false" />
      <span class="hint">{{ job.progress.done }} / {{ job.progress.total }} · {{ serverText(job.progress.message) }}</span>
    </div>
    <n-alert v-if="error" type="error" :show-icon="false" class="alert"><pre class="log">{{ error }}</pre></n-alert>
    <template v-if="result">
      <n-alert v-if="!result.found" type="success" :show-icon="false" class="alert">
        {{ t('stress.noDiff', { n: result.iterations }) }}<template v-if="result.stoppedBy !== 'iterations'"> ({{ t(`stress.stopped.${result.stoppedBy}`) }})</template>
      </n-alert>
      <template v-else-if="result.counterexample">
        <n-space align="center" class="found">
          <n-tag :type="verdictType(result.counterexample.verdict)" :bordered="false">{{ result.counterexample.verdict }}</n-tag>
          <span>{{ t('stress.found', { n: result.iterations }) }}</span>
          <span class="mono hint">{{ form.generator }} {{ result.counterexample.args }}</span>
          <n-button v-if="result.counterexample.savedAs" size="tiny" @click="ws.openFile(result.counterexample.savedAs!)">{{ t('stress.saved', { path: result.counterexample.savedAs }) }}</n-button>
          <n-button v-else size="tiny" :loading="saving" @click="saveCounterexample">{{ t('tests.addTest') }}</n-button>
        </n-space>
        <div v-if="result.counterexample.message" class="hint mono">{{ result.counterexample.message }}</div>
        <div class="three">
          <div>
            <div class="label">{{ t('inv.input') }}</div>
            <pre class="box mono">{{ result.counterexample.input.slice(0, 20000) }}</pre>
          </div>
          <div>
            <div class="label">{{ t('stress.expected') }}</div>
            <pre class="box mono">{{ result.counterexample.expected }}</pre>
          </div>
          <div>
            <div class="label">{{ t('inv.output') }}</div>
            <pre class="box mono">{{ result.counterexample.output }}</pre>
          </div>
        </div>
      </template>
    </template>

    <template #footer>
      <n-space justify="end">
        <n-button v-if="running" @click="cancel">{{ t('common.cancel') }}</n-button>
        <n-button type="primary" :loading="running" :disabled="!form.generator || !form.solution" @click="start">{{ t('stress.start') }}</n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
.hint {
  font-size: 12px;
  opacity: 0.65;
}
.hint:not(.mono) {
  margin: -6px 0 10px;
}
.progress {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 8px 0;
}
.alert {
  margin-top: 8px;
}
.log {
  margin: 0;
  white-space: pre-wrap;
  font-size: 12px;
}
.found {
  margin: 8px 0 4px;
}
.three {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-top: 6px;
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
  max-height: 260px;
  overflow: auto;
}
</style>
