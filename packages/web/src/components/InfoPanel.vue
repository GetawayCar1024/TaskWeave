<script setup lang="ts">
import { computed, h, reactive, ref, watch } from 'vue';
import { stdCheckerDescription } from '../lib/stdCheckers';
import { useI18n } from 'vue-i18n';
import {
  NButton,
  NCard,
  NDescriptions,
  NDescriptionsItem,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NScrollbar,
  NSelect,
  NAlert,
  NTag,
  useMessage,
  type SelectOption,
} from 'naive-ui';
import { SOLUTION_TAGS, isSourceFile, judgeMode, type JudgeMode, type PatchProblemRequest, type SolutionTag } from '@polyforge/shared';
import { api, errorMessage } from '../lib/api';
import { formatSize } from '../lib/format';
import type { Judge } from '../lib/judge';
import { tagType } from '../lib/tags';
import { Check, X } from 'lucide-vue-next';
import { SHARED_TAB, type Workspace } from '../lib/workspace';

const props = defineProps<{ ws: Workspace; judge: Judge }>();
const { t, locale } = useI18n();
const message = useMessage();

/** Input / output choices: the standard stream, or a file (kept when already set). */
const streamOptions = (std: 'stdin' | 'stdout', cur: string) => [
  { label: `${std} (${t(std === 'stdin' ? 'problem.stdin' : 'problem.stdout')})`, value: std },
  ...(cur && cur !== std ? [{ label: cur, value: cur }] : []),
];
const cfg = computed(() => props.ws.state.detail?.config ?? null);

const form = reactive({
  titleZh: '',
  titleEn: '',
  timeLimit: 1000,
  memoryLimit: 256,
  judgeMode: 'batch' as JudgeMode,
  graderSources: [] as string[],
  graderHeaders: [] as string[],
  input: 'stdin',
  output: 'stdout',
  checker: null as string | null,
  lemonChecker: null as string | null,
  validator: null as string | null,
  interactor: null as string | null,
  samples: '',
});

function reset() {
  const c = cfg.value;
  if (!c) return;
  Object.assign(form, {
    titleZh: c.problem.title.zh ?? '',
    titleEn: c.problem.title.en ?? '',
    timeLimit: c.problem.time_limit,
    memoryLimit: c.problem.memory_limit,
    judgeMode: judgeMode(c.problem),
    graderSources: [...(c.grader?.sources ?? [])],
    graderHeaders: [...(c.grader?.headers ?? [])],
    input: c.problem.input,
    output: c.problem.output,
    checker: c.checker?.source ?? null,
    lemonChecker: c.lemon_checker?.source ?? null,
    validator: c.validator?.source ?? null,
    interactor: c.interactor?.source ?? null,
    samples: c.tests.samples ?? '',
  });
}
watch(cfg, reset, { immediate: true });

const dirty = computed(() => {
  const c = cfg.value;
  if (!c) return false;
  return (
    form.titleZh !== (c.problem.title.zh ?? '') ||
    form.titleEn !== (c.problem.title.en ?? '') ||
    form.timeLimit !== c.problem.time_limit ||
    form.memoryLimit !== c.problem.memory_limit ||
    form.judgeMode !== judgeMode(c.problem) ||
    JSON.stringify(form.graderSources) !== JSON.stringify(c.grader?.sources ?? []) ||
    JSON.stringify(form.graderHeaders) !== JSON.stringify(c.grader?.headers ?? []) ||
    form.input !== c.problem.input ||
    form.output !== c.problem.output ||
    form.checker !== (c.checker?.source ?? null) ||
    form.lemonChecker !== (c.lemon_checker?.source ?? null) ||
    form.validator !== (c.validator?.source ?? null) ||
    form.interactor !== (c.interactor?.source ?? null) ||
    form.samples !== (c.tests.samples ?? '')
  );
});

const localSources = computed(() => props.ws.files.value.filter((f) => isSourceFile(f.path)).map((f) => f.path));

const checkerOptions = computed<SelectOption[]>(() => [
  {
    type: 'group',
    label: t('info.stdCheckers'),
    key: 'std',
    children: (props.ws.state.shared?.checkers ?? []).map((c) => ({ label: `${c.ref} — ${stdCheckerDescription(c.ref!, c.description, locale.value)}`, value: c.ref! })),
  },
  { type: 'group', label: t('info.localFiles'), key: 'local', children: localSources.value.map((p) => ({ label: p, value: p })) },
]);
const sourceOptions = computed<SelectOption[]>(() => localSources.value.map((p) => ({ label: p, value: p })));
const converting = ref(false);
async function convertChecker() {
  const detail = props.ws.state.detail;
  if (!detail || dirty.value || converting.value) return;
  if (props.ws.state.tabs.some(tab => tab.dirty && (tab.path === cfg.value?.checker?.source || tab.path === 'problem.toml'))) {
    message.warning(t('oiFeatures.saveCheckerFirst')); return;
  }
  converting.value = true;
  try {
    const r = await api.convertLemonChecker(detail.summary.id);
    await props.ws.loadDetail(); await props.ws.openFile(r.source);
    message.success(t('oiFeatures.convertedChecker'));
  } catch (e) { message.error(errorMessage(e)); }
  finally { converting.value = false; }
}

async function save() {
  const c = cfg.value;
  if (!c) return;
  const req: PatchProblemRequest = {
    title: { ...c.problem.title, zh: form.titleZh, en: form.titleEn },
    timeLimit: form.timeLimit,
    memoryLimit: form.memoryLimit,
    judgeMode: form.judgeMode,
    ...(form.judgeMode === 'grader' ? { grader: { sources: form.graderSources, headers: form.graderHeaders } } : {}),
    input: form.input || 'stdin',
    output: form.output || 'stdout',
    checker: form.checker,
    lemonChecker: form.lemonChecker,
    validator: form.validator,
    interactor: form.interactor,
    samples: form.samples,
  };
  try {
    await props.ws.patch(req);
    message.success(t('common.saved'));
  } catch (e) {
    message.error(errorMessage(e));
  }
}

async function setTag(source: string, tag: SolutionTag) {
  try {
    await props.ws.patch({ solution: { source, tag } });
  } catch (e) {
    message.error(errorMessage(e));
  }
}

const tagOptions = SOLUTION_TAGS.map((x) => ({ label: x, value: x }));
const renderTag = (o: SelectOption) =>
  h(NTag, { size: 'tiny', type: tagType(o.value as SolutionTag), bordered: false }, () => o.label as string);

const active = computed(() => props.ws.activeTab.value);
const compile = computed(() => (active.value ? props.judge.state.compile[active.value.path] ?? null : null));
const activeInfo = computed(() => {
  const tab = active.value;
  if (!tab) return null;
  const shared = tab.path.startsWith(SHARED_TAB);
  const file = props.ws.files.value.find((f) => f.path === tab.path);
  return {
    path: tab.path,
    role: shared ? (tab.path.startsWith(`${SHARED_TAB}checkers/`) ? 'checker' : 'resource') : props.ws.roleOf(tab.path),
    size: file?.size,
    lang: props.ws.languageFor(tab.path),
  };
});
</script>

<template>
  <n-scrollbar style="height: 100%">
    <div class="panel">
      <n-card v-if="activeInfo" size="small" :title="t('info.file')">
        <n-descriptions :column="1" size="small" label-placement="left">
          <n-descriptions-item :label="t('info.path')"><span class="mono small">{{ activeInfo.path }}</span></n-descriptions-item>
          <n-descriptions-item :label="t('info.role')">{{ t(`roles.${activeInfo.role}`) }}</n-descriptions-item>
          <n-descriptions-item v-if="activeInfo.size !== undefined" :label="t('info.size')">{{ formatSize(activeInfo.size) }}</n-descriptions-item>
          <n-descriptions-item v-if="isSourceFile(activeInfo.path)" :label="t('info.language')">
            <span v-if="activeInfo.lang">{{ activeInfo.lang.name }} <span class="mono small dim">({{ activeInfo.lang.id }})</span></span>
            <span v-else class="dim">{{ t('info.noLanguage') }}</span>
          </n-descriptions-item>
        </n-descriptions>
      </n-card>

      <n-card v-if="cfg" size="small" :title="t('info.problem')">
        <template #header-extra>
          <n-button size="tiny" type="primary" :disabled="!dirty" @click="save">{{ t('common.save') }}</n-button>
        </template>
        <n-form size="small" label-placement="left" label-width="100" :show-feedback="false" class="form">
          <n-form-item :label="t('create.titleZh')"><n-input v-model:value="form.titleZh" /></n-form-item>
          <n-form-item :label="t('create.titleEn')"><n-input v-model:value="form.titleEn" /></n-form-item>
          <n-form-item :label="t('problem.timeLimit')">
            <n-input-number v-model:value="form.timeLimit" :min="100" :max="15000" :step="500">
              <template #suffix>ms</template>
            </n-input-number>
          </n-form-item>
          <n-form-item :label="t('problem.memoryLimit')">
            <n-input-number v-model:value="form.memoryLimit" :min="4" :max="1024" :step="64">
              <template #suffix>MB</template>
            </n-input-number>
          </n-form-item>
          <n-form-item :label="t('problem.io')">
            <div class="io">
              <!-- stdin / stdout, or a file name typed in (e.g. input.txt) -->
              <n-select v-model:value="form.input" :options="streamOptions('stdin', form.input)" filterable tag :placeholder="t('problem.ioFile')" />
              <n-select v-model:value="form.output" :options="streamOptions('stdout', form.output)" filterable tag :placeholder="t('problem.ioFile')" />
            </div>
          </n-form-item>
          <n-form-item :label="t('oiFeatures.mode')"><n-select v-model:value="form.judgeMode" :options="['batch', 'io', 'grader'].map(value => ({ value, label: t(`oiFeatures.${value}`) }))" /></n-form-item>
          <template v-if="form.judgeMode === 'grader'">
            <n-alert type="warning" style="margin-bottom: 12px">{{ t('oiFeatures.graderWarning') }}</n-alert>
            <n-form-item :label="t('oiFeatures.graderSources')"><n-select v-model:value="form.graderSources" multiple filterable :options="sourceOptions.filter(o => /\.(cpp|cc|cxx)$/i.test(String(o.value)))" /></n-form-item>
            <n-form-item :label="t('oiFeatures.graderHeaders')"><n-select v-model:value="form.graderHeaders" multiple filterable :options="ws.files.value.filter(f => /\.(h|hpp|hh|hxx|inc)$/i.test(f.path)).map(f => ({ value: f.path, label: f.path }))" /></n-form-item>
            <p class="small dim">{{ t('oiFeatures.graderHint') }}</p>
          </template>
          <n-form-item :label="t('roles.checker')">
            <n-select v-model:value="form.checker" :options="checkerOptions" filterable clearable />
          </n-form-item>
          <n-form-item :label="t('roles.validator')">
            <n-select v-model:value="form.validator" :options="sourceOptions" filterable clearable />
          </n-form-item>
          <n-form-item :label="t('oiFeatures.lemonChecker')">
            <n-select v-model:value="form.lemonChecker" :options="sourceOptions" filterable clearable />
          </n-form-item>
          <p class="small dim">{{ t('oiFeatures.lemonCheckerHint') }}</p>
          <n-button size="small" :loading="converting" :disabled="dirty || converting || !cfg.checker" :title="dirty ? t('oiFeatures.saveCheckerFirst') : undefined" @click="convertChecker">{{ t('oiFeatures.convertChecker') }}</n-button>
          <p class="small dim">{{ t('oiFeatures.convertCheckerHint') }}</p>
          <n-form-item v-if="form.judgeMode === 'io'" :label="t('roles.interactor')">
            <n-select v-model:value="form.interactor" :options="sourceOptions" filterable clearable />
          </n-form-item>
          <n-form-item :label="t('info.samples')">
            <n-input v-model:value="form.samples" placeholder="1-2" class="mono" />
          </n-form-item>
        </n-form>
      </n-card>

      <n-card v-if="cfg" size="small" :title="t('roles.solution')">
        <div v-if="cfg.solutions.length === 0" class="dim small">{{ t('info.noSolutions') }}</div>
        <div v-for="s in cfg.solutions" :key="s.source" class="sol">
          <a class="mono small link" @click="ws.openFile(s.source)">{{ s.source }}</a>
          <n-select
            size="tiny"
            :value="s.tag"
            :options="tagOptions"
            :render-label="renderTag"
            style="width: 110px"
            @update:value="(v: SolutionTag) => setTag(s.source, v)"
          />
        </div>
      </n-card>

      <n-card v-if="compile" size="small" :title="t('info.compile')">
        <template #header-extra>
          <span v-if="judge.state.compiling[compile.source]" class="dim small">{{ t('info.compiling') }}</span>
          <span v-else :class="compile.ok ? 'good' : 'bad'" class="small status"><check v-if="compile.ok" :size="13" /><x v-else :size="13" />{{ compile.ok ? t('info.compileOk') : t('info.compileFailed') }}</span>
        </template>
        <div class="dim small">{{ compile.durationMs }} ms{{ compile.cached ? ' · ' + t('run.cached') : '' }}</div>
        <pre v-if="compile.log" class="log mono">{{ compile.log }}</pre>
      </n-card>
    </div>
  </n-scrollbar>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
}
.form :deep(.n-form-item) {
  margin-bottom: 6px;
}
.io {
  display: flex;
  gap: 4px;
  width: 100%;
}
.io > * {
  flex: 1;
  min-width: 0;
}
.sol {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 2px 0;
}
.small {
  font-size: 12px;
}
.dim {
  opacity: 0.6;
}
.log {
  margin: 6px 0 0;
  font-size: 12px;
  white-space: pre-wrap;
  max-height: 240px;
  overflow: auto;
}
.good {
  color: #63e2b7;
}
.status {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.bad {
  color: #e88080;
}
.link {
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.link:hover {
  text-decoration: underline;
}
</style>
