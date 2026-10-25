<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NAlert, NButton, NForm, NFormItem, NInput, NInputNumber, NSelect, NSpace, useMessage } from 'naive-ui';
import type { JobInfo, StressResult } from '@polyforge/shared';
import { api, errorMessage } from '../lib/api';
import type { Judge } from '../lib/judge';
import { waitJob } from '../lib/jobs';
import { verdictClass } from '../lib/verdict';
import type { Workspace } from '../lib/workspace';
import ToolWindow from './ToolWindow.vue';

/**
 * 对拍: random tests until a solution disagrees with the reference. With `judge` the
 * job is the problem's stress job, so it can be closed and reopened (even after
 * leaving the problem) and still shows the running or finished job.
 */
const props = defineProps<{ show: boolean; ws: Workspace; problemId: string; judge?: Judge }>();
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

// The last settings of the problem are kept.
const FORM_KEY = `polyforge-stress-${props.problemId}`;
const form = reactive({ generator: '', args: '10 1000', solution: '', reference: '', maxIterations: 1000, timeLimitSec: 60 });
try {
  Object.assign(form, JSON.parse(localStorage.getItem(FORM_KEY) ?? '{}'));
} catch {
  /* ignore */
}
watch(form, (f) => localStorage.setItem(FORM_KEY, JSON.stringify(f)), { deep: true });
const localJob = ref<JobInfo | null>(null);
const job = computed<JobInfo | null>(() => props.judge?.state.jobs.stress ?? localJob.value);
const result = computed<StressResult | null>(() => (job.value?.status === 'done' ? ((job.value.result as StressResult | undefined) ?? null) : null));
const startError = ref('');
const error = computed(() => startError.value || (job.value?.status === 'failed' ? job.value.error ?? '' : ''));
const counterexampleLoaded = new Set<string>();
// A counterexample was saved as a test: show it in the file tree.
watch(result, (r) => {
  if (r?.found && job.value && !counterexampleLoaded.has(job.value.id)) {
    counterexampleLoaded.add(job.value.id);
    void props.ws.loadDetail();
  }
});

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
  startError.value = '';
  try {
    const started = await api.stress(props.problemId, { ...form, reference: form.reference || undefined });
    if (props.judge) {
      // Progress and the result arrive with the problem's job events.
      props.judge.trackJob(started);
      return;
    }
    localJob.value = started;
    localJob.value = await waitJob(started, (j) => (localJob.value = j));
  } catch (e) {
    startError.value = errorMessage(e);
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
  <tool-window :show="show" :title="t('stress.title')" size="lg" :status="job?.status ?? null" :progress="job?.progress ?? null" :error="error" @update:show="emit('update:show', $event)">
    <n-form label-placement="left" label-width="auto" size="small" :disabled="running">
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

    <template v-if="result">
      <n-alert v-if="!result.found" type="success" :show-icon="false" class="alert">
        {{ t('stress.noDiff', { n: result.iterations }) }}<template v-if="result.stoppedBy !== 'iterations'"> ({{ t(`stress.stopped.${result.stoppedBy}`) }})</template>
      </n-alert>
      <template v-else-if="result.counterexample">
        <n-space align="center" class="found">
          <span class="pf-verdict-pill" :class="verdictClass(result.counterexample.verdict)">{{ result.counterexample.verdict }}</span>
          <span>{{ t('stress.found', { n: result.iterations }) }}</span>
          <span class="mono hint">{{ form.generator }} {{ result.counterexample.args }}</span>
          <n-button v-if="result.counterexample.savedAs" size="tiny" @click="ws.openFile(result.counterexample.savedAs!)">{{ t('stress.saved', { path: result.counterexample.savedAs }) }}</n-button>
          <n-button v-else size="tiny" :loading="saving" @click="saveCounterexample">{{ t('tests.addTest') }}</n-button>
        </n-space>
        <div v-if="result.counterexample.message" class="hint mono">{{ result.counterexample.message }}</div>
        <div class="three">
          <div>
            <div class="pf-label">{{ t('inv.input') }}</div>
            <pre class="pf-box box">{{ result.counterexample.input.slice(0, 20000) }}</pre>
          </div>
          <div>
            <div class="pf-label">{{ t('stress.expected') }}</div>
            <pre class="pf-box box">{{ result.counterexample.expected }}</pre>
          </div>
          <div>
            <div class="pf-label">{{ t('inv.output') }}</div>
            <pre class="pf-box box">{{ result.counterexample.output }}</pre>
          </div>
        </div>
      </template>
    </template>

    <template #footer>
      <n-button v-if="running" @click="cancel">{{ t('inv.stop') }}</n-button>
      <n-button type="primary" :disabled="running || !form.generator || !form.solution" @click="start">{{ t('stress.start') }}</n-button>
    </template>
  </tool-window>
</template>

<style scoped>
.hint {
  font-size: 12px;
  color: var(--pf-text-secondary);
}
.hint:not(.mono) {
  margin: -6px 0 10px;
}
.alert {
  margin-top: 8px;
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
.box {
  max-height: 260px;
}
</style>
