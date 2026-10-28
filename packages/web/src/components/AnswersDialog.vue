<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { NAlert, NButton, NFormItem, NSelect, useMessage } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import type { AnswerBackupInfo, AnswerOperationResult, JobInfo } from '@taskweave/shared';
import { api, errorMessage } from '../lib/api';
import { waitJob } from '../lib/jobs';
import { createJobFollower } from '../lib/jobFollower';
import type { Workspace } from '../lib/workspace';
import type { Judge } from '../lib/judge';
import ToolWindow from './ToolWindow.vue';

const props = defineProps<{ show: boolean; problemId: string; testset: string; ws: Workspace; judge: Judge }>();
const emit = defineEmits<{ 'update:show': [boolean] }>();
const { t } = useI18n(), message = useMessage();
const source = ref(''), error = ref(''), starting = ref(false), original = ref<AnswerBackupInfo | null>(null);
const job = ref<JobInfo | null>(null);
const solutions = computed(() => (props.ws.state.detail?.config?.solutions ?? []).map(solution => ({ value: solution.source, label: `${solution.tag} · ${solution.source}` })));
const busy = computed(() => starting.value || job.value?.status === 'running');
const follower = createJobFollower(waitJob, value => { job.value = value; props.judge.trackJob(value); }, async result => {
  if (result.status === 'failed') { error.value = result.error ?? ''; return; }
  if (result.status !== 'done') return;
  const done = result.result as AnswerOperationResult;
  await Promise.all([props.judge.loadManifest(done.testset), props.ws.loadDetail(), loadBackup()]);
  message.success(t(done.action === 'restore' ? 'answers.restored' : 'answers.generated', { n: done.tests }));
});
onBeforeUnmount(() => follower.dispose());
async function loadBackup() {
  try { original.value = await api.originalAnswers(props.problemId, props.testset); }
  catch (e) { error.value = errorMessage(e); }
}
watch(() => props.show, async show => {
  if (!show) return;
  error.value = '';
  if (!solutions.value.some(solution => solution.value === source.value)) source.value = props.ws.state.detail?.config?.solutions.find(solution => solution.tag === 'MA')?.source ?? solutions.value[0]?.value ?? '';
  await loadBackup();
  const running = props.judge.state.jobs.answers;
  if (running?.status === 'running') void follower.follow(running);
});
async function run(action: 'regenerate' | 'restore') {
  if (busy.value) return;
  if (props.ws.hasDirty.value) { message.warning(t('tree.saveFirst')); return; }
  starting.value = true; error.value = '';
  try { await follower.follow(await (action === 'regenerate' ? api.regenerateAnswers(props.problemId, { source: source.value, testset: props.testset }) : api.restoreAnswers(props.problemId, props.testset))); }
  catch (e) { error.value = errorMessage(e); }
  finally { starting.value = false; }
}
</script>
<template>
  <tool-window :show="show" :title="t('answers.title')" size="md" :error="error" :status="job?.status" :progress="job?.progress" @update:show="emit('update:show', $event)">
    <n-form-item :label="t('packages.testset')">{{ testset }}</n-form-item>
    <n-form-item :label="t('roles.solution')"><n-select v-model:value="source" :options="solutions" :disabled="busy" /></n-form-item>
    <n-alert v-if="!solutions.length" type="info" :show-icon="false">{{ t('answers.noSolution') }}</n-alert>
    <p>{{ t('answers.hint') }}</p>
    <n-alert v-if="original?.available" type="info" :show-icon="false">{{ t(original.origin === 'import' ? 'answers.importBackup' : 'answers.existingBackup') }} · {{ new Date(original.createdAt!).toLocaleString() }}</n-alert>
    <p v-else>{{ t('answers.firstBackup') }}</p>
    <template #footer>
      <n-button v-if="job?.status === 'running'" @click="judge.cancel('answers')">{{ t('common.cancel') }}</n-button>
      <n-button :disabled="busy || !original?.available" @click="run('restore')">{{ t('answers.restore') }}</n-button>
      <n-button type="primary" :loading="busy" :disabled="!source || !solutions.length" @click="run('regenerate')">{{ t('answers.generate') }}</n-button>
    </template>
  </tool-window>
</template>
