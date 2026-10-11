import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { parseIndexList, STATEMENT_SECTIONS, type ProblemToml, type TestsManifest } from '@polyforge/shared';
import { exists, HttpError, safeJoin } from '../util/fs.js';
import { sampleStatementPaths, scriptStatementPaths, statementPaths } from '../judge/tests.js';

const headings = {
  zh: { legend: '题目描述', input: '输入格式', output: '输出格式', interaction: '交互方式', notes: '样例解释', scoring: '数据范围与约定' },
  en: { legend: 'Description', input: 'Input', output: 'Output', interaction: 'Interaction', notes: 'Sample explanation', scoring: 'Constraints and scoring' },
};

export function oiTemplate(lang: string): string {
  const h = lang === 'zh' ? headings.zh : headings.en;
  return [h.legend, h.input, h.output, h.scoring].map(x => `\\section*{${x}}\n\n`).join('');
}

/** Merge Polygon sections without translating or rewriting their LaTeX. */
export async function cfToOi(dir: string, config: ProblemToml, lang: string): Promise<string> {
  const h = lang === 'zh' ? headings.zh : headings.en;
  const parts: string[] = [];
  const add = (title: string, text: string) => { if (text.trim()) parts.push(`\\section*{${title}}\n\n${text.trim()}\n`); };
  const sections: Record<string, string> = {};
  for (const key of STATEMENT_SECTIONS) sections[key] = await fsp.readFile(safeJoin(dir, `statement/${lang}/${key}.tex`), 'utf8').catch(() => '');
  for (const key of ['legend', 'input', 'output', 'interaction'] as const) add(h[key], sections[key]);
  const manifest = await fsp.readFile(path.join(dir, '.polyforge/tests/manifest.json'), 'utf8').then(x => JSON.parse(x) as TestsManifest).catch(() => null);
  const manual = config.tests.manual ?? 'tests/manual';
  const files = await fsp.readdir(safeJoin(dir, manual)).catch(() => [] as string[]);
  for (const [n, index] of parseIndexList(config.tests.samples ?? '').entries()) {
    const test = manifest?.tests.find(t => t.index === index);
    const file = files.find(f => /^\d+\.in$/.test(f) && Number(f.slice(0, -3)) === index);
    const source = test?.origin === 'manual' ? test.source : file ? `${manual}/${file}` : undefined;
    const overrides = test ? sampleStatementPaths(test) : source ? statementPaths(source) : scriptStatementPaths(index);
    const read = async (candidates: string[]) => {
      for (const rel of candidates.filter(Boolean)) {
        const absolute = safeJoin(dir, rel);
        if (await exists(absolute)) return fsp.readFile(absolute, 'utf8');
      }
      throw new HttpError(400, 'sample_unavailable', `Sample ${index} is incomplete. Generate tests and answers before converting to OI.`);
    };
    const input = await read([overrides.input, source ?? '', `.polyforge/tests/${index}.in`]);
    const output = await read([overrides.output, `.polyforge/tests/${index}.ans`, ...(source ? [source.replace(/\.in$/, '.ans'), source.replace(/\.in$/, '.out')] : [])]);
    for (const [label, text] of [[lang === 'zh' ? '输入' : 'Input', input], [lang === 'zh' ? '输出' : 'Output', output]]) {
      // A sample containing a TeX environment terminator needs manual handling.
      if (text.includes('\\end{verbatim}')) throw new HttpError(400, 'sample_format', 'Sample contains a LaTeX verbatim terminator');
      add(`${lang === 'zh' ? '样例' : 'Sample'} ${n + 1} ${label}`, `\\begin{verbatim}\n${text.replace(/\r\n/g, '\n').replace(/\n$/, '')}\n\\end{verbatim}`);
    }
  }
  add(h.notes, sections.notes);
  add(h.scoring, sections.scoring);
  return parts.join('\n');
}
