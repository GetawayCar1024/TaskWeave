/** Exercise the actual DELETE API with data and build files on a different volume. */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { GlobalStore } from '../src/global.js';
import { ProblemRegistry } from '../src/workspace/problems.js';
import { ContestRegistry } from '../src/workspace/contests.js';
import { FileService, SelfWrites } from '../src/workspace/files.js';
import { ProblemWatcher } from '../src/workspace/watcher.js';
import { Judge } from '../src/judge/index.js';
import { JobManager } from '../src/jobs.js';
import { WsHub } from '../src/ws.js';
import { buildApp } from '../src/app.js';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-recycle-home-'));
const root = await fs.mkdtemp(path.join(process.cwd(), '.pf-recycle-bench-'));
const global = new GlobalStore(home); await global.init(); global.config.problems.roots = [root];
const registry = new ProblemRegistry(global), contests = new ContestRegistry(registry, global), hub = new WsHub();
const files = new FileService(new SelfWrites()), watcher = new ProblemWatcher(registry, files, hub), judge = new Judge(global, registry, hub);
const app = await buildApp({ global, registry, contests, hub, judge, files, watcher, jobs: new JobManager(hub), token: 'test-only' });
const copy = fs.cp;
let copies = 0;
try {
  const p = await registry.create({ name: 'recycle-speed', dataOnly: true });
  const data = Buffer.alloc(128 * 1024, 65);
  for (let i = 1; i <= 256; i++) for (const ext of ['in', 'ans']) await fs.writeFile(path.join(p.dir, 'tests/manual', `${i}.${ext}`), data);
  if (process.argv.includes('--watch')) await watcher.start();
  fs.cp = (async (...args: Parameters<typeof fs.cp>) => { copies++; return copy(...args); }) as typeof fs.cp;
  const start = performance.now();
  const result = await app.inject({ method: 'DELETE', url: `/api/problems/${p.id}`, headers: { host: 'localhost', 'x-taskweave-token': 'test-only' } });
  assert.equal(result.statusCode, 200, result.body);
  console.log(JSON.stringify({ files: 512, sizeMiB: 64, milliseconds: Math.round(performance.now() - start), directoryCopies: copies, watcher: process.argv.includes('--watch') }));
  assert.equal(await fs.readFile(path.join(result.json().trash, 'tests/manual/256.ans'), 'utf8').then(text => text.length), data.length);
  if (process.argv.includes('--assert-fast')) assert.equal(copies, 0, 'Recycling must move data on its own volume, not copy every file to the global directory.');
} finally {
  fs.cp = copy; await watcher.stop(); await app.close();
  await fs.rm(root, { recursive: true, force: true }); await fs.rm(home, { recursive: true, force: true });
}
