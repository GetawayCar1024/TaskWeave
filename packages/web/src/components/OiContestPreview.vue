<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NAlert, NButton, NDropdown, NInput, NSpin, useMessage } from 'naive-ui';
import { Check, ChevronDown, Download, FileText, SlidersHorizontal } from 'lucide-vue-next';
import type { ContestDetail, ContestStatement } from '@taskweave/shared';
import { renderLatex, type MacroTable } from '../lib/latex';
import { cnoiProblemElement } from '../lib/cnoiDocument';
import { oiContent, oiFileIo, oiLayout, oiNotesBody, oiNotesImage, oiProblems, oiRows, oiTitle } from '../lib/oiDocument';
import { exportMarkdown } from '../lib/markdownExport';
import { api, token } from '../lib/api';
import { serverText } from '../lib/serverText';

const props = defineProps<{ detail: ContestDetail; statements: ContestStatement[]; lang: string; doc: 'statements' | 'tutorials'; notes: string; macros: MacroTable; toc?: boolean; loading?: boolean; preparingDown?: boolean; downRequest?: number; single?: boolean }>();
const emit = defineEmits<{ prepareDown: [] }>();
let pendingDown = false;
watch(() => props.downRequest, value => { if (value) pendingDown = true; });
watch(() => [props.lang, props.doc], () => { pendingDown = false; });
const { locale, t } = useI18n(); const message = useMessage();
const ui = (zh: string, en: string) => locale.value.startsWith('zh') ? zh : en;
const word = (zh: string, en: string) => props.lang === 'zh' ? zh : en;
const initial = oiLayout(props.detail);
const subtitle = ref(initial.subtitle);
const dayname = ref(initial.dayname);
const options = ref(initial.options);
const start = ref(initial.start);
const end = ref(initial.end);
const settingsKey = () => JSON.stringify([subtitle.value, dayname.value, options.value, start.value, end.value]);
let savedSettings = settingsKey(); let saveQueue = Promise.resolve();
const busy = ref(true); const error = ref(''); const pdf = ref(''); const svg = ref(''); const stale = ref(true); const exporting = ref(false);
/** SimSun / SimHei / KaiTi are not bundled (not redistributable): the worker reports the ones this system lacks. */
const missingFonts = ref<string[]>([]); const fallbackFonts = ref<string[]>([]); const fontDir = ref('');
const FONT_NAMES: Record<string, [string, string, string]> = { simsun: ['宋体', 'SimSun', 'simsun.ttc'], simhei: ['黑体', 'SimHei', 'simhei.ttf'], simkai: ['楷体', 'KaiTi', 'simkai.ttf'] };
const missingFontText = computed(() => missingFonts.value.map(k => FONT_NAMES[k] ? ui(`${FONT_NAMES[k][0]}（${FONT_NAMES[k][1]}）`, FONT_NAMES[k][1]) : k).join(ui('、', ', ')));
const missingFontFiles = computed(() => missingFonts.value.map(k => FONT_NAMES[k]?.[2] ?? k).join(ui('、', ', ')));
const problems = computed(() => oiProblems(props.statements, props.doc));
const title = computed(() => oiTitle(props.detail, props.lang, props.doc));
const notesImage = oiNotesImage(props.detail.summary.id);
/** Cover, overview tables and instructions: optional for statements, never for tutorials. */
const withToc = computed(() => props.doc === 'statements' && props.toc !== false);
const notesBody = computed(() => oiNotesBody(props.notes));
const fileIo = computed(() => oiFileIo(problems.value));
const rows = computed(() => oiRows(problems.value, props.lang));
let worker: Worker | undefined; let timer: ReturnType<typeof setTimeout> | undefined; let generation = 0;
function stop() { generation++; clearTimeout(timer); worker?.terminate(); worker = undefined; busy.value = false; }
function schedulePreview() { stop(); stale.value = true; busy.value = true; error.value = ''; if (!props.loading) timer = setTimeout(generate, 350); }
watch(() => [props.statements, props.notes, props.lang, props.doc, props.macros, withToc.value, props.loading, props.detail.summary.title, subtitle.value, dayname.value, options.value, start.value, end.value], schedulePreview, { immediate: true });
onBeforeUnmount(() => { stop(); if (pdf.value) URL.revokeObjectURL(pdf.value); });
async function generate() {
  stop(); if (props.loading) return;
  error.value = ''; busy.value = true;
  const current = generation;
  try {
    const content = oiContent({ detail: props.detail, statements: props.statements, lang: props.lang, doc: props.doc, notes: props.notes, macros: props.macros, ui, layout: { subtitle: subtitle.value, dayname: dayname.value, options: options.value, start: start.value, end: end.value, toc: props.toc !== false } });
    const key = settingsKey();
    if (!props.single && key !== savedSettings) {
      const statement = { ...props.detail.summary.statement!, subtitle: subtitle.value, session: dayname.value, compileOptions: options.value, schedule: `${start.value}/${end.value}` };
      saveQueue = saveQueue.catch(() => {}).then(async () => { await api.updateContest(props.detail.summary.id, { statement }); savedSettings = key; });
      await saveQueue;
    }
    if (current !== generation) return;
    const activeWorker = new Worker(new URL('../lib/cnoi.worker.ts', import.meta.url), { type: 'module' }); worker = activeWorker;
    activeWorker.onerror = e => { if (current === generation) { error.value = e.message; stop(); } };
    activeWorker.onmessage = ({ data }) => {
      if (current !== generation) return;
      if (data.error) { error.value = data.error; pendingDown = false; }
      else {
        if (pdf.value) URL.revokeObjectURL(pdf.value); pdf.value = URL.createObjectURL(new Blob([data.pdf], { type: 'application/pdf' })); svg.value = data.svg; stale.value = false;
        missingFonts.value = data.missingFonts ?? []; fallbackFonts.value = data.fallbackFonts ?? [];
        if (missingFonts.value.length && !fontDir.value) api.systemFonts().then(s => { fontDir.value = s.userDir; }).catch(() => {});
      }
      stop();
      if (pendingDown && !stale.value) { pendingDown = false; void exportDown(); }
    };
    activeWorker.postMessage({ content, token });
  } catch (e) { if (current === generation) { error.value = e instanceof Error ? e.message : String(e); stop(); } }
}
const baseName = () => `${props.detail.summary.name}-${props.doc}-${props.lang}-oi`;
async function exportDown() {
  if (busy.value || exporting.value || stale.value || !pdf.value || props.doc !== 'statements') return;
  const snapshot = { id: props.detail.summary.id, lang: props.lang, url: pdf.value, statements: JSON.parse(JSON.stringify(props.statements)) as ContestStatement[], notes: props.notes };
  exporting.value = true;
  try { await api.contestDown(snapshot.id, snapshot.lang, await (await fetch(snapshot.url)).blob(), snapshot.statements, snapshot.notes, props.single); message.success(t('export.saved', { file: 'down.zip' })); }
  catch (e) { message.error(serverText(e instanceof Error ? e.message : String(e))); }
  finally { exporting.value = false; }
}
async function onExport(format: string) {
  if (busy.value || exporting.value || stale.value || !pdf.value) return;
  exporting.value = true;
  try {
    if (format === 'pdf') { const a = document.createElement('a'); a.href = pdf.value; a.download = `${baseName()}.pdf`; a.click(); message.success(t('export.saved', { file: a.download })); return; }
    const root = document.createElement('article');
    const appendText = (tag: string, text: string, parent: HTMLElement = root) => { const node = document.createElement(tag); node.textContent = text; parent.append(node); return node; };
    if (withToc.value) {
      for (const text of [subtitle.value, dayname.value, `${word('时间', 'Time')}: ${start.value.replace('T', ' ')} – ${end.value.replace('T', ' ')}`]) if (text) appendText('p', text).style.textAlign = 'center';
      const table = appendText('table', '');
      const labels: [keyof typeof rows.value[number], string][] = [
        ['title', word('题目名称', 'Problem')], ['type', word('题目类型', 'Problem type')], ['dir', word('目录', 'Directory')], ['exec', word('可执行文件名', 'Executable')],
        ...(fileIo.value ? [['input', word('输入文件名', 'Input file')], ['output', word('输出文件名', 'Output file')]] as [keyof typeof rows.value[number], string][] : []),
        ['time_limit', word('每个测试点时限', 'Time limit per test')], ['memory_limit', word('内存限制', 'Memory limit')], ['testcase', word('测试点数目', 'Test cases')], ['point_equal', word('测试点是否等分', 'Equal points per test')],
      ];
      for (const [key, label] of labels) {
        const tr = appendText('tr', '', table); appendText('th', label, tr);
        rows.value.forEach((row, i) => {
          const td = appendText('td', '', tr);
          if (key === 'title') { const a = appendText('a', String(row[key]), td); a.setAttribute('href', `#problem-${problems.value[i].index}`); }
          else appendText(['dir', 'exec', 'input', 'output'].includes(key) ? 'code' : 'span', String(row[key]), td);
        });
      }
      appendText('p', word('提交源程序文件名', 'Source file names'));
      const sourceTable = appendText('table', ''); const sourceRow = appendText('tr', '', sourceTable); appendText('th', 'C++', sourceRow);
      rows.value.forEach(row => appendText('code', row.submit_filename[0], appendText('td', '', sourceRow)));
      appendText('p', word('编译选项', 'Compiler options'));
      const compileTable = appendText('table', ''); const compileRow = appendText('tr', '', compileTable); appendText('th', 'C++', compileRow); appendText('code', options.value, appendText('td', '', compileRow));
      if (notesBody.value.trim()) {
        appendText('h1', word('注意事项（请仔细阅读）', 'Instructions (please read carefully)'));
        const body = appendText('div', ''); body.innerHTML = renderLatex(notesBody.value, { macros: props.macros, imageUrl: notesImage }).html;
      }
    }
    // Footnote marks restart in every section, as in the PDF (section endnotes).
    problems.value.forEach((p, i) => {
      const heading = appendText('div', `${p.title}${word('（', ' (')}${rows.value[i].name}${word('）', ')')}`);
      heading.className = 'title'; heading.id = `problem-${p.index}`;
      root.append(cnoiProblemElement(p, props.doc, props.lang, props.macros));
    });
    const result = await exportMarkdown(root, baseName(), { contestTitle: title.value });
    message.success(t('export.saved', { file: result.file }));
    if (result.warnings) message.warning(t('improve.markdownWarnings'));
  } catch (e) { message.error(e instanceof Error ? e.message : String(e)); }
  finally { exporting.value = false; }
}
</script>

<template>
  <section class="oi-preview">
    <div class="settings-panel">
      <div class="settings-heading"><SlidersHorizontal :size="15" /><strong>{{ ui('排版设置', 'Layout settings') }}</strong><span class="format-label">OI · A4</span></div>
    <div class="options">
      <label class="subtitle-field">{{ ui('副标题', 'Subtitle') }}<n-input v-model:value="subtitle" size="small" :placeholder="ui('可选', 'Optional')" /></label>
      <label>{{ ui('场次', 'Session') }}<n-input v-model:value="dayname" size="small" :placeholder="ui('如 Day 1', 'e.g. Day 1')" /></label>
      <label>{{ ui('开始时间', 'Start time') }}<input v-model="start" type="datetime-local" /></label>
      <label>{{ ui('结束时间', 'End time') }}<input v-model="end" type="datetime-local" /></label>
      <label class="compiler-field">{{ ui('编译选项', 'Compiler options') }}<n-input v-model:value="options" size="small" /></label>
    </div>
    </div>
    <div class="preview-toolbar">
      <div class="preview-status" role="status" aria-live="polite">
        <n-spin v-if="busy" :size="14" /><Check v-else-if="!stale" :size="15" />
        <span>{{ busy ? ui('正在更新预览…', 'Updating preview…') : error ? ui('预览未完成', 'Preview unavailable') : ui('预览已更新', 'Preview up to date') }}</span>
        <n-button v-if="error" size="small" @click="generate">{{ ui('重试', 'Retry') }}</n-button>
      </div>
      <div class="export-actions">
      <n-button v-if="doc === 'statements'" size="small" :loading="preparingDown" :disabled="preparingDown || exporting || loading" @click="emit('prepareDown')">{{ t('oiFeatures.down') }}</n-button>
      <n-dropdown trigger="click" :options="[{ key: 'pdf', label: 'PDF' }, { key: 'markdown', label: 'Markdown' }]" @select="onExport">
        <n-button size="small" type="primary" :disabled="busy || stale || !pdf" :loading="exporting"><template #icon><Download :size="15" /></template>{{ t('contest.export') }}<ChevronDown class="export-chevron" :size="13" /></n-button>
      </n-dropdown>
      </div>
    </div>
    <n-alert v-if="error" type="error">{{ error }}</n-alert>
    <n-alert v-if="missingFonts.length && !error" :type="fallbackFonts.length ? 'info' : 'warning'" :title="ui(`本机缺少 OI 排版字体：${missingFontText}`, `Missing OI fonts on this computer: ${missingFontText}`)">
      {{ fallbackFonts.length ? ui(
        `这些字体不能随 TaskWeave 分发，需从本机读取。已改用本机的中文字体（如 Noto CJK）排版，字形与官方题面略有不同；如需一致，可把 ${missingFontFiles} 放到 ${fontDir || '全局目录的 fonts 文件夹'} 后重新检测。`,
        `These fonts cannot ship with TaskWeave and are read from this computer. Installed Chinese fonts (such as Noto CJK) are used instead, with slightly different glyphs; for the exact look, put ${missingFontFiles} into ${fontDir || 'the fonts folder of the global directory'} and check again.`,
      ) : ui(
        `这些字体不能随 TaskWeave 分发，需从本机读取；本机也没有可代替的中文字体，中文无法显示。Linux 可安装 fonts-noto-cjk，或把 ${missingFontFiles} 放到 ${fontDir || '全局目录的 fonts 文件夹'} 后重新检测。`,
        `These fonts cannot ship with TaskWeave and are read from this computer; no other Chinese font is installed, so Chinese text cannot be shown. On Linux install fonts-noto-cjk, or put ${missingFontFiles} into ${fontDir || 'the fonts folder of the global directory'} and check again.`,
      ) }}
      <div class="font-actions"><n-button size="small" @click="generate">{{ ui('重新检测', 'Check again') }}</n-button></div>
    </n-alert>
    <div v-if="!svg && !error" class="preview-placeholder"><FileText :size="32" :stroke-width="1.25" /><span>{{ ui('正在排版，首次预览可能需要几秒钟', 'Preparing pages. The first preview may take a few seconds.') }}</span></div>
    <div v-if="svg" class="oi-pages" :class="{ stale }" :aria-busy="busy" :aria-label="ui('OI 题面预览', 'OI statement preview')" v-html="svg" />
    <div class="attribution">{{ ui('排版', 'Typesetting') }} · <a href="https://github.com/Mr-Python-in-China/cnoi-statement-generator/tree/43d437ba80d2cd42e04344d59928cfa23fdeb569" target="_blank" rel="noopener">CNOI · AGPL-3.0</a></div>
  </section>
</template>

<style scoped>
.oi-preview { padding: 16px 24px 24px; display: flex; flex-direction: column; gap: 12px; }
.settings-panel { padding: 12px 14px 14px; border: 1px solid var(--pf-border); border-radius: 8px; background: var(--pf-surface); box-shadow: var(--pf-shadow); }
.settings-heading { display: flex; align-items: center; gap: 7px; margin-bottom: 10px; font-size: 12px; }
.settings-heading > svg { color: var(--pf-text-secondary); }
.format-label { margin-left: auto; color: var(--pf-text-secondary); font-size: 11px; }
.options { display: grid; grid-template-columns: minmax(140px, 1.3fr) minmax(100px, .7fr) repeat(2, minmax(190px, 1fr)) minmax(160px, 1fr); gap: 12px; }
.options label { display: flex; min-width: 0; flex-direction: column; gap: 5px; color: var(--pf-text-secondary); font-size: 12px; }
.options input { box-sizing: border-box; width: 100%; min-width: 0; height: 28px; padding: 3px 8px; border: 1px solid var(--pf-border); border-radius: 4px; color: var(--pf-text); background: var(--pf-surface); font: inherit; }
.options input:focus-visible { outline: 2px solid var(--pf-accent); outline-offset: 1px; }
.preview-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.preview-status { display: flex; align-items: center; gap: 7px; color: var(--pf-text-secondary); font-size: 12px; }
.export-chevron { margin-left: 8px; }
.export-actions { display: flex; gap: 8px; }
.font-actions { margin-top: 8px; }
.preview-placeholder { min-height: 320px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--pf-text-secondary); font-size: 13px; }
.oi-pages { width: min(100%, 850px); margin: 0 auto; background: #fff; color: #111; color-scheme: light; box-shadow: 0 2px 12px #0002; }
.oi-pages.stale { opacity: .5; }
.oi-pages :deep(svg) { display: block; width: 100%; height: auto; }
.attribution { text-align: center; color: var(--pf-text-secondary); font-size: 11px; }
.attribution a { color: inherit; text-decoration: none; }
.attribution a:hover { text-decoration: underline; }
@media (max-width: 1100px) { .options { grid-template-columns: repeat(2, minmax(0, 1fr)); } .compiler-field { grid-column: 1 / -1; } }
@media (max-width: 560px) { .oi-preview { padding: 12px; } .options { grid-template-columns: minmax(0, 1fr); } }
</style>
