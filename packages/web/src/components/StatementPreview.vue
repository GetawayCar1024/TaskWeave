<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NButton, NDropdown, NTag, NTooltip, useMessage } from 'naive-ui';
import 'katex/dist/katex.min.css';
import { STATEMENT_SECTIONS, sampleNotePath, statementLanguages, type StatementSection, type StatementSample } from '@taskweave/shared';
import { exportMarkdown } from '../lib/markdownExport';
import { api, rawUrl } from '../lib/api';
import type { Judge } from '../lib/judge';
import { buildMacros, renderLatex, type MacroTable } from '../lib/latex';
import StatementDoc from './StatementDoc.vue';
import { getDefs } from '../lib/defs';
import { onWs } from '../lib/ws';
import type { Workspace } from '../lib/workspace';

const props = defineProps<{ ws: Workspace; judge: Judge; problemId: string; lang: string; mode?: 'statement' | 'tutorial' }>();
const emit = defineEmits<{ createTutorial: [lang: string] }>();
const { t } = useI18n();
const host = ref<HTMLElement>();
const message = useMessage();
const exportingMarkdown = ref(false);
async function markdown() {
  if (exportingMarkdown.value) return;
  exportingMarkdown.value = true;
  try {
    const doc = host.value?.querySelector<HTMLElement>('.statement-doc')?.cloneNode(true) as HTMLElement | undefined;
    if (!doc) return;
    // OI-only parts are shown in the preview only; the Markdown export is the CF statement.
    doc.querySelectorAll('.oi-only').forEach((el) => el.remove());
    const result = await exportMarkdown(doc, `${props.ws.state.detail?.summary.name ?? props.problemId}-${props.lang}`);
    message.success(t('export.saved', { file: result.file }));
    if (result.warnings) message.warning(t('improve.markdownWarnings'));
  } catch (e) { message.error(String(e)); }
  finally { exportingMarkdown.value = false; }
}


const disk = ref<Partial<Record<StatementSection, string>>>({});
const macros = shallowRef<MacroTable>(new Map());
const tick = ref(0);
const samples = ref<StatementSample[]>([]);

const pathOf = (s: StatementSection) => `statement/${props.lang}/${s}.tex`;
const wholePath = computed(() => `statement/${props.lang}/statement.tex`);
const whole = computed(() => props.ws.files.value.some(f => f.path === wholePath.value));
const wholeDisk = ref('');
/** OI-only files (constraints.tex, samples/*.tex), by path. */
const oiDisk = ref<Record<string, string>>({});
const isOiFile = (p: string) => p === `statement/${props.lang}/constraints.tex` || (p.startsWith(`statement/${props.lang}/samples/`) && p.endsWith('.tex'));

let diskRequest = 0;
async function loadDisk() {
  const request = ++diskRequest;
  const present = new Set(props.ws.files.value.map((f) => f.path));
  const read = (path: string) => api.readFile(props.problemId, path).then((f) => f.content).catch(() => undefined);
  const [entries, oiEntries] = await Promise.all([
    Promise.all(STATEMENT_SECTIONS.filter((s) => present.has(pathOf(s))).map(async (s) => [s, await read(pathOf(s))] as const)),
    Promise.all([...present].filter(isOiFile).map(async (p) => [p, await read(p)] as const)),
  ]);
  const body = whole.value ? await read(wholePath.value) : '';
  if (request !== diskRequest) return;
  wholeDisk.value = body ?? '';
  disk.value = Object.fromEntries(entries.filter(([, v]) => v !== undefined));
  oiDisk.value = Object.fromEntries(oiEntries.filter((e): e is readonly [string, string] => e[1] !== undefined));
}

let sampleRequest = 0;
async function loadSamples() {
  const request = ++sampleRequest;
  try { const result = await api.statementSamples(props.problemId, props.lang); if (request === sampleRequest) samples.value = result; }
  catch (e) { if (request === sampleRequest) { samples.value = []; message.error(String(e)); } }
}

// A workspace revision includes edits made while another section is active.
watch(() => props.ws.state.contentRevision, () => tick.value++);
watch(() => props.ws.state.tabs.map(x => x.path).join('|'), () => tick.value++);
const off = onWs((e) => {
  if (e.type === 'file:changed' && e.problemId === props.problemId && e.path.startsWith(`statement/${props.lang}/`)) loadDisk();
});

onMounted(async () => {
  macros.value = buildMacros(await getDefs(), props.lang);
  await Promise.all([loadDisk(), loadSamples()]);
  tick.value++;
});
watch(() => props.lang, async () => {
  macros.value = buildMacros(await getDefs(), props.lang);
  await Promise.all([loadDisk(), loadSamples()]);
  tick.value++;
});
watch(() => props.judge.state.manifest?.tests, loadSamples);
watch(() => JSON.stringify(props.ws.state.detail?.config?.tests), loadSamples);
// Sections created or deleted on disk.
watch(() => props.ws.files.value.filter((f) => f.path.startsWith(`statement/${props.lang}/`)).length, loadDisk);
onBeforeUnmount(() => {
  off();

});

const rendered = computed(() => {
  void tick.value;
  const opts = { macros: macros.value, imageUrl: (n: string) => rawUrl(props.problemId, `statement/images/${n}`) };
  const out: Partial<Record<StatementSection, string>> = {};
  const unknown = new Set<string>();
  for (const s of STATEMENT_SECTIONS) {
    if (whole.value && s !== 'legend' && s !== 'tutorial') continue;
    const path = whole.value && s === 'legend' ? wholePath.value : pathOf(s);
    const tab = props.ws.state.tabs.find((x) => x.path === path);
    const src = tab ? tab.model.getValue() : whole.value && s === 'legend' ? wholeDisk.value : disk.value[s];
    if (!src?.trim()) continue;
    const r = renderLatex(src, opts);
    out[s] = r.html;
    r.unknown.forEach((u) => unknown.add(u));
  }
  // OI-only parts, as in the OI contest document; the CF exports leave them out.
  const oiSource = (path: string) => props.ws.state.tabs.find((x) => x.path === path)?.model.getValue() ?? oiDisk.value[path];
  const oiHtml = (src: string | undefined) => {
    if (!src?.trim()) return undefined;
    const r = renderLatex(src, opts);
    r.unknown.forEach((u) => unknown.add(u));
    return r.html || undefined;
  };
  const constraints = oiHtml(oiSource(`statement/${props.lang}/constraints.tex`));
  const sampleNotes = samples.value.map((x, i) => {
    const path = sampleNotePath(props.lang, x.index ?? x.number ?? i + 1, x.testset);
    return oiHtml(props.ws.files.value.some((f) => f.path === path) ? oiSource(path) : x.note);
  });
  const oi = constraints || sampleNotes.some(Boolean) ? { constraints, sampleNotes, label: t('preview.oiOnly') } : undefined;
  return { sections: out, unknown: [...unknown], oi };
});

const summary = computed(() => props.ws.state.detail?.summary);
const title = computed(() => summary.value?.title[props.lang] || summary.value?.title.en || summary.value?.name || '');

// Tutorial languages follow the statement languages.
const langs = computed(() => statementLanguages(props.ws.files.value));
const noStatement = computed(() => props.mode === 'tutorial' && !langs.value.statement.includes(props.lang));
const noTutorial = computed(() => props.mode !== 'tutorial' && langs.value.missingTutorial.includes(props.lang));
const otherTutorials = computed(() => langs.value.tutorial.filter((l) => l !== props.lang));
/** OI problems: create constraints.tex or a sample explanation that does not exist yet. */
const oiCreate = computed(() => {
  if (props.mode === 'tutorial' || summary.value?.type !== 'oi') return [];
  const present = new Set(props.ws.files.value.map((f) => f.path));
  const constraints = `statement/${props.lang}/constraints.tex`;
  return [
    ...(present.has(constraints) ? [] : [{ key: constraints, label: t('preview.addConstraints') }]),
    ...samples.value.map((x, i) => ({ key: sampleNotePath(props.lang, x.index ?? x.number ?? i + 1, x.testset), label: t('preview.addSampleNote', { n: x.number ?? i + 1 }) })).filter((o) => !present.has(o.key)),
  ];
});
async function createOi(path: string) {
  try { await props.ws.createFile(path); }
  catch (e) { message.error(String(e)); }
}
</script>

<template>
  <div ref="host" class="statement">
    <div class="export-tools">
      <n-button size="tiny" :loading="exportingMarkdown" @click="markdown">{{ t('improve.markdown') }}</n-button>
      <n-dropdown v-if="oiCreate.length" trigger="click" :options="oiCreate" @select="createOi">
        <n-button size="tiny" quaternary>+ {{ t('preview.addOi') }}</n-button>
      </n-dropdown>
    </div>
    <div v-if="rendered.unknown.length" class="lint">
      <n-tooltip>
        <template #trigger>
          <n-tag size="small" type="warning" :bordered="false">{{ t('preview.unknown', { n: rendered.unknown.length }) }}</n-tag>
        </template>
        {{ rendered.unknown.map((u) => '\\' + u).join('  ') }}
      </n-tooltip>
    </div>
    <div v-if="mode === 'tutorial' && noStatement" class="lint">
      <n-tag size="small" type="warning" :bordered="false">{{ t('preview.tutorialNoStatement', { lang }) }}</n-tag>
    </div>
    <div v-if="mode !== 'tutorial' && noTutorial" class="lint">
      <n-tag size="small" :bordered="false" class="clickable" @click="emit('createTutorial', lang)">{{ t('preview.noTutorial', { lang }) }}</n-tag>
    </div>
    <statement-doc
      :lang="lang"
      :title="title"
      :limits="summary"
      :sections="rendered.sections"
      :samples="samples"
      :oi="rendered.oi"
      :mode="mode"
      :note="otherTutorials.length ? `${t('preview.otherLangs')}: ${otherTutorials.join(', ')}` : ''"
    >
      <template #empty><div class="empty-hint">{{ t('preview.emptyTutorial') }}</div></template>
    </statement-doc>
  </div>
</template>

<style scoped>
.export-tools { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.statement {
  padding: 16px 20px;
  max-width: 900px;
}
.lint {
  font-family: system-ui, sans-serif;
  margin-bottom: 8px;
}
.empty-hint {
  opacity: 0.55;
  font-family: system-ui, sans-serif;
  font-size: 13px;
}
.clickable {
  cursor: pointer;
}
</style>
