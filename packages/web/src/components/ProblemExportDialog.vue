<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { NAlert, NButton, NForm, NFormItem, NSelect, useMessage } from 'naive-ui';
import { luoguExportOptions, testsetsOf, type LuoguAggregate, type ProblemDetail, type ProblemExportRequest, type JobInfo } from '@taskweave/shared';
import { api, errorMessage } from '../lib/api';
import { waitJob } from '../lib/jobs';
import { serverText } from '../lib/serverText';
import ToolWindow from './ToolWindow.vue';
import { createJobFollower } from '../lib/jobFollower';
import { labelWidth } from '../lib/labelWidth';

const props = defineProps<{ show: boolean; detail: ProblemDetail | null }>();
const emit = defineEmits<{ 'update:show': [boolean] }>();
const { t, locale } = useI18n(), router = useRouter(), message = useMessage();
const width = labelWidth(112, 160);
const format = ref('polygon'), testsets = ref<string[]>(['tests']);
const time = ref<LuoguAggregate>('sum'), memory = ref<LuoguAggregate>('max');
const busy = ref(false), error = ref(''), job = ref<JobInfo | null>(null);
const sets = computed(() => props.detail?.config ? testsetsOf(props.detail.config).map(ts => ({ value: ts.name, label: ts.name })) : []);
const formats = computed(() => [
  { value: 'polygon', label: t('oiFeatures.polygon') },
  { value: 'hydro', label: t('packages.hydroExport') },
  { value: 'fps', label: t('packages.fps') },
  { value: 'luogu', label: t('packages.luoguExport') },
  { value: 'joi', label: t('packages.joiExport') },
  { value: 'documents', label: t('packages.documents'), disabled: !props.detail?.summary.status.statementLangs.length && !props.detail?.summary.status.tutorialLangs.length },
  { value: 'down', label: 'down.zip' },
]);
const aggregations = computed(() => (['sum', 'min', 'max'] as const).map(value => ({ value, label: t(`contest.agg.${value}`) })));
watch([() => props.show, () => props.detail?.summary.id], ([value]) => { if (value && props.detail) {
  if (busy.value) return;
  format.value = 'polygon'; testsets.value = ['tests']; error.value = ''; job.value = null;
  const options = props.detail?.config ? luoguExportOptions(props.detail.config) : { time: 'sum' as const, memory: 'max' as const };
  time.value = options.time; memory.value = options.memory;
} });
let alive = true;
let closed: (() => void) | undefined;
function afterClose() { closed?.(); closed = undefined; }
function closeBeforeNotice() {
  if (!props.show) return Promise.resolve();
  return new Promise<void>(resolve => { closed = resolve; emit('update:show', false); });
}
const follower = createJobFollower(waitJob, value => job.value = value, () => {});
onBeforeUnmount(() => { alive = false; follower.dispose(); afterClose(); });
async function submit() {
  if (!props.detail || busy.value) return;
  const id = props.detail.summary.id;
  busy.value = true; error.value = '';
  try {
    if (format.value === 'documents' || format.value === 'down' && !props.detail.summary.dataOnly) {
      emit('update:show', false);
      await router.push({ name: 'problem-print', params: { id }, query: format.value === 'down' ? { style: 'oi', down: '1' } : {} });
      return;
    }
    if (format.value === 'down') {
      await api.downSamples(id, locale.value === 'zh-CN' ? 'zh' : 'en', true);
      await closeBeforeNotice();
      if (!alive) return;
      message.success(t('export.saved', { file: 'down.zip' }));
    } else {
      await follower.follow(await api.exportPackage(id, { format: format.value as ProblemExportRequest['format'], testsets: testsets.value, ...(format.value === 'luogu' ? { luogu: { time: time.value, memory: memory.value } } : {}) }));
      if (!alive) return;
      const result = job.value!;
      if (result.status !== 'done') throw new Error(result.error ?? result.status);
      const data = result.result as { file: string; tests: number; warnings: string[] };
      await api.downloadExport(id, data.file);
      if (!alive) return;
      await closeBeforeNotice();
      if (!alive) return;
      message.success(t('export.done', { file: format.value === 'luogu' ? 'data.zip' : data.file, n: data.tests }));
      if (data.warnings.length) message.warning(data.warnings.map(serverText).join('\n'), { duration: 10000 });
    }
  } catch (e) { error.value = errorMessage(e); }
  finally { busy.value = false; }
}
</script>
<template>
  <tool-window :show="show" :title="t('packages.exportProblem')" size="md" :error="error" :status="job?.status" :progress="job?.progress" @after-leave="afterClose" @update:show="value => !busy && emit('update:show', value)">
    <n-form label-placement="left" :label-width="width">
      <n-form-item :label="t('packages.format')"><n-select v-model:value="format" :disabled="busy" :options="formats" /></n-form-item>
      <template v-if="format === 'luogu'">
        <n-form-item :label="t('testsets.title')"><n-select v-model:value="testsets" multiple :disabled="busy" :options="sets" /></n-form-item>
        <n-form-item :label="t('contest.luoguTime')"><n-select v-model:value="time" :options="aggregations" :disabled="busy" /></n-form-item>
        <n-form-item :label="t('contest.luoguMemory')"><n-select v-model:value="memory" :options="aggregations" :disabled="busy" /></n-form-item>
      </template>
      <template v-if="format === 'hydro' || format === 'joi' || format === 'fps'">
        <n-form-item :label="t('testsets.title')"><n-select v-model:value="testsets" multiple :disabled="busy" :options="sets" /></n-form-item>
      </template>
      <n-alert v-if="detail?.summary.dataOnly && format === 'down'" type="info" :show-icon="false">{{ t('dataOnly.downSamples') }}</n-alert>
    </n-form>
    <template #footer><n-button :disabled="busy" @click="emit('update:show', false)">{{ t('common.cancel') }}</n-button><n-button type="primary" :disabled="!detail || ['luogu', 'hydro', 'joi', 'fps'].includes(format) && !testsets.length" :loading="busy" @click="submit">{{ t('contest.export') }}</n-button></template>
  </tool-window>
</template>
