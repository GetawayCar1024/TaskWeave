<script setup lang="ts">
import { computed } from 'vue';
import { serverText } from '../lib/serverText';
import { useI18n } from 'vue-i18n';
import { NAlert, NButton, NSpace, NTag, useMessage } from 'naive-ui';
import { errorMessage } from '../lib/api';
import type { Judge } from '../lib/judge';
import { verdictType } from '../lib/verdict';
import { Check, X } from 'lucide-vue-next';
import type { Workspace } from '../lib/workspace';

const props = defineProps<{ ws: Workspace; judge: Judge }>();
const { t } = useI18n();
const message = useMessage();

const vr = computed(() => props.judge.state.validatorReport);
const cr = computed(() => props.judge.state.checkerReport);
const passed = (rs: { ok: boolean }[]) => rs.filter((r) => r.ok).length;

async function go(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    message.error(errorMessage(e));
  }
}
</script>

<template>
  <div class="panel">
    <section>
      <n-space align="center" justify="space-between">
        <span class="pf-section-title">{{ t('selftest.validator') }}</span>
        <n-button size="small" :loading="judge.running('validator-tests')" @click="go(judge.validatorTests)">{{ t('selftest.run') }}</n-button>
      </n-space>
      <div class="pf-hint">{{ t('selftest.validatorHint') }}</div>
      <template v-if="vr">
        <n-alert v-if="vr.compile && !vr.compile.ok" type="error" :show-icon="false"><pre class="pf-log">{{ vr.compile.log }}</pre></n-alert>
        <n-alert v-if="vr.error" type="warning" :show-icon="false" class="small">{{ serverText(vr.error) }}</n-alert>
        <div v-if="vr.results.length" class="summary" :class="passed(vr.results) === vr.results.length ? 'good' : 'bad'">
          {{ passed(vr.results) }} / {{ vr.results.length }}
        </div>
        <div v-for="r in vr.results" :key="r.file" class="row">
          <check v-if="r.ok" :size="13" class="good" /><x v-else :size="13" class="bad" />
          <a class="mono link" @click="ws.openFile(r.file)">{{ r.file.replace('validator-tests/', '') }}</a>
          <n-tag size="tiny" :bordered="false">{{ r.expected }}</n-tag>
          <span v-if="!r.ok" class="small">{{ t('selftest.got', { v: r.actual }) }}</span>
          <div v-if="r.message" class="msg" :title="r.message">{{ r.message }}</div>
        </div>
      </template>
    </section>

    <section>
      <n-space align="center" justify="space-between">
        <span class="pf-section-title">{{ t('selftest.checker') }}</span>
        <n-button size="small" :loading="judge.running('checker-tests')" @click="go(judge.checkerTests)">{{ t('selftest.run') }}</n-button>
      </n-space>
      <div class="pf-hint">{{ t('selftest.checkerHint') }}</div>
      <template v-if="cr">
        <n-alert v-if="cr.compile && !cr.compile.ok" type="error" :show-icon="false"><pre class="pf-log">{{ cr.compile.log }}</pre></n-alert>
        <n-alert v-if="cr.error" type="warning" :show-icon="false" class="small">{{ serverText(cr.error) }}</n-alert>
        <div v-if="cr.results.length" class="summary" :class="passed(cr.results) === cr.results.length ? 'good' : 'bad'">
          {{ passed(cr.results) }} / {{ cr.results.length }}
        </div>
        <div v-for="r in cr.results" :key="r.name" class="row">
          <check v-if="r.ok" :size="13" class="good" /><x v-else :size="13" class="bad" />
          <a class="mono link" @click="ws.openFile(`checker-tests/${r.name}.out`)">{{ r.name }}</a>
          <n-tag size="tiny" :bordered="false">{{ r.expected }}</n-tag>
          <n-tag v-if="!r.ok" size="tiny" :type="verdictType(r.actual)" :bordered="false">{{ r.actual }}</n-tag>
          <div v-if="r.message" class="msg" :title="r.message">{{ r.message }}</div>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 8px;
}
section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.summary {
  font-size: 13px;
  font-weight: 600;
}
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
.msg {
  width: 100%;
  padding-left: 18px;
  color: var(--pf-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.link {
  cursor: pointer;
}
.link:hover {
  text-decoration: underline;
}
.good {
  color: light-dark(#16804a, #63e2b7);
}
.bad {
  color: light-dark(#c53b3b, #e88080);
}
.small {
  font-size: 12px;
}
</style>
