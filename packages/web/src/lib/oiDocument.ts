import type { ContestDetail, ContestStatement } from '@taskweave/shared';
import type { MacroTable } from './latex';
import { cnoiMarkdown, cnoiProblemMarkdown } from './cnoiDocument';
import { token } from './api';

/** OI cover settings, stored in contest.toml [statement]. */
export interface OiLayout { subtitle: string; dayname: string; options: string; start: string; end: string; toc: boolean }

/** The contest's saved OI settings, with the defaults of the OI preview. */
export function oiLayout(detail: ContestDetail, toc = localStorage.getItem('taskweave-print-toc') !== '0'): OiLayout {
  const st = detail.summary.statement;
  const today = new Date(), date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const schedule = st?.schedule.split('/') ?? [];
  return {
    subtitle: st?.subtitle ?? '', dayname: st?.session ?? '', options: st?.compileOptions || '-O2 -std=c++14',
    start: schedule[0]?.includes('T') ? schedule[0] : `${date}T08:00`, end: schedule[1]?.includes('T') ? schedule[1] : `${date}T12:00`, toc,
  };
}

const word = (lang: string, zh: string, en: string) => (lang === 'zh' ? zh : en);

export function oiProblems(statements: ContestStatement[], doc: 'statements' | 'tutorials') {
  return statements.filter(s => doc === 'tutorials' ? s.sections.tutorial?.trim() : s.body || s.sections.legend || s.sections.input || s.sections.output);
}

export function oiTitle(detail: ContestDetail, lang: string, doc: 'statements' | 'tutorials') {
  return (detail.summary.title[lang] || detail.summary.title.en || detail.summary.name) + (doc === 'tutorials' ? word(lang, ' · 题解', ' · Tutorial') : '');
}

export const oiNotesBody = (notes: string) => notes.replace(/^\s*\*\*(?:注意事项[^\n]*|Instructions[^\n]*)\*\*\s*/i, '');
export const oiFileIo = (problems: ContestStatement[]) => problems.some(p => p.input !== 'stdin' && !!p.input || p.output !== 'stdout' && !!p.output);
export const oiNotesImage = (contestId: string) => (n: string) => `/api/contests/${encodeURIComponent(contestId)}/file/raw?path=${encodeURIComponent(n)}&token=${encodeURIComponent(token)}`;

export function oiRows(problems: ContestStatement[], lang: string) {
  const w = (zh: string, en: string) => word(lang, zh, en);
  return problems.map(p => ({
    name: p.name || p.problem, title: p.title, type: p.interactive ? w('交互型', 'Interactive') : w('传统型', 'Batch'), dir: p.name || p.problem, exec: p.name || p.problem,
    input: !p.input || p.input === 'stdin' ? w('标准输入', 'standard input') : p.input,
    output: !p.output || p.output === 'stdout' ? w('标准输出', 'standard output') : p.output,
    time_limit: `${p.timeLimit / 1000} ${w('秒', 's')}`, memory_limit: `${p.memoryLimit} MiB`, testcase: String(p.testCount ?? '—'),
    point_equal: p.equalPoints === undefined ? '—' : p.equalPoints ? w('是', 'Yes') : w('否', 'No'),
    submit_filename: [`${p.name || p.problem}.cpp`], pretestcase: '',
  }));
}

/** Input of the CNOI worker; throws with a message in the UI language. */
export function oiContent(input: { detail: ContestDetail; statements: ContestStatement[]; lang: string; doc: 'statements' | 'tutorials'; notes: string; macros: MacroTable; layout: OiLayout; ui: (zh: string, en: string) => string }) {
  const { detail, statements, lang, doc, notes, macros, layout, ui } = input;
  const dateArray = (s: string) => { const d = new Date(s); if (!Number.isFinite(+d)) throw new Error(ui('请填写有效的比赛起止时间', 'Enter a valid start and end time.')); return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()]; };
  const startDate = dateArray(layout.start), endDate = dateArray(layout.end);
  if (new Date(layout.end) <= new Date(layout.start)) throw new Error(ui('结束时间应晚于开始时间', 'The end time must be after the start time.'));
  const problems = oiProblems(statements, doc);
  if (!problems.length) throw new Error(ui('当前语言没有可导出的内容', 'No content is available in this language.'));
  const body = oiNotesBody(notes);
  return {
    lang, title: oiTitle(detail, lang, doc), subtitle: layout.subtitle, dayname: layout.dayname, date: { start: startDate, end: endDate },
    noi_style: true, file_io: oiFileIo(problems), use_pretest: false, pf_toc: doc === 'statements' && layout.toc,
    support_languages: [{ name: 'C++', compile_options: layout.options }],
    problems: oiRows(problems, lang).map((row, i) => ({ ...row, markdown: cnoiProblemMarkdown(problems[i], doc, lang, macros) })),
    extraContents: { precaution: { markdown: body.trim() ? `**${word(lang, '注意事项（请仔细阅读）', 'Instructions (please read carefully)')}**\n\n` + cnoiMarkdown(body, macros, oiNotesImage(detail.summary.id), lang) : '' } },
  };
}

export interface OiRender { pdf: Uint8Array; svg: string; missingFonts: string[]; fallbackFonts: string[] }

/** Typeset once in a worker. `signal` terminates it. */
export function renderOi(content: ReturnType<typeof oiContent>, signal?: AbortSignal): { worker: Worker; result: Promise<OiRender> } {
  const worker = new Worker(new URL('./cnoi.worker.ts', import.meta.url), { type: 'module' });
  const result = new Promise<OiRender>((resolve, reject) => {
    const done = () => { worker.terminate(); signal?.removeEventListener('abort', abort); };
    const abort = () => { done(); reject(new DOMException('Aborted', 'AbortError')); };
    signal?.addEventListener('abort', abort);
    worker.onerror = e => { done(); reject(new Error(e.message)); };
    worker.onmessage = ({ data }) => { done(); if (data.error) reject(new Error(data.error)); else resolve({ pdf: data.pdf, svg: data.svg, missingFonts: data.missingFonts ?? [], fallbackFonts: data.fallbackFonts ?? [] }); };
    worker.postMessage({ content, token });
  });
  return { worker, result };
}
