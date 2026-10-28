import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { LightMyRequestResponse } from 'fastify';
import { GlobalStore } from '../src/global.js';
import { ProblemRegistry } from '../src/workspace/problems.js';
import { ContestRegistry } from '../src/workspace/contests.js';
import { FileService, SelfWrites } from '../src/workspace/files.js';
import { ProblemWatcher } from '../src/workspace/watcher.js';
import { Judge } from '../src/judge/index.js';
import { WsHub } from '../src/ws.js';
import { JobManager } from '../src/jobs.js';
import { buildApp } from '../src/app.js';
import { atomicWrite, exists } from '../src/util/fs.js';
import { readZip } from '../src/util/zip.js';

async function fixture(run: (ctx: { home: string; registry: ProblemRegistry; contests: ContestRegistry; watcher: ProblemWatcher; call: (method: 'GET' | 'PATCH', url: string, body?: object) => Promise<LightMyRequestResponse> }) => Promise<void>) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pf-name-folder-')));
  const global = new GlobalStore(home); await global.init(); global.config.problems.roots = [path.join(home, 'problems')];
  const registry = new ProblemRegistry(global), contests = new ContestRegistry(registry, global), hub = new WsHub();
  const files = new FileService(new SelfWrites()), watcher = new ProblemWatcher(registry, files, hub), judge = new Judge(global, registry, hub);
  const app = await buildApp({ global, registry, contests, hub, files, watcher, judge, jobs: new JobManager(hub), token: 'test-only' });
  try { await run({ home, registry, contests, watcher, call: (method, url, payload) => app.inject({ method, url, payload, headers: { host: 'localhost', 'x-taskweave-token': 'test-only' } }) }); }
  finally { await watcher.stop(); await app.close(); await fs.rm(home, { recursive: true, force: true }); }
}

test('short-name edits rename the folder and preserve contest references, files, history and answer backups', async () => fixture(async ({ registry, contests, watcher, call }) => {
  const p = await registry.create({ name: 'old-folder', dataOnly: true });
  await atomicWrite(path.join(p.dir, 'tests/manual/1.in'), 'input');
  await atomicWrite(path.join(p.dir, '.taskweave/answers-original/original.bin'), Buffer.from([0, 255, 10]));
  await atomicWrite(path.join(p.dir, '.taskweave/ai/history.json'), '{"keep":true}');
  const contest = await contests.create({ name: 'round', problems: [{ index: 'A', problem: p.id }] });
  await watcher.start();
  const response = await call('PATCH', `/api/problems/${p.id}`, { name: 'new-folder', title: { en: 'Renamed' } });
  assert.equal(response.statusCode, 200, response.body);
  const detail = response.json();
  assert.equal(path.basename(detail.summary.dir), 'new-folder');
  assert.equal(detail.summary.name, 'new-folder'); assert.equal(detail.summary.id, p.id);
  assert.equal(await exists(p.dir), false);
  assert.equal((await call('GET', `/api/problems/${p.id}/files/tests/manual/1.in`)).json().content, 'input');
  assert.deepEqual(await fs.readFile(path.join(detail.summary.dir, '.taskweave/answers-original/original.bin')), Buffer.from([0, 255, 10]));
  assert.equal(await fs.readFile(path.join(detail.summary.dir, '.taskweave/ai/history.json'), 'utf8'), '{"keep":true}');
  assert.equal((await contests.detail(contest.id)).problems[0].summary?.dir, detail.summary.dir);
  assert.equal(watcher.running, true);
  assert.equal((await registry.scan()).find(ref => ref.id === p.id)?.dir, detail.summary.dir);
  let tex = await call('GET', `/api/problems/${p.id}/tex?lang=en`);
  assert.equal(tex.statusCode, 200);
  assert.equal(tex.headers['content-disposition'], 'attachment; filename="new-folder-statements-en.tex"');
  await atomicWrite(path.join(detail.summary.dir, 'statement/en/legend.tex'), 'Diagram: \\includegraphics{diagram.png}');
  await atomicWrite(path.join(detail.summary.dir, 'statement/images/diagram.png'), 'image bytes');
  tex = await call('GET', `/api/problems/${p.id}/tex?lang=en`);
  assert.equal(tex.headers['content-disposition'], 'attachment; filename="new-folder-statements-en.zip"');
  assert.ok(readZip(tex.rawPayload).has('new-folder-statements-en.tex'));
}));

test('rename rejects occupied folders and invalid combined patches before changing files', async () => fixture(async ({ registry, call }) => {
  const p = await registry.create({ name: 'unchanged', dataOnly: true });
  const target = path.join(p.root, 'occupied'); await fs.mkdir(target); await fs.writeFile(path.join(target, 'keep.txt'), 'user file');
  let response = await call('PATCH', `/api/problems/${p.id}`, { name: 'occupied' });
  assert.equal(response.statusCode, 409); assert.equal((await registry.detail(p.id)).summary.name, 'unchanged');
  assert.equal(await fs.readFile(path.join(target, 'keep.txt'), 'utf8'), 'user file');
  response = await call('PATCH', `/api/problems/${p.id}`, { name: 'invalid-update', timeLimit: -1 });
  assert.equal(response.statusCode, 400); assert.equal(await exists(p.dir), true);
  assert.equal(await exists(path.join(p.root, 'invalid-update')), false);
}));

test('failed directory moves roll back the short-name update; legacy mismatches can be synchronized', async () => fixture(async ({ registry }) => {
  const p = await registry.create({ name: 'original', dataOnly: true }), configFile = path.join(p.dir, 'problem.toml');
  const before = await fs.readFile(configFile, 'utf8');
  const rename = fs.rename;
  fs.rename = async (from, to) => { if (String(from) === p.dir) throw new Error('injected directory lock'); return rename(from, to); };
  try { await assert.rejects(registry.patch(p.id, { name: 'locked-name' }), /injected directory lock/); }
  finally { fs.rename = rename; }
  assert.equal(await fs.readFile(configFile, 'utf8'), before);
  await fs.writeFile(configFile, before.replace('name = "original"', 'name = "legacy-short"'));
  const fixed = await registry.patch(p.id, { name: 'legacy-short' });
  assert.equal(path.basename(fixed.summary.dir), 'legacy-short');
  assert.equal(fixed.summary.id, p.id);
}));
