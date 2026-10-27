/** Reproducible I/O benchmark: first load, unchanged refresh, then concurrent readers. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { GlobalStore } from '../src/global.js';
import { ProblemRegistry } from '../src/workspace/problems.js';
import { Judge } from '../src/judge/index.js';
import { WsHub } from '../src/ws.js';
import { readManifest } from '../src/judge/tests.js';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-data-bench-'));
const originalRead = fs.readFile;
let reads = 0, bytes = 0;
try {
  const global = new GlobalStore(home); await global.init(); global.config.problems.roots = [path.join(home, 'problems')];
  const registry = new ProblemRegistry(global), judge = new Judge(global, registry, new WsHub());
  const problem = await registry.create({ name: 'benchmark', dataOnly: true });
  const data = Buffer.alloc(256 * 1024, 65);
  for (let i = 1; i <= 128; i++) for (const extension of ['in', 'ans']) await fs.writeFile(path.join(problem.dir, 'tests/manual', `${i}.${extension}`), data);
  const ctx = await judge.ctx(problem.id);
  // Instrument public fs calls rather than relying on a machine-specific timing threshold.
  fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
    const result = await (originalRead as (...args: any[]) => Promise<Buffer | string>)(...args);
    if (/\.(in|ans|out)$/.test(String(args[0]))) { reads++; bytes += Buffer.byteLength(result); }
    return result;
  }) as typeof fs.readFile;
  for (const [name, count] of [['first load', 1], ['unchanged refresh', 1], ['three concurrent readers', 3]] as const) {
    reads = 0; bytes = 0; const start = performance.now();
    const manifests = await Promise.all(Array.from({ length: count }, () => readManifest(ctx)));
    if (manifests.some(m => m?.tests.length !== 128)) throw new Error('Missing tests');
    console.log(`${name}: ${Math.round(performance.now() - start)} ms, ${reads} full-file reads, ${(bytes / 1024 / 1024).toFixed(1)} MiB read`);
    if (process.argv.includes('--assert-cached') && name !== 'first load' && reads !== 0) throw new Error('Unchanged compatibility data must not be reread in full.');
  }
} finally { fs.readFile = originalRead; await fs.rm(home, { recursive: true, force: true }); }
