/// <reference path="../types/turndown-plugin-gfm.d.ts" />
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { stringify as yaml } from 'yaml';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { flattenFiles, groupLayout, groupTotal, judgeMode, parseIndexList, PROBLEM_NAME_RE, testsetOf, testsetsOf, testLimitLookup, type ProblemToml, type TestGroup } from '@polyforge/shared';
import { buildMacros, renderLatex, type DefsToml } from '../../../web/src/lib/latex.js';
import { parseDefsToml, readSharedDefs } from '../defs.js';
import type { JobCtx } from '../jobs.js';
import { exists, HttpError, safeJoin, toPosix } from '../util/fs.js';
import { ZipWriter } from '../util/zip.js';
import { buildTree } from '../workspace/files.js';
import { checkGroups } from '../workspace/problems.js';
import { readStatementSections } from '../workspace/statements.js';
import type { Judge, ProblemCtx } from './index.js';
import { exportedTests, splitScore, testFileStem } from './lemonlime.js';
import { readSamples } from './samples.js';
import { answerPath, generateTests, inputPath } from './tests.js';

const fail = (message: string): never => { throw new HttpError(400, 'hydro_export', message); };
interface HydroCase { input: string; output: string; score: number; time: string; memory: string }
interface HydroSubtask { id: number; type: 'min' | 'sum'; score: number; if: number[]; cases: HydroCase[] }

/** Explicit Hydro cases avoid its filename-based regrouping. Dependencies precede their users. */
export function hydroSubtasks(config: ProblemToml, sets: { name: string; tests: number[] }[]): HydroSubtask[] {
  const out: HydroSubtask[] = [];
  for (const set of sets) {
    const ts = testsetOf(config, set.name)!;
    const tests = [...set.tests].sort((a, b) => a - b);
    if (!tests.length) fail(`${set.name}: No tests to export.`);
    const points = !!config.tests.points;
    const layout = groupLayout(ts, points);
    const limits = testLimitLookup(config, ts);
    const groups: TestGroup[] = points && ts.groups ? checkGroups(set.name, ts.group) : [
      { name: 'all', tests: tests.join(','), policy: 'EACH_TEST', points: 100 },
    ];
    const shares = splitScore(100, tests.length);
    const defaults = new Map(tests.map((index, i) => [index, shares[i]]));
    if (points && ts.groups) {
      const loose = tests.filter(i => !layout.mapping[i]);
      let looseName = '__ungrouped';
      while (groups.some(g => g.name === looseName)) looseName += '_';
      if (loose.length) groups.push({ name: looseName, tests: loose.join(','), policy: 'EACH_TEST', points: 0 });
    }
    const byName = new Map(groups.map(g => [g.name, g]));
    const ids = new Map<string, number>();
    const add = (name: string) => {
      if (ids.has(name)) return;
      const group = byName.get(name) ?? fail(`Unknown subtask dependency: ${name}`);
      for (const dependency of group.dependencies ?? []) add(dependency);
      const indices = [...new Set(parseIndexList(group.tests ?? ''))].sort((a, b) => a - b);
      if (!indices.length || indices.some(i => !tests.includes(i))) fail(`${set.name}: Subtask ${name} is empty or refers to missing tests.`);
      const score = groupTotal(group) ?? fail(`${set.name}: Subtask ${name} has no score.`);
      if (!Number.isSafeInteger(score) || score < 0) fail(`${set.name}/${name}: Hydro requires nonnegative integer scores.`);
      const type = group.policy === 'EACH_TEST' ? 'sum' : 'min';
      const id = out.length + 1;
      ids.set(name, id);
      out.push({ id, type, score, if: (group.dependencies ?? []).map(d => ids.get(d)!), cases: indices.map(index => {
        const limit = limits(index, group);
        if (!Number.isSafeInteger(limit.memoryLimit)) fail(`${set.name}/${name}: Hydro rounds memory to whole MiB. Choose a whole-MiB limit before exporting.`);
        const pointsPerTest = type === 'min' ? score : points && ts.groups ? layout.byGroup[group.name]?.[index] ?? 0 : defaults.get(index)!;
        if (!Number.isSafeInteger(pointsPerTest)) fail(`${set.name}/${name}: Hydro requires integer per-test scores.`);
        return { input: `${testFileStem(set.name, index)}.in`, output: `${testFileStem(set.name, index)}.ans`,
          score: pointsPerTest, time: `${limit.timeLimit}ms`, memory: `${limit.memoryLimit}m` };
      }) });
    };
    for (const group of groups) add(group.name);
  }
  // Hydro replaces falsy scores with the remaining share of 100. Never silently turn zero into points.
  if (out.some(s => s.score === 0) && out.reduce((sum, s) => sum + s.score, 0) < 100) fail('Hydro would replace zero subtask scores with default points. Adjust the scoring or selected testsets before exporting.');
  for (const s of out) if (s.type === 'sum' && s.cases.some(c => c.score === 0) && s.cases.reduce((sum, c) => sum + c.score, 0) < s.score) fail('Hydro would replace zero case scores with default points. Adjust the subtask scores before exporting.');
  return out;
}

const fence = (text: string, lang = '') => {
  const marker = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1)));
  return `${marker}${lang}\n${text.replace(/\r\n/g, '\n').replace(/\n$/, '')}\n${marker}`;
};

/** Render the same TeX/Markdown dialect as the editor, retaining math as source for Hydro. */
export function hydroMarkdown(source: string, defs: DefsToml, lang: string, asset: (name: string) => string) {
  const rendered = renderLatex(source, { macros: buildMacros(defs, lang), imageUrl: asset });
  const converter = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  converter.use(gfm);
  converter.addRule('math', {
    filter: node => /(?:^|\s)(?:katex|katex-display|math-display)(?:\s|$)/.test(node.className ?? '') && !!node.querySelector('annotation'),
    replacement: (_content, node) => {
      const tex = node.querySelector('annotation')!.textContent ?? '';
      return /(?:math-display|katex-display)/.test(node.className) ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`;
    },
  });
  converter.addRule('code', { filter: 'pre', replacement: (_content, node) => '\n\n' + fence(node.textContent ?? '') + '\n\n' });
  converter.addRule('merged-table', {
    filter: node => node.nodeName === 'TABLE' && !!node.querySelector('[colspan],[rowspan]'),
    replacement: (_content, node) => '\n\n' + node.outerHTML + '\n\n',
  });
  return { markdown: converter.turndown(rendered.html), warnings: rendered.unknown };
}

/** Native whole-problem archive: problem.yaml + statements + testdata + additional_file. */
export async function hydroPackage(judge: Judge, ctx: ProblemCtx, job: JobCtx, testsets: string[]) {
  const { config } = ctx, p = config.problem, mode = judgeMode(p);
  if (!PROBLEM_NAME_RE.test(p.name)) fail('Invalid problem name.');
  if (mode === 'grader') fail('Hydro communication managers and linked graders use different protocols. Convert the grader before exporting a Hydro package.');
  const warnings: string[] = [];
  const sets = await exportedTests(judge, ctx, testsets, p.name, job);
  const subtasks = hydroSubtasks(config, sets);
  const nativeCases = subtasks.flatMap(subtask => subtask.cases);
  if (nativeCases.length > 100 || nativeCases.reduce((sum, test) => sum + Number(test.time.replace(/ms$/, '')), 0) > 60000 || nativeCases.some(test => Number(test.memory.replace(/m$/, '')) > 512)) {
    warnings.push('This package exceeds Hydro default judge budgets (100 cases, 60 s total time or 512 MiB memory). These are deployment-configurable; check the target judge settings.');
  }
  const zip = new ZipWriter({ async: true });
  const used = new Set<string>();
  const outputNames = new Set(['config.yaml', 'polyforge-files.json', 'lemon-license.txt']);
  for (const set of sets) for (const index of set.tests) {
    for (const [ext, file] of [['in', inputPath(ctx, index, set.name)], ['ans', answerPath(ctx, index, set.name)]]) {
      const name = `${testFileStem(set.name, index)}.${ext}`;
      outputNames.add(name.toLowerCase()); zip.add(`testdata/${name}`, await fs.readFile(file));
    }
  }
  const all = flattenFiles(await buildTree(ctx.ref.dir));
  const allocate = (name: string, names: Set<string>) => {
    const base = path.basename(name).replace(/[^\w.-]/g, '_') || 'file';
    let chosen = base;
    for (let i = 2; names.has(chosen.toLowerCase()); i++) chosen = `${i}-${base}`;
    names.add(chosen.toLowerCase()); return chosen;
  };
  const sourceNames = new Map<string, string>();
  const project = await fs.realpath(ctx.ref.dir), shared = await fs.realpath(judge.global.sharedDir);
  const within = (root: string, file: string) => { const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
  const addSource = async (file: string): Promise<string> => {
    const abs = await fs.realpath(file);
    if (!within(project, abs) && !within(shared, abs)) return fail('A Hydro source dependency is outside the problem and shared directories.');
    const previous = sourceNames.get(abs); if (previous) return previous;
    const name = allocate(path.basename(file), outputNames); sourceNames.set(abs, name);
    if (within(project, abs)) used.add(toPosix(path.relative(project, abs)));
    let text = await fs.readFile(abs, 'utf8');
    // Quoted local includes are flattened with their files, preserving relative dependencies.
    const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|R"([^ ()\\\t\r\n]{0,16})\([\s\S]*?\)\1"|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g, s => s.replace(/[^\r\n]/g, ' '));
    for (const include of [...text.matchAll(/^\s*#\s*include\s*"([^"\r\n]+)"/gm)].reverse()) {
      if (!code.slice(include.index, include.index! + include[0].length).includes('#')) continue;
      const local = path.resolve(path.dirname(abs), include[1]);
      if (include[1] === 'testlib.h' && !await exists(local)) continue; // Hydro provides its Testlib header.
      const dependency = await exists(local) ? local : path.resolve(shared, include[1]);
      if (!await exists(dependency)) fail(`Missing source dependency: ${include[1]}`);
      const dependencyName = await addSource(dependency);
      text = text.slice(0, include.index) + include[0].replace(`"${include[1]}"`, `"${dependencyName}"`) + text.slice(include.index! + include[0].length);
    }
    zip.add(`testdata/${name}`, text); return name;
  };
  const dataConfig: Record<string, unknown> = { type: mode === 'io' ? 'interactive' : 'default', time: `${p.time_limit}ms`, memory: `${p.memory_limit}m`, checker_type: 'default', subtasks };
  if (config.checker?.source.startsWith('std:')) { dataConfig.checker_type = 'testlib'; dataConfig.checker = config.checker.source.slice(4); }
  else if (config.checker) { dataConfig.checker_type = 'testlib'; dataConfig.checker = await addSource(safeJoin(ctx.ref.dir, config.checker.source)); }
  else if (config.lemon_checker) { dataConfig.checker_type = 'lemon'; dataConfig.checker = await addSource(safeJoin(ctx.ref.dir, config.lemon_checker.source)); }
  if (config.validator) dataConfig.validator = await addSource(judge.compiler.resolveSource(ctx.ref.dir, config.validator.source).srcPath);
  if (mode === 'io') {
    if (!config.interactor) fail('Interactive problem without an interactor.');
    dataConfig.interactor = await addSource(safeJoin(ctx.ref.dir, config.interactor!.source));
    warnings.push('Hydro interactive packages require the interactor to decide the verdict. Verify its protocol before judging.');
  }
  if (p.input !== 'stdin' || p.output !== 'stdout') {
    const name = p.input.replace(/\.in$/, '');
    if (p.input !== `${name}.in` || p.output !== `${name}.out` || /[\\/]/.test(name)) fail('Hydro file I/O requires matching <name>.in and <name>.out filenames.');
    dataConfig.filename = name;
  }
  const extraJudgeFiles = [...sourceNames.values()].filter(name => ![dataConfig.checker, dataConfig.validator, dataConfig.interactor].includes(name));
  if (extraJudgeFiles.length) dataConfig.judge_extra_files = extraJudgeFiles;
  if ([...sourceNames.keys()].some(file => within(path.join(shared, 'lemon'), file))) zip.add('testdata/lemon-LICENSE.txt', await fs.readFile(path.join(shared, 'lemon/LICENSE')));
  zip.add('testdata/config.yaml', yaml(dataConfig));

  const publicNames = new Set<string>(), assets = new Map<string, string>();
  for (const file of all.filter(f => f.path.startsWith('statement/images/') || f.path.startsWith('attachments/'))) {
    const name = allocate(file.name, publicNames);
    zip.add(`additional_file/${name}`, await fs.readFile(safeJoin(ctx.ref.dir, file.path))); used.add(file.path);
    const relative = file.path.replace(/^(statement\/images|attachments)\//, '');
    assets.set(relative, name);
  }
  const asset = (name: string) => {
    if (/^https?:\/\//i.test(name)) return name;
    const rel = name.replace(/^file:\/\//, '').replace(/^statement\/images\//, '').replace(/^\.\//, '');
    const mapped = assets.get(rel) ?? fail(`Missing statement asset: ${name}`);
    return `file://${encodeURIComponent(mapped)}`;
  };
  let defs = parseDefsToml(await readSharedDefs(judge.global.sharedDir)) as DefsToml;
  if (await exists(path.join(ctx.ref.dir, 'files/defs.toml'))) defs = { ...defs, ...parseDefsToml(await fs.readFile(path.join(ctx.ref.dir, 'files/defs.toml'), 'utf8')) as DefsToml };
  for (const ts of testsetsOf(config).filter(ts => ts.samples?.trim() && !testsets.includes(ts.name))) {
    const manifest = await generateTests(judge, ctx, job, ts.name);
    if (!manifest.ok) fail(manifest.errors.join('\n'));
  }
  const languages = (await fs.readdir(path.join(ctx.ref.dir, 'statement')).catch(() => [] as string[])).filter(lang => /^[a-z]{2,8}$/.test(lang) && lang !== 'images').sort();
  const statements: { name: string; lang: string; source: string }[] = [];
  for (const lang of languages) {
    const sections = await readStatementSections(ctx.ref.dir, lang);
    const headings: Record<string, string> = lang === 'zh' ? { input: '输入格式', output: '输出格式', interaction: '交互', scoring: '评分', constraints: '数据范围', notes: '说明' } : { input: 'Input', output: 'Output', interaction: 'Interaction', scoring: 'Scoring', constraints: 'Constraints', notes: 'Notes' };
    const parts: string[] = [];
    const append = (source: string, heading = '') => {
      if (!source.trim()) return;
      const rendered = hydroMarkdown(source, defs, lang, asset);
      if (rendered.warnings.length) warnings.push(`${lang}: unsupported statement commands: ${rendered.warnings.join(', ')}`);
      parts.push((heading ? `## ${heading}\n\n` : '') + rendered.markdown);
    };
    append(sections.legend ?? '');
    for (const key of ['input', 'output', 'interaction', 'scoring', 'constraints']) append(sections[key] ?? '', headings[key]);
    for (const [i, row] of (await readSamples(ctx, true, lang)).entries()) {
      if (row.sample.large) {
        const input = allocate(row.sample.inputFile!, publicNames), output = allocate(row.sample.outputFile!, publicNames);
        zip.add(`additional_file/${input}`, row.input); zip.add(`additional_file/${output}`, row.output);
        parts.push(`## ${lang === 'zh' ? '样例' : 'Sample'} ${i + 1}\n\n[${input}](file://${input}) / [${output}](file://${output})`);
      } else parts.push(fence(row.sample.input, `input${i + 1}`), fence(row.sample.output, `output${i + 1}`));
      append(row.sample.note ?? '', lang === 'zh' ? `样例 ${i + 1} 解释` : `Explanation for sample ${i + 1}`);
    }
    append(sections.notes ?? '', headings.notes);
    if (parts.some(s => s.trim())) {
      const source = `problem_${lang}.md`;
      zip.add(source, parts.join('\n\n') + '\n'); statements.push({ name: `${lang}.md`, lang, source });
    }
    if (sections.tutorial?.trim()) { const tutorial = hydroMarkdown(sections.tutorial, defs, lang, asset); zip.add(`solution/tutorial-${lang}.md`, tutorial.markdown); }
  }
  const solutionNames = new Set(languages.map(lang => `tutorial-${lang}.md`));
  for (const solution of config.solutions) {
    const name = allocate(path.basename(solution.source), solutionNames);
    zip.add(`solution/${name}`, await fs.readFile(safeJoin(ctx.ref.dir, solution.source))); used.add(solution.source);
  }
  // Extra files are private testdata, not contestant attachments; preserve their original paths in a map.
  const extraFiles: Record<string, string> = {};
  for (const file of all) {
    if (used.has(file.path) || file.path.startsWith('tests/') && /\.(in|out|ans)$/i.test(file.path)) continue;
    const name = allocate(`extra-${file.name}`, outputNames);
    zip.add(`testdata/${name}`, await fs.readFile(safeJoin(ctx.ref.dir, file.path))); extraFiles[file.path] = name;
  }
  zip.add('testdata/polyforge-files.json', JSON.stringify(extraFiles, null, 2));
  zip.add('problem.yaml', yaml({ title: p.title.zh || p.title.en || p.name, statements, tag: [], polyforge: { name: p.name, titles: p.title } }));
  if (!statements.length) warnings.push('This Hydro package has no statement. Complete it before publishing the problem.');
  return { data: await zip.finishAsync(), tests: sets.reduce((n, set) => n + set.tests.length, 0), warnings };
}
