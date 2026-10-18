import { promises as fs } from 'node:fs';
import path from 'node:path';
import { groupLayout, judgeMode, parseIndexList, PROBLEM_NAME_RE, testsetOf, type ProblemToml } from '@polyforge/shared';
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

export function lemonTestCases(config: ProblemToml, indices: number[], folder: string): LemonTestCase[] {
  const ts = testsetOf(config)!;
  const available = new Set(indices);
  const result: LemonTestCase[] = [];
  const make = (tests: number[], score: number, dependencies: number[] = []) => {
    if (!Number.isSafeInteger(score) || score < 0 || score > 2147483647) fail('LemonLime requires nonnegative integer scores (up to 2147483647).');
    result.push({ fullScore: score, timeLimit: config.problem.time_limit, memoryLimit: config.problem.memory_limit,
      inputFiles: [...tests.map(i => `${folder}/${i}.in`), ...dependencies.map(i => `${i}_lemon_SUbtaskDEPENDENCE_fLAg`)],
      outputFiles: tests.map(i => `${folder}/${i}.ans`) });
  };
  if (!indices.length) fail('No tests to export.');
  if (!ts.groups) {
    if (config.tests.points) fail('Points are enabled but there are no subtasks. Configure subtask scores before exporting.');
    const each = Math.floor(100 / indices.length);
    indices.forEach((index, i) => make([index], each + (i === indices.length - 1 ? 100 - each * indices.length : 0)));
    return result;
  }
  if (!config.tests.points) fail('Subtasks are enabled without scores. Enable points and set each subtask score before exporting.');
  const groups = checkGroups('tests', ts.group);
  const layout = groupLayout(ts, true);
  if (indices.some(i => !layout.mapping[i])) fail('Some tests do not belong to a subtask. Assign all tests before exporting.');
  const byName = new Map(groups.map(g => [g.name, g]));
  const exported = new Map<string, number[]>();
  const addGroup = (name: string) => {
    if (exported.has(name)) return;
    const g = byName.get(name)!;
    for (const dep of g.dependencies ?? []) addGroup(dep);
    const tests = [...new Set(parseIndexList(g.tests ?? ''))].sort((a,b) => a-b);
    if (!tests.length || tests.some(i => !available.has(i))) fail(`Subtask ${name} is empty or refers to missing tests.`);
    if (g.points === undefined) fail(`Subtask ${name} has no score.`);
    if (!Number.isSafeInteger(g.points)) fail(`Subtask ${name}: LemonLime requires integer scores.`);
    const deps = (g.dependencies ?? []).flatMap(d => exported.get(d)!);
    const first = result.length;
    if (g.policy === 'EACH_TEST') tests.forEach(i => make([i], layout.points[i] ?? 0, deps));
    else make(tests, g.points!, deps);
    exported.set(name, Array.from({length: result.length - first}, (_, i) => first + i + 1));
  };
  for (const g of groups) addGroup(g.name);
  return result;
}

/** Called for every problem before starting any data generation. No fallback to the Polygon checker. */
export async function preflightLemonChecker(judge: Judge, ctx: ProblemCtx, index: string) {
  const { config } = ctx;
  const p = config.problem;
  if (!PROBLEM_NAME_RE.test(p.name) || !/^[A-Z][A-Z0-9]{0,3}$/.test(index)) fail('Invalid problem name or contest index.');
  const mode = judgeMode(p);
  if (mode === 'io') fail(`${index}: LemonLime export does not support pipe-based I/O interactive problems.`);
  for (const [file, standard] of [[p.input, 'stdin'], [p.output, 'stdout']]) {
    if (file && file !== standard && (!/^[\w.-]+$/.test(file) || file === '.' || file === '..')) fail(`${index}: input/output file names must be simple file names for LemonLime.`);
  }
  const source = config.lemon_checker?.source;
  if (!source) fail(`${index}: no Lemon checker configured. Select a Testlib for Lemons source in Information > Lemon checker.`);
  safeJoin(ctx.ref.dir, source!);
  const compiled = await judge.compile(ctx, source!, false);
  if (!compiled.program) fail(`${index}: Lemon checker compilation failed.\n${compiled.result.log}`);
  const checker = compiled.program!;
  if (checker.argv.length !== 1 || !checker.build) fail(`${index}: LemonLime requires a compiled native checker executable.`);
  return checker;
}

async function checkLemonProtocol(judge: Judge, ctx: ProblemCtx, checker: Program, test: number, index: string, job: JobCtx) {
  await fs.mkdir(ctx.work, { recursive: true });
  const dir = await fs.mkdtemp(path.join(ctx.work, 'lemon-check-'));
  try {
    // Protect the original data from checker side effects and use a fresh score path for every run.
    const input = path.join(dir, 'input'), output = path.join(dir, 'output'), answer = path.join(dir, 'answer');
    await fs.copyFile(inputPath(ctx, test), input);
    await fs.copyFile(answerPath(ctx, test), output);
    await fs.copyFile(answerPath(ctx, test), answer);
    const score = path.join(dir, 'score'), message = path.join(dir, 'message');
    const stats = await judge.runner.run({ argv: [...checker.argv, input, output, answer, '100', score, message], build: checker.build,
      cwd: dir, stdout: path.join(dir, 'stdout'), stderr: path.join(dir, 'stderr'), timeLimitMs: 10000, wallLimitMs: 15000,
      memoryLimitBytes: 512 * 1024 * 1024, outputLimitBytes: 1024 * 1024 }, job.signal);
    const value = (await fs.readFile(score, 'utf8').catch(() => '')).trim();
    if (stats.status !== 'OK' || stats.exitCode !== 0 || !/^100(?:\.0+)?$/.test(value)) {
      const report = (await fs.readFile(message, 'utf8').catch(() => '')).slice(0, 2000);
      fail(`${index}: Lemon checker protocol check failed on test ${test}. Use Testlib for Lemons and registerLemonChecker(argc, argv); the standard answer must receive full score in the score file.\n${report}`);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

/** Preserve source-relative includes and put global headers under shared/ for rebuilding. */
async function addCheckerSources(judge: Judge, ctx: ProblemCtx, checker: Program, folder: string, zip: ZipWriter) {
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
  await add(checker.srcPath);
  for (const file of ['LICENSE', 'README.md']) zip.add(`data/${folder}/checker-sources/shared/lemon/${file}`, await fs.readFile(path.join(judge.global.sharedDir, 'lemon', file)));
}

export async function addLemonProblem(judge: Judge, ctx: ProblemCtx, index: string, zip: ZipWriter, job: JobCtx) {
  const { config } = ctx, p = config.problem, mode = judgeMode(p);
  const checker = await preflightLemonChecker(judge, ctx, index);
  const manifest = await generateTests(judge, ctx, job);
  if (!manifest.ok) fail(`${index}: test generation failed.\n${manifest.errors.join('\n')}`);
  const folder = p.name;
  const testCases = lemonTestCases(config, manifest.tests.map(t => t.index), folder);
  await checkLemonProtocol(judge, ctx, checker, manifest.tests[0].index, index, job);
  for (const test of manifest.tests) {
    job.signal.throwIfAborted();
    for (const [extension, file] of [['in', inputPath(ctx, test.index)], ['ans', answerPath(ctx, test.index)]]) {
      const bytes = await fs.readFile(file).catch(() => fail(`${index}: missing ${extension} for test ${test.index}.`));
      zip.add(`data/${folder}/${test.index}.${extension}`, bytes);
    }
  }
  const checkerName = `${folder}/checker${process.platform === 'win32' ? '.exe' : ''}`;
  await withBuildLocks([checker.build!.dir], async () => {
    await verifyBuild(checker.build);
    zip.add(`data/${checkerName}`, await fs.readFile(checker.argv[0]), true);
  }, 'read');
  // Keep sources to allow rebuilding checkers when moving to another platform.
  await addCheckerSources(judge, ctx, checker, folder, zip);
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
    taskType: mode === 'grader' ? 3 : 0, subFolderCheck: true,
    comparisonMode: 4, diffArguments: '--ignore-space-change --text --brief', realPrecision: 6,
    specialJudge: checkerName, compilerConfiguration: { 'g++': cppConfiguration }, answerFileExtension: 'ans', testCases,
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
  return { task, tests: manifest.tests.length };
}

export const lemonReadme = (platform: string) => `LemonLime contest package\n\nOpen the .cdf file in LemonLime (JSON CDF version 1.0).\nContestants: source/<contestant>/<problem>/<problem>.cpp\nThe source directory is deliberately empty.\nInputs, answers, checkers and supplied grader files are in data/.\nOnly the default tests testset is exported. Problems without point settings total 100 points.\nSubtasks are ordered by dependencies; bundled tests share one score.\nChecker executables target ${platform}; other platforms must rebuild them from checker-sources/problem/ with -I checker-sources/shared/. The Lemon checker uses Testlib for Lemons (registerLemonChecker), independently of the Polygon checker. Preserve the included header license. Configure your C++ compiler in LemonLime.\nGrader problems use LemonLime Communication mode.\n`;
