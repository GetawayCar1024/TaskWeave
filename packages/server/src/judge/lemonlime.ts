import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DEFAULT_TESTSET, groupLayout, groupTotal, judgeMode, LEMON_COMPARISON_MODES, parseIndexList, PROBLEM_NAME_RE, testsetOf, testsetsOf, testLimitLookup, type ProblemToml, type TestGroup } from '@taskweave/shared';
import type { JobCtx } from '../jobs.js';
import { exists, HttpError, safeJoin, toPosix } from '../util/fs.js';
import type { ZipWriter } from '../util/zip.js';
import { checkGroups } from '../workspace/problems.js';
import { verifyBuild, withBuildLocks } from './buildLock.js';
import { pickLanguage, type Program } from './compiler.js';
import type { Judge, ProblemCtx } from './index.js';
import { answerPath, generateTests, inputPath } from './tests.js';

/** LemonLime JSON CDF v1.0, verified against upstream 9f2386849ae2d972431bcc738ce465e648756ad8:
 * core/{contest,task,testcase}.cpp. All paths are relative to data/, never the host workspace. */
export interface LemonTestCase {
  fullScore: number; timeLimit: number; memoryLimit: number; inputFiles: string[]; outputFiles: string[];
}
const fail = (message: string): never => { throw new HttpError(400, 'lemonlime_export', message); };
export type LemonTarget = 'windows' | 'linux';
export const lemonHost = (): LemonTarget => process.platform === 'win32' ? 'windows' : 'linux';
export interface LemonCheckerBuild { source: string; include: string; output: string; standard: string }

/** `total` split into `n` integers adding up exactly (the last ones get one more). */
export function splitScore(total: number, n: number): number[] {
  const each = Math.floor(total / n), extra = total - each * n;
  return Array.from({ length: n }, (_, i) => each + (i >= n - extra ? 1 : 0));
}

/** Data file stem of a test: "tests" keeps the plain index, other testsets are prefixed. */
export const testFileStem = (testset: string, index: number) => (testset === DEFAULT_TESTSET ? `${index}` : `${testset}-${index}`);

/**
 * Test cases of one testset. `offset` is the number of test cases before it (dependency
 * flags refer to 1-based test case numbers of the whole task).
 */
export function lemonTestCases(config: ProblemToml, indices: number[], folder: string, testset = DEFAULT_TESTSET, offset = 0): LemonTestCase[] {
  const ts = testsetOf(config, testset);
  if (!ts) return fail(`Unknown testset: ${testset}`);
  const where = testset === DEFAULT_TESTSET ? '' : `${testset}: `;
  const available = new Set(indices);
  const result: LemonTestCase[] = [];
  const limits = testLimitLookup(config, ts);
  const make = (tests: number[], score: number, dependencies: number[] = [], group?: TestGroup) => {
    if (!Number.isSafeInteger(score) || score < 0 || score > 2147483647) fail('LemonLime requires nonnegative integer scores (up to 2147483647).');
    const { timeLimit, memoryLimit } = limits(tests[0], group);
    if (![timeLimit, memoryLimit].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647)) fail(`${where}LemonLime requires integer time (ms) and memory (MiB), from 1 to 2147483647.`);
    if (tests.some(i => limits(i, group).timeLimit !== timeLimit || limits(i, group).memoryLimit !== memoryLimit)) fail(`${where}LemonLime bundled tests must use the same time and memory limits.`);
    result.push({ fullScore: score, timeLimit, memoryLimit,
      inputFiles: [...tests.map(i => `${folder}/${testFileStem(testset, i)}.in`), ...dependencies.map(i => `${i}_lemon_SUbtaskDEPENDENCE_fLAg`)],
      outputFiles: tests.map(i => `${folder}/${testFileStem(testset, i)}.ans`) });
  };
  if (!indices.length) fail(`${where}No tests to export.`);
  if (!ts.groups) {
    if (config.tests.points) fail(`${where}Points are enabled but there are no subtasks. Configure subtask scores before exporting.`);
    const scores = splitScore(100, indices.length);
    indices.forEach((index, i) => make([index], scores[i]));
    return result;
  }
  if (!config.tests.points) fail(`${where}Subtasks are enabled without scores. Enable points and set each subtask score before exporting.`);
  const groups = checkGroups(testset, ts.group);
  const layout = groupLayout(ts, true);
  if (indices.some(i => !layout.mapping[i])) fail(`${where}Some tests do not belong to a subtask. Assign all tests before exporting.`);
  const byName = new Map(groups.map(g => [g.name, g]));
  const exported = new Map<string, number[]>();
  // Dependencies are listed transitively, so the order and Lemon's own propagation do not matter.
  const closure = (name: string, seen = new Set<string>()): Set<string> => {
    for (const d of byName.get(name)?.dependencies ?? []) if (!seen.has(d)) { seen.add(d); closure(d, seen); }
    return seen;
  };
  const addGroup = (name: string) => {
    if (exported.has(name)) return;
    const g = byName.get(name)!;
    for (const dep of g.dependencies ?? []) addGroup(dep);
    const tests = [...new Set(parseIndexList(g.tests ?? ''))].sort((a,b) => a-b);
    if (!tests.length || tests.some(i => !available.has(i))) fail(`${where}Subtask ${name} is empty or refers to missing tests.`);
    const total = groupTotal(g);
    if (total === undefined) fail(`${where}Subtask ${name} has no score.`);
    if (!Number.isSafeInteger(total)) fail(`${where}Subtask ${name}: LemonLime requires integer scores.`);
    const deps = [...closure(name)].flatMap(d => exported.get(d)!).sort((a, b) => a - b);
    const first = result.length;
    if (g.policy === 'EACH_TEST') tests.forEach(i => make([i], layout.byGroup[g.name][i] ?? 0, deps, g));
    else make(tests, g.points!, deps, g);
    exported.set(name, Array.from({length: result.length - first}, (_, i) => offset + first + i + 1));
  };
  for (const g of groups) addGroup(g.name);
  return result;
}

/** Native modes need no checker binary; custom Lemon sources are validated before generation. */
export async function preflightLemonChecker(judge: Judge, ctx: ProblemCtx, index: string, target = lemonHost()) {
  const { config } = ctx;
  const p = config.problem;
  if (p.unresolved_judge) fail(`${index}: ${p.unresolved_judge}`);
  if (!PROBLEM_NAME_RE.test(p.name) || !/^[A-Z][A-Z0-9]{0,3}$/.test(index)) fail('Invalid problem name or contest index.');
  const mode = judgeMode(p);
  if (mode === 'io') fail(`${index}: LemonLime export does not support pipe-based I/O interactive problems.`);
  for (const [file, standard] of [[p.input, 'stdin'], [p.output, 'stdout']]) {
    if (file && file !== standard && (!/^[\w.-]+$/.test(file) || file === '.' || file === '..')) fail(`${index}: input/output file names must be simple file names for LemonLime.`);
  }
  const source = config.lemon_checker?.source;
  if (config.lemon_comparison || !source) return null;
  const resolved = judge.compiler.resolveSource(ctx.ref.dir, source!).srcPath;
  if (!/\.(cpp|cc|cxx)$/i.test(resolved) || !await exists(resolved)) fail(`${index}: Lemon checker must be an existing C++ source for g++.`);
  if (target === 'windows' ? process.platform !== 'win32' : process.platform !== 'linux') return null;
  const compiled = p.data_only
    ? await judge.compiler.compile(ctx.ref.dir, source!, judge.langOf(config, source!), ctx.buildRoot)
    : await judge.compile(ctx, source!, false);
  if (!compiled.program) fail(`${index}: Lemon checker compilation failed.\n${compiled.result.log}`);
  const checker = compiled.program!;
  if (checker.argv.length !== 1 || !checker.build) fail(`${index}: LemonLime requires a compiled native checker executable.`);
  return checker;
}

async function checkLemonProtocol(judge: Judge, ctx: ProblemCtx, checker: Program, test: number, index: string, job: JobCtx, testset = DEFAULT_TESTSET) {
  await fs.mkdir(ctx.work, { recursive: true });
  const dir = await fs.mkdtemp(path.join(ctx.work, 'lemon-check-'));
  try {
    // Protect the original data from checker side effects and use a fresh score path for every run.
    const input = path.join(dir, 'input'), output = path.join(dir, 'output'), answer = path.join(dir, 'answer');
    await fs.copyFile(inputPath(ctx, test, testset), input);
    await fs.copyFile(answerPath(ctx, test, testset), output);
    await fs.copyFile(answerPath(ctx, test, testset), answer);
    const score = path.join(dir, 'score'), message = path.join(dir, 'message');
    const testlib = ctx.config.lemon_checker?.protocol === 'testlib';
    const stats = await judge.runner.run({ argv: [...checker.argv, input, output, answer, ...(testlib ? [] : ['100', score, message])], build: checker.build,
      cwd: dir, stdout: path.join(dir, 'stdout'), stderr: path.join(dir, 'stderr'), timeLimitMs: 10000, wallLimitMs: 15000,
      memoryLimitBytes: 512 * 1024 * 1024, outputLimitBytes: 1024 * 1024 }, job.signal);
    if (testlib) {
      const report = (await fs.readFile(path.join(dir, 'stderr'), 'utf8').catch(() => '')).slice(0, 2000).trim();
      const full = /^ok(?:\s|$)/i.test(report) || /^points\s+1(?:\.0+)?(?:\s|$)/i.test(report) || /^partially correct \(100\)/i.test(report);
      if (!['OK', 'RE'].includes(stats.status) || !full) fail(`${index}: Lemon Testlib checker protocol check failed on test ${test}; the standard answer must receive full score.\n${report}`);
      return;
    }
    const value = (await fs.readFile(score, 'utf8').catch(() => '')).trim();
    if (stats.status !== 'OK' || stats.exitCode !== 0 || !/^100(?:\.0+)?$/.test(value)) {
      const report = (await fs.readFile(message, 'utf8').catch(() => '')).slice(0, 2000);
      fail(`${index}: Lemon checker protocol check failed on test ${test}. Use Testlib for Lemons and registerLemonChecker(argc, argv); the standard answer must receive full score in the score file.\n${report}`);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

/** Preserve source-relative includes and put global headers under shared/ for rebuilding. */
async function addCheckerSources(judge: Judge, ctx: ProblemCtx, checker: Pick<Program, 'srcPath'>, folder: string, zip: ZipWriter) {
  const seen = new Set<string>();
  const problemDir = await fs.realpath(ctx.ref.dir), sharedDir = await fs.realpath(judge.global.sharedDir);
  const add = async (file: string): Promise<void> => {
    file = await fs.realpath(file);
    if (seen.has(file)) return;
    seen.add(file);
    const local = path.relative(problemDir, file), shared = path.relative(sharedDir, file);
    const inside = (rel: string) => !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`);
    const rel = inside(local) ? `problem/${toPosix(local)}` : inside(shared) ? `shared/${toPosix(shared)}` : fail('Lemon checker includes a file outside the problem and shared directories.');
    const bytes = await fs.readFile(file);
    zip.add(`data/${folder}/checker-sources/${rel}`, bytes);
    for (const m of bytes.toString('utf8').matchAll(/^\s*#\s*include\s*(["<])([^">\r\n]+)[">]/gm)) {
      let found = false;
      for (const base of [...(m[1] === '"' ? [path.dirname(file)] : []), judge.global.sharedDir]) {
        const candidate = path.resolve(base, m[2]);
        if (await exists(candidate)) { await add(candidate); found = true; break; }
      }
      if (!found && m[1] === '"') fail(`Cannot package Lemon checker dependency: ${m[2]}`);
    }
  };
  const sourcePath = await fs.realpath(checker.srcPath);
  const source = withinSource(problemDir, sourcePath) ? `problem/${toPosix(path.relative(problemDir, sourcePath))}` : `shared/${toPosix(path.relative(sharedDir, sourcePath))}`;
  await add(sourcePath);
  await add(path.join(sharedDir, 'lemon/testlib.h'));
  for (const file of ['LICENSE', 'README.md']) zip.add(`data/${folder}/checker-sources/shared/lemon/${file}`, await fs.readFile(path.join(judge.global.sharedDir, 'lemon', file)));
  return `data/${folder}/checker-sources/${source}`;
}
const withinSource = (root: string, file: string) => { const rel = path.relative(root, file); return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep); };

/** Selected testsets of a problem ("tests" by default), generated and in problem.toml order. */
export function exportTestsets(ctx: ProblemCtx, index: string, wanted?: string[]): string[] {
  if (ctx.config.problem.unresolved_judge) fail(`${index}: ${ctx.config.problem.unresolved_judge}`);
  const all = testsetsOf(ctx.config).map(ts => ts.name);
  const list = wanted?.length ? wanted : [DEFAULT_TESTSET];
  for (const name of list) if (!all.includes(name)) fail(`${index}: unknown testset ${name}.`);
  return all.filter(name => list.includes(name));
}

export async function exportedTests(judge: Judge, ctx: ProblemCtx, testsets: string[], index: string, job: JobCtx) {
  if (ctx.config.problem.unresolved_judge) fail(`${index}: ${ctx.config.problem.unresolved_judge}`);
  const out: { name: string; tests: number[] }[] = [];
  for (const name of testsets) {
    if (testsetOf(ctx.config, name)?.unresolvedScoring) fail(`${index}: imported scoring is not representable. Edit the subtask configuration before exporting.`);
    const manifest = await generateTests(judge, ctx, job, name);
    if (!manifest.ok) fail(`${index}: test generation failed${name === DEFAULT_TESTSET ? '' : ` (${name})`}.\n${manifest.errors.join('\n')}`);
    if (!manifest.tests.length) fail(`${index}: ${name === DEFAULT_TESTSET ? '' : `${name}: `}No tests to export.`);
    out.push({ name, tests: manifest.tests.map(t => t.index) });
  }
  return out;
}

export async function addLemonProblem(judge: Judge, ctx: ProblemCtx, index: string, zip: ZipWriter, job: JobCtx, testsets = [DEFAULT_TESTSET], subfolders = false, target = lemonHost()) {
  const { config } = ctx, p = config.problem, mode = judgeMode(p);
  const checker = await preflightLemonChecker(judge, ctx, index, target);
  const checkerSource = config.lemon_comparison ? undefined : config.lemon_checker?.source;
  const hasChecker = !!checkerSource;
  const folder = p.name;
  const testCases: LemonTestCase[] = [];
  let count = 0;
  for (const { name, tests } of await exportedTests(judge, ctx, testsets, index, job)) {
    testCases.push(...lemonTestCases(config, tests, folder, name, testCases.length));
    if (!count && checker) await checkLemonProtocol(judge, ctx, checker, tests[0], index, job, name);
    count += tests.length;
    for (const test of tests) {
      job.signal.throwIfAborted();
      for (const [extension, file] of [['in', inputPath(ctx, test, name)], ['ans', answerPath(ctx, test, name)]]) {
        const bytes = await fs.readFile(file).catch(() => fail(`${index}: missing ${extension} for test ${test}${name === DEFAULT_TESTSET ? '' : ` (${name})`}.`));
        zip.add(`data/${folder}/${testFileStem(name, test)}.${extension}`, bytes);
      }
    }
  }
  const checkerName = `${folder}/checker${target === 'windows' ? '.exe' : ''}`;
  let checkerBuild: LemonCheckerBuild | undefined;
  if (checker) {
    await withBuildLocks([checker.build!.dir], async () => {
      await verifyBuild(checker.build);
      zip.add(`data/${checkerName}`, await fs.readFile(checker.argv[0]), true);
    }, 'read');
  }
  if (checkerSource) {
    const srcPath = judge.compiler.resolveSource(ctx.ref.dir, checkerSource).srcPath;
    const source = await addCheckerSources(judge, ctx, { srcPath }, folder, zip);
    const command = pickLanguage((await judge.global.readLanguages()).languages, srcPath, judge.langOf(config, checkerSource))?.lang.compile ?? '';
    const standard = command.match(/-std=((?:gnu|c)\+\+(?:98|03|11|14|17|20|23|26|2a|2b|2c))\b/)?.[1] ?? 'c++17';
    checkerBuild = { source, include: `data/${folder}/checker-sources`, output: `data/${folder}/checker`, standard };
  }
  const main = judge.mainSolution(config) ?? `${p.name}.cpp`;
  const compile = pickLanguage((await judge.global.readLanguages()).languages, main, judge.langOf(config, main))?.lang.compile ?? '';
  const standard = compile.match(/-std=(?:c|gnu)\+\+(98|03|11|14|17|20)\b/)?.[1];
  const optimization = compile.match(/(?:^|\s)-O([23])(?:\s|$)/)?.[1];
  const cppConfiguration = standard ? `C++${standard}${optimization ? ` O${optimization}` : ''}` : 'default';
  const task = {
    problemTitle: `${index}. ${p.title.zh || p.title.en || p.name}`, sourceFileName: p.name,
    inputFileName: p.input === 'stdin' ? `${p.name}.in` : p.input,
    outputFileName: p.output === 'stdout' ? `${p.name}.out` : p.output,
    standardInputCheck: !p.input || p.input === 'stdin', standardOutputCheck: !p.output || p.output === 'stdout',
    taskType: mode === 'grader' ? 3 : 0, subFolderCheck: subfolders,
    comparisonMode: config.lemon_comparison ? LEMON_COMPARISON_MODES[config.lemon_comparison.mode] : hasChecker ? (config.lemon_checker?.protocol === 'testlib' ? 5 : 4) : 1, diffArguments: '--ignore-space-change --text --brief', realPrecision: config.lemon_comparison?.precision ?? 3,
    specialJudge: hasChecker ? checkerName : '', compilerConfiguration: { 'g++': cppConfiguration }, answerFileExtension: 'ans', testCases,
    ...(mode === 'grader' ? { sourceFilesPath: [`${p.name}.cpp`], sourceFilesName: [`${p.name}.cpp`], graderFilesPath: [] as string[], graderFilesName: [] as string[] } : {}),
  };
  if (mode === 'grader') {
    if (!config.grader?.sources.length) fail(`${index}: grader sources are not configured.`);
    const names = new Set([`${p.name}.cpp`.toLowerCase()]);
    for (const file of [...config.grader!.sources, ...config.grader!.headers]) {
      const name = path.basename(file);
      if (names.has(name.toLowerCase())) fail(`${index}: grader file name collision: ${name}.`);
      names.add(name.toLowerCase());
      const target = `${folder}/grader/${name}`;
      zip.add(`data/${target}`, await fs.readFile(safeJoin(ctx.ref.dir, file)));
      task.graderFilesPath!.push(target); task.graderFilesName!.push(name);
    }
    // CDF Communication copies grader files to a single working directory.
    // Refuse nested include paths that would break after that flattening.
    for (const file of [...config.grader!.sources, ...config.grader!.headers]) {
      const text = await fs.readFile(safeJoin(ctx.ref.dir, file), 'utf8');
      for (const m of text.matchAll(/^\s*#\s*include\s*"([^"\r\n]+)"/gm)) {
        if (!names.has(m[1].toLowerCase()) || /[\\/]/.test(m[1])) fail(`${index}: grader include "${m[1]}" must name a supplied header without directories for LemonLime.`);
      }
    }
  }
  return { task, tests: count, checkerBuild };
}

/** Both scripts work from any current directory, quote paths and preserve a previous build on errors. */
export function addLemonBuildScripts(zip: ZipWriter, builds: LemonCheckerBuild[]) {
  const sh = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
  const cmd = (value: string) => '"' + value.replace(/\//g, '\\').replace(/%/g, '%%') + '"';
  const windows = ['@echo off', 'setlocal DisableDelayedExpansion', 'chcp 65001 >nul', 'cd /d "%~dp0"'];
  const linux = ['#!/usr/bin/env bash', 'set -euo pipefail', 'cd -- "$(dirname -- "${BASH_SOURCE[0]}")"'];
  if (builds.length) {
    windows.push('where g++ >nul 2>nul', 'if errorlevel 1 (echo g++ was not found on PATH. & exit /b 1)');
    linux.push('command -v g++ >/dev/null || { echo "g++ was not found on PATH." >&2; exit 1; }');
  }
  for (const build of builds) {
    windows.push(`g++ -std=${build.standard} -O2 -DONLINE_JUDGE -static -s -I${cmd(build.include + '/shared')} -I${cmd(build.include + '/problem')} ${cmd(build.source)} -o ${cmd(build.output + '.pf-build.exe')}`,
      'if errorlevel 1 exit /b 1', `move /y ${cmd(build.output + '.pf-build.exe')} ${cmd(build.output + '.exe')} >nul`, 'if errorlevel 1 exit /b 1');
    linux.push(`g++ -std=${build.standard} -O2 -DONLINE_JUDGE -I${sh(build.include + '/shared')} -I${sh(build.include + '/problem')} ${sh(build.source)} -o ${sh(build.output + '.pf-build')}`,
      `mv -f -- ${sh(build.output + '.pf-build')} ${sh(build.output)}`);
  }
  windows.push(`echo Built ${builds.length} checker(s).`, 'exit /b 0'); linux.push(`echo 'Built ${builds.length} checker(s).'`);
  zip.add('compile-checkers.cmd', windows.join('\r\n') + '\r\n');
  zip.add('compile-checkers.sh', linux.join('\n') + '\n', true);
}

export const lemonReadme = (platform: string, subfolders = false) => `LemonLime contest package

Open the .cdf file in LemonLime (JSON CDF version 1.0).
Contestants: source/<contestant>/${subfolders ? '<problem>/' : ''}<problem>.cpp
Search subfolders for contestant code: ${subfolders ? 'enabled' : 'disabled'}.
Inputs, answers, checkers and supplied grader files are in data/.
Each selected testset keeps its own subtasks. Bundled entries take the minimum; sum entries carry per-test points.
CDF limits are milliseconds and MiB. Shared inputs can be used by several entries with independent limits.
Target system: ${platform}. CDF specialJudge uses the actual relative executable path: checker.exe on Windows, checker on Linux.
Native comparison modes 0/1/3 run inside LemonLime and use an empty specialJudge path.
For custom checkers, install g++ and add it to PATH, then compile them from the archive root:
  Windows (PowerShell or cmd): .\\compile-checkers.cmd
  Linux: bash ./compile-checkers.sh
Both scripts include the supplied Testlib for Lemons and local headers. No download is needed.
Run the script matching the selected target before judging; cross-system exports contain sources rather than a wrongly labelled host executable.
To change the target system, export again with the other target so the CDF paths also match.
Preserve the included source/header licenses. The executable uses the selected target's native g++ environment.
Grader problems use LemonLime Communication mode. Configure the C++ compiler in LemonLime.
`;
