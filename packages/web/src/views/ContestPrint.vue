<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { NAlert, NButton, NDropdown, NRadioButton, NRadioGroup, NSpin, NSwitch, NTag, useMessage } from 'naive-ui';
import 'katex/dist/katex.min.css';
import { ArrowLeft, FileDown, Printer } from 'lucide-vue-next';
import katex from 'katex';
import { exportMarkdown } from '../lib/markdownExport';
import { fitPrintMath } from '../lib/printMath';
import { STATEMENT_SECTIONS, testsetsOf, type ContestDetail, type ContestStatement, type StatementSection } from '@polyforge/shared';
import StatementDoc from '../components/StatementDoc.vue';
import OiContestPreview from '../components/OiContestPreview.vue';
import { api, errorMessage, rawUrl, token } from '../lib/api';
import { getDefs } from '../lib/defs';
import { waitJob } from '../lib/jobs';
import { buildMacros, renderLatex, type MacroTable } from '../lib/latex';
import { desktop } from '../lib/desktop';

/**
 * The statements, or the tutorials, of a contest in one language as a separate
 * document, laid out as A4 pages for printing (browser print → PDF).
 */
const props = defineProps<{ id: string; single?: boolean }>();
const { t } = useI18n();
const router = useRouter();
const route = useRoute();
const message = useMessage();

const detail = ref<ContestDetail | null>(null);
const statements = ref<ContestStatement[]>([]);
const notes = ref('');
const notesHtml = computed(() => renderLatex(notes.value, { macros: macros.value, imageUrl: n => `/api/contests/${encodeURIComponent(props.id)}/file/raw?path=${encodeURIComponent(n)}&token=${encodeURIComponent(token)}` }).html);
const macros = shallowRef<MacroTable>(new Map());
const loading = ref(true);
const style = ref<'cf' | 'oi'>(route.query.style === 'oi' || route.query.down ? 'oi' : 'cf');
const preparingDown = ref(false);
const downRequest = ref(0);
let alive = true;
onBeforeUnmount(() => { alive = false; });
async function prepareDown() {
  if (preparingDown.value) return;
  preparingDown.value = true;
  try {
    if (detail.value?.problems.some(p => p.summary?.dataOnly)) {
      await api.downSamples(props.id, lang.value, props.single);
      message.info(t('dataOnly.downSamples'));
      return;
    }
    const job = props.single ? await api.generateTests(props.id) : await api.contestBatch(props.id, { action: 'generate' });
    const done = await waitJob(job, () => {});
    if (done.status !== 'done') throw new Error(done.error ?? 'Sample generation cancelled.');
    if (props.single) {
      const result = done.result as import('@polyforge/shared').TestsManifest;
      if (!result.ok) throw new Error(result.errors.join('\n'));
      const config = (await api.problem(props.id)).config;
      for (const ts of config ? testsetsOf(config).filter(ts => ts.name !== 'tests' && ts.samples?.trim()) : []) {
        const extra = await waitJob(await api.generateTests(props.id, ts.name));
        if (extra.status !== 'done') throw new Error(extra.error ?? extra.status);
        const manifest = extra.result as import('@polyforge/shared').TestsManifest;
        if (!manifest.ok) throw new Error(manifest.errors.join('\n'));
      }
    } else {
      const result = done.result as import('@polyforge/shared').ContestBatchResult;
      const errors = result.items.filter(item => !item.ok);
      if (errors.length) throw new Error(errors.map(item => `${item.index}: ${item.message}\n${(item.details ?? []).join('\n')}`).join('\n'));
    }
    if (!alive) return;
    if (!await load()) return;
    await nextTick();
    if (alive) downRequest.value++;
  } catch (e) { if (alive) message.error(errorMessage(e)); }
  finally { preparingDown.value = false; }
}
const lang = ref((typeof route.query.lang === 'string' && route.query.lang) || localStorage.getItem('polyforge-print-lang') || 'zh');
/** Which document: the problem statements or the tutorials (kept in the URL). */
const doc = ref<'statements' | 'tutorials'>(route.query.doc === 'tutorials' ? 'tutorials' : 'statements');
watch(doc, (d) => router.replace({ query: { ...route.query, doc: d === 'tutorials' ? d : undefined } }));
const pageBreaks = ref(true);
/** Contents page: contest title and the list of problems, before the first problem. */
const withToc = ref(!props.single && localStorage.getItem('polyforge-print-toc') !== '0');
watch(withToc, (v) => localStorage.setItem('polyforge-print-toc', v ? '1' : '0'));

const langs = computed(() => {
  const set = new Set<string>();
  for (const p of detail.value?.problems ?? []) for (const l of p.summary?.status.statementLangs ?? []) set.add(l);
  return [...set].sort();
});

let loadVersion = 0;
async function load() {
  const version = ++loadVersion;
  const language = lang.value;
  loading.value = true;
  try {
    const [d, s, defs, instructions] = await Promise.all([
      props.single ? api.problemDocument(props.id) : api.contest(props.id),
      props.single ? api.problemStatements(props.id, language) : api.contestStatements(props.id, language),
      getDefs(), props.single ? Promise.resolve({ content: '' }) : api.contestNotes(props.id, language),
    ]);
    if (version !== loadVersion) return false;
    notes.value = instructions.content;
    detail.value = d;
    statements.value = s;
    macros.value = buildMacros(defs, language);
    if (langs.value.length && !langs.value.includes(lang.value)) lang.value = langs.value[0];
    return true;
  } catch (e) {
    if (version === loadVersion) message.error(errorMessage(e));
    return false;
  } finally {
    if (version === loadVersion) loading.value = false;
  }
}
onMounted(async () => { await load(); if (route.query.down) await prepareDown(); });
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

const formulaOverflow = ref(0);
async function fitMath() {
  await nextTick(); await document.fonts.ready;
  const sheet = document.querySelector<HTMLElement>('.sheet');
  if (sheet) formulaOverflow.value = fitPrintMath(sheet);
}
watch([rendered, doc], fitMath, { flush: 'post' });
const print = async () => { await fitMath(); window.print(); };
/** The desktop app saves through Chromium's PDF output (selectable text, clickable links). */
async function savePdf() {
  if (!desktop?.printToPdf) return print();
  await fitMath();
  const saved = await desktop.printToPdf(baseName());
  if (saved) message.success(t('contest.pdfSaved', { path: saved }));
}
async function markdown() {
  const fragment = document.createElement('article');
  const instructions = document.querySelector('.sheet .contest-notes');
  if (withToc.value && instructions) fragment.append(instructions.cloneNode(true));
  document.querySelectorAll<HTMLElement>('.sheet .problem').forEach(problem => {
    const doc = problem.querySelector('.statement-doc')?.cloneNode(true) as HTMLElement | undefined;
    if (!doc) return;
    doc.querySelector('.title')?.setAttribute('id', problem.id);
    fragment.append(doc);
  });
  const contentsTable = withToc.value ? document.querySelector<HTMLElement>('.sheet .toc table') ?? undefined : undefined;
  if (await exportMarkdown(fragment, baseName(), { contestTitle: docTitle.value, contentsTable })) message.warning(t('improve.markdownWarnings'));
}
/**
 * Contents link: scroll the preview (.print-page) so the problem's title shows just
 * below the sticky toolbar, which would otherwise cover it.
 */
function jump(index: string) {
  const el = document.getElementById(`problem-${index}`);
  const page = document.querySelector<HTMLElement>('.print-page');
  if (!el || !page) return;
  const bar = page.querySelector<HTMLElement>('.toolbar')?.offsetHeight ?? 0;
  const top = el.getBoundingClientRect().top - page.getBoundingClientRect().top + page.scrollTop - bar - 12;
  page.scrollTo({ top: Math.max(top, 0), behavior: 'smooth' });
}

// ---- export as HTML (this page, self-contained) or TeX (server) ----
const exporting = ref(false);
const exportOptions = computed(() => [
  { key: 'markdown', label: 'Markdown' },
  { key: 'html', label: 'HTML' },
  { key: 'tex', label: 'TeX' },
  // PDF: the browser's print dialog ("Save as PDF"), which matches this page.
  { key: 'pdf', label: 'PDF' },
]);
const baseName = () => `${detail.value?.summary.name ?? props.id}-${doc.value}-${lang.value}`;
async function onExport(key: string) {
  exporting.value = true;
  try {
    if (key === 'tex') {
      if (props.single) await api.problemTex(props.id, lang.value, doc.value);
      else await api.contestTex(props.id, lang.value, doc.value, pageBreaks.value, withToc.value);
    }
    else if (key === 'pdf') await savePdf();
    else if (key === 'markdown') await markdown();
    else await exportHtml();
  } catch (e) {
    message.error(errorMessage(e));
  } finally {
    exporting.value = false;
  }
}
/**
 * The rendered sheet as one HTML file: the statement styles of this page are copied,
 * images are embedded as data URLs, and KaTeX's stylesheet / fonts come from the CDN.
 */
async function exportHtml() {
  const sheet = document.querySelector('.sheet');
  if (!sheet) return;
  const clone = sheet.cloneNode(true) as HTMLElement;
  for (const img of Array.from(clone.querySelectorAll('img'))) {
    try {
      const blob = await (await fetch(img.src)).blob();
      img.src = await new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.readAsDataURL(blob);
      });
    } catch {
      /* keep the link */
    }
  }
  // The styles are Vue-scoped: copy the rules keyed by the data-v-* attributes that
  // occur in the exported sheet (StatementDoc and this page), plus @page.
  const scopes = new Set<string>();
  for (const el of [clone, ...Array.from(clone.querySelectorAll('*'))]) for (const at of Array.from(el.attributes)) if (at.name.startsWith('data-v-')) scopes.add(at.name);
  let css = '';
  for (const s of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = s.cssRules;
    } catch {
      continue;
    }
    for (const r of Array.from(rules)) {
      const text = r.cssText;
      if (text.startsWith('@page') || [...scopes].some((sc) => text.includes(sc))) css += text + '\n';
    }
  }
  const html = `<!DOCTYPE html>
<html lang="${lang.value}">
<head>
<meta charset="utf-8">
<title>${docTitle.value.replace(/</g, '&lt;')}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@${katex.version}/dist/katex.min.css">
<style>
body { margin: 0; background: #f0f0f0; }
${css}
@media print { body { background: #fff; } }
</style>
</head>
<body>
${clone.outerHTML}
<script>
// Hovering a test case line highlights that case in the input and the output box.
document.addEventListener('mouseover', (e) => toggle(e, true));
document.addEventListener('mouseout', (e) => toggle(e, false));
function toggle(e, on) {
  const line = e.target.closest && e.target.closest('.test-example-line[data-case]');
  if (!line) return;
  line.closest('.sample').querySelectorAll('.test-example-line[data-case="' + line.dataset.case + '"]').forEach((el) => el.classList.toggle('hl', on));
}
<\/script>
</body>
</html>
`;
  const href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const a = document.createElement('a');
  a.href = href;
  a.download = `${baseName()}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

const contestTitle = computed(() => detail.value?.summary.title[lang.value] || detail.value?.summary.title.en || detail.value?.summary.name || '');
const docTitle = computed(() => (doc.value === 'tutorials' ? `${contestTitle.value} — ${lang.value === 'zh' ? '题解' : 'Tutorial'}` : contestTitle.value));
/** Contents table headers, in the language of the document (not of the UI). */
const tocHead = computed(() => (lang.value === 'zh' ? ['题号', '题目', '输入', '输出', '时间限制', '空间限制'] : ['#', 'Problem', 'Input', 'Output', 'Time limit', 'Memory limit']));
/** "standard input" / "standard output" in the document language, or the file name. */
const stream = (v: string, std: 'stdin' | 'stdout') =>
  !v || v === std ? (lang.value === 'zh' ? (std === 'stdin' ? '标准输入' : '标准输出') : std === 'stdin' ? 'standard input' : 'standard output') : v;
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
    pageStyle.textContent = `@page { background: #fff; color: #111; @bottom-center { content: ${page}; font: 9pt Verdana, 'Microsoft YaHei', sans-serif; color: #666; } }`;
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
      <n-button size="small" quaternary @click="router.push({ name: single ? 'problem' : 'contest', params: { id } })">
        <template #icon><arrow-left /></template>{{ t(single ? 'packages.backToProblem' : 'nav.contest') }}
      </n-button>
      <n-radio-group v-model:value="lang" size="small" :disabled="preparingDown">
        <n-radio-button v-for="l in langs.length ? langs : [lang]" :key="l" :value="l">{{ l }}</n-radio-button>
      </n-radio-group>
      <n-radio-group v-model:value="doc" size="small" :disabled="preparingDown">
        <n-radio-button value="statements">{{ t('contest.docStatements') }}</n-radio-button>
        <n-radio-button value="tutorials">{{ t('contest.docTutorials') }}</n-radio-button>
      </n-radio-group>
      <n-radio-group v-model:value="style" size="small" :disabled="preparingDown"><n-radio-button value="cf">CF</n-radio-button><n-radio-button value="oi">OI</n-radio-button></n-radio-group>
      <label v-if="style === 'cf' || doc === 'statements'" class="opt"><n-switch v-model:value="withToc" size="small" :disabled="preparingDown" /> {{ t('contest.toc') }}</label>
      <label v-if="style === 'cf'" class="opt"><n-switch v-model:value="pageBreaks" size="small" /> {{ t('contest.pageBreaks') }}</label>
      <n-tag v-if="doc === 'statements' && problemsMissing.length" size="small" type="error" :bordered="false">{{ t('contest.noStatementIn', { lang, list: problemsMissing.join(', ') }) }}</n-tag>
      <n-tag v-if="doc === 'tutorials' && tutorialsMissing.length" size="small" type="warning" :bordered="false">
        {{ t('contest.noTutorialIn', { lang, list: tutorialsMissing.join(', ') }) }}
      </n-tag>
      <span class="grow" />
      <n-dropdown v-if="style === 'cf'" trigger="click" :options="exportOptions" @select="onExport">
        <n-button size="small" :loading="exporting"><template #icon><file-down /></template>{{ t('contest.export') }}</n-button>
      </n-dropdown>
      <n-button v-if="style === 'cf'" size="small" type="primary" @click="print"><template #icon><printer /></template>{{ t('contest.print') }}</n-button>
    </div>

    <n-alert v-if="formulaOverflow" type="warning" class="no-print">{{ t('improve.formulaOverflow') }}</n-alert>
    <n-alert v-if="preparingDown" type="info" class="no-print">{{ t('oiFeatures.preparingDown') }}</n-alert>
    <div v-if="loading && !statements.length" class="center no-print"><n-spin /></div>
    <n-alert v-else-if="!statements.length" type="info" :show-icon="false" class="no-print empty">{{ t('contest.noProblems') }}</n-alert>
    <oi-contest-preview v-else-if="style === 'oi' && detail" :single="single" :detail="detail" :statements="statements" :lang="lang" :doc="doc" :notes="notes" :macros="macros" :toc="withToc" :loading="loading" :preparing-down="preparingDown" :down-request="downRequest" @prepare-down="prepareDown" />
    <div v-else class="sheet" :class="{ breaks: pageBreaks, 'with-toc': withToc }">
      <h1 v-if="!single" class="contest-title">{{ docTitle }}</h1>
      <section v-if="withToc && shown.length" class="toc">
        <table>
          <thead>
            <tr>
              <th class="idx">{{ tocHead[0] }}</th>
              <th>{{ tocHead[1] }}</th>
              <template v-if="doc === 'statements'">
                <th>{{ tocHead[2] }}</th>
                <th>{{ tocHead[3] }}</th>
                <th class="num">{{ tocHead[4] }}</th>
                <th class="num">{{ tocHead[5] }}</th>
              </template>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in shown" :key="r.s.index">
              <td class="idx">{{ r.s.index }}</td>
              <td><a :href="`#problem-${r.s.index}`" class="toc-link" @click.prevent="jump(r.s.index)">{{ r.s.title }}</a></td>
              <template v-if="doc === 'statements'">
                <td :class="{ mono: r.s.input && r.s.input !== 'stdin' }">{{ stream(r.s.input, 'stdin') }}</td>
                <td :class="{ mono: r.s.output && r.s.output !== 'stdout' }">{{ stream(r.s.output, 'stdout') }}</td>
                <td class="num">{{ r.s.timeLimit / 1000 }} {{ lang === 'zh' ? '秒' : 's' }}</td>
                <td class="num">{{ r.s.memoryLimit }} MB</td>
              </template>
            </tr>
          </tbody>
        </table>
        <div v-if="notes.trim()" class="contest-notes"><statement-doc :lang="lang" :title="lang === 'zh' ? '注意事项' : 'Instructions'" :sections="{ legend: notesHtml }" :samples="[]" /></div>
      </section>
      <div v-if="!shown.length" class="nothing">{{ doc === 'tutorials' ? t('contest.noTutorials') : t('contest.noProblems') }}</div>
      <section v-for="r in shown" :id="`problem-${r.s.index}`" :key="r.s.index" class="problem">
        <statement-doc
          v-if="doc === 'statements'"
          :lang="lang"
          :index="single ? undefined : r.s.index"
          :title="r.s.title"
          :limits="r.s"
          :sections="r.sections"
          :samples="r.s.samples"
        />
        <statement-doc v-else :tutorial-suffix="false" :lang="lang" :index="single ? undefined : r.s.index" :title="r.s.title" :sections="r.sections" :samples="[]" mode="tutorial" />
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
  --pf-line-even: rgb(224, 224, 224);
}
/* Contents page: title and the problem table, then the problems from the next page on. */
.toc {
  margin: 8px auto 32px;
  max-width: 680px;
  font-family: Verdana, 'Microsoft YaHei', 'PingFang SC', sans-serif;
  font-size: 14px;
}
.toc table {
  width: 100%;
  border-collapse: collapse;
}
.toc th,
.toc td {
  border-bottom: 1px solid #bbb;
  padding: 6px 10px;
  text-align: left;
}
.toc th {
  font-family: Arial, 'Microsoft YaHei', sans-serif;
  border-bottom: 2px solid #888;
}
.toc .idx {
  width: 3em;
  font-weight: bold;
  white-space: nowrap;
}
.toc .mono {
  font-family: Consolas, 'Courier New', monospace;
}
.toc-link {
  color: inherit;
  text-decoration: none;
}
.toc-link:hover {
  color: #1a4fa0;
  text-decoration: underline;
}
.toc .num {
  text-align: right;
  white-space: nowrap;
}
/* Instructions under the contents table. */
.toc .contest-notes {
  margin-top: 36px;
}
.with-toc .toc + .problem {
  margin-top: 40px;
  padding-top: 24px;
  border-top: 1px dashed #bbb;
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
  .with-toc .toc {
    break-after: page;
    margin-top: 0;
  }
  .with-toc .toc + .problem {
    border-top: none;
    margin-top: 0;
    padding-top: 0;
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
  background: #fff;
  color: #111;
}
@media print {
  /* Menus, messages and tooltips are teleported to <body>; one still open at the screen's
     right edge (the export menu when picking PDF) makes the browser shrink every page. */
  body > *:not(#app) {
    display: none !important;
  }
  html,
  body,
  #app {
    color-scheme: light !important;
    color: #111 !important;
    background: #fff !important;
    height: auto !important;
    overflow: visible !important;
  }
}
</style>
