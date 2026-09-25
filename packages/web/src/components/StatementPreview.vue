<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NTag, NTooltip } from 'naive-ui';
import 'katex/dist/katex.min.css';
import { STATEMENT_SECTIONS, statementLanguages, type StatementSection } from '@polyforge/shared';
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
