<script setup lang="ts">
import type { StatementSection } from '@polyforge/shared';
import { sampleHtml } from '../lib/latex';

/** A rendered statement (or tutorial): used by the editor preview and the contest print view. */
const props = defineProps<{
  lang: string;
  title: string;
  /** Contest letter shown before the title. */
  index?: string;
  limits?: { timeLimit: number; memoryLimit: number } | null;
  /** Rendered HTML per section. */
  sections: Partial<Record<StatementSection, string>>;
  samples: { input: string; output: string }[];
  mode?: 'statement' | 'tutorial';
  /** Small line under the title (tutorial mode). */
  note?: string;
  /**
   * Paper layout for printing / PDF, as Polygon's LaTeX (olymp.sty) statements:
   * "Problem A. Title", a block of files and limits, serif text, samples as a
   * standard input | standard output table.
   */
  paper?: boolean;
  io?: { input: string; output: string };
}>();

const ioName = (v: string | undefined, std: 'stdin' | 'stdout') =>
  !v || v === std ? (zh() ? (std === 'stdin' ? '标准输入' : '标准输出') : std === 'stdin' ? 'standard input' : 'standard output') : v;
const seconds = (ms: number) => {
  const v = ms / 1000;
  return zh() ? `${v} 秒` : `${v} second${v === 1 ? '' : 's'}`;
};

const HEADINGS: Record<string, Partial<Record<StatementSection | 'examples', string>>> = {
  zh: { input: '输入格式', output: '输出格式', interaction: '交互', scoring: '评分', notes: '说明', tutorial: '题解', examples: '样例' },
  en: { input: 'Input', output: 'Output', interaction: 'Interaction', scoring: 'Scoring', notes: 'Note', tutorial: 'Tutorial', examples: 'Examples' },
};
const heading = (k: StatementSection | 'examples') => (HEADINGS[props.lang] ?? HEADINGS.en)[k] ?? k;
const zh = () => props.lang === 'zh';
</script>

<template>
  <div class="statement-doc" :class="{ paper }">
    <template v-if="mode === 'tutorial'">
      <div class="header">
        <!-- On paper the document title already says Tutorial: problems get just their name. -->
        <div v-if="paper" class="paper-title"><template v-if="index">{{ index }}. </template>{{ title }}</div>
        <div v-else class="title"><template v-if="index">{{ index }}. </template>{{ title }} — {{ heading('tutorial') }}</div>
        <div v-if="note" class="limits">{{ note }}</div>
      </div>
      <div v-if="sections.tutorial" class="section" v-html="sections.tutorial" />
      <slot v-else name="empty" />
    </template>
    <template v-else-if="paper">
      <div class="paper-header">
        <div class="paper-title">{{ zh() ? '题目' : 'Problem' }} <template v-if="index">{{ index }}. </template>{{ title }}</div>
        <table v-if="limits" class="paper-limits">
          <tr><td>{{ zh() ? '输入文件：' : 'Input file:' }}</td><td>{{ ioName(io?.input, 'stdin') }}</td></tr>
          <tr><td>{{ zh() ? '输出文件：' : 'Output file:' }}</td><td>{{ ioName(io?.output, 'stdout') }}</td></tr>
          <tr><td>{{ zh() ? '时间限制：' : 'Time limit:' }}</td><td>{{ seconds(limits.timeLimit) }}</td></tr>
          <tr><td>{{ zh() ? '空间限制：' : 'Memory limit:' }}</td><td>{{ limits.memoryLimit }} {{ zh() ? 'MB' : 'megabytes' }}</td></tr>
        </table>
      </div>
      <div v-if="sections.legend" class="section" v-html="sections.legend" />
      <template v-for="s in ['input', 'output', 'interaction', 'scoring'] as const" :key="s">
        <template v-if="sections[s]">
          <div class="section-title">{{ heading(s) }}</div>
          <div class="section" v-html="sections[s]" />
        </template>
      </template>
      <template v-if="samples.length">
        <div class="section-title">{{ zh() ? '样例' : samples.length === 1 ? 'Example' : 'Examples' }}</div>
        <table class="paper-samples">
          <tr>
            <th>{{ ioName(io?.input, 'stdin') }}</th>
            <th>{{ ioName(io?.output, 'stdout') }}</th>
          </tr>
          <tr v-for="(x, i) in samples" :key="i">
            <td><pre>{{ x.input }}</pre></td>
            <td><pre>{{ x.output }}</pre></td>
          </tr>
        </table>
      </template>
      <template v-if="sections.notes">
        <div class="section-title">{{ heading('notes') }}</div>
        <div class="section" v-html="sections.notes" />
      </template>
    </template>
    <template v-else>
      <div class="header">
        <div class="title"><template v-if="index">{{ index }}. </template>{{ title }}</div>
        <div v-if="limits" class="limits">
          {{ zh() ? '时间限制' : 'time limit per test' }}: {{ limits.timeLimit / 1000 }} {{ zh() ? '秒' : limits.timeLimit === 1000 ? 'second' : 'seconds' }}<br />
          {{ zh() ? '空间限制' : 'memory limit per test' }}: {{ limits.memoryLimit }} {{ zh() ? 'MB' : 'megabytes' }}
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
        <div v-for="(x, i) in samples" :key="i" v-html="sampleHtml(x.input, x.output, zh() ? '输入' : 'Input', zh() ? '输出' : 'Output')" />
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
  line-height: 1.5em;
  --pf-sample-bg: rgba(128, 128, 128, 0.12);
  --pf-rule: rgb(136, 136, 136);
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
  margin: 0 0 1em;
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
  margin: 0.6em 0;
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
.statement-doc :deep(pre.verbatim) {
  font-size: 110%;
  white-space: pre-wrap;
  padding: 0.5em;
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
  padding-left: 1.5em;
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
.statement-doc :deep(.sample pre) {
  line-height: 1.25em;
  padding: 0.25em;
  margin: 0;
  background: var(--pf-sample-bg);
  overflow-x: auto;
}

/* ---- paper (print / PDF), after Polygon's olymp.sty ---- */
.statement-doc.paper {
  font-family: 'Times New Roman', 'CMU Serif', 'Songti SC', 'SimSun', serif;
  font-size: 11pt;
  line-height: 1.4;
  text-align: justify;
}
.paper .title {
  font-size: 17pt;
  font-weight: bold;
  font-family: inherit;
}
.paper :deep(.katex) {
  font-size: 1.05em;
}
.paper .header {
  text-align: left;
}
.paper-header {
  margin-bottom: 1em;
  break-after: avoid;
}
.paper-title {
  font-size: 17pt;
  font-weight: bold;
  margin-bottom: 0.4em;
}
.paper-limits {
  border-collapse: collapse;
}
.paper-limits td {
  padding: 0 1.2em 0 0;
}
.paper .section-title {
  font-family: inherit;
  font-size: 12pt;
  margin: 0.9em 0 0.3em;
  break-after: avoid;
}
.paper .section :deep(.p) {
  margin: 0 0 0.6em;
}
.paper :deep(code),
.paper-samples pre {
  font-family: 'Courier New', Courier, monospace;
}
.paper-samples {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  break-inside: avoid;
  margin-bottom: 0.6em;
}
.paper-samples th,
.paper-samples td {
  border: 1px solid currentColor;
  text-align: left;
  vertical-align: top;
  padding: 2px 6px;
}
.paper-samples th {
  font-weight: bold;
}
.paper-samples pre {
  margin: 0;
  font-size: 10pt;
  line-height: 1.25;
  white-space: pre-wrap;
  word-break: break-all;
}
.paper :deep(.math-display),
.paper :deep(table.tabular),
.paper :deep(.stmt-img) {
  break-inside: avoid;
}
</style>
