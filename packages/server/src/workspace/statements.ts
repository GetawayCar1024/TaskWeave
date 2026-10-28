import { promises as fs } from 'node:fs';
import path from 'node:path';
import { OI_SECTIONS, STATEMENT_BODY_SECTIONS, STATEMENT_SECTIONS, type StatementMode } from '@taskweave/shared';
import { atomicWrite, exists, HttpError } from '../util/fs.js';

const language = (lang: string) => {
  if (!/^[a-z]{2,8}$/.test(lang) || lang === 'images') throw new HttpError(400, 'bad_lang', 'Invalid statement language');
  return lang;
};

export async function wholeStatementLanguages(dir: string): Promise<string[]> {
  const langs = await fs.readdir(path.join(dir, 'statement')).catch(() => [] as string[]);
  const found = await Promise.all(langs.filter(l => /^[a-z]{2,8}$/.test(l) && l !== 'images').map(async lang =>
    await exists(path.join(dir, 'statement', lang, 'statement.tex')) ? lang : null));
  return found.filter((l): l is string => l !== null).sort();
}

/** One representation for preview, documents and Polygon: a whole statement occupies legend. */
export async function readStatementSections(dir: string, lang: string): Promise<Record<string, string>> {
  const base = path.join(dir, 'statement', language(lang));
  const whole = await exists(path.join(base, 'statement.tex'));
  const sections: Record<string, string> = {};
  for (const section of [...STATEMENT_SECTIONS, ...OI_SECTIONS]) {
    if (whole && section !== 'legend' && STATEMENT_BODY_SECTIONS.includes(section as typeof STATEMENT_BODY_SECTIONS[number])) continue;
    const text = await fs.readFile(path.join(base, whole && section === 'legend' ? 'statement.tex' : `${section}.tex`), 'utf8').catch(e => {
      if (e.code === 'ENOENT') return ''; throw e;
    });
    if (text.trim()) sections[section] = text;
  }
  return sections;
}

const headings: Record<string, Record<string, string>> = {
  zh: { input: '输入格式', output: '输出格式', interaction: '交互', scoring: '评分', notes: '说明' },
  en: { input: 'Input', output: 'Output', interaction: 'Interaction', scoring: 'Scoring', notes: 'Notes' },
};

/** Called only after the editor has saved and confirmed losing the original section boundaries. */
export async function convertStatementMode(dir: string, lang: string, mode: StatementMode) {
  const base = path.join(dir, 'statement', language(lang));
  const wholeFile = path.join(base, 'statement.tex');
  if (mode !== 'whole' && mode !== 'sections') throw new HttpError(400, 'bad_request', 'Unknown statement mode');
  const whole = await exists(wholeFile);
  if ((mode === 'whole') === whole) return;
  if (mode === 'whole') {
    const sections = await readStatementSections(dir, lang);
    const labels = headings[lang] ?? headings.en;
    const text = STATEMENT_BODY_SECTIONS.filter(s => sections[s]?.trim()).map(s =>
      `${s === 'legend' ? '' : `\\section*{${labels[s]}}\n\n`}${sections[s].trimEnd()}`).join('\n\n');
    // Write the complete text first: a failed write never deletes the original sections.
    await atomicWrite(wholeFile, text ? text + '\n' : '');
    for (const section of STATEMENT_BODY_SECTIONS) await fs.rm(path.join(base, `${section}.tex`), { force: true });
  } else {
    const text = await fs.readFile(wholeFile, 'utf8');
    // Never silently overwrite sections edited externally while statement.tex exists.
    for (const section of STATEMENT_BODY_SECTIONS) {
      const old = await fs.readFile(path.join(base, `${section}.tex`), 'utf8').catch(() => '');
      if (old.trim()) throw new HttpError(409, 'statement_conflict', `Both statement.tex and ${section}.tex contain text. Move the section file aside before converting.`);
    }
    await atomicWrite(path.join(base, 'legend.tex'), text);
    for (const section of STATEMENT_BODY_SECTIONS.filter(s => s !== 'legend')) await atomicWrite(path.join(base, `${section}.tex`), '');
    await fs.unlink(wholeFile);
  }
}

export const wholeStatementWarning = (langs: string[]) => langs.length
  ? [`Whole statements (${langs.join(', ')}) will be converted to sections for Polygon; all text is placed in legend.`] : [];

export async function splitStatementsForPolygon(dir: string): Promise<string[]> {
  const langs = await wholeStatementLanguages(dir);
  for (const lang of langs) await convertStatementMode(dir, lang, 'sections');
  return wholeStatementWarning(langs);
}
