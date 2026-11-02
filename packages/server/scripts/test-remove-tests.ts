import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import type { RemoveTestsResult } from '@taskweave/shared';
import { GlobalStore } from '../src/global.js';
import { ProblemRegistry } from '../src/workspace/problems.js';
import { ContestRegistry } from '../src/workspace/contests.js';
import { FileService, SelfWrites } from '../src/workspace/files.js';
import { ProblemWatcher } from '../src/workspace/watcher.js';
import { Judge } from '../src/judge/index.js';
import { JobManager } from '../src/jobs.js';
import { WsHub } from '../src/ws.js';
import { buildApp } from '../src/app.js';
import { planTests, removeTests, requireTestset } from '../src/judge/tests.js';
import { ensureOriginalAnswers, readOriginalAnswers } from '../src/workspace/answerBackups.js';

type Call = (method: 'DELETE' | 'GET', url: string, payload?: object) => Promise<LightMyRequestResponse>;
async function fixture(run: (ctx: { registry: ProblemRegistry; judge: Judge; call: Call }) => Promise<void>) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tw-remove-tests-')));
  const global = new GlobalStore(home); await global.init(); global.config.problems.roots = [path.join(home, 'problems')];
  const registry = new ProblemRegistry(global), contests = new ContestRegistry(registry, global), hub = new WsHub();
  const files = new FileService(new SelfWrites()), watcher = new ProblemWatcher(registry, files, hub), judge = new Judge(global, registry, hub);
  const app = await buildApp({ global, registry, contests, hub, files, watcher, judge, jobs: new JobManager(hub), token: 'fixture' });
  const call: Call = (method, url, payload) => app.inject({ method, url, payload, headers: { host: 'localhost', 'x-taskweave-token': 'fixture' } });
  try { await run({ registry, judge, call }); }
  finally { await watcher.stop(); await app.close(); await fs.rm(home, { recursive: true, force: true }); }
}
/** Tests 1-2 are manual files, 3-4 and 7 come from "$" lines, 5-6 from one {5-6} line. */
async function problem(registry: ProblemRegistry, script = 'gen 1 > $\ngen 2 > $\nmulti > {5-6}\ngen 3 > $\n') {
  const p = await registry.create({ name: 'batch' });
  await fs.rm(path.join(p.dir, 'tests'), { recursive: true });
  for (const [file, text] of Object.entries({ 'manual/01.in': '1\n', 'manual/02.in': '2\n', 'manual/01.statement.in': 'shown\n', '_statement/03.in': 'shown\n', 'script.txt': script })) {
    await fs.mkdir(path.dirname(path.join(p.dir, 'tests', file)), { recursive: true }); await fs.writeFile(path.join(p.dir, 'tests', file), text);
  }
  await registry.patch(p.id, { testsets: { tests: { samples: '2,4,7', largeSamples: '7' } } });
  return p;
}
const sources = async (judge: Judge, id: string) => (await planTests(await judge.ctx(id), [])).map(t => `${t.index}:${t.source}`);

test('checked tests are removed in one operation against one plan, and samples follow their tests', async () => fixture(async ({ registry, judge, call }) => {
  const p = await problem(registry);
  assert.deepEqual(await sources(judge, p.id), ['1:tests/manual/01.in', '2:tests/manual/02.in', '3:gen 1 > $', '4:gen 2 > $', '5:multi > {5-6}', '6:multi > {5-6}', '7:gen 3 > $']);
  // Test 5 takes test 6 with it (same line); every index refers to the plan before the removal.
  const response = await call('DELETE', `/api/problems/${p.id}/tests`, { tests: [{ index: 1, source: 'tests/manual/01.in' }, { index: 5, source: 'multi > {5-6}' }, { index: 3, source: 'gen 1 > $' }] });
  assert.equal(response.statusCode, 200, response.body);
  const result: RemoveTestsResult = response.json();
  assert.deepEqual([result.removed, result.manual, result.lines, result.renumbered], [[1, 3, 5, 6], 1, 2, 3]);
  assert.equal(await fs.readFile(path.join(p.dir, 'tests/script.txt'), 'utf8'), 'gen 2 > $\ngen 3 > $\n');
  for (const gone of ['manual/02.in', 'manual/01.statement.in', '_statement/03.in']) await assert.rejects(fs.access(path.join(p.dir, 'tests', gone)));
  // Later tests moved down in their order (the manual one was renamed); sample marks moved with them and were saved.
  assert.deepEqual(await sources(judge, p.id), ['1:tests/manual/01.in', '2:gen 2 > $', '3:gen 3 > $']);
  assert.equal(await fs.readFile(path.join(p.dir, 'tests/manual/01.in'), 'utf8'), '2\n');
  assert.deepEqual([result.samples, result.largeSamples], ['1-3', '3']);
  const config = (await registry.detail(p.id)).config!;
  assert.deepEqual([config.tests.samples, config.tests.large_samples], ['1-3', '3']);
}));

test('later tests move down: files, explicit script targets, subtasks, per-test settings, notes and the answer backup follow', async () => fixture(async ({ registry, judge, call }) => {
  const p = await registry.create({ name: 'renumber' });
  await fs.rm(path.join(p.dir, 'tests'), { recursive: true });
  const files: Record<string, string> = { 'tests/script.txt': 'gen a > 6\ngen b > {7-8}\n', 'statement/en/samples/5.tex': 'note of 5\n', 'statement/en/samples/3.tex': 'note of 3\n' };
  for (let i = 1; i <= 5; i++) Object.assign(files, { [`tests/manual/${i}.in`]: `in ${i}\n`, [`tests/manual/${i}.ans`]: `ans ${i}\n` });
  for (const [file, text] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(p.dir, file)), { recursive: true }); await fs.writeFile(path.join(p.dir, file), text); }
  await registry.patch(p.id, { points: true, testsets: { tests: { answers: 'provided', samples: '1,5', groups: true, cases: { 5: { time_limit: 2000 }, 7: { time_limit: 3000 } }, group: [
    { name: 'g1', tests: '1-2', points: 20, policy: 'EACH_TEST' }, { name: 'g2', tests: '3-4', points: 30, policy: 'COMPLETE_GROUP', dependencies: ['g1'] },
    { name: 'g3', tests: '5-8', points: 50, policy: 'EACH_TEST', dependencies: ['g2'] }] } } });
  let ctx = await judge.ctx(p.id);
  const pairs = Array.from({ length: 5 }, (_, i) => ({ input: `tests/manual/${i + 1}.in`, output: `tests/manual/${i + 1}.ans` }));
  await ensureOriginalAnswers(p.dir, requireTestset(ctx), pairs);
  const response = await call('DELETE', `/api/problems/${p.id}/tests`, { tests: [2, 3, 4].map(index => ({ index, source: `tests/manual/${index}.in` })) });
  assert.equal(response.statusCode, 200, response.body);
  const result: RemoveTestsResult = response.json();
  assert.deepEqual([result.removed, result.renumbered, result.gaps], [[2, 3, 4], 4, undefined]);
  assert.deepEqual(await sources(judge, p.id), ['1:tests/manual/1.in', '2:tests/manual/2.in', '3:gen a > 3', '4:gen b > {4-5}', '5:gen b > {4-5}']);
  assert.equal(await fs.readFile(path.join(p.dir, 'tests/script.txt'), 'utf8'), 'gen a > 3\ngen b > {4-5}\n');
  assert.deepEqual([await fs.readFile(path.join(p.dir, 'tests/manual/2.in'), 'utf8'), await fs.readFile(path.join(p.dir, 'tests/manual/2.ans'), 'utf8')], ['in 5\n', 'ans 5\n']);
  for (const gone of ['tests/manual/3.in', 'tests/manual/5.in', 'tests/manual/5.ans', 'statement/en/samples/3.tex', 'statement/en/samples/5.tex']) await assert.rejects(fs.access(path.join(p.dir, gone)), gone);
  assert.equal(await fs.readFile(path.join(p.dir, 'statement/en/samples/2.tex'), 'utf8'), 'note of 5\n');
  const config = (await registry.detail(p.id)).config!;
  assert.equal(config.tests.samples, '1-2');
  assert.deepEqual(config.tests.cases, { 2: { time_limit: 2000 }, 4: { time_limit: 3000 } });
  // g2 lost all its tests and was removed: g3 now depends on g1; the sum group g1 lost the points of test 2.
  assert.deepEqual(config.tests.group!.map(g => [g.name, g.tests, g.points, g.dependencies ?? []]), [['g1', '1', 10, []], ['g3', '2-5', 50, ['g1']]]);
  // Restoring original answers puts test 5's answer on the test that is now number 2.
  ctx = await judge.ctx(p.id);
  const baseline = (await readOriginalAnswers(p.dir, requireTestset(ctx)))!;
  assert.deepEqual(baseline.entries.map(e => [e.input, e.output, e.backup]), [['tests/manual/1.in', 'tests/manual/1.ans', '1.ans'], ['tests/manual/2.in', 'tests/manual/2.ans', '5.ans']]);
}));

test('a template script whose targets cannot be rewritten keeps its numbers and reports the gap', async () => fixture(async ({ registry, judge }) => {
  const p = await registry.create({ name: 'templated' });
  await fs.rm(path.join(p.dir, 'tests'), { recursive: true });
  for (const [file, text] of Object.entries({ 'manual/1.in': '1\n', 'manual/2.in': '2\n', 'script.txt': '<#list 3..3 as i>\ngen x > ${i}\n</#list>\n' })) {
    await fs.mkdir(path.dirname(path.join(p.dir, 'tests', file)), { recursive: true }); await fs.writeFile(path.join(p.dir, 'tests', file), text);
  }
  const result = await removeTests(await judge.ctx(p.id), [{ index: 1, source: 'tests/manual/1.in' }]);
  assert.deepEqual([result.removed, result.renumbered, result.gaps], [[1], 0, true]);
  assert.deepEqual(await sources(judge, p.id), ['2:tests/manual/2.in', '3:gen x > 3']);
}));

test('a batch changes nothing when one test is stale, unknown or comes from a template loop', async () => fixture(async ({ registry, judge, call }) => {
  const p = await problem(registry);
  const before = await sources(judge, p.id), script = await fs.readFile(path.join(p.dir, 'tests/script.txt'), 'utf8');
  const unchanged = async () => {
    assert.deepEqual(await sources(judge, p.id), before);
    assert.equal(await fs.readFile(path.join(p.dir, 'tests/script.txt'), 'utf8'), script);
    await fs.access(path.join(p.dir, 'tests/manual/01.in'));
  };
  let response = await call('DELETE', `/api/problems/${p.id}/tests`, { tests: [{ index: 1, source: 'tests/manual/01.in' }, { index: 4, source: 'gen 1 > $' }] });
  assert.equal(response.statusCode, 409); assert.match(response.json().message, /Test 4 is now gen 2 > \$, not gen 1 > \$/);
  await unchanged();
  response = await call('DELETE', `/api/problems/${p.id}/tests`, { tests: [{ index: 1, source: 'tests/manual/01.in' }, { index: 9, source: 'gen 9 > $' }] });
  assert.equal(response.statusCode, 404); await unchanged();
  for (const body of [{}, { tests: [] }, { tests: [{ index: 0, source: 'x' }] }, { tests: [{ index: 1 }] }]) assert.equal((await call('DELETE', `/api/problems/${p.id}/tests`, body)).statusCode, 400);
  await unchanged();
  const looped = await registry.create({ name: 'looped' });
  await fs.writeFile(path.join(looped.dir, 'tests/script.txt'), '<#list 1..2 as i>\ngen ${i} > $\n</#list>\ngen 9 > $\n');
  const ctx = await judge.ctx(looped.id);
  await assert.rejects(removeTests(ctx, [{ index: 4, source: 'gen 9 > $' }, { index: 2, source: 'gen 1 > $' }]), /template loop/);
  assert.match(await fs.readFile(path.join(looped.dir, 'tests/script.txt'), 'utf8'), /gen 9 > \$/);
  // The single removal shares the batch logic and keeps its result shape.
  response = await call('DELETE', `/api/problems/${p.id}/tests/2?source=${encodeURIComponent('tests/manual/02.in')}`);
  assert.equal(response.statusCode, 200, response.body); assert.deepEqual([response.json().kind, response.json().removed], ['manual', [2]]);
}));
