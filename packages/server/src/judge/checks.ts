import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { DEFAULT_TESTSET, lintStatement, parseIndexList, statementLanguages, STD_PREFIX, testsetsOf, type LocalCheck } from '@polyforge/shared';
import { exists, safeJoin } from '../util/fs.js';
import type { Judge, ProblemCtx } from './index.js';
import { readManifest } from './tests.js';

/**
 * Deterministic checks that need no AI: missing parts, statement/tutorial language
 * mismatch, statement lint, test generation errors. Shown in the UI and given to the
 * AI check as a starting point.
 */
export async function localChecks(_judge: Judge, ctx: ProblemCtx): Promise<LocalCheck[]> {
  const { config, ref } = ctx;
  const out: LocalCheck[] = [];
  const has = async (rel?: string) => !!rel && (rel.startsWith(STD_PREFIX) || (await exists(safeJoin(ref.dir, rel))));

  // ---- statement & tutorial ----
  const files: { path: string; size: number; text: string }[] = [];
  for (const lang of await fsp.readdir(path.join(ref.dir, 'statement')).catch(() => [] as string[])) {
    if (lang === 'images') continue;
    for (const f of await fsp.readdir(path.join(ref.dir, 'statement', lang)).catch(() => [] as string[])) {
      if (!f.endsWith('.tex')) continue;
      const text = await fsp.readFile(path.join(ref.dir, 'statement', lang, f), 'utf8').catch(() => '');
      files.push({ path: `statement/${lang}/${f}`, size: text.trim().length, text });
    }
  }
  const langs = statementLanguages(files);
  if (!langs.statement.length) out.push({ level: 'error', category: 'statement', message: 'No statement written yet' });
  for (const lang of langs.statement) {
    for (const sec of ['legend', 'input', 'output']) {
      if (!files.some((f) => f.path === `statement/${lang}/${sec}.tex` && f.size)) {
        out.push({ level: 'warning', category: 'statement', file: `statement/${lang}/${sec}.tex`, message: `${lang} statement has no ${sec} section` });
      }
    }
    if (config.problem.interactive && !files.some((f) => f.path === `statement/${lang}/interaction.tex` && f.size)) {
      out.push({ level: 'warning', category: 'statement', file: `statement/${lang}/interaction.tex`, message: `Interactive problem without an interaction section (${lang})` });
    }
    if (!config.problem.title[lang]) out.push({ level: 'warning', category: 'statement', file: 'problem.toml', message: `No ${lang} title in problem.toml` });
  }
  for (const lang of langs.missingTutorial) {
    out.push({ level: 'warning', category: 'tutorial', file: `statement/${lang}/tutorial.tex`, message: `Statement language ${lang} has no tutorial` });
  }
  for (const lang of langs.orphanTutorial) {
    out.push({ level: 'warning', category: 'tutorial', file: `statement/${lang}/tutorial.tex`, message: `Tutorial in ${lang}, but there is no ${lang} statement` });
  }
  for (const f of files) {
    if (!f.size) continue;
    const { issues } = lintStatement(f.text, { lang: f.path.split('/')[1] });
    if (!issues.length) continue;
    const kinds = [...new Set(issues.map((i) => i.rule))];
    out.push({
      level: issues.some((i) => !i.fixable) ? 'warning' : 'info',
      category: f.path.endsWith('/tutorial.tex') ? 'tutorial' : 'statement',
      file: f.path,
      line: issues[0].line,
      message: `${issues.length} formatting issue(s): ${kinds.join(', ')}${issues.every((i) => i.fixable) ? ' (all auto-fixable)' : ''}`,
    });
  }

  // ---- programs ----
  if (!config.validator || !(await has(config.validator.source))) out.push({ level: 'error', category: 'validator', message: 'No validator' });
  if (!config.checker || !(await has(config.checker.source))) out.push({ level: 'error', category: 'checker', message: 'No checker' });
  if (config.problem.interactive && (!config.interactor || !(await has(config.interactor.source)))) {
    out.push({ level: 'error', category: 'interactor', message: 'Interactive problem without an interactor' });
  }
  const ma = config.solutions.filter((s) => s.tag === 'MA');
  if (ma.length !== 1) out.push({ level: 'error', category: 'solutions', file: 'problem.toml', message: ma.length ? 'More than one MA solution' : 'No main solution (tag MA)' });
  for (const s of config.solutions) if (!(await has(s.source))) out.push({ level: 'error', category: 'solutions', file: 'problem.toml', message: `Listed solution is missing: ${s.source}` });
  if (config.solutions.length < 2) out.push({ level: 'info', category: 'solutions', message: 'Only one solution: add a brute force and wrong solutions to check the tests' });

  // ---- tests ----
  const manualDir = path.join(ref.dir, 'tests', 'manual');
  const manual = (await fsp.readdir(manualDir).catch(() => [] as string[])).length;
  if (!manual && !(config.tests.script && (await has(config.tests.script)))) out.push({ level: 'error', category: 'tests', message: 'No tests: add manual tests or tests/script.txt' });
  if (!parseIndexList(config.tests.samples ?? '').length) out.push({ level: 'warning', category: 'tests', file: 'problem.toml', message: 'No sample tests (tests.samples)' });
  const vt = (await fsp.readdir(path.join(ref.dir, 'validator-tests')).catch(() => [] as string[])).filter((f) => !f.startsWith('.'));
  if (!vt.length) out.push({ level: 'info', category: 'validator', message: 'No validator tests' });
  const m = await readManifest(ctx);
  if (m) for (const e of m.errors.slice(0, 10)) out.push({ level: 'error', category: 'tests', message: `Last test generation: ${e}` });

  // ---- testsets, groups (subtasks) and scoring ----
  for (const ts of testsetsOf(config)) {
    const where = ts.name === DEFAULT_TESTSET ? '' : ` (${ts.name})`;
    if (ts.name !== DEFAULT_TESTSET) {
      const own = (await fsp.readdir(safeJoin(ref.dir, ts.manual)).catch(() => [] as string[])).length;
      if (!own && !(ts.script && (await has(ts.script)))) out.push({ level: 'warning', category: 'tests', file: 'problem.toml', message: `Testset ${ts.name} has no tests` });
    }
    if (!ts.groups) continue;
    if (!ts.group.length) {
      out.push({ level: 'warning', category: 'tests', file: 'problem.toml', message: `Groups are enabled${where} but none is defined` });
      continue;
    }
    const tm = await readManifest(ctx, ts.name);
    if (tm) {
      const all = new Set(tm.tests.map((t) => t.index));
      const loose = tm.tests.filter((t) => !t.group).map((t) => t.index);
      if (loose.length) out.push({ level: 'warning', category: 'tests', file: 'problem.toml', message: `Tests outside every group${where}: ${loose.slice(0, 20).join(', ')}` });
      for (const g of ts.group) {
        const idx = parseIndexList(g.tests ?? '');
        if (!idx.length) out.push({ level: 'warning', category: 'tests', file: 'problem.toml', message: `Group ${g.name}${where} has no tests` });
        const missing = idx.filter((i) => !all.has(i));
        if (missing.length) out.push({ level: 'error', category: 'tests', file: 'problem.toml', message: `Group ${g.name}${where} refers to missing tests ${missing.slice(0, 10).join(', ')}` });
      }
    }
    if (config.tests.points && ts.name === DEFAULT_TESTSET) {
      const noPoints = ts.group.filter((g) => g.points === undefined).map((g) => g.name);
      if (noPoints.length) out.push({ level: 'warning', category: 'tests', file: 'problem.toml', message: `Groups without points: ${noPoints.join(', ')}` });
      const sum = ts.group.reduce((a, g) => a + (g.points ?? 0), 0);
      if (sum !== 100) out.push({ level: 'info', category: 'tests', file: 'problem.toml', message: `Group points add up to ${sum}, not 100` });
    }
  }
  if (config.scoring?.source && !(await has(config.scoring.source))) {
    out.push({ level: 'error', category: 'tests', file: 'problem.toml', message: `Scoring program not found: ${config.scoring.source}` });
  }
  return out;
}
