import { promises as fs } from 'node:fs';
import { DEFAULT_TESTSET, groupLayout, groupTotal, judgeMode, parseIndexList, PROBLEM_NAME_RE, STD_PREFIX, testLimitLookup, testsetOf, type LuoguAggregate, type ProblemToml, type TestGroup } from '@polyforge/shared';
import type { JobCtx } from '../jobs.js';
import { HttpError, safeJoin } from '../util/fs.js';
import { ZipWriter } from '../util/zip.js';
import { checkGroups } from '../workspace/problems.js';
import type { Judge, ProblemCtx } from './index.js';
import { exportedTests, splitScore } from './lemonlime.js';
import { answerPath, inputPath } from './tests.js';

/**
 * Luogu data package (help.luogu.com.cn: testcase-config, scoring-script, special-judge,
 * interactive-problems): <name>/<name>k.in / .out, config.yml, a problem-level scoring
 * script that implements bundled subtasks and dependencies, checker.cpp and a README.
 */
const fail = (message: string): never => { throw new HttpError(400, 'luogu_export', message); };

export interface LuoguCase { k: number; testset: string; index: number; score: number; subtask: number; timeLimit?: number; memoryLimit?: number }
export interface LuoguSubtask { id: number; label: string; points: number; policy: 'COMPLETE_GROUP' | 'EACH_TEST'; dependencies: number[] }

/** Test cases and subtasks: per testset the ungrouped tests (if any), then its groups; ids continue over testsets. */
export function luoguLayout(config: ProblemToml, sets: { name: string; tests: number[] }[], warnings: string[]): { cases: LuoguCase[]; subtasks: LuoguSubtask[] } {
  const cases: LuoguCase[] = [], subtasks: LuoguSubtask[] = [];
  const points = !!config.tests.points;
  for (const set of sets) {
    const firstCase = cases.length;
    const ts = testsetOf(config, set.name) ?? fail(`Unknown testset: ${set.name}`);
    const where = set.name === DEFAULT_TESTSET ? '' : `${set.name}: `;
    const tests = [...set.tests].sort((a, b) => a - b);
    if (!tests.length) fail(`${where}No tests to export.`);
    const groups = points && ts.groups ? checkGroups(set.name, ts.group).filter(g => parseIndexList(g.tests ?? '').length || (warnings.push(`${where}Subtask ${g.name} has no tests and is not exported.`), false)) : [];
    if (points && !groups.length) fail(`${where}Points are enabled but there are no scored subtasks.`);
    const layout = groupLayout(ts, points), limits = testLimitLookup(config, ts);
    const available = new Set(tests);
    const of = new Map<number, string>();
    for (const g of groups) {
      const idx = parseIndexList(g.tests ?? '');
      if (idx.some(i => !available.has(i))) fail(`${where}Subtask ${g.name} is empty or refers to missing tests.`);
      idx.forEach(i => of.set(i, g.name));
    }
    // Without subtask points the testset's 100 points are split over its tests.
    const share = new Map<number, number>();
    if (!points || !groups.length) splitScore(100, tests.length).forEach((s, i) => share.set(tests[i], s));
    const ids = new Map<string, number>();
    const loose = tests.filter(i => !of.has(i));
    const entries: { name?: string; group?: TestGroup; tests: number[]; points: number; policy: LuoguSubtask['policy']; deps: string[] }[] = [];
    if (loose.length) entries.push({ tests: loose, points: loose.reduce((a, i) => a + (share.get(i) ?? 0), 0), policy: 'EACH_TEST', deps: [] });
    for (const g of groups) {
      const idx = [...new Set(parseIndexList(g.tests ?? ''))].sort((a, b) => a - b);
      const p = groupTotal(g);
      if (p === undefined) fail(`${where}Subtask ${g.name} has no score.`);
      if (!Number.isSafeInteger(p)) fail(`${where}Subtask ${g.name}: Luogu requires integer scores.`);
      entries.push({ name: g.name, group: g, tests: idx, points: p!, policy: g.policy ?? 'COMPLETE_GROUP', deps: g.dependencies ?? [] });
    }
    for (const e of entries) {
      const id = subtasks.length === 0 && !e.name ? 0 : (subtasks.length ? subtasks[subtasks.length - 1].id + 1 : 1);
      if (e.name) ids.set(e.name, id);
      const scores = splitScore(e.points, e.tests.length);
      e.tests.forEach((index, k) => {
        const score = e.policy === 'EACH_TEST' && e.name ? layout.byGroup[e.name][index] ?? 0 : scores[k];
        if (!Number.isSafeInteger(score)) fail(`${where}Luogu requires integer per-test scores.`);
        cases.push({ k: cases.length + 1, testset: set.name, index, score, subtask: id, ...limits(index, e.group) });
      });
      subtasks.push({ id, label: e.name ? `${where}${e.name}` : `${where}—`, points: e.points, policy: e.policy, dependencies: [] });
    }
    // Dependencies, transitively (the script checks each one directly).
    const byName = new Map(groups.map(g => [g.name, g]));
    const closure = (name: string, seen = new Set<string>()): Set<string> => {
      for (const d of byName.get(name)?.dependencies ?? []) if (!seen.has(d)) { seen.add(d); closure(d, seen); }
      return seen;
    };
    for (const e of entries) if (e.name) {
      const st = subtasks.find(s => s.id === ids.get(e.name!))!;
      st.dependencies = [...closure(e.name)].map(d => ids.get(d)).filter((d): d is number => d !== undefined).sort((a, b) => a - b);
    }
    const ordered = cases.splice(firstCase).sort((a, b) => a.index - b.index || a.subtask - b.subtask);
    ordered.forEach((entry, index) => entry.k = firstCase + index + 1); cases.push(...ordered);
  }
  return { cases, subtasks };
}

const ac = (id: number) => `(@status${id} == AC)`;

/** Combine @timeX / @memoryX of all subtasks into @final_time / @final_memory. */
function aggregate(target: string, vars: string[], how: LuoguAggregate): string[] {
  if (!vars.length) return [`${target} = 0;`];
  if (how === 'sum') return [`${target} = ${vars.join(' + ')};`];
  const cmp = how === 'max' ? '>' : '<';
  return [`${target} = ${vars[0]};`, ...vars.slice(1).map(v => `if ${v} ${cmp} ${target}; then\n    ${target} = ${v};\nfi`)];
}

/** Problem-level scoring script (inputs @statusX, @scoreX, @timeX, @memoryX per subtask X). */
export function luoguScript(subtasks: LuoguSubtask[], agg: { time: LuoguAggregate; memory: LuoguAggregate }): string {
  const lines: string[] = ['@total_score = 0;'];
  for (const s of subtasks) {
    const cond = s.policy === 'COMPLETE_GROUP' ? [s.id, ...s.dependencies].map(ac) : s.dependencies.map(ac);
    const add = s.policy === 'COMPLETE_GROUP' ? `${s.points}` : `@score${s.id}`;
    if (!cond.length) lines.push(`@total_score = @total_score + ${add};`);
    else lines.push(`if ${cond.join(' and ')}; then\n    @total_score = @total_score + ${add};\nfi`);
  }
  const max = subtasks.reduce((a, s) => a + s.points, 0);
  const pass = max > 0 ? `@total_score == ${max}` : subtasks.map(s => ac(s.id)).join(' and ') || '1 == 1';
  lines.push(`if ${pass}; then\n    @final_status = AC;\nelse\n    @final_status = UNAC;\nfi`);
  lines.push(...aggregate('@final_time', subtasks.map(s => `@time${s.id}`), agg.time));
  lines.push(...aggregate('@final_memory', subtasks.map(s => `@memory${s.id}`), agg.memory));
  return lines.join('\n') + '\n';
}

export function luoguConfig(config: ProblemToml, cases: LuoguCase[]): string {
  return cases.map(c => {
    const test = testsetOf(config, c.testset)?.cases?.[c.index];
    const time = c.timeLimit ?? test?.time_limit ?? config.problem.time_limit;
    const memory = (c.memoryLimit ?? test?.memory_limit ?? config.problem.memory_limit) * 1024;
    if (!Number.isSafeInteger(memory)) fail('Luogu memory limits must be exactly representable in whole KiB.');
    return `${c.k}.in:\n  timeLimit: ${time}\n  memoryLimit: ${memory}\n  score: ${c.score}\n  subtaskId: ${c.subtask}\n${test?.pretest || c.testset === 'pretests' ? '  isPretest: true\n' : ''}`;
  }).join('\n');
}

export async function luoguData(judge: Judge, ctx: ProblemCtx, index: string, job: JobCtx, testsets: string[], agg: { time: LuoguAggregate; memory: LuoguAggregate }) {
  const { config } = ctx, p = config.problem, mode = judgeMode(p);
  if (!PROBLEM_NAME_RE.test(p.name)) fail(`${index}: invalid problem name.`);
  const warnings: string[] = [];
  const sets = await exportedTests(judge, ctx, testsets, index, job);
  const { cases, subtasks } = luoguLayout(config, sets, warnings);
  const folder = p.name;
  const zip = new ZipWriter({ async: true });
  for (const c of cases) {
    job.signal.throwIfAborted();
    for (const [extension, file] of [['in', inputPath(ctx, c.index, c.testset)], ['out', answerPath(ctx, c.index, c.testset)]]) {
      const bytes = await fs.readFile(file).catch(() => fail(`${index}: missing ${extension === 'in' ? 'input' : 'answer'} for test ${c.index}${c.testset === DEFAULT_TESTSET ? '' : ` (${c.testset})`}.`));
      zip.add(`${c.k}.${extension}`, bytes);
    }
  }
  // YAML comments are ignored by Luogu, and let our own importer restore policies,
  // dependency edges and sample flags without evaluating arbitrary scoring scripts.
  const metadata = { version: 1, subtasks, aggregation: agg, samples: cases.filter(c => parseIndexList(testsetOf(config, c.testset)?.samples ?? '').includes(c.index)).map(c => c.k) };
  zip.add('config.yml', `# polyforge-scoring: ${JSON.stringify(metadata)}\n` + luoguConfig(config, cases));
  zip.add('score.txt', luoguScript(subtasks, agg));
  if (p.input !== 'stdin' || p.output !== 'stdout') warnings.push(`${index}: Luogu uses standard input / output; file input / output (${p.input} / ${p.output}) is not exported.`);
  const read = (source: string) => fs.readFile(judge.compiler.resolveSource(ctx.ref.dir, source).srcPath, 'utf8');
  const localIncludes = (text: string) => [...text.matchAll(/^\s*#\s*include\s*"([^"\r\n]+)"/gm)].map(m => m[1]).filter(h => h !== 'testlib.h');
  let checker = '';
  if (mode === 'io') {
    if (!config.interactor) fail(`${index}: interactive problem without an interactor.`);
    checker = await read(config.interactor!.source);
    zip.add('interactive_lib.cpp', '');
    warnings.push(`${index}: I/O interactive: the interactor is packaged as checker.cpp; on Luogu it must decide the verdict itself (the Polygon checker is not run).`);
  } else if (config.checker) checker = await read(config.checker.source);
  if (mode === 'grader') {
    const sources = config.grader?.sources ?? [];
    if (sources.length !== 1) fail(`${index}: Luogu needs exactly one grader source (interactive_lib.cpp).`);
    const lib = await fs.readFile(safeJoin(ctx.ref.dir, sources[0]), 'utf8');
    zip.add('interactive_lib.cpp', lib);
    if (config.grader!.headers.length || localIncludes(lib).length) warnings.push(`${index}: grader headers are not supported by Luogu; paste their declarations into interactive_lib.cpp.`);
    // Luogu's SPJ for function interaction talks to the library instead of reading the input itself.
    if (config.checker?.source.startsWith(STD_PREFIX)) checker = '';
    else if (config.checker) warnings.push(`${index}: grader problem with a custom checker: on Luogu the checker must forward the input to interactive_lib.cpp; check checker.cpp.`);
  }
  if (checker) {
    zip.add('checker.cpp', checker);
    if (localIncludes(checker).length) warnings.push(`${index}: checker.cpp includes ${localIncludes(checker).join(', ')}; Luogu only provides testlib.h.`);
  }
  const readme = luoguReadme(config, { cases: cases.length, subtasks, spj: !!checker, mode, agg, sets: sets.map(s => s.name) });
  warnings.push('Luogu does not automatically install score.txt. Paste its contents into the whole-problem scoring script after uploading data.zip.');
  const data = await zip.finishAsync();
  if (data.length > 50 * 1024 * 1024) warnings.push('Luogu documents a 50 MiB compressed upload limit; this package is larger.');
  return { data, readme, tests: cases.length, warnings };
}

export async function addLuoguProblem(judge: Judge, ctx: ProblemCtx, index: string, zip: ZipWriter, job: JobCtx, testsets: string[], agg: { time: LuoguAggregate; memory: LuoguAggregate }) {
  const result = await luoguData(judge, ctx, index, job, testsets, agg);
  zip.add(`${ctx.config.problem.name}/data.zip`, result.data);
  zip.add(`${ctx.config.problem.name}/README.txt`, result.readme);
  return { tests: result.tests, warnings: result.warnings };
}

export const luoguContestReadme = (title: string, indices: string[]) => `洛谷数据包：${title}

每道题（${indices.join('、')}）一个文件夹，以题目英文名命名。
每个文件夹中的 data.zip 可以直接上传。README.txt 说明了配置 Subtask、粘贴 score.txt 计分脚本以及 Special Judge / 交互库的设置。
`;

const AGG: Record<LuoguAggregate, string> = { sum: '求和', min: '取最小值', max: '取最大值' };

export function luoguReadme(config: ProblemToml, o: { cases: number; subtasks: LuoguSubtask[]; spj: boolean; mode: string; agg: { time: LuoguAggregate; memory: LuoguAggregate }; sets: string[] }): string {
  const name = config.problem.name;
  const st = o.subtasks.map(s => `  Subtask ${s.id}（${s.label.endsWith('—') ? `${s.label.slice(0, -1)}不属于任何子任务的测试点` : s.label}）：${s.points} 分，${s.policy === 'COMPLETE_GROUP' ? '捆绑（全部通过才得分）' : '按测试点累加'}${s.dependencies.length ? `，依赖 Subtask ${s.dependencies.join(', ')}` : ''}`).join('\n');
  return `洛谷题目数据包：${name}

一、上传测试数据
1. 在洛谷题目管理的“测试信息 / 上传测试数据”中上传 data.zip。压缩包根目录包含 1.in … ${o.cases}.out、config.yml 和 score.txt${o.spj ? '、checker.cpp' : ''}${o.mode !== 'batch' ? '、interactive_lib.cpp' : ''}。score.txt 是计分脚本副本，洛谷没有文档保证自动读取它；如上传器拒绝额外文件，取出 score.txt 后上传数据与 config.yml。
2. config.yml 设置了每个测试点的时间限制（${config.problem.time_limit} ms）、内存限制（${config.problem.memory_limit * 1024} KB）、分值和所属 Subtask。上传后网页上的设置会覆盖配置文件，请以网页显示为准。
3. 导出的测试集：${o.sets.join('、')}（共 ${o.cases} 个测试点，按顺序编号）。

二、子任务与计分脚本
${st}
4. 将 score.txt 的内容粘贴到题目的“计分脚本”（整题计分脚本）中。脚本实现了捆绑测试、子任务依赖（含间接依赖）和总分，满分时整题状态为 AC。
5. 各 Subtask 的计分方式请保持默认的“求和”，脚本中按测试点累加的子任务使用 @scoreX。
6. 用时按子任务${AGG[o.agg.time]}、内存按子任务${AGG[o.agg.memory]}汇总。
${o.spj ? `
三、Special Judge
7. checker.cpp 是${o.mode === 'io' ? '交互器（IO 交互题由 checker.cpp 与选手程序交互）' : '本题的检查器'}，基于 testlib（洛谷使用 testlib 0.9.45，以 g++ -std=c++14 -O2 编译）。请为题目加上“Special Judge”标签${o.mode !== 'batch' ? '和“交互题”标签' : ''}。
8. 若检查器只是标准的逐词 / 逐行比较，也可以删除 checker.cpp 并去掉 Special Judge 标签，改用洛谷默认的比较方式。
` : o.mode !== 'batch' ? `
三、交互题
7. 请为题目加上“交互题”标签；interactive_lib.cpp 为交互库，以 C++14 编译。
` : ''}`;
}
