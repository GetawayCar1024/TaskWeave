<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NAlert, NButton, NInput, NRadioButton, NRadioGroup, NSelect, NSpace, NTag, useMessage } from 'naive-ui';
import { isSourceFile, type QuickRunResponse } from '@taskweave/shared';
import { api, errorMessage } from '../lib/api';
import type { Judge } from '../lib/judge';
import { fmtMem, verdictType } from '../lib/verdict';
import { useResizable } from '../lib/resize';
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

/** Output boxes: height limits set by dragging their bottom border. */
const outSize = useResizable('taskweave-run-stdout-height', { edge: 'bottom', initial: 240, min: 60 });
const errSize = useResizable('taskweave-run-stderr-height', { edge: 'bottom', initial: 240, min: 60 });

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
        <pre class="pf-log">{{ result.compile.log }}</pre>
      </n-alert>
      <template v-else>
        <n-space align="center" size="small">
          <n-tag v-if="result.verdict" :type="verdictType(result.verdict)" size="small" :bordered="false">{{ result.verdict }}</n-tag>
          <span v-if="result.run" class="small">{{ result.run.timeMs }} ms · {{ fmtMem(result.run.memoryKb) }}</span>
          <span v-if="result.run && result.run.exitCode" class="small dim">{{ t('run.exitCode', { code: result.run.exitCode }) }}</span>
          <span v-if="result.compile.cached" class="small dim">{{ t('run.cached') }}</span>
        </n-space>
        <div v-if="result.checker?.message" class="small msg">{{ result.checker.message }}</div>
        <div class="pf-label">{{ t('run.stdout') }}<span v-if="result.stdoutTruncated" class="dim"> ({{ t('run.truncated') }})</span></div>
        <div class="out-wrap">
          <pre class="pf-box out" :style="{ maxHeight: `${outSize.size.value}px` }">{{ result.stdout }}</pre>
          <div class="pf-resize-handle bottom" :class="{ active: outSize.dragging.value }" :title="t('improve.resize')" @pointerdown="outSize.start" @dblclick="outSize.reset" />
        </div>
        <template v-if="result.stderr">
          <div class="pf-label">{{ t('run.stderr') }}</div>
          <div class="out-wrap">
            <pre class="pf-box out err" :style="{ maxHeight: `${errSize.size.value}px` }">{{ result.stderr }}</pre>
            <div class="pf-resize-handle bottom" :class="{ active: errSize.dragging.value }" :title="t('improve.resize')" @pointerdown="errSize.start" @dblclick="errSize.reset" />
          </div>
        </template>
        <details v-if="result.compile.log" class="small">
          <summary class="dim">{{ t('run.compileLog') }}</summary>
          <pre class="pf-log">{{ result.compile.log }}</pre>
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
.out {
  white-space: pre;
}
.out-wrap {
  position: relative;
}
.out.err {
  color: light-dark(#b0482a, #e8a080);
}
.msg {
  word-break: break-word;
}
.small {
  font-size: 12px;
}
.dim {
  color: var(--pf-text-secondary);
}
</style>
