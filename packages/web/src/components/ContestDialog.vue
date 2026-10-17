<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { serverText } from '../lib/serverText';
import { useI18n } from 'vue-i18n';
import { NAlert, NButton, NForm, NFormItem, NInput, NInputNumber, NModal, NProgress, NSelect, NSpace, useMessage } from 'naive-ui';
import { PROBLEM_NAME_RE, type ContestSummary, type JobInfo, type ProblemSummary } from '@polyforge/shared';
import { api, errorMessage } from '../lib/api';
import { problemTitle } from '../lib/format';
import DirPicker from './DirPicker.vue';
import { loadSettings } from '../lib/settings';
import { waitJob } from '../lib/jobs';

const props = defineProps<{ show: boolean; mode: 'create' | 'import'; roots: string[]; problems: ProblemSummary[] }>();
const emit = defineEmits<{ 'update:show': [boolean]; created: [ContestSummary] }>();
const { t, locale } = useI18n();
const message = useMessage();

const blank = () => ({ name: '', titleZh: '', titleEn: '', root: props.roots[0] ?? '', problems: [] as string[], contestId: null as number | null });
const form = reactive(blank());
const busy = ref(false);
const showRootPicker = ref(false);
const importError = ref('');
const job = ref<JobInfo | null>(null);
const warnings = ref<string[]>([]);

watch(
  () => props.show,
  (s) => {
    if (!s) return;
    Object.assign(form, blank());
    job.value = null;
    warnings.value = [];
    importError.value = "";
  },
);

const nameValid = computed(() => PROBLEM_NAME_RE.test(form.name));
const canSubmit = computed(() => nameValid.value && (props.mode === 'create' || (!!form.contestId && !!form.root.trim())));
const rootOptions = computed(() => props.roots.map((r) => ({ label: r, value: r })));
const problemOptions = computed(() => props.problems.map((p) => ({ label: `${problemTitle(p.title, locale.value) || p.name} (${p.id})`, value: p.id })));
const letter = (i: number) => String.fromCharCode(65 + i);

async function submit() {
  if (!canSubmit.value) return;
  busy.value = true;
  importError.value = '';
  try {
    if (props.mode === 'create') {
      const c = await api.createContest({
        name: form.name,
        title: { zh: form.titleZh, en: form.titleEn },
        problems: form.problems.map((problem, i) => ({ index: letter(i), problem })),
      });
      emit('update:show', false);
      emit('created', c);
      return;
    }
    const started = await api.importContest({ contestId: form.contestId!, name: form.name, root: form.root || undefined });
    job.value = started;
    const done = await waitJob(started, (j) => (job.value = j));
    job.value = done;
    await loadSettings();
    if (done.status !== 'done') throw new Error(done.error ?? done.status);
    const r = done.result as { contest: ContestSummary; warnings: string[] };
    if (r.warnings.length) {
      warnings.value = r.warnings;
      message.warning(t('contest.importWarnings', { n: r.warnings.length }));
      emit('created', r.contest);
      return;
    }
    emit('update:show', false);
    emit('created', r.contest);
  } catch (e) {
    importError.value = serverText(errorMessage(e));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    :title="mode === 'create' ? t('contest.new') : t('contest.importTitle')"
    style="width: 560px"
    @update:show="emit('update:show', $event)"
  >
    <n-form label-placement="left" label-width="auto" @submit.prevent="submit">
      <n-form-item v-if="mode === 'import'" :label="t('contest.polygonId')">
        <n-input-number v-model:value="form.contestId" :min="1" :show-button="false" placeholder="12345" style="width: 100%" />
      </n-form-item>
      <n-form-item
        :label="t('create.name')"
        :feedback="form.name && !nameValid ? t('create.nameRule') : ''"
        :validation-status="form.name && !nameValid ? 'error' : undefined"
      >
        <n-input v-model:value="form.name" placeholder="round-1" />
      </n-form-item>
      <template v-if="mode === 'create'">
        <n-form-item :label="t('create.titleZh')"><n-input v-model:value="form.titleZh" /></n-form-item>
        <n-form-item :label="t('create.titleEn')"><n-input v-model:value="form.titleEn" /></n-form-item>
        <n-form-item :label="t('contest.problems')">
          <n-select v-model:value="form.problems" multiple filterable :options="problemOptions" />
        </n-form-item>
        <div v-if="form.problems.length" class="letters">
          <span v-for="(p, i) in form.problems" :key="p" class="mono">{{ letter(i) }}: {{ p }}</span>
        </div>
      </template>
      <n-form-item v-if="mode === 'import'" :label="t('contest.problemsRoot')">
        <n-space vertical style="width: 100%"><n-select v-model:value="form.root" filterable tag :options="rootOptions" :disabled="busy" /><n-button size="small" :disabled="busy" @click="showRootPicker = true">{{ t('dirPicker.title') }}</n-button></n-space>
      </n-form-item>
    </n-form>
    <div v-if="job && job.status === 'running'" class="progress">
      <n-progress type="line" :percentage="job.progress.total ? Math.round((job.progress.done / job.progress.total) * 100) : 0" :height="4" :show-indicator="false" />
      <span class="small dim">{{ serverText(job.progress.message) }}</span>
    </div>
    <dir-picker v-model:show="showRootPicker" :initial="form.root" @pick="p => form.root = p" />
    <n-alert v-if="importError" type="error" style="white-space: pre-wrap">{{ importError }}</n-alert>
    <n-alert v-if="warnings.length" type="warning" :show-icon="false">
      <div v-for="w in warnings" :key="w" class="small">{{ serverText(w) }}</div>
    </n-alert>
    <template #footer>
      <n-space justify="end">
        <n-button @click="emit('update:show', false)">{{ warnings.length ? t('common.close') : t('common.cancel') }}</n-button>
        <n-button v-if="!warnings.length" type="primary" :disabled="!canSubmit" :loading="busy" @click="submit">
          {{ mode === 'create' ? t('common.create') : t('contest.import') }}
        </n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
.letters {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  font-size: 12px;
  opacity: 0.7;
  margin: -8px 0 12px;
}
.progress {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 8px;
}
.small {
  font-size: 12px;
}
.dim {
  opacity: 0.6;
}
</style>
