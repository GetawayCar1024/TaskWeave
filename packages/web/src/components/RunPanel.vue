<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NAlert, NButton, NInput, NRadioButton, NRadioGroup, NSelect, NSpace, NTag, useMessage } from 'naive-ui';
import { isSourceFile, type QuickRunResponse } from '@polyforge/shared';
import { api, errorMessage } from '../lib/api';
import type { Judge } from '../lib/judge';
import { fmtMem, verdictType } from '../lib/verdict';
import type { Workspace } from '../lib/workspace';

const props = defineProps<{ ws: Workspace; judge: Judge; problemId: string }>();
const { t } = useI18n();
const message = useMessage();

const sources = computed(() => props.ws.files.value.filter((f) => isSourceFile(f.path)).map((f) => f.path));
const source = ref<string | null>(null);
const mode = ref<'custom' | 'test'>('custom');
const input = ref('');
const test = ref<number | null>(null);
const busy = ref(false);
const result = ref<QuickRunResponse | null>(null);

// Follow the active editor tab when it is a source file.
watch(
  () => props.ws.state.active,
  (p) => {
    if (p && isSourceFile(p) && !p.startsWith('@shared/')) source.value = p;
  },
  { immediate: true },
);
watch(sources, (s) => {
  if (!source.value || !s.includes(source.value)) source.value = props.ws.state.detail?.config?.solutions.find((x) => x.tag === 'MA')?.source ?? s[0] ?? null;
}, { immediate: true });

const testOptions = computed(() => (props.judge.state.manifest?.tests ?? []).map((x) => ({ label: `#${x.index}  ${x.source}`, value: x.index })));

async function run() {
  if (!source.value) return;
  busy.value = true;
  try {
    // Unsaved edits would otherwise run the old code.
    const tab = props.ws.state.tabs.find((x) => x.path === source.value);
    if (tab?.dirty) await props.ws.save(tab.path);
    result.value = await api.run(props.problemId, {
      source: source.value,
      ...(mode.value === 'test' && test.value !== null ? { test: test.value } : { input: input.value }),
    });
  } catch (e) {
    message.error(errorMessage(e));
  } finally {
    busy.value = false;
  }
}

function runOnTest(n: number) {
  mode.value = 'test';
  test.value = n;
  run();
}

defineExpose({ run, runOnTest });
</script>

<template>
  <div class="panel">
    <n-select v-model:value="source" size="small" :options="sources.map((s) => ({ label: s, value: s }))" filterable />
    <n-radio-group v-model:value="mode" size="small">
      <n-radio-button value="custom">{{ t('run.custom') }}</n-radio-button>
      <n-radio-button value="test" :disabled="!testOptions.length">{{ t('run.onTest') }}</n-radio-button>
    </n-radio-group>
    <n-input
      v-if="mode === 'custom'"
      v-model:value="input"
      type="textarea"
      class="mono"
      :autosize="{ minRows: 3, maxRows: 10 }"
      :placeholder="t('run.stdin')"
    />
    <n-select v-else v-model:value="test" size="small" :options="testOptions" filterable />
    <n-space align="center">
      <n-button size="small" type="primary" :loading="busy" :disabled="!source" title="Ctrl+Enter" @click="run">{{ t('run.run') }}</n-button>
    </n-space>

    <template v-if="result">
      <n-alert v-if="!result.compile.ok" type="error" :show-icon="false" :title="t('run.compileError')" class="alert">
        <pre class="log mono">{{ result.compile.log }}</pre>
      </n-alert>
      <template v-else>
        <n-space align="center" size="small">
          <n-tag v-if="result.verdict" :type="verdictType(result.verdict)" size="small" :bordered="false">{{ result.verdict }}</n-tag>
          <span v-if="result.run" class="small">{{ result.run.timeMs }} ms · {{ fmtMem(result.run.memoryKb) }}</span>
          <span v-if="result.run && result.run.exitCode" class="small dim">{{ t('run.exitCode', { code: result.run.exitCode }) }}</span>
          <span v-if="result.compile.cached" class="small dim">{{ t('run.cached') }}</span>
        </n-space>
        <div v-if="result.checker?.message" class="small msg">{{ result.checker.message }}</div>
        <div class="label">{{ t('run.stdout') }}<span v-if="result.stdoutTruncated" class="dim"> ({{ t('run.truncated') }})</span></div>
        <pre class="out mono">{{ result.stdout }}</pre>
        <template v-if="result.stderr">
          <div class="label">{{ t('run.stderr') }}</div>
          <pre class="out mono err">{{ result.stderr }}</pre>
        </template>
        <details v-if="result.compile.log" class="small">
          <summary class="dim">{{ t('run.compileLog') }}</summary>
          <pre class="log mono">{{ result.compile.log }}</pre>
        </details>
      </template>
    </template>
  </div>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
}
.alert {
  padding: 4px 8px;
}
.log {
  margin: 0;
  white-space: pre-wrap;
  font-size: 12px;
  max-height: 300px;
  overflow: auto;
}
.label {
  font-size: 12px;
  opacity: 0.7;
}
.out {
  margin: 0;
  padding: 6px;
  font-size: 12px;
  background: rgba(128, 128, 128, 0.12);
  border-radius: 4px;
  max-height: 240px;
  overflow: auto;
  white-space: pre;
}
.out.err {
  color: #e8a080;
}
.msg {
  word-break: break-word;
}
.small {
  font-size: 12px;
}
.dim {
  opacity: 0.6;
}
</style>
