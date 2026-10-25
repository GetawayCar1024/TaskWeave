<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NAlert, NButton, NForm, NFormItem, NInput, NInputNumber, NScrollbar, NSelect, NSpin } from 'naive-ui';
import { PROBLEM_NAME_RE, type JobInfo, type PolygonProblem, type ProblemSummary } from '@polyforge/shared';
import { api, errorMessage } from '../lib/api';
import { waitJob } from '../lib/jobs';
import ToolWindow from './ToolWindow.vue';

const props = defineProps<{ show: boolean; roots: string[] }>();
const emit = defineEmits<{ 'update:show': [boolean]; imported: [ProblemSummary] }>();
const { t } = useI18n();

const list = ref<PolygonProblem[] | null>(null);
const listError = ref('');
const filter = ref('');
const polygonId = ref<number | null>(null);
const name = ref('');
const root = ref('');
const busy = ref(false);
const job = ref<JobInfo | null>(null);
const error = ref('');

watch(
  () => props.show,
  async (s) => {
    if (!s) return;
    polygonId.value = null;
    name.value = '';
    root.value = props.roots[0] ?? '';
    list.value = null;
    listError.value = '';
    error.value = '';
    if (!busy.value) job.value = null;
    try {
      list.value = (await api.polygonProblems()).filter((p) => !(p as { deleted?: boolean }).deleted);
    } catch (e) {
      listError.value = errorMessage(e);
    }
  },
);

const shown = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return (list.value ?? []).filter((p) => !q || p.name.includes(q) || String(p.id).includes(q) || p.owner.toLowerCase().includes(q)).slice(0, 200);
});

function pick(p: PolygonProblem) {
  polygonId.value = p.id;
  name.value = p.name;
}

const nameOk = computed(() => !name.value || PROBLEM_NAME_RE.test(name.value));

async function submit() {
  if (!polygonId.value || !nameOk.value) return;
  busy.value = true;
  error.value = '';
  try {
    const started = await api.importPolygon({ polygonId: polygonId.value, name: name.value || undefined, root: root.value || undefined });
    job.value = started;
    const done = await waitJob(started, (j) => (job.value = j));
    job.value = done;
    if (done.status !== 'done') throw new Error(done.error ?? done.status);
    emit('update:show', false);
    emit('imported', done.result as ProblemSummary);
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <tool-window
    :show="show"
    :title="t('import.title')"
    size="md"
    :status="job?.status ?? null"
    :progress="job?.progress ?? null"
    :error="error"
    @update:show="emit('update:show', $event)"
  >
    <n-alert v-if="listError" type="warning" :show-icon="false" class="pf-dialog-note">{{ listError }}</n-alert>
    <template v-else>
      <n-input v-model:value="filter" size="small" clearable :placeholder="t('import.search')" />
      <n-scrollbar class="list">
        <div v-if="!list" class="pf-center"><n-spin size="small" /></div>
        <div v-for="p in shown" :key="p.id" class="pf-row row" :class="{ active: polygonId === p.id }" @click="pick(p)">
          <span class="mono">{{ p.name }}</span>
          <span class="pf-hint">#{{ p.id }} · {{ p.owner }}<template v-if="p.accessType"> · {{ p.accessType }}</template></span>
        </div>
        <div v-if="list && !shown.length" class="pf-empty">{{ t('import.none') }}</div>
      </n-scrollbar>
    </template>
    <n-form label-placement="left" label-width="auto" size="small">
      <n-form-item :label="t('import.id')">
        <n-input-number v-model:value="polygonId" :show-button="false" style="width: 160px" />
      </n-form-item>
      <n-form-item :label="t('import.name')" :validation-status="nameOk ? undefined : 'error'" :feedback="nameOk ? '' : t('create.nameRule')">
        <n-input v-model:value="name" :placeholder="t('import.namePlaceholder')" />
      </n-form-item>
      <n-form-item v-if="roots.length > 1" :label="t('create.root')">
        <n-select v-model:value="root" :options="roots.map((r) => ({ label: r, value: r }))" />
      </n-form-item>
    </n-form>
    <template #footer>
      <n-button @click="emit('update:show', false)">{{ t('common.cancel') }}</n-button>
      <n-button type="primary" :disabled="!polygonId || !nameOk" :loading="busy" @click="submit">{{ t('import.run') }}</n-button>
    </template>
  </tool-window>
</template>

<style scoped>
.list {
  max-height: 260px;
  margin: 6px 0 12px;
}
.row {
  justify-content: space-between;
  gap: 8px;
}
</style>
