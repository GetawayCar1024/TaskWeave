<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { NAlert, NButton, NRadioButton, NRadioGroup, NSpin, NSwitch, NTag, useMessage } from 'naive-ui';
import 'katex/dist/katex.min.css';
import { ArrowLeft, FileDown, Printer } from 'lucide-vue-next';
import { serverText } from '../lib/serverText';
import { STATEMENT_SECTIONS, type ContestDetail, type ContestStatement, type StatementSection } from '@polyforge/shared';
import StatementDoc from '../components/StatementDoc.vue';
import { api, errorMessage, rawUrl } from '../lib/api';
import { getDefs } from '../lib/defs';
import { buildMacros, renderLatex, type MacroTable } from '../lib/latex';

/**
 * The statements, or the tutorials, of a contest in one language as a separate
 * document, laid out as A4 pages for printing (browser print → PDF).
 */
const props = defineProps<{ id: string }>();
const { t } = useI18n();
const router = useRouter();
const route = useRoute();
const message = useMessage();

const detail = ref<ContestDetail | null>(null);
const statements = ref<ContestStatement[]>([]);
const macros = shallowRef<MacroTable>(new Map());
const loading = ref(true);
const lang = ref((typeof route.query.lang === 'string' && route.query.lang) || localStorage.getItem('polyforge-print-lang') || 'zh');
/** Which document: the problem statements or the tutorials (kept in the URL). */
const doc = ref<'statements' | 'tutorials'>(route.query.doc === 'tutorials' ? 'tutorials' : 'statements');
watch(doc, (d) => router.replace({ query: { ...route.query, doc: d === 'tutorials' ? d : undefined } }));
const pageBreaks = ref(true);

const langs = computed(() => {
  const set = new Set<string>();
  for (const p of detail.value?.problems ?? []) for (const l of p.summary?.status.statementLangs ?? []) set.add(l);
  return [...set].sort();
});

async function load() {
  loading.value = true;
  try {
    const [d, s, defs] = await Promise.all([api.contest(props.id), api.contestStatements(props.id, lang.value), getDefs()]);
    detail.value = d;
    statements.value = s;
    macros.value = buildMacros(defs, lang.value);
    if (langs.value.length && !langs.value.includes(lang.value)) lang.value = langs.value[0];
  } catch (e) {
    message.error(errorMessage(e));
  } finally {
    loading.value = false;
  }
}
onMounted(load);
watch(lang, (l) => {
  localStorage.setItem('polyforge-print-lang', l);
  load();
});

const rendered = computed(() =>
  statements.value.map((s) => {
    const opts = { macros: macros.value, imageUrl: (n: string) => rawUrl(s.problem, `statement/images/${n}`) };
    const sections: Partial<Record<StatementSection, string>> = {};
    for (const k of STATEMENT_SECTIONS) if (s.sections[k]) sections[k] = renderLatex(s.sections[k], opts).html;
    const hasStatement = !!(s.sections.legend || s.sections.input || s.sections.output);
    return { s, sections, hasStatement, hasTutorial: !!s.sections.tutorial };
  }),
);
// Tutorial languages follow statement languages: flag problems where they do not.
const problemsMissing = computed(() => rendered.value.filter((r) => !r.hasStatement).map((r) => r.s.index));
const tutorialsMissing = computed(() => rendered.value.filter((r) => r.hasStatement && !r.hasTutorial).map((r) => r.s.index));

const print = () => window.print();
// The PDF is made by a headless Edge / Chrome on this page, so it has the page's own
// A4 size and margins and none of the print dialog's headers and footers.
const exporting = ref(false);
async function exportPdf() {
  exporting.value = true;
  try {
    await api.contestPdf(props.id, lang.value, doc.value, `${detail.value?.summary.name ?? props.id}-${doc.value}-${lang.value}.pdf`);
  } catch (e) {
    message.error(serverText(errorMessage(e)));
  } finally {
    exporting.value = false;
  }
}
const contestTitle = computed(() => detail.value?.summary.title[lang.value] || detail.value?.summary.title.en || detail.value?.summary.name || '');
const docTitle = computed(() => (doc.value === 'tutorials' ? `${contestTitle.value} — ${lang.value === 'zh' ? '题解' : 'Tutorial'}` : contestTitle.value));
const shown = computed(() => rendered.value.filter((r) => (doc.value === 'tutorials' ? r.hasTutorial : r.hasStatement)));
// The browser suggests the page title as the PDF file name.
watch(
  () => [detail.value?.summary.name, doc.value, lang.value],
  () => {
    if (detail.value) document.title = `${detail.value.summary.name}-${doc.value}-${lang.value}`;
  },
  { immediate: true },
);
// Page numbers on every printed page, via an @page margin box.
const pageStyle = document.createElement('style');
document.head.appendChild(pageStyle);
watch(
  () => [docTitle.value, lang.value],
  () => {
    const page = lang.value === 'zh' ? '"第 " counter(page) " 页，共 " counter(pages) " 页"' : '"Page " counter(page) " of " counter(pages)';
    pageStyle.textContent = `@page { @bottom-center { content: ${page}; font: 9pt Verdana, 'Microsoft YaHei', sans-serif; color: #666; } }`;
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  document.title = 'PolyForge';
  pageStyle.remove();
});
</script>

<template>
  <div class="print-page">
    <div class="toolbar no-print">
      <n-button size="small" quaternary @click="router.push({ name: 'contest', params: { id } })">
        <template #icon><arrow-left /></template>{{ t('nav.contest') }}
      </n-button>
      <n-radio-group v-model:value="lang" size="small">
        <n-radio-button v-for="l in langs.length ? langs : [lang]" :key="l" :value="l">{{ l }}</n-radio-button>
      </n-radio-group>
      <n-radio-group v-model:value="doc" size="small">
        <n-radio-button value="statements">{{ t('contest.docStatements') }}</n-radio-button>
        <n-radio-button value="tutorials">{{ t('contest.docTutorials') }}</n-radio-button>
      </n-radio-group>
      <label class="opt"><n-switch v-model:value="pageBreaks" size="small" /> {{ t('contest.pageBreaks') }}</label>
      <n-tag v-if="doc === 'statements' && problemsMissing.length" size="small" type="error" :bordered="false">{{ t('contest.noStatementIn', { lang, list: problemsMissing.join(', ') }) }}</n-tag>
      <n-tag v-if="doc === 'tutorials' && tutorialsMissing.length" size="small" type="warning" :bordered="false">
        {{ t('contest.noTutorialIn', { lang, list: tutorialsMissing.join(', ') }) }}
      </n-tag>
      <span class="grow" />
      <n-button size="small" @click="print"><template #icon><printer /></template>{{ t('contest.printPaper') }}</n-button>
      <n-button size="small" type="primary" :loading="exporting" @click="exportPdf"><template #icon><file-down /></template>{{ t('contest.exportPdf') }}</n-button>
    </div>

    <div v-if="loading && !statements.length" class="center no-print"><n-spin /></div>
    <n-alert v-else-if="!statements.length" type="info" :show-icon="false" class="no-print empty">{{ t('contest.noProblems') }}</n-alert>
    <div v-else class="sheet" :class="{ breaks: pageBreaks }">
      <h1 class="contest-title">{{ docTitle }}</h1>
      <div v-if="!shown.length" class="nothing">{{ doc === 'tutorials' ? t('contest.noTutorials') : t('contest.noProblems') }}</div>
      <section v-for="r in shown" :key="r.s.index" class="problem">
        <statement-doc
          v-if="doc === 'statements'"
          :lang="lang"
          :index="r.s.index"
          :title="r.s.title"
          :limits="r.s"
          :sections="r.sections"
          :samples="r.s.samples"
        />
        <statement-doc v-else :tutorial-suffix="false" :lang="lang" :index="r.s.index" :title="r.s.title" :sections="r.sections" :samples="[]" mode="tutorial" />
      </section>
    </div>
  </div>
</template>

<style scoped>
.print-page {
  height: 100%;
  overflow: auto;
}
.toolbar {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 8px 16px;
  background: var(--pf-toolbar-bg, rgba(24, 24, 28, 0.96));
  border-bottom: 1px solid rgba(128, 128, 128, 0.25);
}
.opt {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.grow {
  flex: 1;
}
.center {
  display: flex;
  justify-content: center;
  padding: 80px;
}
.empty {
  margin: 24px;
}
/* On screen the sheet looks like paper so the preview matches the printout. */
.sheet {
  background: #fff;
  color: #1a1a1a;
  width: 210mm;
  min-height: 297mm;
  box-sizing: border-box;
  margin: 24px auto;
  padding: 20mm;
  box-shadow: 0 2px 16px rgba(0, 0, 0, 0.35);
}
.nothing {
  text-align: center;
  color: #888;
}
.sheet :deep(.statement-doc) {
  --pf-sample-bg: rgb(239, 239, 239);
}
.contest-title {
  text-align: center;
  font-family: Arial, 'Microsoft YaHei', 'PingFang SC', sans-serif;
  font-size: 24px;
  font-weight: normal;
  margin: 0 0 24px;
}
.problem + .problem {
  margin-top: 40px;
  padding-top: 24px;
  border-top: 1px dashed #bbb;
}
.breaks .problem + .problem {
  border-top: none;
}

@media print {
  .no-print {
    display: none !important;
  }
  .print-page {
    height: auto;
    overflow: visible;
  }
  .sheet {
    box-shadow: none;
    margin: 0;
    padding: 0;
    width: auto;
    min-height: 0;
  }
  .breaks .problem + .problem {
    break-before: page;
    margin-top: 0;
    padding-top: 0;
  }
}
</style>

<style>
/* The page margins of the PDF match the 20 mm padding of the on-screen sheet. */
@page {
  size: A4;
  margin: 20mm;
}
@media print {
  html,
  body,
  #app {
    background: #fff !important;
    height: auto !important;
    overflow: visible !important;
  }
}
</style>
