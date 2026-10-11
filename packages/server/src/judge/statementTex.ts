import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { oiOverview, type ContestStatement } from '@polyforge/shared';
import { expandMacros } from '../ai/macros.js';
import { exists } from '../util/fs.js';
import { ZipWriter } from '../util/zip.js';
import type { ContestRegistry } from '../workspace/contests.js';
import { contestStatements } from './contest.js';
import type { Judge } from './index.js';

const HEAD: Record<string, Record<string, string>> = {
  zh: { input: '输入格式', output: '输出格式', interaction: '交互', scoring: '评分', notes: '说明', examples: '样例', tutorial: '题解', stdin: '标准输入', stdout: '标准输出', inFile: '输入', outFile: '输出' },
  en: { input: 'Input', output: 'Output', interaction: 'Interaction', scoring: 'Scoring', notes: 'Note', examples: 'Examples', tutorial: 'Tutorial', stdin: 'standard input', stdout: 'standard output', inFile: 'input', outFile: 'output' },
};

/**
 * The contest's statements (or tutorials) in one language as a self-contained LaTeX
 * document: no olymp.sty needed; the Polygon statement commands used in sections
 * (\t, \epigraph, \exmp, …) are defined in the preamble and defs.toml macros are
 * expanded. Chinese uses ctex (compile with XeLaTeX). With images, a zip holding the
 * .tex and the images is returned.
 */
export async function contestTex(
  judge: Judge,
  contests: ContestRegistry,
  contestId: string,
  lang: string,
  doc: 'statements' | 'tutorials',
  pageBreaks: boolean,
  toc = true,
): Promise<{ data: Buffer; ext: 'tex' | 'zip' }> {
  const { ref, config } = await contests.config(contestId);
  const statements = await contestStatements(judge, contests, contestId, lang);
  const oi = config.contest.type === 'oi';
  const h: Record<string, string> = { ...(HEAD[lang] ?? HEAD.en), ...(oi && lang === 'zh' ? { scoring: '数据范围与约定', notes: '样例解释' } : {}) };
  const zh = lang === 'zh';
  const title = config.contest.title[lang] || config.contest.title.en || config.contest.name;
  const images = new Map<string, string>(); // zip path -> absolute file
  const sharedDir = judge.global.sharedDir;
  const dirs = new Map<string, string>();
  for (const s of statements) {
    const r = await judge.registry.get(s.problem).catch(() => null);
    if (r) dirs.set(s.problem, r.dir);
  }

  const section = async (s: ContestStatement, text: string) => {
    let t = await expandMacros(sharedDir, text, lang);
    // Images of each problem live in its statement/images; keep them apart in the zip.
    t = t.replace(/\\includegraphics(\[[^\]]*\])?\{([^}]+)\}/g, (_m, opt: string | undefined, name: string) => {
      const file = name.trim();
      const zipPath = `images/${s.problem}/${file}`;
      const dir = dirs.get(s.problem);
      if (dir) images.set(zipPath, path.join(dir, 'statement', 'images', file));
      return `\\includegraphics${opt ?? '[width=0.6\\textwidth]'}{${zipPath}}`;
    });
    return t.trim();
  };

  const body: string[] = [];
  const opts = config.statement;
  if (!oi) body.push(`\\begin{center}{\\LARGE ${esc(doc === 'tutorials' ? `${title} — ${h.tutorial}` : title)}}\\end{center}`, '');
  else if (toc) {
    body.push('\\thispagestyle{empty}', '\\begin{center}',
      `{\\fontsize{22}{33}\\selectfont${zh ? '\\heiti' : ''}\\bfseries ${esc(title)}}\\par`);
    if (opts.subtitle) body.push(`{\\fontsize{22}{33}\\selectfont${zh ? '\\heiti' : ''} ${esc(opts.subtitle)}}\\par`);
    if (opts.session) body.push(`{\\fontsize{22}{33}\\selectfont${zh ? '\\kaishu' : ''} ${esc(opts.session)}}\\par`);
    if (opts.schedule) body.push(`\\medskip{\\fontsize{15}{23}\\selectfont ${zh ? '时间：' : 'Time: '}${esc(opts.schedule)}}\\par`);
    body.push('\\end{center}', '');
  }
  const shown = statements.filter((s) => (doc === 'tutorials' ? !!s.sections.tutorial : !!(s.body || s.sections.legend || s.sections.input || s.sections.output)));
  if (toc && shown.length && oi && doc === 'statements') {
    const table = (rows: string[][], n: number) => [
      `\\noindent\\begin{tabularx}{\\textwidth}{|p{0.23\\textwidth}|${'X|'.repeat(n)}}\\hline`,
      ...rows.map(cells => cells.join(' & ') + ' \\\\ \\hline'),
      '\\end{tabularx}\\par',
    ];
    for (let i = 0; i < shown.length; i += 4) {
      const group = shown.slice(i, i + 4);
      body.push(...table(oiOverview(group, lang).map(r => [esc(r.label), ...r.values.map(v => r.mono ? `\\texttt{${esc(v)}}` : esc(v))]), group.length));
      body.push(zh ? '提交源程序文件名\\par' : 'Source file names\\par',
        ...table([[zh ? '对于 C++ 语言' : 'For C++', ...group.map(p => `\\texttt{${esc(p.name ?? p.problem)}.cpp}`)]], group.length));
    }
    if (opts.compileOptions) body.push(zh ? '编译选项\\par' : 'Compiler options\\par', ...table([[zh ? '对于 C++ 语言' : 'For C++', `\\centering\\arraybackslash\\texttt{${esc(opts.compileOptions)}}`]], 1));
    if (opts.instructions) body.push(`{${zh ? '\\heiti 注意事项（请仔细阅读）' : '\\bfseries Instructions (please read carefully)'}}\\par`, ...opts.instructions.split(/\r?\n/).map(line => `${esc(line)}\\par`));
    body.push('\\clearpage', '');
  } else if (toc && shown.length) {
    // Contents page: the problems of this document, then the first problem on a new page.
    const cols = doc === 'statements';
    const th = zh ? ['题号', '题目', '输入', '输出', '时间限制', '空间限制'] : ['\\#', 'Problem', 'Input', 'Output', 'Time limit', 'Memory limit'];
    const stream = (v: string, std: 'stdin' | 'stdout') => (!v || v === std ? h[std] : `\\texttt{${esc(v)}}`);
    body.push(
      '\\begin{center}',
      cols ? (oi ? '\\begin{tabularx}{\\textwidth}{|l|X|X|X|r|r|}' : '\\begin{tabular}{llllrr}') : '\\begin{tabular}{ll}',
      '\\hline',
      (cols ? th : th.slice(0, 2)).map((x) => `\\textbf{${x}}`).join(' & ') + ' \\\\ \\hline',
      ...shown.map((s) => {
        const cells = [`\\textbf{${esc(s.index)}}`, esc(s.title)];
        if (cols) cells.push(stream(s.input, 'stdin'), stream(s.output, 'stdout'), zh ? `${s.timeLimit / 1000} 秒` : `${s.timeLimit / 1000} s`, `${s.memoryLimit} MB`);
        return cells.join(' & ') + ' \\\\';
      }),
      '\\hline',
      cols && oi ? '\\end{tabularx}' : '\\end{tabular}',
      '\\end{center}',
      '\\newpage',
      '',
    );
  }
  for (const [k, s] of shown.entries()) {
    if (k > 0) body.push(pageBreaks || oi ? '\\clearpage' : '\\bigskip\\hrule\\bigskip');
    const name = s.name ?? s.problem;
    const heading = oi ? `${esc(s.title)}${zh ? '（' : ' ('}${esc(name)}${zh ? '）' : ')'}` : `${esc(s.index)}. ${esc(s.title)}`;
    if (oi) body.push(
      `\\fancyhead[L]{\\fontsize{10}{12}\\selectfont ${esc([title, opts.subtitle].filter(Boolean).join(' '))}}`,
      `\\fancyhead[R]{\\fontsize{10}{12}\\selectfont ${esc(opts.session)} ${heading}}`,
    );
    if (doc === 'tutorials') {
      body.push(oi ? `\\pftitle{${heading}}` : `\\begin{center}{\\Large ${heading}}\\end{center}`, '', await section(s, s.sections.tutorial!), '');
      continue;
    }
    const secs = s.timeLimit / 1000;
    const tl = zh ? `时间限制：${secs} 秒` : `time limit per test: ${secs} second${secs === 1 ? '' : 's'}`;
    const ml = zh ? `空间限制：${s.memoryLimit} MB` : `memory limit per test: ${s.memoryLimit} megabytes`;
    // Input / output files, as in the rendered statement: stdin / stdout are not mentioned.
    const io = (v: string, std: 'stdin' | 'stdout', name: string) => (oi || (v && v !== std) ? `\\\\${zh ? `${name}：` : `${name}: `}${!v || v === std ? h[std] : `\\texttt{${esc(v)}}`}` : '');
    if (oi) body.push(`\\pftitle{${heading}}`);
    else body.push(
      `\\begin{center}{\\Large ${heading}}\\\\[0.4em]`,
      `{\\small ${tl}\\\\${ml}${io(s.input, 'stdin', h.inFile)}${io(s.output, 'stdout', h.outFile)}}\\end{center}`,
      '',
    );
    if (oi && s.body !== undefined) {
      body.push(await section(s, s.body), '');
      continue;
    }
    if (s.sections.legend) {
      if (oi) body.push(`\\pfsection{${zh ? '题目描述' : 'Description'}}`);
      body.push(await section(s, s.sections.legend), '');
    }
    for (const key of (oi ? ['input', 'output', 'interaction'] : ['input', 'output', 'interaction', 'scoring']) as ('input' | 'output' | 'interaction' | 'scoring')[]) {
      if (s.sections[key]) body.push(`\\pfsection{${h[key]}}`, await section(s, s.sections[key]), '');
    }
    if (s.samples.length) {
      if (!oi) body.push(`\\pfsection{${h.examples}}`);
      for (const [i, x] of s.samples.entries()) {
        if (oi) {
          for (const [label, text] of [[zh ? '输入' : 'Input', x.input], [zh ? '输出' : 'Output', x.output]]) {
            body.push(`\\pfsection{${zh ? '样例' : 'Sample'} ${i + 1} ${label}}`, '\\begin{OIsample}', text.replace(/\r\n/g, '\n').replace(/\n$/, ''), '\\end{OIsample}');
          }
        } else body.push(sampleTex(x.input, x.output, h.stdin, h.stdout));
      }
      body.push('');
    }
    if (s.sections.notes) body.push(`\\pfsection{${h.notes}}`, await section(s, s.sections.notes), '');
    if (oi && s.sections.scoring) body.push(`\\pfsection{${h.scoring}}`, await section(s, s.sections.scoring), '');
  }

  const tex = [
    '% Generated by PolyForge.',
    zh ? '% Compile with XeLaTeX (ctex).' : '% Compile with pdfLaTeX or XeLaTeX.',
    `\\documentclass[${oi ? '12' : '11'}pt,a4paper]{article}`,
    `\\usepackage[a4paper,margin=${oi ? '25' : '20'}mm]{geometry}`,
    zh ? '\\usepackage[UTF8]{ctex}' : '\\usepackage[T1]{fontenc}\n\\usepackage[utf8]{inputenc}\n\\usepackage{lmodern}',
    '\\usepackage{amsmath,amssymb}',
    '\\usepackage{graphicx}',
    '\\usepackage{array}',
    '\\usepackage{tabularx}',
    '\\usepackage{verbatim}',
    '\\setlength{\\parindent}{0pt}',
    '\\setlength{\\parskip}{0.6em}',
    '\\pagestyle{plain}',
    '% Polygon statement commands',
    '\\renewcommand{\\t}[1]{\\texttt{#1}}',
    '\\newcommand{\\pfsection}[1]{\\par\\medskip{\\large\\textbf{#1}}\\par\\nopagebreak}',
    '\\newcommand{\\epigraph}[2]{\\par\\hfill\\begin{minipage}{0.33\\textwidth}#1\\par\\vspace{0.2em}\\hrule\\vspace{0.2em}\\hfill #2\\end{minipage}\\par\\medskip}',
    '\\newcommand{\\exmp}[2]{\\par\\begin{tabular}{|p{0.46\\textwidth}|p{0.46\\textwidth}|}\\hline\\texttt{#1} & \\texttt{#2}\\\\\\hline\\end{tabular}\\par}',
    '\\newcommand{\\exmpfile}[2]{}',
    '\\newcommand{\\InputFile}{\\pfsection{' + h.input + '}}',
    '\\newcommand{\\OutputFile}{\\pfsection{' + h.output + '}}',
    '\\newcommand{\\Examples}{\\pfsection{' + h.examples + '}}',
    '\\newcommand{\\Example}{\\pfsection{' + h.examples + '}}',
    '\\newcommand{\\Note}{\\pfsection{' + h.notes + '}}',
    '\\newcommand{\\Interaction}{\\pfsection{' + h.interaction + '}}',
    '\\newcommand{\\Scoring}{\\pfsection{' + h.scoring + '}}',
    ...(oi ? [
      '\\setlength{\\parindent}{2em}',
      '\\makeatletter',
      '\\renewcommand{\\section}{\\@ifstar\\pfsection\\pfsection}',
      '\\renewcommand{\\subsection}{\\@ifstar\\pfsection\\pfsection}',
      '\\makeatother',
      '\\renewcommand{\\arraystretch}{1.15}',
      '\\setlength{\\arrayrulewidth}{0.3pt}',
      '\\linespread{1.25}',
      '\\usepackage{fancyhdr,lastpage,xcolor,fvextra}',
      '\\pagestyle{fancy}\\fancyhf{}',
      '\\setlength{\\headheight}{26pt}',
      '\\renewcommand{\\headrulewidth}{0.3pt}',
      '\\DefineVerbatimEnvironment{OIsample}{Verbatim}{numbers=left,numbersep=9pt,frame=single,framerule=0.4pt,rulecolor=\\color{blue},framesep=3pt,breaklines=true,fontsize=\\normalsize}',
      '\\RecustomVerbatimEnvironment{verbatim}{Verbatim}{numbers=left,numbersep=9pt,frame=single,framerule=0.4pt,rulecolor=\\color{blue},framesep=3pt,breaklines=true,fontsize=\\normalsize}',
      `\\newcommand{\\pftitle}[1]{\\begin{center}{\\fontsize{18}{27}\\selectfont${zh ? '\\heiti' : ''} #1}\\end{center}}`,
      zh ? '\\fancyfoot[C]{\\small 第 \\thepage 页，共 \\pageref{LastPage} 页}' : '\\fancyfoot[C]{\\small Page \\thepage\\ of \\pageref{LastPage}}',
      `\\renewcommand{\\pfsection}[1]{\\par\\medskip\\noindent\\hspace{1.5em}{${zh ? '\\heiti' : '\\bfseries'}\\fontsize{13}{20}\\selectfont ${zh ? '【#1】' : '[#1]'}}\\par\\nopagebreak}`,
    ] : []),
    '\\begin{document}',
    '',
    ...body,
    '\\end{document}',
    '',
  ].join('\n');

  const found = [...images];
  const existing: [string, string][] = [];
  for (const [zp, abs] of found) if (await exists(abs)) existing.push([zp, abs]);
  if (!existing.length) return { data: Buffer.from(tex, 'utf8'), ext: 'tex' };
  const zip = new ZipWriter();
  zip.add(`${ref.id}-${doc}-${lang}.tex`, tex);
  for (const [zp, abs] of existing) zip.add(zp, await fsp.readFile(abs));
  return { data: zip.finish(), ext: 'zip' };
}

/** A sample as a two-column table; verbatim inside minipages keeps spaces and symbols. */
function sampleTex(input: string, output: string, inLabel: string, outLabel: string): string {
  const cell = (s: string) => `\\begin{minipage}[t]{0.46\\textwidth}\\vspace{0pt}\n\\begin{verbatim}\n${s.replace(/\r\n/g, '\n').replace(/\n$/, '')}\n\\end{verbatim}\n\\end{minipage}`;
  return [
    '\\par\\noindent\\begin{tabular}{|p{0.47\\textwidth}|p{0.47\\textwidth}|}',
    `\\hline \\textbf{${inLabel}} & \\textbf{${outLabel}} \\\\ \\hline`,
    `${cell(input)} &`,
    `${cell(output)} \\\\ \\hline`,
    '\\end{tabular}\\par\\smallskip',
  ].join('\n');
}

/** Escape plain text (titles) for LaTeX. */
function esc(s: string): string {
  return s.replace(/[\\{}&%$#_^~]/g, (c) => ({ '\\': '\\textbackslash{}', '^': '\\^{}', '~': '\\~{}' })[c] ?? `\\${c}`);
}
