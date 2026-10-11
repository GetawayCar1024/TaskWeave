import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_TESTSET,
  checkText,
  lintStatement,
  parseIndexList,
  statementLanguages,
  STD_PREFIX,
  testsetsOf,
  type CheckCode,
  type CheckParams,
  type LocalCheck,
} from '@polyforge/shared';
import { exists, safeJoin } from '../util/fs.js';
import type { Judge, ProblemCtx } from './index.js';
import { readManifest } from './tests.js';

/**
 * Deterministic checks that need no AI: missing parts, statement/tutorial language
 * mismatch, statement lint, test generation errors, groups. Shown in the UI and given
 * to the AI check as a starting point.
 */
export async function localChecks(_judge: Judge, ctx: ProblemCtx): Promise<LocalCheck[]> {
  const { config, ref } = ctx;
  const out: LocalCheck[] = [];
  const add = (level: LocalCheck['level'], category: LocalCheck['category'], code: CheckCode, params: CheckParams = {}, extra: { file?: string; line?: number } = {}) =>
    out.push({ level, category, code, params, message: checkText(code, params), ...extra });
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
  if (!langs.statement.length) add('error', 'statement', 'noStatement');
  for (const lang of langs.statement) {
    for (const section of (config.problem.type === 'oi' ? ['statement'] : ['legend', 'input', 'output'])) {
      const file = `statement/${lang}/${section}.tex`;
      if (!files.some((f) => f.path === file && f.size)) add('warning', 'statement', 'missingSection', { lang, section }, { file });
    }
    if (config.problem.type !== 'oi' && config.problem.interactive && !files.some((f) => f.path === `statement/${lang}/interaction.tex` && f.size)) {
      add('warning', 'statement', 'noInteraction', { lang }, { file: `statement/${lang}/interaction.tex` });
    }
    if (!config.problem.title[lang]) add('warning', 'statement', 'noTitle', { lang }, { file: 'problem.toml' });
  }
  for (const lang of langs.missingTutorial) add('warning', 'tutorial', 'missingTutorial', { lang }, { file: `statement/${lang}/tutorial.tex` });
  for (const lang of langs.orphanTutorial) add('warning', 'tutorial', 'orphanTutorial', { lang }, { file: `statement/${lang}/tutorial.tex` });
  for (const f of files) {
    if (!f.size) continue;
    const { issues } = lintStatement(f.text, { lang: f.path.split('/')[1] });
    if (!issues.length) continue;
    const rules = [...new Set(issues.map((i) => i.rule))].join(', ');
    const fixable = issues.every((i) => i.fixable);
    add(fixable ? 'info' : 'warning', f.path.endsWith('/tutorial.tex') ? 'tutorial' : 'statement', fixable ? 'formattingFixable' : 'formatting', { n: issues.length, rules }, { file: f.path, line: issues[0].line });
  }

  // ---- programs ----
  if (!config.validator || !(await has(config.validator.source))) add('error', 'validator', 'noValidator');
  if (!config.checker || !(await has(config.checker.source))) add('error', 'checker', 'noChecker');
  if (config.problem.type !== 'oi' && config.problem.interactive && (!config.interactor || !(await has(config.interactor.source)))) add('error', 'interactor', 'noInteractor');
  const ma = config.solutions.filter((s) => s.tag === 'MA');
  if (ma.length !== 1) add('error', 'solutions', ma.length ? 'severalMain' : 'noMain', {}, { file: 'problem.toml' });
  for (const s of config.solutions) if (!(await has(s.source))) add('error', 'solutions', 'solutionMissing', { file: s.source }, { file: 'problem.toml' });
  if (config.solutions.length < 2) add('info', 'solutions', 'oneSolution');

  // ---- tests ----
  const manual = (await fsp.readdir(path.join(ref.dir, 'tests', 'manual')).catch(() => [] as string[])).length;
  if (!manual && !(config.tests.script && (await has(config.tests.script)))) add('error', 'tests', 'noTests');
  if (!parseIndexList(config.tests.samples ?? '').length) add('warning', 'tests', 'noSamples', {}, { file: 'problem.toml' });
  const vt = (await fsp.readdir(path.join(ref.dir, 'validator-tests')).catch(() => [] as string[])).filter((f) => !f.startsWith('.'));
  if (!vt.length) add('info', 'validator', 'noValidatorTests');
  const m = await readManifest(ctx);
  if (m) for (const error of m.errors.slice(0, 10)) add('error', 'tests', 'generation', { error });

  // ---- testsets and groups (subtasks) ----
  for (const ts of testsetsOf(config)) {
    const where = ts.name === DEFAULT_TESTSET ? '' : ` (${ts.name})`;
    const file = { file: 'problem.toml' };
    if (ts.name !== DEFAULT_TESTSET) {
      const own = (await fsp.readdir(safeJoin(ref.dir, ts.manual)).catch(() => [] as string[])).length;
      if (!own && !(ts.script && (await has(ts.script)))) add('warning', 'tests', 'testsetEmpty', { testset: ts.name }, file);
    }
    if (!ts.groups) continue;
    if (!ts.group.length) {
      add('warning', 'tests', 'groupsUndefined', { where }, file);
      continue;
    }
    const tm = await readManifest(ctx, ts.name);
    if (tm) {
      const all = new Set(tm.tests.map((t) => t.index));
      const loose = tm.tests.filter((t) => !t.group).map((t) => t.index);
      if (loose.length) add('warning', 'tests', 'looseTests', { where, list: loose.slice(0, 20).join(', ') }, file);
      for (const g of ts.group) {
        const idx = parseIndexList(g.tests ?? '');
        if (!idx.length) add('warning', 'tests', 'groupEmpty', { group: g.name, where }, file);
        const missing = idx.filter((i) => !all.has(i));
        if (missing.length) add('error', 'tests', 'groupMissingTests', { group: g.name, where, list: missing.slice(0, 10).join(', ') }, file);
      }
    }
    if (config.tests.points && ts.name === DEFAULT_TESTSET) {
      const noPoints = ts.group.filter((g) => g.points === undefined).map((g) => g.name);
      if (noPoints.length) add('warning', 'tests', 'groupsWithoutPoints', { list: noPoints.join(', ') }, file);
      const sum = ts.group.reduce((a, g) => a + (g.points ?? 0), 0);
      if (sum !== 100) add('info', 'tests', 'pointsSum', { sum }, file);
    }
  }
  return out;
}
