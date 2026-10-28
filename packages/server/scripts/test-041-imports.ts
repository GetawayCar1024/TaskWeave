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
import { JobManager } from '../src/jobs.js';
import { WsHub } from '../src/ws.js';
import { buildApp } from '../src/app.js';
import { ZipWriter } from '../src/util/zip.js';

type Call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object | Buffer) => Promise<LightMyRequestResponse>;
async function fixture(run: (ctx: { home: string; registry: ProblemRegistry; call: Call }) => Promise<void>) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tw041-import-')));
  const global = new GlobalStore(home); await global.init(); global.config.problems.roots = [path.join(home, 'problems')];
  const registry = new ProblemRegistry(global), contests = new ContestRegistry(registry, global), hub = new WsHub();
  const files = new FileService(new SelfWrites()), watcher = new ProblemWatcher(registry, files, hub), judge = new Judge(global, registry, hub);
  const app = await buildApp({ global, registry, contests, hub, files, watcher, judge, jobs: new JobManager(hub), token: 'fixture' });
  const call: Call = (method, url, payload) => app.inject({ method, url, payload, headers: { host: 'localhost', 'x-polyforge-token': 'fixture', ...(Buffer.isBuffer(payload) ? { 'content-type': 'application/zip' } : {}) } });
  try { await run({ home, registry, call }); }
  finally { await watcher.stop(); await app.close(); await fs.rm(home, { recursive: true, force: true }); }
}
const zip = (files: Record<string, string>) => { const z = new ZipWriter(); Object.entries(files).forEach(([file, value]) => z.add(file, value)); return z.finish(); };

test('auto detection reports the concrete format and uses it for the staged import', async () => fixture(async ({ call }) => {
  const response = await call('POST', '/api/packages/uploads?format=auto', zip({ '1.in': '1', '1.out': '2' }));
  assert.equal(response.statusCode, 200, response.body);
  const upload = response.json(); assert.equal(upload.format, 'data');
  const imported = await call('POST', '/api/packages/import', { items: [{ uploadId: upload.id, format: upload.format, entry: '', name: 'automatic' }] });
  assert.equal(imported.statusCode, 200, imported.body); assert.equal(imported.json().items[0].result.tests, 1);
}));

test('an unpacked folder imports like a ZIP and the compatibility manifest is ready when import returns', async () => fixture(async ({ home, call }) => {
  const directory = path.join(home, 'already unpacked'); await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, '01.in'), '7\n'); await fs.writeFile(path.join(directory, '01.out'), 'answer\r\n');
  const staged = await call('POST', '/api/packages/directories', { path: directory, format: 'auto' });
  assert.equal(staged.statusCode, 200, staged.body);
  const upload = staged.json();
  const response = await call('POST', '/api/packages/import', { items: [{ uploadId: upload.id, format: upload.format, entry: '', name: 'folder-import' }] });
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json().items[0].result; assert.ok(result, response.body);
  const manifest = JSON.parse(await fs.readFile(path.join(result.problem.dir, '.polyforge/tests/manifest.json'), 'utf8'));
  assert.equal(manifest.ok, true); assert.equal(manifest.tests.length, 1);
  assert.equal(manifest.tests[0].originalInput, '01.in');
  assert.equal(await fs.readFile(path.join(result.problem.dir, '.polyforge/tests/1.ans'), 'utf8'), 'answer\r\n');
  assert.equal(await fs.readFile(path.join(directory, '01.out'), 'utf8'), 'answer\r\n');
}));

test('compatibility ZIP imports materialize the initial scan before returning', async () => fixture(async ({ call }) => {
  const response = await call('POST', '/api/problems/import/package?format=data&name=scanned', zip({ '1.in': '3', '1.out': '6' }));
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json();
  const manifest = JSON.parse(await fs.readFile(path.join(result.problem.dir, '.polyforge/tests/manifest.json'), 'utf8'));
  assert.equal(manifest.ok, true); assert.equal(manifest.tests.length, 1);
}));
