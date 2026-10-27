<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NAlert, NForm, NFormItem, NInput, NInputNumber, NSelect, NButton } from 'naive-ui';
import { PROBLEM_NAME_RE, type JudgeMode, type ProblemSummary, type StatementMode } from '@polyforge/shared';
import { api, errorMessage } from '../lib/api';
import ToolWindow from './ToolWindow.vue';

const props = defineProps<{ show: boolean; roots: string[] }>();
const emit = defineEmits<{ 'update:show': [boolean]; created: [ProblemSummary] }>();
const { t } = useI18n();

const blank = () => ({ name: '', titleZh: '', titleEn: '', timeLimit: 1000, memoryLimit: 256, judgeMode: 'batch' as JudgeMode, statementMode: 'sections' as StatementMode, dataOnly: false, root: props.roots[0] ?? '' });
const form = reactive(blank());
const busy = ref(false);
const error = ref('');

watch(
  () => props.show,
  (s) => {
    if (!s) return;
    Object.assign(form, blank());
    error.value = '';
  },
);

const nameValid = computed(() => PROBLEM_NAME_RE.test(form.name));
const rootOptions = computed(() => props.roots.map((r) => ({ label: r, value: r })));

async function submit() {
  if (!nameValid.value) return;
  busy.value = true;
  error.value = '';
  try {
    const p = await api.createProblem({
      name: form.name,
      root: form.root || undefined,
      title: { zh: form.titleZh, en: form.titleEn },
      timeLimit: form.timeLimit,
      memoryLimit: form.memoryLimit,
      judgeMode: form.dataOnly ? 'batch' : form.judgeMode,
      dataOnly: form.dataOnly,
      statementMode: form.statementMode,
    });
    emit('update:show', false);
    emit('created', p);
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <tool-window :show="show" :title="t('create.title')" size="md" :error="error" @update:show="emit('update:show', $event)">
    <n-form label-placement="left" label-width="auto" @submit.prevent="submit">
      <n-form-item
        :label="t('create.name')"
        :feedback="form.name && !nameValid ? t('create.nameRule') : ''"
        :validation-status="form.name && !nameValid ? 'error' : undefined"
      >
        <n-input v-model:value="form.name" placeholder="a-plus-b" autofocus />
      </n-form-item>
      <n-form-item :label="t('create.titleZh')"><n-input v-model:value="form.titleZh" /></n-form-item>
      <n-form-item :label="t('create.titleEn')"><n-input v-model:value="form.titleEn" /></n-form-item>
      <n-form-item :label="t('problem.timeLimit')">
        <n-input-number v-model:value="form.timeLimit" :min="1" :max="Number.MAX_SAFE_INTEGER" :step="100">
          <template #suffix>ms</template>
        </n-input-number>
      </n-form-item>
      <n-form-item :label="t('problem.memoryLimit')">
        <n-input-number v-model:value="form.memoryLimit" :min="0.001" :max="Number.MAX_SAFE_INTEGER" :step="64">
          <template #suffix>MB</template>
        </n-input-number>
      </n-form-item>
      <n-form-item :label="t('dataOnly.authoringMode')"><n-select :value="form.dataOnly ? 'data' : 'full'" :options="[{ value: 'full', label: t('dataOnly.full') }, { value: 'data', label: t('dataOnly.title') }]" @update:value="value => form.dataOnly = value === 'data'" /></n-form-item>
      <n-alert v-if="form.dataOnly" type="warning" :show-icon="false" class="pf-dialog-note">{{ t('dataOnly.warning') }}</n-alert>
      <n-form-item v-if="!form.dataOnly" :label="t('statementMode.title')"><n-select v-model:value="form.statementMode" :options="[{ value: 'sections', label: t('statementMode.sections') }, { value: 'whole', label: t('statementMode.whole') }]" /></n-form-item>
      <n-form-item v-if="!form.dataOnly" :label="t('oiFeatures.mode')"><n-select v-model:value="form.judgeMode" :options="['batch', 'io', 'grader'].map(value => ({ value, label: t(`oiFeatures.${value}`) }))" /></n-form-item>
      <n-alert v-if="form.judgeMode === 'grader'" type="warning" :show-icon="false" class="pf-dialog-note">{{ t('oiFeatures.graderWarning') }}</n-alert>
      <n-form-item v-if="roots.length > 1" :label="t('create.root')">
        <n-select v-model:value="form.root" :options="rootOptions" />
      </n-form-item>
    </n-form>
    <template #footer>
      <n-button @click="emit('update:show', false)">{{ t('common.cancel') }}</n-button>
      <n-button type="primary" :disabled="!nameValid" :loading="busy" @click="submit">{{ t('common.create') }}</n-button>
    </template>
  </tool-window>
</template>
