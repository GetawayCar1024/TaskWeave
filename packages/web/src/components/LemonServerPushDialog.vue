<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { NAlert, NButton, NCheckbox, NCheckboxGroup, NInput, NRadioButton, NRadioGroup, NSelect, NSpace, NSpin, NSwitch, NTag, useMessage } from 'naive-ui';
import { CircleAlert, CircleCheck, ExternalLink, RefreshCw, Server } from 'lucide-vue-next';
import { commonContestLanguages, type ContestBatchRequest, type ContestDetail, type JobInfo, type LemonServerStatus, type LuoguExportOptions } from '@taskweave/shared';
import ToolWindow from './ToolWindow.vue';
import { api, errorMessage } from '../lib/api';
import { waitJob } from '../lib/jobs';
import { getDefs } from '../lib/defs';
import { buildMacros } from '../lib/latex';
import { oiContent, oiLayout, renderOi } from '../lib/oiDocument';
import { serverText } from '../lib/serverText';

type TestsetChoice = Record<string, { all: string[]; chosen: string[]; luogu: LuoguExportOptions }>;
const props = defineProps<{
  show: boolean;
  contestId: string;
  detail: ContestDetail | null;
  /** The contest's current job (any kind); the push job is followed by the parent. */
  job: JobInfo | null;
  /** Another contest job runs. */
  contestBusy: boolean;
  testsets: TestsetChoice;
  loadingOptions: boolean;
  follow: (job: JobInfo) => Promise<void>;
}>();
const emit = defineEmits<{ 'update:show': [boolean] }>();
const { t, locale } = useI18n();
const router = useRouter();
const message = useMessage();
const ui = (zh: string, en: string) => (locale.value.startsWith('zh') ? zh : en);

// ---- server ----
const server = ref<LemonServerStatus | null>(null);
const serverUrl = ref('');
const checking = ref(false);
const serverError = ref('');
const serverReady = computed(() => !!server.value && !server.value.setupRequired);
async function checkServer() {
  checking.value = true; serverError.value = ''; server.value = null;
  try {
    const secrets = await api.secrets();
    serverUrl.value = secrets.lemonServer?.url ?? '';
    if (!serverUrl.value || !secrets.lemonServer?.hasKey) { serverError.value = t('contest.lemonServerNotConfigured'); return; }
    server.value = await api.lemonServerTest();
    if (server.value.setupRequired) serverError.value = t('settings.lemonServerSetup');
  } catch (e) { serverError.value = errorMessage(e); }
  finally { checking.value = false; }
}

// ---- contest ----
const name = ref('');
const overwrite = ref(false);
const keepSources = ref(true);
const subfolders = ref(false);
const compile = ref(true);
const nameValid = computed(() => { const n = name.value; return !!n.trim() && n === n.trim() && !/[<>:"/\\|?*\x00-\x1f]/.test(n) && !n.endsWith('.') && n.length <= 128; });
const exists = computed(() => {
  const n = name.value.trim(), s = server.value;
  return !!s && !!n && s.names.some(x => (s.target === 'windows' ? x.toLowerCase() === n.toLowerCase() : x === n));
});

// ---- down.zip ----
const downMode = ref<'none' | 'samples' | 'pdf'>('none');
const dataOnly = computed(() => !!props.detail?.problems.some(p => p.summary?.dataOnly));
const downLangs = computed(() => (props.detail ? commonContestLanguages(props.detail.problems, 'statements') : []));
const downLang = ref('');
const downToc = ref(localStorage.getItem('taskweave-print-toc') !== '0');
watch(downLangs, list => { if (!list.includes(downLang.value)) downLang.value = list.includes(locale.value.startsWith('zh') ? 'zh' : 'en') ? (locale.value.startsWith('zh') ? 'zh' : 'en') : list[0] ?? ''; }, { immediate: true });
/** Why the statement PDF is not available: problems without a statement in a language all of them share. */
const pdfBlocked = computed(() => {
  if (!props.detail || downLangs.value.length) return '';
  const problems = props.detail.problems;
  if (!problems.length) return t('contest.lemonServerPdfEmpty');
  const missing = problems.filter(p => !p.summary?.status.statementLangs.length).map(p => p.index);
  return missing.length ? t('contest.lemonServerPdfMissing', { list: missing.join(', ') }) : t('contest.lemonServerPdfNoCommon');
});
watch(pdfBlocked, v => { if (v && downMode.value === 'pdf') downMode.value = 'samples'; });

const multiTestsets = computed(() => (props.detail?.problems ?? []).filter(p => (props.testsets[p.problem]?.all.length ?? 0) > 1));

// ---- push ----
const jobId = ref<string | null>(null);
const pushJob = computed(() => (props.job && props.job.id === jobId.value ? props.job : null));
const submitting = ref(false);
/** Steps that run here before the push job (sample generation, OI typesetting). */
const phase = ref('');
const error = ref('');
let abort: AbortController | undefined;
const running = computed(() => submitting.value || pushJob.value?.status === 'running');
const status = computed(() => (phase.value ? 'running' : pushJob.value?.status ?? null));
const progress = computed(() => (phase.value ? { done: 0, total: 0, message: phase.value } : pushJob.value?.progress ?? null));
const canPush = computed(() => serverReady.value && nameValid.value && (!exists.value || overwrite.value) && !props.loadingOptions && !props.contestBusy && !running.value && (downMode.value !== 'pdf' || !!downLang.value));

watch(() => props.show, open => {
  if (!open) return;
  error.value = '';
  if (!running.value) jobId.value = null;
  if (!name.value) name.value = props.detail?.summary.name ?? '';
  void checkServer();
}, { immediate: true });

const toBase64 = (bytes: Uint8Array) => new Promise<string>((resolve, reject) => {
  const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.onerror = reject; r.readAsDataURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
});

/** The OI statement PDF of down.zip: samples generated first, then typeset here (as on the print page). */
async function statementPdf(lang: string, signal: AbortSignal): Promise<NonNullable<NonNullable<ContestBatchRequest['lemonServer']>['down']>> {
  phase.value = t('contest.lemonServerPhaseGenerate');
  const done = await waitJob(await api.contestBatch(props.contestId, { action: 'generate' }), () => {});
  if (done.status !== 'done') throw new Error(done.error ?? t('tool.status.cancelled'));
  const bad = (done.result as import('@taskweave/shared').ContestBatchResult).items.filter(item => !item.ok);
  if (bad.length) throw new Error(bad.map(item => `${item.index}: ${serverText(item.message)}`).join('\n'));
  signal.throwIfAborted();
  phase.value = t('contest.lemonServerPhaseTypeset');
  const [detail, statements, defs, notes] = await Promise.all([api.contest(props.contestId), api.contestStatements(props.contestId, lang), getDefs(), api.contestNotes(props.contestId, lang)]);
  const content = oiContent({ detail, statements, lang, doc: 'statements', notes: notes.content, macros: buildMacros(defs, lang), layout: { ...oiLayout(detail), toc: downToc.value }, ui });
  const rendered = await renderOi(content, signal).result;
  if (rendered.missingFonts.length && !rendered.fallbackFonts.length) message.warning(t('contest.lemonServerMissingFonts', { fonts: rendered.missingFonts.join(', ') }));
  return { mode: 'pdf', lang, pdf: await toBase64(rendered.pdf), statements, notes: notes.content };
}

async function push() {
  if (!canPush.value) return;
  submitting.value = true; error.value = '';
  abort = new AbortController();
  try {
    localStorage.setItem('taskweave-print-toc', downToc.value ? '1' : '0');
    const down = downMode.value === 'pdf' ? await statementPdf(downLang.value, abort.signal) : downMode.value === 'samples' ? { mode: 'samples' as const, lang: downLang.value || 'en' } : undefined;
    phase.value = '';
    const testsets = Object.fromEntries(Object.entries(props.testsets).map(([k, v]) => [k, v.chosen.length ? v.chosen : ['tests']]));
    const started = await api.contestBatch(props.contestId, { action: 'lemon-push', testsets, lemon: { subfolders: subfolders.value }, lemonServer: { name: name.value.trim(), overwrite: exists.value && overwrite.value, keepSources: keepSources.value, compileOnServer: compile.value, down } });
    jobId.value = started.id;
    await props.follow(started);
    if (pushJob.value?.status === 'done') emit('update:show', false);
    else if (pushJob.value?.status === 'failed') error.value = pushJob.value.error ?? t('tool.status.failed');
  } catch (e) {
    if ((e as Error).name !== 'AbortError') error.value = errorMessage(e);
  } finally { phase.value = ''; submitting.value = false; abort = undefined; }
}
function openServer() { window.open(serverUrl.value, '_blank', 'noopener'); }
function close() {
  // Closing stops the local steps (typesetting); a started push job keeps running.
  abort?.abort();
  emit('update:show', false);
}
</script>

<template>
  <tool-window :show="show" :title="t('contest.lemonServerPushTitle')" size="md" :status="status" :progress="progress" :error="error" @update:show="v => v ? emit('update:show', true) : close()">
    <div class="push">
      <!-- server -->
      <div class="server" :class="{ bad: !!serverError, ok: serverReady }">
        <server :size="18" class="server-icon" />
        <div class="server-main">
          <div class="server-url mono" :title="serverUrl">{{ serverUrl || t('contest.lemonServerNoUrl') }}</div>
          <div class="server-state">
            <template v-if="checking"><n-spin :size="12" />{{ t('contest.lemonServerChecking') }}</template>
            <template v-else-if="serverError"><circle-alert :size="13" />{{ serverError }}</template>
            <template v-else-if="server"><circle-check :size="13" />{{ server.version || '?' }} · {{ server.platform }}<n-tag size="small" :bordered="false" round>{{ server.target === 'windows' ? 'Windows' : 'Linux' }}</n-tag></template>
          </div>
        </div>
        <n-button size="small" quaternary circle :loading="checking" :title="t('contest.lemonServerRecheck')" @click="checkServer"><template #icon><refresh-cw /></template></n-button>
        <n-button v-if="serverUrl" size="small" quaternary circle :title="t('contest.lemonServerOpen')" @click="openServer"><template #icon><external-link /></template></n-button>
        <n-button v-if="serverError && !checking" size="small" @click="router.push({ name: 'settings', query: { tab: 'lemonserver' } })">{{ t('contest.lemonServerSettings') }}</n-button>
      </div>

      <!-- contest -->
      <section>
        <div class="section-title">{{ t('contest.lemonServerSectionContest') }}</div>
        <label class="field">
          <span class="field-label">{{ t('contest.lemonServerName') }}</span>
          <n-input v-model:value="name" size="small" :disabled="running" :status="name && !nameValid ? 'error' : undefined" class="mono" />
        </label>
        <div v-if="name && !nameValid" class="field-hint bad">{{ t('contest.lemonServerNameInvalid') }}</div>
        <div v-if="exists" class="replace">
          <n-checkbox v-model:checked="overwrite" :disabled="running">{{ t('contest.lemonServerOverwrite', { name: name.trim() }) }}</n-checkbox>
          <div class="field-hint">{{ t('contest.lemonServerOverwriteHint') }}</div>
          <n-checkbox v-if="overwrite" v-model:checked="keepSources" :disabled="running" class="nested">{{ t('contest.lemonServerKeepSources') }}</n-checkbox>
        </div>
        <n-checkbox v-model:checked="subfolders" :disabled="running">{{ t('contest.lemonSubfolders') }}</n-checkbox>
        <n-checkbox v-model:checked="compile" :disabled="running">{{ t('contest.lemonServerCompile') }}</n-checkbox>
      </section>

      <!-- down.zip -->
      <section>
        <div class="section-title">{{ t('contest.lemonServerSectionDown') }}</div>
        <n-radio-group v-model:value="downMode" size="small" :disabled="running">
          <n-radio-button value="none">{{ t('contest.lemonServerDownNone') }}</n-radio-button>
          <n-radio-button value="samples">{{ t('contest.lemonServerDownSamples') }}</n-radio-button>
          <n-radio-button value="pdf" :disabled="!!pdfBlocked" :title="pdfBlocked">{{ t('contest.lemonServerDownPdf') }}</n-radio-button>
        </n-radio-group>
        <div v-if="downMode === 'pdf'" class="down-options">
          <label class="inline">{{ t('contest.lemonServerDownLang') }}<n-select v-model:value="downLang" size="small" :options="downLangs.map(l => ({ value: l, label: l }))" :disabled="running" class="lang" /></label>
          <label class="inline"><n-switch v-model:value="downToc" size="small" :disabled="running" />{{ t('contest.toc') }}</label>
        </div>
        <div class="field-hint">{{ downMode === 'none' ? (exists && overwrite ? t('contest.lemonServerDownKeep') : t('contest.lemonServerDownNoneHint')) : downMode === 'samples' ? t('contest.lemonServerDownSamplesHint') : t('contest.lemonServerDownPdfHint') }}</div>
        <div v-if="pdfBlocked" class="field-hint">{{ pdfBlocked }}</div>
      </section>

      <!-- testsets -->
      <section v-if="multiTestsets.length">
        <div class="section-title">{{ t('contest.exportTestsets') }}</div>
        <div v-for="p in multiTestsets" :key="p.problem" class="testset">
          <strong>{{ p.index }}</strong>
          <n-checkbox-group v-model:value="testsets[p.problem].chosen" :disabled="running">
            <n-space size="small"><n-checkbox v-for="ts in testsets[p.problem].all" :key="ts" :value="ts" :label="ts" /></n-space>
          </n-checkbox-group>
        </div>
      </section>
      <n-alert v-if="dataOnly" type="warning" :show-icon="false">{{ t('dataOnly.lemonHint') }}</n-alert>
    </div>
    <template #footer-left>{{ t('contest.lemonServerPushNote') }}</template>
    <template #footer>
      <n-button @click="close">{{ running ? t('common.close') : t('common.cancel') }}</n-button>
      <n-button type="primary" :disabled="!canPush" :loading="running || loadingOptions" @click="push">{{ exists && overwrite ? t('contest.lemonServerPushReplace') : t('contest.lemonServerPushButton') }}</n-button>
    </template>
  </tool-window>
</template>

<style scoped>
.push { display: flex; flex-direction: column; gap: 16px; }
.server { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--pf-border); border-radius: 8px; background: var(--pf-surface); }
.server.ok { border-color: color-mix(in srgb, var(--pf-success, #18a058) 45%, var(--pf-border)); }
.server.bad { border-color: color-mix(in srgb, var(--pf-warning, #f0a020) 55%, var(--pf-border)); }
.server-icon { color: var(--pf-text-secondary); flex-shrink: 0; }
.server-main { flex: 1; min-width: 0; }
.server-url { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.server-state { display: flex; align-items: center; gap: 6px; margin-top: 2px; font-size: 12px; color: var(--pf-text-secondary); }
.server.bad .server-state { color: var(--pf-warning, #f0a020); }
.server.ok .server-state > svg { color: var(--pf-success, #18a058); }
section { display: flex; flex-direction: column; gap: 8px; }
.section-title { font-size: 12px; font-weight: 600; color: var(--pf-text-secondary); }
.field { display: grid; grid-template-columns: 140px minmax(0, 1fr); align-items: center; gap: 10px; }
.field-label { font-size: 13px; }
.field-hint { font-size: 12px; color: var(--pf-text-secondary); line-height: 1.5; }
.field-hint.bad { color: var(--pf-error, #d03050); }
.replace { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border-radius: 6px; background: color-mix(in srgb, var(--pf-warning, #f0a020) 10%, transparent); }
.nested { margin-left: 24px; }
.down-options { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; }
.inline { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.lang { width: 110px; }
.testset { display: flex; align-items: center; gap: 12px; }
.testset strong { min-width: 28px; }
</style>
