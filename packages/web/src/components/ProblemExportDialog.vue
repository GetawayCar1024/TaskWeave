<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { NAlert, NButton, NForm, NFormItem, NSelect, useMessage } from 'naive-ui';
import { luoguExportOptions, testsetsOf, type LuoguAggregate, type ProblemDetail, type JobInfo } from '@polyforge/shared';
import { api, errorMessage } from '../lib/api';
import { waitJob } from '../lib/jobs';
import { serverText } from '../lib/serverText';
import ToolWindow from './ToolWindow.vue';

const props = defineProps<{ show: boolean; detail: ProblemDetail | null }>();
const emit = defineEmits<{ 'update:show': [boolean] }>();
const { t, locale } = useI18n(), router = useRouter(), message = useMessage();
const format = ref('polygon'), testsets = ref<string[]>(['tests']);
const time = ref<LuoguAggregate>('sum'), memory = ref<LuoguAggregate>('max');
const busy = ref(false), error = ref(''), job = ref<JobInfo | null>(null);
const sets = computed(() => props.detail?.config ? testsetsOf(props.detail.config).map(ts => ({ value: ts.name, label: ts.name })) : []);
const formats = computed(() => [
  { value: 'polygon', label: t('oiFeatures.polygon'), disabled: !!props.detail?.summary.dataOnly },
  { value: 'luogu', label: t('packages.luoguExport') },
  { value: 'hydro', label: t('packages.hydroExport') },
  { value: 'documents', label: t('packages.documents'), disabled: !props.detail?.summary.status.statementLangs.length && !props.detail?.summary.status.tutorialLangs.length },
  { value: 'down', label: 'down.zip' },
]);
const aggregations = computed(() => (['sum', 'min', 'max'] as const).map(value => ({ value, label: t(`contest.agg.${value}`) })));
watch([() => props.show, () => props.detail?.summary.id], ([value]) => { if (value && props.detail) {
  format.value = props.detail?.summary.dataOnly ? 'luogu' : 'polygon'; testsets.value = ['tests']; error.value = ''; job.value = null;
  const options = props.detail?.config ? luoguExportOptions(props.detail.config) : { time: 'sum' as const, memory: 'max' as const };
  time.value = options.time; memory.value = options.memory;
} });
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
      message.info(t('dataOnly.downSamples'));
    } else {
      const result = await waitJob(await api.exportPackage(id, { format: format.value as 'polygon' | 'luogu' | 'hydro', testsets: testsets.value, ...(format.value === 'luogu' ? { luogu: { time: time.value, memory: memory.value } } : {}) }), value => job.value = value);
      if (result.status !== 'done') throw new Error(result.error ?? result.status);
      const data = result.result as { file: string; tests: number; warnings: string[] };
      await api.downloadExport(id, data.file);
      message.success(t('export.done', { file: format.value === 'luogu' ? 'data.zip' : data.file, n: data.tests }));
      if (data.warnings.length) message.warning(data.warnings.map(serverText).join('\n'), { duration: 10000 });
    }
    emit('update:show', false);
  } catch (e) { error.value = errorMessage(e); }
  finally { busy.value = false; }
}
</script>
<template>
  <tool-window :show="show" :title="t('packages.exportProblem')" size="md" :error="error" :status="job?.status" :progress="job?.progress" @update:show="value => !busy && emit('update:show', value)">
    <n-form label-placement="left" label-width="auto">
      <n-form-item :label="t('packages.format')"><n-select v-model:value="format" :disabled="busy" :options="formats" /></n-form-item>
      <template v-if="format === 'luogu'">
        <n-alert type="info" :show-icon="false" class="pf-dialog-note">{{ t('packages.luoguHint') }}</n-alert>
        <n-form-item :label="t('testsets.title')"><n-select v-model:value="testsets" multiple :disabled="busy" :options="sets" /></n-form-item>
        <n-form-item :label="t('contest.luoguTime')"><n-select v-model:value="time" :options="aggregations" :disabled="busy" /></n-form-item>
        <n-form-item :label="t('contest.luoguMemory')"><n-select v-model:value="memory" :options="aggregations" :disabled="busy" /></n-form-item>
      </template>
      <template v-if="format === 'hydro'">
        <n-alert type="info" :show-icon="false" class="pf-dialog-note">{{ t('packages.hydroHint') }}</n-alert>
        <n-form-item :label="t('testsets.title')"><n-select v-model:value="testsets" multiple :disabled="busy" :options="sets" /></n-form-item>
      </template>
      <n-alert v-if="detail?.summary.dataOnly && format === 'down'" type="info" :show-icon="false">{{ t('dataOnly.downSamples') }}</n-alert>
    </n-form>
    <template #footer><n-button :disabled="busy" @click="emit('update:show', false)">{{ t('common.cancel') }}</n-button><n-button type="primary" :disabled="!detail || ['luogu', 'hydro'].includes(format) && !testsets.length" :loading="busy" @click="submit">{{ t('contest.export') }}</n-button></template>
  </tool-window>
</template>
