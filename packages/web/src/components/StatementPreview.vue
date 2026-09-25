<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NTag, NTooltip } from 'naive-ui';
import 'katex/dist/katex.min.css';
import { STATEMENT_SECTIONS, statementLanguages, type StatementSection } from '@polyforge/shared';
import { api, rawUrl } from '../lib/api';
import type { Judge } from '../lib/judge';
import { buildMacros, renderLatex, sampleHtml, type MacroTable } from '../lib/latex';
import { getDefs } from '../lib/defs';
import { onWs } from '../lib/ws';
import type { Workspace } from '../lib/workspace';

const props = defineProps<{ ws: Workspace; judge: Judge; problemId: string; lang: string; mode?: 'statement' | 'tutorial' }>();
const emit = defineEmits<{ createTutorial: [lang: string] }>();
const { t } = useI18n();

const HEADINGS: Record<string, Partial<Record<StatementSection | 'examples' | 'limits', string>>> = {
  zh: { input: '输入格式', output: '输出格式', interaction: '交互', notes: '说明', tutorial: '题解', examples: '样例' },
  en: { input: 'Input', output: 'Output', interaction: 'Interaction', notes: 'Note', tutorial: 'Tutorial', examples: 'Examples' },
};
const heading = (k: StatementSection | 'examples') => (HEADINGS[props.lang] ?? HEADINGS.en)[k] ?? k;

const disk = ref<Partial<Record<StatementSection, string>>>({});
const macros = shallowRef<MacroTable>(new Map());
const tick = ref(0);
const samples = ref<{ index: number; input: string; output: string }[]>([]);

const pathOf = (s: StatementSection) => `statement/${props.lang}/${s}.tex`;

async function loadDisk() {
  const present = new Set(props.ws.files.value.map((f) => f.path));
  const entries = await Promise.all(
    STATEMENT_SECTIONS.filter((s) => present.has(pathOf(s))).map(
      async (s) => [s, await api.readFile(props.problemId, pathOf(s)).then((f) => f.content).catch(() => undefined)] as const,
    ),
  );
  disk.value = Object.fromEntries(entries.filter(([, v]) => v !== undefined));
}

async function loadSamples() {
  const tests = (props.judge.state.manifest?.tests ?? []).filter((x) => x.sample);
  samples.value = await Promise.all(
    tests.map(async (x) => ({
      index: x.index,
      input: (await api.testFile(props.problemId, x.index, 'in').catch(() => null))?.content ?? '',
      output: (await api.testFile(props.problemId, x.index, 'ans').catch(() => null))?.content ?? '',
    })),
  );
}

// Open tabs provide live (unsaved) content; re-render on edits, debounced.
let timer: ReturnType<typeof setTimeout> | undefined;
const subs: { dispose(): void }[] = [];
function watchModels() {
  subs.splice(0).forEach((d) => d.dispose());
  for (const tab of props.ws.state.tabs) {
    if (!tab.path.startsWith(`statement/${props.lang}/`)) continue;
    subs.push(
      tab.model.onDidChangeContent(() => {
        clearTimeout(timer);
        timer = setTimeout(() => tick.value++, 150);
      }),
    );
  }
  tick.value++;
}
watch(() => props.ws.state.tabs.map((x) => x.path).join('|'), watchModels);

const off = onWs((e) => {
  if (e.type === 'file:changed' && e.problemId === props.problemId && e.path.startsWith(`statement/${props.lang}/`)) loadDisk();
});

onMounted(async () => {
  macros.value = buildMacros(await getDefs(), props.lang);
  await Promise.all([loadDisk(), loadSamples()]);
  watchModels();
});
watch(() => props.lang, async () => {
  macros.value = buildMacros(await getDefs(), props.lang);
  await loadDisk();
  watchModels();
});
watch(() => props.judge.state.manifest?.generatedAt, loadSamples);
// Sections created or deleted on disk.
watch(() => props.ws.files.value.filter((f) => f.path.startsWith(`statement/${props.lang}/`)).length, loadDisk);
onBeforeUnmount(() => {
  off();
  clearTimeout(timer);
  subs.forEach((d) => d.dispose());
});

const rendered = computed(() => {
  void tick.value;
  const opts = { macros: macros.value, imageUrl: (n: string) => rawUrl(props.problemId, `statement/images/${n}`) };
  const out: Partial<Record<StatementSection, string>> = {};
  const unknown = new Set<string>();
  for (const s of STATEMENT_SECTIONS) {
    const tab = props.ws.state.tabs.find((x) => x.path === pathOf(s));
    const src = tab ? tab.model.getValue() : disk.value[s];
    if (!src?.trim()) continue;
    const r = renderLatex(src, opts);
    out[s] = r.html;
    r.unknown.forEach((u) => unknown.add(u));
  }
  return { sections: out, unknown: [...unknown] };
});

const summary = computed(() => props.ws.state.detail?.summary);
const title = computed(() => summary.value?.title[props.lang] || summary.value?.title.en || summary.value?.name || '');
const inLabel = computed(() => (props.lang === 'zh' ? '输入' : 'Input'));
const outLabel = computed(() => (props.lang === 'zh' ? '输出' : 'Output'));

// Tutorial languages follow the statement languages.
const langs = computed(() => statementLanguages(props.ws.files.value));
const noStatement = computed(() => props.mode === 'tutorial' && !langs.value.statement.includes(props.lang));
const noTutorial = computed(() => props.mode !== 'tutorial' && langs.value.missingTutorial.includes(props.lang));
const otherTutorials = computed(() => langs.value.tutorial.filter((l) => l !== props.lang));
</script>

<template>
  <div class="statement">
    <div v-if="rendered.unknown.length" class="lint">
      <n-tooltip>
        <template #trigger>
          <n-tag size="small" type="warning" :bordered="false">{{ t('preview.unknown', { n: rendered.unknown.length }) }}</n-tag>
        </template>
        {{ rendered.unknown.map((u) => '\\' + u).join('  ') }}
      </n-tooltip>
    </div>
    <template v-if="mode === 'tutorial'">
      <div v-if="noStatement" class="lint">
        <n-tag size="small" type="warning" :bordered="false">{{ t('preview.tutorialNoStatement', { lang }) }}</n-tag>
      </div>
      <div class="header">
        <div class="title">{{ title }} — {{ heading('tutorial') }}</div>
        <div v-if="otherTutorials.length" class="limits">{{ t('preview.otherLangs') }}: {{ otherTutorials.join(', ') }}</div>
      </div>
      <div v-if="rendered.sections.tutorial" class="section" v-html="rendered.sections.tutorial" />
      <div v-else class="empty-hint">{{ t('preview.emptyTutorial') }}</div>
    </template>
    <template v-else>
    <div v-if="noTutorial" class="lint">
      <n-tag size="small" :bordered="false" class="clickable" @click="emit('createTutorial', lang)">{{ t('preview.noTutorial', { lang }) }}</n-tag>
    </div>
    <div class="header">
      <div class="title">{{ title }}</div>
      <div v-if="summary" class="limits">
        {{ lang === 'zh' ? '时间限制' : 'time limit per test' }}: {{ summary.timeLimit / 1000 }} {{ lang === 'zh' ? '秒' : 'seconds' }}<br />
        {{ lang === 'zh' ? '空间限制' : 'memory limit per test' }}: {{ summary.memoryLimit }} {{ lang === 'zh' ? 'MB' : 'megabytes' }}
      </div>
    </div>
    <div v-if="rendered.sections.legend" class="section" v-html="rendered.sections.legend" />
    <template v-for="s in ['input', 'output', 'interaction'] as const" :key="s">
      <template v-if="rendered.sections[s]">
        <div class="section-title">{{ heading(s) }}</div>
        <div class="section" v-html="rendered.sections[s]" />
      </template>
    </template>
    <template v-if="samples.length">
      <div class="section-title">{{ heading('examples') }}</div>
      <div v-for="x in samples" :key="x.index" v-html="sampleHtml(x.input, x.output, inLabel, outLabel)" />
    </template>
    <template v-if="rendered.sections.notes">
      <div class="section-title">{{ heading('notes') }}</div>
      <div class="section" v-html="rendered.sections.notes" />
    </template>
    </template>
  </div>
</template>

<style scoped>
.statement {
  padding: 16px 20px;
  font-size: 15px;
  line-height: 1.6;
  font-family: 'Times New Roman', 'Songti SC', 'SimSun', serif;
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
.header {
  text-align: center;
  margin-bottom: 16px;
}
.title {
  font-size: 1.5em;
  font-weight: bold;
}
.limits {
  font-size: 0.9em;
  opacity: 0.8;
}
.section-title {
  font-size: 1.15em;
  font-weight: bold;
  margin: 18px 0 6px;
}
.section :deep(.p) {
  margin: 0 0 0.8em;
}
.section :deep(code),
.statement :deep(pre) {
  font-family: Consolas, 'Courier New', monospace;
}
.statement :deep(.tex-unknown) {
  background: rgba(240, 200, 40, 0.35);
  border-radius: 2px;
  padding: 0 2px;
  font-family: Consolas, monospace;
  font-size: 0.9em;
}
.statement :deep(.tex-error) {
  color: #e88080;
}
.statement :deep(.math-display) {
  margin: 0.6em 0;
  overflow-x: auto;
}
.statement :deep(table.tabular) {
  border-collapse: collapse;
  margin: 0.5em auto;
}
.statement :deep(table.tabular td) {
  padding: 2px 8px;
}
.statement :deep(table.tabular.bordered td) {
  border: 1px solid rgba(128, 128, 128, 0.6);
}
.statement :deep(.stmt-img) {
  max-width: 100%;
}
.statement :deep(pre.verbatim) {
  background: rgba(128, 128, 128, 0.12);
  padding: 6px 8px;
  border-radius: 4px;
  overflow-x: auto;
}
.statement :deep(.sc) {
  font-variant: small-caps;
}
.statement :deep(.sf) {
  font-family: system-ui, sans-serif;
}
.statement :deep(.footnotes) {
  font-size: 0.85em;
  border-top: 1px solid rgba(128, 128, 128, 0.4);
  padding-top: 6px;
  margin-top: 16px;
}
.statement :deep(.epigraph) {
  margin: 0 0 1em auto;
  width: 60%;
  font-style: italic;
}
.statement :deep(.epigraph .who) {
  text-align: right;
}
.statement :deep(.sample) {
  display: grid;
  grid-template-columns: 1fr 1fr;
  border: 1px solid rgba(128, 128, 128, 0.5);
  margin-bottom: 8px;
}
.statement :deep(.sample-part + .sample-part) {
  border-left: 1px solid rgba(128, 128, 128, 0.5);
}
.statement :deep(.sample-title) {
  font-family: system-ui, sans-serif;
  font-size: 0.85em;
  padding: 2px 8px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.5);
}
.statement :deep(.sample pre) {
  margin: 0;
  padding: 6px 8px;
  font-size: 0.85em;
  overflow-x: auto;
}
</style>
