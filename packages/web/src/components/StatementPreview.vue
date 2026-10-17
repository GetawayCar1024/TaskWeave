<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NButton, NTag, NTooltip, useMessage } from 'naive-ui';
import 'katex/dist/katex.min.css';
import { STATEMENT_SECTIONS, statementLanguages, type StatementSection } from '@polyforge/shared';
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
async function markdown() {
  try {
    const doc = host.value?.querySelector<HTMLElement>('.statement-doc')?.cloneNode(true) as HTMLElement | undefined;
    if (!doc) return;
    if (await exportMarkdown(doc, `${props.ws.state.detail?.summary.name ?? props.problemId}-${props.lang}`)) message.warning(t('improve.markdownWarnings'));
  } catch (e) { message.error(String(e)); }
}


const disk = ref<Partial<Record<StatementSection, string>>>({});
const macros = shallowRef<MacroTable>(new Map());
const tick = ref(0);
const samples = ref<{ index: number; input: string; output: string; inputCases?: number[] }[]>([]);

const pathOf = (s: StatementSection) => `statement/${props.lang}/${s}.tex`;

let diskRequest = 0;
async function loadDisk() {
  const request = ++diskRequest;
  const present = new Set(props.ws.files.value.map((f) => f.path));
  const entries = await Promise.all(
    STATEMENT_SECTIONS.filter((s) => present.has(pathOf(s))).map(
      async (s) => [s, await api.readFile(props.problemId, pathOf(s)).then((f) => f.content).catch(() => undefined)] as const,
    ),
  );
  if (request !== diskRequest) return;
  disk.value = Object.fromEntries(entries.filter(([, v]) => v !== undefined));
}

async function loadSamples() {
  const tests = (props.judge.state.manifest?.tests ?? []).filter((x) => x.sample);
  samples.value = await Promise.all(
    tests.map(async (x) => ({
      index: x.index,
      // The markup describes the real input, not a custom statement input.
      inputCases: x.statementInput ? undefined : x.inputCases,
      input: (await api.testFile(props.problemId, x.index, 'statement-in').catch(() => null))?.content ?? '',
      output: (await api.testFile(props.problemId, x.index, 'statement-out').catch(() => null))?.content ?? '',
    })),
  );
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
  await loadDisk();
  tick.value++;
});
watch(() => props.judge.state.manifest?.tests, loadSamples);
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

// Tutorial languages follow the statement languages.
const langs = computed(() => statementLanguages(props.ws.files.value));
const noStatement = computed(() => props.mode === 'tutorial' && !langs.value.statement.includes(props.lang));
const noTutorial = computed(() => props.mode !== 'tutorial' && langs.value.missingTutorial.includes(props.lang));
const otherTutorials = computed(() => langs.value.tutorial.filter((l) => l !== props.lang));
</script>

<template>
  <div ref="host" class="statement">
    <div class="export-tools"><n-button size="tiny" @click="markdown">{{ t('improve.markdown') }}</n-button></div>
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
