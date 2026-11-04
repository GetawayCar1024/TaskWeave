import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GlobalStore } from '../src/global.js';
import { ProblemRegistry } from '../src/workspace/problems.js';
import { Judge } from '../src/judge/index.js';
import { WsHub } from '../src/ws.js';
import { checkerOutcome, runChecker } from '../src/judge/execute.js';
import { groupScore } from '../src/judge/scoring.js';
import { luoguPartialScript, luoguSubtaskScript } from '../src/judge/luogu.js';
import { parseLuoguData } from '../src/imports/data.js';
import { createLemonChecker } from '../src/judge/lemonChecker.js';
import { programSpec } from '../src/judge/execute.js';
import { hydroPackage } from '../src/judge/hydro.js';
import { exportPackage } from '../src/judge/package.js';
import { readZip } from '../src/util/zip.js';

test('checker units are explicit and malformed partial reports fail closed', () => {
  assert.deepEqual(checkerOutcome(7, 'points 0.5 half'), { verdict: 'PC', message: 'points 0.5 half', fraction: 0.5 });
  assert.equal(checkerOutcome(7, 'points 50 half', 'percent').fraction, 0.5);
  assert.equal(checkerOutcome(7, 'points 50 half', 'points').points, 50);
  assert.equal(checkerOutcome(50, 'partially correct (50) half', 'points').fraction, 0.5);
  assert.equal(checkerOutcome(7, 'points 50', 'hydro').fraction, 0.5);
  assert.equal(checkerOutcome(7, 'points 0.5', 'hydro').fraction, 0.5);
  assert.deepEqual(checkerOutcome(1, 'partially correct (1)', 'hydro'), { verdict: 'PC', message: 'partially correct (1)', fraction: 1 });
  assert.equal(groupScore({ rounding: 'floor', tests: [{ index: 1, points: 3, verdict: 'PC', checkerFraction: 0.5 }], groups: [] }).total, 1);
  for (const report of ['points 50', 'points 0.5junk', 'points NaN', 'points -1', 'points points_info=x']) assert.equal(checkerOutcome(7, report).verdict, 'FAIL', report);
});

test('Luogu partial-credit scripts round-trip with verified min/sum settings', () => {
  const subtasks = [
    { id: 1, label: 'bundle', points: 40, policy: 'COMPLETE_GROUP' as const, dependencies: [] },
    { id: 2, label: 'sum', points: 60, policy: 'EACH_TEST' as const, dependencies: [1] },
  ];
  const aggregation = { time: 'sum' as const, memory: 'max' as const };
  const cases = [1, 2, 3].map(k => ({ k, testset: 'tests', index: k, score: k === 3 ? 60 : 40, subtask: k === 3 ? 2 : 1 }));
  const files = new Map<string, Buffer>();
  const config = cases.map(test => `${test.k}.in:\n  score: ${test.score}\n  subtaskId: ${test.subtask}\n`).join('');
  files.set('config.yml', Buffer.from('# taskweave-scoring: ' + JSON.stringify({ version: 2, subtasks, aggregation }) + '\n' + config));
  files.set('score.txt', Buffer.from(luoguPartialScript(subtasks, aggregation)));
  for (const subtask of subtasks) files.set(`score-subtask-${subtask.id}.txt`, Buffer.from(luoguSubtaskScript(subtask, cases, aggregation)));
  for (const c of cases) for (const ext of ['in', 'out']) files.set(`${c.k}.${ext}`, Buffer.from('1'));
  const parsed = parseLuoguData(files);
  assert.equal(parsed.unresolvedScoring, false);
  assert.deepEqual(parsed.groups.map(g => [g.name, g.points, g.policy]), [['bundle', 40, 'COMPLETE_GROUP'], ['sum', 60, 'EACH_TEST']]);
  assert.match(files.get('score-subtask-1.txt')!.toString(), /@total_score = @score1;[\s\S]*if @score2 < @total_score/);
  assert.match(files.get('score.txt')!.toString(), /^@total_score = 0;\n@total_score = @total_score \+ @score1;/);
  files.set('score-subtask-1.txt', Buffer.from('@total_score = 400;'));
  assert.equal(parseLuoguData(files).unresolvedScoring, true, 'metadata must not override a different scoring script');
});

test('real Testlib partial scores scale with each subtask and do not pass full-score dependencies', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'taskweave-checker-score-'));
  try {
    const global = new GlobalStore(home); await global.init(); global.config.problems.roots = [path.join(home, 'problems')];
    const registry = new ProblemRegistry(global), judge = new Judge(global, registry, new WsHub());
    const problem = await registry.create({ name: 'partial' });
    await fs.writeFile(path.join(problem.dir, 'partial.cpp'), '#include "testlib.h"\nint main(int argc,char**argv){registerTestlibCmd(argc,argv);double p=ouf.readDouble();if(p==2)quitf(_pc(50),"half");if(p==3)quitpi("unsupported");quitp(p,"fraction");}\n');
    await registry.patch(problem.id, { checker: 'partial.cpp' });
    const program = await judge.checker(await judge.ctx(problem.id));
    const work = path.join(home, 'work'); await fs.mkdir(work);
    const files = { input: path.join(home, 'input'), output: path.join(home, 'output'), answer: path.join(home, 'answer') };
    await Promise.all(Object.values(files).map(file => fs.writeFile(file, '0.5\n')));
    const half = await runChecker(judge.runner, program, files, work);
    const result = groupScore({ tests: [{ index: 1, points: 40, verdict: half.verdict, checkerPoints: half.points, checkerFraction: half.fraction }, { index: 2, points: 60, verdict: 'OK' }], groups: [
      { name: 'a', points: 40, policy: 'COMPLETE_GROUP', dependencies: [], tests: [1] },
      { name: 'b', points: 60, policy: 'COMPLETE_GROUP', dependencies: ['a'], tests: [2] },
    ] });
    assert.equal(result.total, 20, JSON.stringify({ half, result }));
    assert.equal(result.groups[0].passed, false);
    assert.deepEqual(result.groups[1].blockedBy, ['a']);
    assert.equal(half.verdict, 'PC');
    for (const [text, verdict, fraction] of [['0', 'WA', 0], ['1', 'OK', 1], ['2', 'PC', 0.5], ['3', 'FAIL', undefined]] as const) {
      await fs.writeFile(files.output, text + '\n');
      const outcome = await runChecker(judge.runner, program, files, work);
      assert.equal(outcome.verdict, verdict, JSON.stringify(outcome));
      assert.equal(outcome.fraction, fraction);
    }
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('percentage and absolute checkers retain their score in Lemon and Hydro; Polygon declares its mode', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'taskweave-platform-scores-'));
  try {
    const global = new GlobalStore(home); await global.init(); global.config.problems.roots = [path.join(home, 'problems')];
    const registry = new ProblemRegistry(global), judge = new Judge(global, registry, new WsHub());
    const problem = await registry.create({ name: 'units' });
    await fs.writeFile(path.join(problem.dir, 'numeric.cpp'), '#include "testlib.h"\nint main(int argc,char**argv){registerTestlibCmd(argc,argv);double p=ouf.readDouble();quitp(p,"score=%g",p);}\n');
    const work = path.join(home, 'work'); await fs.mkdir(work);
    const input = path.join(work, 'input'), output = path.join(work, 'output'), answer = path.join(work, 'answer');
    await fs.writeFile(input, '1\n'); await fs.writeFile(answer, '1\n');
    const job = { signal: new AbortController().signal, progress() {} };
    for (const [unit, value, expected] of [['points', '7', '7'], ['percent', '50', '20']] as const) {
      await registry.patch(problem.id, { checker: 'numeric.cpp', checkerScoring: unit });
      const converted = await createLemonChecker(judge, problem.id);
      const compiled = await judge.compile(await judge.ctx(problem.id), converted.source, false);
      assert.ok(compiled.program, compiled.result.log);
      await fs.writeFile(output, value + '\n');
      const score = path.join(work, 'score'), message = path.join(work, 'message');
      const result = await judge.runner.run({ ...programSpec(compiled.program!), argv: [...compiled.program!.argv, input, output, answer, '40', score, message], cwd: work, stderr: path.join(work, 'stderr'), wallLimitMs: 5000 });
      assert.equal(result.status, 'OK', JSON.stringify(result));
      assert.equal((await fs.readFile(score, 'utf8')).trim(), expected);
      await registry.patch(problem.id, { points: true, testsets: { tests: { answers: 'provided', script: null, groups: true, group: [{ name: 'g', tests: '1', points: 40 }] } } });
      await fs.writeFile(path.join(problem.dir, 'tests/manual/01.ans'), '3\n');
      const hydro = await hydroPackage(judge, await judge.ctx(problem.id), job, ['tests']);
      const archive = readZip(hydro.data);
      assert.match(archive.get('testdata/config.yaml')!.toString(), /checker_type: lemon/);
      assert.ok([...archive.keys()].some(file => file.startsWith('testdata/') && file.endsWith('testlib.h')));
    }
    await registry.patch(problem.id, { checkerScoring: 'fraction' });
    const ctx = await judge.ctx(problem.id);
    const result = await exportPackage(judge, ctx, job);
    const xml = readZip(await fs.readFile(path.join(ctx.work, 'export', result.file))).get('problem.xml')!.toString();
    assert.match(xml, /treat-points-from-checker-as-percent="true"/);
    await registry.patch(problem.id, { testsets: { tests: { group: [{ name: 'g', tests: '1', points: 40 }, { name: 'dependent', tests: '1', points: 60, dependencies: ['g'] }] } } });
    await assert.rejects(exportPackage(judge, await judge.ctx(problem.id), job), /propagate partial credit/);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
