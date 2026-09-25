<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { serverText } from '../lib/serverText';
import { useI18n } from 'vue-i18n';
import { NAlert, NButton, NForm, NFormItem, NInput, NInputNumber, NModal, NScrollbar, NSelect, NSpace, NSpin, useMessage } from 'naive-ui';
import { PROBLEM_NAME_RE, type PolygonProblem, type ProblemSummary } from '@polyforge/shared';
import { api, errorMessage } from '../lib/api';
import { waitJob } from '../lib/jobs';

const props = defineProps<{ show: boolean; roots: string[] }>();
const emit = defineEmits<{ 'update:show': [boolean]; imported: [ProblemSummary] }>();
const { t } = useI18n();
const message = useMessage();

const list = ref<PolygonProblem[] | null>(null);
const listError = ref('');
const filter = ref('');
const polygonId = ref<number | null>(null);
const name = ref('');
const root = ref('');
const busy = ref(false);
const progress = ref('');

watch(
  () => props.show,
  async (s) => {
    if (!s) return;
    polygonId.value = null;
    name.value = '';
    root.value = props.roots[0] ?? '';
    list.value = null;
    listError.value = '';
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
  progress.value = '';
  try {
    const job = await api.importPolygon({ polygonId: polygonId.value, name: name.value || undefined, root: root.value || undefined });
    const done = await waitJob(job, (j) => (progress.value = serverText(j.progress.message)));
    if (done.status !== 'done') throw new Error(done.error ?? done.status);
    emit('update:show', false);
    emit('imported', done.result as ProblemSummary);
  } catch (e) {
    message.error(serverText(errorMessage(e)));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <n-modal :show="show" preset="card" :title="t('import.title')" style="width: 640px" @update:show="emit('update:show', $event)">
    <n-alert v-if="listError" type="warning" :show-icon="false" class="small">{{ listError }}</n-alert>
    <template v-else>
      <n-input v-model:value="filter" size="small" clearable :placeholder="t('import.search')" />
      <n-scrollbar style="max-height: 260px; margin: 6px 0">
        <div v-if="!list" class="center"><n-spin size="small" /></div>
        <div v-for="p in shown" :key="p.id" class="row" :class="{ active: polygonId === p.id }" @click="pick(p)">
          <span class="mono">{{ p.name }}</span>
          <span class="dim small">#{{ p.id }} · {{ p.owner }}<template v-if="p.accessType"> · {{ p.accessType }}</template></span>
        </div>
        <div v-if="list && !shown.length" class="dim small center">{{ t('import.none') }}</div>
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
      <n-space justify="space-between" align="center">
        <span class="dim small">{{ progress }}</span>
        <n-space>
          <n-button @click="emit('update:show', false)">{{ t('common.cancel') }}</n-button>
          <n-button type="primary" :disabled="!polygonId || !nameOk" :loading="busy" @click="submit">{{ t('import.run') }}</n-button>
        </n-space>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
.row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 3px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
}
.row:hover {
  background: rgba(128, 128, 128, 0.12);
}
.row.active {
  background: rgba(99, 226, 183, 0.18);
}
.center {
  display: flex;
  justify-content: center;
  padding: 12px;
}
.small {
  font-size: 12px;
}
.dim {
  opacity: 0.65;
}
</style>
