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
}>();

const HEADINGS: Record<string, Partial<Record<StatementSection | 'examples', string>>> = {
  zh: { input: '输入格式', output: '输出格式', interaction: '交互', scoring: '评分', notes: '说明', tutorial: '题解', examples: '样例' },
  en: { input: 'Input', output: 'Output', interaction: 'Interaction', scoring: 'Scoring', notes: 'Note', tutorial: 'Tutorial', examples: 'Examples' },
};
const heading = (k: StatementSection | 'examples') => (HEADINGS[props.lang] ?? HEADINGS.en)[k] ?? k;
const zh = () => props.lang === 'zh';
</script>

<template>
  <div class="statement-doc">
    <template v-if="mode === 'tutorial'">
      <div class="header">
        <div class="title"><template v-if="index">{{ index }}. </template>{{ title }} — {{ heading('tutorial') }}</div>
        <div v-if="note" class="limits">{{ note }}</div>
      </div>
      <div v-if="sections.tutorial" class="section" v-html="sections.tutorial" />
      <slot v-else name="empty" />
    </template>
    <template v-else>
      <div class="header">
        <div class="title"><template v-if="index">{{ index }}. </template>{{ title }}</div>
        <div v-if="limits" class="limits">
          {{ zh() ? '时间限制' : 'time limit per test' }}: {{ limits.timeLimit / 1000 }} {{ zh() ? '秒' : 'seconds' }}<br />
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
.statement-doc {
  font-size: 15px;
  line-height: 1.6;
  font-family: 'Times New Roman', 'Songti SC', 'SimSun', serif;
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
.statement-doc :deep(pre) {
  font-family: Consolas, 'Courier New', monospace;
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
  border-collapse: collapse;
  margin: 0.5em auto;
}
.statement-doc :deep(table.tabular td) {
  padding: 2px 8px;
}
.statement-doc :deep(table.tabular.bordered td) {
  border: 1px solid rgba(128, 128, 128, 0.6);
}
.statement-doc :deep(.stmt-img) {
  max-width: 100%;
}
.statement-doc :deep(pre.verbatim) {
  background: rgba(128, 128, 128, 0.12);
  padding: 6px 8px;
  border-radius: 4px;
  overflow-x: auto;
}
.statement-doc :deep(.sc) {
  font-variant: small-caps;
}
.statement-doc :deep(.sf) {
  font-family: system-ui, sans-serif;
}
.statement-doc :deep(.footnotes) {
  font-size: 0.85em;
  border-top: 1px solid rgba(128, 128, 128, 0.4);
  padding-top: 6px;
  margin-top: 16px;
}
.statement-doc :deep(.epigraph) {
  margin: 0 0 1em auto;
  width: 60%;
  font-style: italic;
}
.statement-doc :deep(.epigraph .who) {
  text-align: right;
}
.statement-doc :deep(.sample) {
  display: grid;
  grid-template-columns: 1fr 1fr;
  border: 1px solid rgba(128, 128, 128, 0.5);
  margin-bottom: 8px;
  break-inside: avoid;
}
.statement-doc :deep(.sample-part + .sample-part) {
  border-left: 1px solid rgba(128, 128, 128, 0.5);
}
.statement-doc :deep(.sample-title) {
  font-family: system-ui, sans-serif;
  font-size: 0.85em;
  padding: 2px 8px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.5);
}
.statement-doc :deep(.sample pre) {
  margin: 0;
  padding: 6px 8px;
  font-size: 0.85em;
  overflow-x: auto;
}
</style>
