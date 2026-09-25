<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { NAlert, NButton, NRadioButton, NRadioGroup, NSpin, NSwitch, NTag, useMessage } from 'naive-ui';
import 'katex/dist/katex.min.css';
import { ArrowLeft, Printer } from 'lucide-vue-next';
import { STATEMENT_SECTIONS, type ContestDetail, type ContestStatement, type StatementSection } from '@polyforge/shared';
import StatementDoc from '../components/StatementDoc.vue';
import { api, errorMessage, rawUrl } from '../lib/api';
import { getDefs } from '../lib/defs';
import { buildMacros, renderLatex, type MacroTable } from '../lib/latex';

/** All statements of a contest in one language, laid out for printing (browser print → PDF). */
const props = defineProps<{ id: string }>();
const { t } = useI18n();
const router = useRouter();
const message = useMessage();

const detail = ref<ContestDetail | null>(null);
const statements = ref<ContestStatement[]>([]);
const macros = shallowRef<MacroTable>(new Map());
const loading = ref(true);
const lang = ref(localStorage.getItem('polyforge-print-lang') ?? 'zh');
const withTutorials = ref(false);
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
const contestTitle = computed(() => detail.value?.summary.title[lang.value] || detail.value?.summary.title.en || detail.value?.summary.name || '');
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
      <label class="opt"><n-switch v-model:value="withTutorials" size="small" /> {{ t('contest.withTutorials') }}</label>
      <label class="opt"><n-switch v-model:value="pageBreaks" size="small" /> {{ t('contest.pageBreaks') }}</label>
      <n-tag v-if="problemsMissing.length" size="small" type="error" :bordered="false">{{ t('contest.noStatementIn', { lang, list: problemsMissing.join(', ') }) }}</n-tag>
      <n-tag v-if="withTutorials && tutorialsMissing.length" size="small" type="warning" :bordered="false">
        {{ t('contest.noTutorialIn', { lang, list: tutorialsMissing.join(', ') }) }}
      </n-tag>
      <span class="grow" />
      <n-button size="small" type="primary" @click="print"><template #icon><printer /></template>{{ t('contest.print') }}</n-button>
    </div>

    <div v-if="loading && !statements.length" class="center no-print"><n-spin /></div>
    <n-alert v-else-if="!statements.length" type="info" :show-icon="false" class="no-print empty">{{ t('contest.noProblems') }}</n-alert>
    <div v-else class="sheet" :class="{ breaks: pageBreaks }">
      <h1 class="contest-title">{{ contestTitle }}</h1>
      <section v-for="r in rendered.filter((x) => x.hasStatement)" :key="r.s.index" class="problem">
        <statement-doc
          :lang="lang"
          :index="r.s.index"
          :title="r.s.title"
          :limits="r.s"
          :sections="r.sections"
          :samples="r.s.samples"
        />
      </section>
      <template v-if="withTutorials">
        <section v-for="r in rendered.filter((x) => x.hasTutorial)" :key="'t' + r.s.index" class="problem">
          <statement-doc :lang="lang" :index="r.s.index" :title="r.s.title" :sections="r.sections" :samples="[]" mode="tutorial" />
        </section>
      </template>
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
  max-width: 820px;
  margin: 24px auto;
  padding: 40px 56px;
  box-shadow: 0 2px 16px rgba(0, 0, 0, 0.35);
}
.contest-title {
  text-align: center;
  font-family: 'Times New Roman', 'Songti SC', 'SimSun', serif;
  font-size: 26px;
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
    max-width: none;
  }
  .breaks .problem + .problem {
    break-before: page;
    margin-top: 0;
    padding-top: 0;
  }
}
</style>

<style>
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
