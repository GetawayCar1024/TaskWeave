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
import { planTests, removeTests } from '../src/judge/tests.js';

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
  assert.deepEqual([result.removed, result.manual, result.lines], [[1, 3, 5, 6], 1, 2]);
  assert.equal(await fs.readFile(path.join(p.dir, 'tests/script.txt'), 'utf8'), 'gen 2 > $\ngen 3 > $\n');
  for (const gone of ['manual/01.in', 'manual/01.statement.in', '_statement/03.in']) await assert.rejects(fs.access(path.join(p.dir, 'tests', gone)));
  // "$" tests moved down; their sample marks moved with them and were saved.
  assert.deepEqual(await sources(judge, p.id), ['1:gen 2 > $', '2:tests/manual/02.in', '3:gen 3 > $']);
  assert.deepEqual([result.samples, result.largeSamples], ['1-3', '3']);
  const config = (await registry.detail(p.id)).config!;
  assert.deepEqual([config.tests.samples, config.tests.large_samples], ['1-3', '3']);
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
