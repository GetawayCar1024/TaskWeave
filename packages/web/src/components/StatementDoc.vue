<script setup lang="ts">
import { largeSampleNotice, type StatementSection, type StatementSample } from '@polyforge/shared';
import { sampleHtml } from '../lib/latex';

/** A rendered statement (or tutorial): used by the editor preview and the contest print view. */
const props = defineProps<{
  lang: string;
  title: string;
  /** Contest letter shown before the title. */
  index?: string;
  limits?: { timeLimit: number; memoryLimit: number; input?: string; output?: string } | null;
  /** Rendered HTML per section. */
  sections: Partial<Record<StatementSection, string>>;
  samples: StatementSample[];
  mode?: 'statement' | 'tutorial';
  /** Small line under the title (tutorial mode). */
  note?: string;
  /** Tutorial mode: append "— Tutorial" to the title (off when the document title already says it). */
  tutorialSuffix?: boolean;
}>();

const HEADINGS: Record<string, Partial<Record<StatementSection | 'examples', string>>> = {
  zh: { input: '输入格式', output: '输出格式', interaction: '交互', scoring: '评分', notes: '说明', tutorial: '题解', examples: '样例' },
  en: { input: 'Input', output: 'Output', interaction: 'Interaction', scoring: 'Scoring', notes: 'Note', tutorial: 'Tutorial', examples: 'Examples' },
};
const heading = (k: StatementSection | 'examples') => (HEADINGS[props.lang] ?? HEADINGS.en)[k] ?? k;
const zh = () => props.lang === 'zh';

/** Hovering a test case line highlights that case in the input and the output box. */
function hover(e: MouseEvent, on: boolean) {
  const line = (e.target as HTMLElement).closest?.('.test-example-line[data-case]') as HTMLElement | null;
  if (!line) return;
  const sample = line.closest('.sample');
  sample?.querySelectorAll(`.test-example-line[data-case="${line.dataset.case}"]`).forEach((el) => el.classList.toggle('hl', on));
}
</script>

<template>
  <div class="statement-doc" @mouseover="hover($event, true)" @mouseout="hover($event, false)">
    <template v-if="mode === 'tutorial'">
      <div class="header">
        <div class="title"><template v-if="index">{{ index }}. </template>{{ title }}<template v-if="tutorialSuffix !== false"> — {{ heading('tutorial') }}</template></div>
        <div v-if="note" class="limits">{{ note }}</div>
      </div>
      <div v-if="sections.tutorial" class="section" v-html="sections.tutorial" />
      <slot v-else name="empty" />
    </template>
    <template v-else>
      <div class="header">
        <div class="title"><template v-if="index">{{ index }}. </template>{{ title }}</div>
        <div v-if="limits" class="limits">
          {{ zh() ? '时间限制' : 'time limit per test' }}: {{ limits.timeLimit / 1000 }} {{ zh() ? '秒' : limits.timeLimit === 1000 ? 'second' : 'seconds' }}<br />
          {{ zh() ? '空间限制' : 'memory limit per test' }}: {{ limits.memoryLimit }} {{ zh() ? 'MB' : 'megabytes' }}
          <!-- Only file names: stdin / stdout are not mentioned (preview and exports alike). -->
          <template v-if="limits.input && limits.input !== 'stdin'"><br />{{ zh() ? '输入' : 'input' }}: {{ limits.input }}</template>
          <template v-if="limits.output && limits.output !== 'stdout'"><br />{{ zh() ? '输出' : 'output' }}: {{ limits.output }}</template>
        </div>
      </div>
      <div v-if="sections.legend" class="section" v-html="sections.legend" />
      <template v-for="s in ['input', 'output', 'interaction', 'scoring'] as const" :key="s">
        <template v-if="sections[s]">
          <div class="section-title">{{ heading(s) }}</div>
          <div class="section" v-html="sections[s]" />
        </template>
      </template>
      <template v-if="samples.length">
        <div class="section-title">{{ heading('examples') }}</div>
        <template v-for="(x, i) in samples" :key="i">
          <template v-if="x.large"><div class="section-title">{{ zh() ? '样例' : 'Sample' }} {{ x.number ?? i + 1 }}</div><p class="large-sample">{{ largeSampleNotice(x, lang, x.number ?? i + 1) }}</p></template>
          <div v-else v-html="sampleHtml(x.input, x.output, (zh() ? '输入' : 'Input') + ' ' + (x.number ?? i + 1), (zh() ? '输出' : 'Output') + ' ' + (x.number ?? i + 1), x.inputCases)" />
        </template>
      </template>
      <template v-if="sections.notes">
        <div class="section-title">{{ heading('notes') }}</div>
        <div class="section" v-html="sections.notes" />
      </template>
    </template>
  </div>
</template>

<style scoped>
/* Values from Polygon's problem-statement.css (Codeforces statements). Colours are
   translucent so the preview also works on the dark theme; the print sheet is white. */
.statement-doc {
  font-family: Verdana, 'Microsoft YaHei', 'PingFang SC', serif;
  font-size: 14px;
  line-height: 1.65;
  --pf-sample-bg: rgba(128, 128, 128, 0.12);
  --pf-rule: rgb(136, 136, 136);
  --pf-line-even: rgba(128, 128, 128, 0.22);
  --pf-line-hl: rgba(255, 196, 0, 0.35);
}
.header {
  margin-bottom: 1em;
  text-align: center;
}
.title {
  font-size: 150%;
  font-family: Arial, 'Microsoft YaHei', serif;
  margin-bottom: 0.25em;
}
.limits {
  margin: 0 auto;
}
.section-title {
  font-family: Arial, 'Microsoft YaHei', serif;
  font-size: 115%;
  font-weight: bold;
}
.section {
  margin-bottom: 1em;
}
.section :deep(.p) {
  margin: 0 0 1.25em;
}
.section :deep(.p:last-child) {
  margin-bottom: 0;
}
.statement-doc :deep(ul),
.statement-doc :deep(ol) {
  margin: 0 0 1em;
  padding: 0;
}
.statement-doc :deep(li) {
  line-height: 1.5em;
  margin-left: 3em;
}
.statement-doc :deep(code) {
  font-size: 110%;
  font-family: Consolas, 'Lucida Console', 'Andale Mono', 'Bitstream Vera Sans Mono', 'Courier New', Courier, monospace;
}
.statement-doc :deep(pre) {
  font-family: Consolas, 'Lucida Console', 'Andale Mono', 'Bitstream Vera Sans Mono', 'Courier New', Courier, monospace;
}
.statement-doc :deep(.tex-unknown) {
  background: rgba(240, 200, 40, 0.35);
  border-radius: 2px;
  padding: 0 2px;
  font-family: Consolas, monospace;
  font-size: 0.9em;
}
.statement-doc :deep(.tex-error) {
  color: #e88080;
}
.statement-doc :deep(.math-display) {
  margin: 0.85em 0;
  overflow-x: auto;
}
.statement-doc :deep(table.tabular) {
  margin: 1em 0;
  border-collapse: collapse;
  border-spacing: 0;
}
.statement-doc :deep(table.tabular td) {
  padding: 0.15em 0.7em;
}
.statement-doc :deep(table.tabular.bordered td) {
  border: 1px solid;
}
.statement-doc :deep(.stmt-img) {
  max-width: 95%;
}
.statement-doc :deep(blockquote.markdown-quote) {
  margin: 1em 0;
  padding: 0.65em 1em;
  border-left: 3px solid var(--pf-rule);
  background: var(--pf-sample-bg);
  border-radius: 0 4px 4px 0;
}
.statement-doc :deep(blockquote.markdown-quote > .p:last-child) { margin-bottom: 0; }
.statement-doc :deep(hr) { border: 0; border-top: 1px solid var(--pf-rule); margin: 1em 0; }
.statement-doc :deep(h1), .statement-doc :deep(h2), .statement-doc :deep(h3),
.statement-doc :deep(h4), .statement-doc :deep(h5), .statement-doc :deep(h6) { margin: 1em 0 0.5em; line-height: 1.4; }
.statement-doc :deep(pre.verbatim) {
  font-size: 0.95em;
  line-height: 1.5;
  tab-size: 4;
  white-space: pre;
  overflow-x: auto;
  border: 1px solid var(--pf-rule);
  border-radius: 6px;
  padding: 0.8em 1em;
  background: var(--pf-sample-bg);
}
.statement-doc :deep(.sc) {
  text-transform: uppercase;
}
.statement-doc :deep(.sf) {
  font-family: Arial, serif;
}
.statement-doc :deep(.footnotes) {
  font-size: 85%;
  position: relative;
  margin: 1em 0;
  padding-top: 0.25em;
}
/* Mark (∗, †, …) then the text, as on Codeforces: the mark sits in a box one character
   wide before the first character, at its top right, on the first line of the text. */
.statement-doc :deep(.footnote) {
  display: flex;
  align-items: baseline;
}
.statement-doc :deep(.footnote .p) {
  margin: 0 0 0.5em;
}
.statement-doc :deep(.footnote-ref) {
  font-size: 75%;
  line-height: 0;
}
.statement-doc :deep(.footnote > sup) {
  font-size: 75%;
  line-height: 1;
  /* One character of the footnote text (the mark's own font is 75% of it). */
  flex: 0 0 calc(1em / 0.75);
  text-align: right;
  position: relative;
  top: -0.45em;
  vertical-align: baseline;
}
.statement-doc :deep(.footnotes)::before {
  content: '';
  position: absolute;
  left: 0;
  top: -2px;
  width: 25%;
  border-top: 1px solid var(--pf-rule);
}
/* epigraph{text}{source}: the right third, source right-aligned under a rule. */
.statement-doc :deep(.epigraph) {
  margin-left: 67%;
  width: 33%;
  margin-bottom: 1em;
}
.statement-doc :deep(.epigraph-source) {
  border-top: 1px solid var(--pf-rule);
  text-align: right;
}
/* Samples: input and output boxes joined, lowercase bold titles. */
.statement-doc :deep(.sample) {
  margin-bottom: 1em;
  break-inside: avoid;
}
.statement-doc :deep(.sample-part) {
  border: 1px solid var(--pf-rule);
}
.statement-doc :deep(.sample-part + .sample-part) {
  position: relative;
  top: -1px;
}
.statement-doc :deep(.sample-title) {
  font-family: Arial, 'Microsoft YaHei', serif;
  padding: 0.25em;
  border-bottom: 1px solid var(--pf-rule);
  text-transform: lowercase;
  font-weight: bold;
}
/* Test cases in samples (Codeforces: .test-example-line-even, hover highlight). */
.statement-doc :deep(.test-example-line-even) {
  background: var(--pf-line-even);
}
.statement-doc :deep(.test-example-line.hl) {
  background: var(--pf-line-hl);
}
.statement-doc :deep(.sample pre),
.statement-doc :deep(.test-example-line) {
  /* Keep the shades when printing / saving as PDF. */
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.statement-doc :deep(.sample pre) {
  line-height: 1.25em;
  padding: 0.25em;
  margin: 0;
  background: var(--pf-sample-bg);
  overflow-x: auto;
}

</style>
