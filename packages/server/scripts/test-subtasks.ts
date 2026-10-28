import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { groupLayout, inferFilenameGroups, problemTomlSchema, pruneForwardDependencies, testsetOf } from '@taskweave/shared';
import { lemonTestCases } from '../src/judge/lemonlime.js';
import { groupScore, scoringInput } from '../src/judge/scoring.js';
import { checkGroups, ProblemRegistry } from '../src/workspace/problems.js';
import { GlobalStore } from '../src/global.js';
import { Judge } from '../src/judge/index.js';
import { WsHub } from '../src/ws.js';
import { readInvocation, runInvocation } from '../src/judge/invocation.js';
import { atomicWrite } from '../src/util/fs.js';
import { luoguConfig, luoguLayout } from '../src/judge/luogu.js';
import { hydroSubtasks } from '../src/judge/hydro.js';

test('LemonLime CDF retains subtask time and memory instead of falling back to problem defaults', () => {
  const config = problemTomlSchema.parse({ problem: { name: 'limits', time_limit: 1000, memory_limit: 256 }, tests: {
    points: true, groups: true, group: [{ name: '0', tests: '1-2', points: 40, time_limit: 1750, memory_limit: 768 }],
  } });
  const cdf = JSON.parse(JSON.stringify({ testCases: lemonTestCases(config, [1, 2], 'limits') }));
  assert.deepEqual(cdf.testCases.map((row: { timeLimit: number; memoryLimit: number }) => [row.timeLimit, row.memoryLimit]), [[1750, 768]]);
});

const shared = () => problemTomlSchema.parse({ problem: { name: 'shared' }, tests: { points: true, groups: true, group: [
  { name: '0', tests: '1-2', points: 30, policy: 'COMPLETE_GROUP', time_limit: 1750, memory_limit: 768 },
  { name: '1', tests: '1-2', test_points: 12, policy: 'EACH_TEST', time_limit: 2250, memory_limit: 1024 },
] } });

test('shared tests score independently: bundled minimum and uniform sum, without a 100-point normalization', () => {
  const config = shared(), ts = testsetOf(config)!;
  const layout = groupLayout(ts, true);
  assert.deepEqual(layout.memberships[1], ['0', '1']);
  assert.deepEqual(Object.values(layout.byGroup['0']), [30, 30]);
  assert.deepEqual(Object.values(layout.byGroup['1']), [12, 12]);
  const ok = { verdict: 'OK' as const, timeMs: 1, memoryKb: 1 };
  assert.equal(groupScore(scoringInput({ config }, ts, [1, 2], [ok, ok])).total, 54);
  const partial = groupScore(scoringInput({ config }, ts, [1, 2], [ok, { ...ok, verdict: 'WA' }]));
  assert.deepEqual(partial.groups.map(group => [group.score, group.max]), [[0, 30], [12, 24]]);
  const checkerPartial = groupScore(scoringInput({ config }, ts, [1, 2], [ok, { ...ok, points: 7 }]));
  assert.deepEqual(checkerPartial.groups.map(group => group.score), [7, 19]);
});

test('all native OI exporters retain independent limits and scores for overlapping memberships', () => {
  const config = shared();
  const lemon = lemonTestCases(config, [1, 2], 'shared');
  assert.deepEqual(lemon.map(row => [row.fullScore, row.timeLimit, row.memoryLimit]), [[30, 1750, 768], [12, 2250, 1024], [12, 2250, 1024]]);
  assert.ok(lemon[0].inputFiles.includes(lemon[1].inputFiles[0]));
  const hydro = hydroSubtasks(config, [{ name: 'tests', tests: [1, 2] }]);
  assert.deepEqual(hydro.map(group => [group.score, group.cases[0].time, group.cases[0].memory]), [[30, '1750ms', '768m'], [24, '2250ms', '1024m']]);
  const luogu = luoguLayout(config, [{ name: 'tests', tests: [1, 2] }], []);
  assert.equal(luogu.cases.length, 4);
  assert.match(luoguConfig(config, luogu.cases), /2250\n  memoryLimit: 1048576\n  score: 12/);
  config.tests.group![0].memory_limit = 128.5;
  assert.throws(() => lemonTestCases(config, [1, 2], 'shared'), /integer time/);
  assert.throws(() => hydroSubtasks(config, [{ name: 'tests', tests: [1, 2] }]), /whole MiB/);
});

test('saving preserves manual order and dragging removes only invalid dependency edges', () => {
  const groups = checkGroups('tests', [
    { name: '2', tests: '1-2' }, { name: '10', tests: '1', dependencies: ['2'] },
    { name: '1', tests: '1', dependencies: ['2', '10'] }, { name: '0', tests: '2' },
  ], true);
  assert.deepEqual(groups.map(group => group.name), ['2', '10', '1', '0']);
  [groups[1], groups[2]] = [groups[2], groups[1]];
  assert.deepEqual(pruneForwardDependencies(groups), [{ group: '1', dependency: '10' }]);
  assert.deepEqual(groups[1].dependencies, ['2']); assert.deepEqual(groups[2].dependencies, ['2']);
  assert.deepEqual(checkGroups('tests', groups, true).map(group => group.name), ['2', '1', '10', '0']);
  assert.throws(() => checkGroups('tests', [{ name: '1', dependencies: ['2'] }, { name: '2' }], true), /earlier subtasks/);
  assert.throws(() => checkGroups('tests', [{ name: '1', dependencies: ['1'] }], true), /itself/);
});

test('filename suggestions use provenance, preserve leading zeroes and do not invent scores', () => {
  const result = inferFilenameGroups([
    { index: 1, source: 'tests/manual/1.in', originalInput: 'in/01-02.txt' },
    { index: 2, source: 'tests/manual/2.in', originalInput: 'in/01_03.in' },
    { index: 3, source: 'tests/manual/3.in', originalInput: 'case.in' },
  ]);
  assert.deepEqual(result.groups, [{ name: '01', tests: '1-2', policy: 'COMPLETE_GROUP' }]);
  assert.deepEqual(result.unmatched, ['case.in']);
});

test('shared memberships with different budgets run independently through the invocation path', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-shared-run-'));
  try {
    const global = new GlobalStore(home); await global.init(); global.config.problems.roots = [path.join(home, 'problems')];
    const registry = new ProblemRegistry(global), judge = new Judge(global, registry, new WsHub());
    const p = await registry.create({ name: 'contexts' });
    await atomicWrite(path.join(p.dir, 'tests/manual/01.ans'), '3\n');
    await registry.patch(p.id, { testsets: { tests: { answers: 'provided', script: null, groups: true, group: [
      { name: '0', tests: '1', points: 20, time_limit: 500, memory_limit: 128 },
      { name: '1', tests: '1', points: 40, time_limit: 2000, memory_limit: 512 },
    ] } }, points: true });
    const budgets: number[] = [];
    judge.runner.run = async spec => {
      if (spec.stdout) await atomicWrite(spec.stdout, '3\n');
      const solution = spec.timeLimitMs === 500 || spec.timeLimitMs === 2000;
      if (solution) budgets.push(spec.timeLimitMs!);
      // Model a budget-dependent outcome, which cannot be inferred from one wide run.
      const fail = spec.timeLimitMs === 500;
      return { status: fail ? 'RE' : 'OK', exitCode: fail ? 1 : 0, timeMs: 2, wallMs: 2, memoryKb: 32, idle: false };
    };
    const ctx = await judge.ctx(p.id);
    const id = await runInvocation(judge, ctx, [ctx.config.solutions.find(s => s.tag === 'MA')!.source], [1], { signal: new AbortController().signal, progress() {} }, () => {});
    assert.deepEqual(budgets.sort((a, b) => a - b), [500, 2000]);
    const invocation = await readInvocation(ctx, id);
    assert.deepEqual(invocation.solutions[0].score?.groups.map(group => group.score), [0, 40]);
    assert.equal(invocation.cells[0][0]?.groupResults?.['1'].verdict, 'OK');
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
