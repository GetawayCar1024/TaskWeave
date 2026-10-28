import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { GlobalStore } from '../src/global.js';
import { ProblemRegistry } from '../src/workspace/problems.js';
import { ContestRegistry } from '../src/workspace/contests.js';
import { Judge } from '../src/judge/index.js';
import { WsHub } from '../src/ws.js';
import { AgentService } from '../src/ai/agent.js';
import { moveProblem } from '../src/workspace/move.js';
import { importContest } from '../src/judge/contest.js';
import { buildAndVerify } from '../src/polygon/buildPackage.js';
import { lintStatement } from '@taskweave/shared';
import { Sandbox } from '../src/ai/sandbox.js';
import { runInvocation, readInvocation } from '../src/judge/invocation.js';

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-oct-'));
  const global = new GlobalStore(home); await global.init();
  global.config.problems.roots = [path.join(home, 'problems')];
  const registry = new ProblemRegistry(global), contests = new ContestRegistry(registry, global);
  const judge = new Judge(global, registry, new WsHub());
  return { home, global, registry, contests, judge };
}
const job = () => ({ signal: new AbortController().signal, progress() {} });

test('moving a problem preserves stable identity, history and contest references across rescans', async () => {
  const f = await fixture();
  try {
    const p = await f.registry.create({ name: 'sum' });
    const c = await f.contests.create({ name: 'round', problems: [{ index: 'A', problem: p.id }] });
    await fs.writeFile(path.join(p.dir, '.taskweave/history.json'), 'history');
    const target = path.join(f.home, 'another');
    const moved = await moveProblem(f.registry, p.id, target);
    assert.equal(moved.id, p.id);
    assert.equal(await fs.readFile(path.join(moved.dir, '.taskweave/history.json'), 'utf8'), 'history');
    assert.equal((await f.contests.detail(c.id)).problems[0].summary?.id, p.id);
    const other = await f.registry.create({ name: 'sum', root: f.global.config.problems.roots[0] });
    assert.notEqual(other.id, moved.id);
    assert.equal((await new ProblemRegistry(f.global).get(p.id)).dir, moved.dir);
    await assert.rejects(moveProblem(f.registry, p.id, f.global.config.problems.roots[0]), /already exists/);
    await assert.rejects(moveProblem(f.registry, p.id, path.join(moved.dir, 'nested')), /cannot be a problem root/);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test('fenced code conversion preserves code bytes and blank lines; incomplete fences are not altered', () => {
  const code = 'if (x <= 3) {\n  puts("hello");\n\n\n}\n';
  const result = lintStatement('Text\n\n```cpp\n' + code + '```\n', { lang: 'en' });
  assert.ok(result.fixed.includes('\\begin{verbatim}\n' + code + '\\end{verbatim}'));
  assert.ok(result.issues.some(i => i.rule === 'md-code-block' && i.fixable));
  const incomplete = lintStatement('```cpp\n' + code, { lang: 'en' });
  assert.equal(incomplete.fixed, '```cpp\n' + code);
  assert.ok(incomplete.issues.some(i => !i.fixable));
});

test('accepting all language deletions prunes its empty directory and never deletes the problem root', async () => {
  const f = await fixture();
  try {
    const p = await f.registry.create({ name: 'language' });
    const sandbox = new Sandbox(p.dir, path.join(f.home, 'sandbox'), new Set()); await sandbox.sync();
    await assert.rejects(sandbox.remove('.'), /root|allowed/);
    await sandbox.remove('statement/zh');
    const changes = await sandbox.changes();
    assert.ok(changes.length > 0);
    await sandbox.accept(changes.map(c => c.path));
    await assert.rejects(fs.access(path.join(p.dir, 'statement/zh')));
    await fs.access(path.join(p.dir, 'problem.toml'));
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test('contest import refuses a partial contest, reuses successes on retry and honors the chosen root', async () => {
  const f = await fixture();
  try {
    let fail = true;
    const destination = path.join(f.home, 'selected');
    const calls: number[] = [];
    const sync = {
      client: async () => ({ call: async () => ({ A: { id: 1, name: 'Same Name' }, B: { id: 2, name: 'Same Name' } }) }),
      importProblem: async (req: any) => { calls.push(req.polygonId); if (req.polygonId === 2 && fail) throw new Error('remote denied'); const p = await f.registry.create({ name: req.name, root: req.root }); await f.registry.patch(p.id, { polygonId: req.polygonId }); return (await f.registry.detail(p.id)).summary; },
    } as any;
    const request = { contestId: 1, name: 'import-round', root: destination };
    await assert.rejects(importContest({ judge: f.judge, contests: f.contests, sync }, request, job()), /Imported 1\/2[\s\S]*remote denied/);
    assert.equal((await f.contests.list()).length, 0);
    fail = false;
    const result = await importContest({ judge: f.judge, contests: f.contests, sync }, request, job());
    assert.equal(result.contest.problems.length, 2);
    assert.deepEqual(calls, [1, 2, 2]);
    for (const p of await f.registry.list()) assert.equal(path.resolve(p.root), await fs.realpath(destination));
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test('Polygon asynchronous build failure is surfaced with compiler guidance', async () => {
  let calls = 0;
  const client = { call: async (method: string) => method === 'problem.buildPackage' ? undefined : (++calls === 1 ? [] : [{ id: 5, state: 'FAILED', comment: '__int128 is not supported' }]) } as any;
  assert.match((await buildAndVerify(client, 123, false, job())).join(' '), /failed[\s\S]*__int128[\s\S]*64-bit/);
});

test('an unavailable Polygon package baseline cannot report an old package as success', async () => {
  let built = false;
  const client = { call: async (method: string) => { if (method === 'problem.buildPackage') { built = true; return; } throw new Error('unavailable'); } } as any;
  assert.match((await buildAndVerify(client, 123, false, job())).join(' '), /could not be verified/);
  assert.equal(built, true);
});

test('batch invocation publishes a test grid before compiling and incremental results', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    const p = await f.registry.create({ name: 'batch' });
    const src = path.join(p.dir, 'solutions/std.cpp');
    const original = await fs.readFile(src, 'utf8');
    await fs.writeFile(src, original.replace('int main() {', 'int main() { volatile unsigned long long x = 1; for (unsigned long long i = 0; i < 240000000; i++) x = x * 1664525 + 1013904223;'));
    await fs.copyFile(src, path.join(p.dir, 'solutions/other.cpp'));
    const ctx = await f.judge.ctx(p.id);
    let id = '';
    const phases: string[] = [];
    const snapshots: Promise<void>[] = [];
    let gridBeforeCompile = false, incremental = false;
    const j = { signal: new AbortController().signal, progress(done: number, total: number, message?: string) {
      phases.push(message ?? '');
      if (id && (message === 'compiling solutions' || (message === 'running' && done > 0 && done < total))) snapshots.push(readInvocation(ctx, id).then(inv => {
        if (message === 'compiling solutions') gridBeforeCompile = inv.tests.length > 0 && inv.cells.length === 2;
        else if (inv.cells.flat().some(Boolean) && inv.cells.flat().some(c => c === null)) incremental = true;
      }));
    } };
    await runInvocation(f.judge, ctx, ['solutions/std.cpp', 'solutions/other.cpp'], undefined, j, value => { id = value; });
    await Promise.all(snapshots);
    const result = await readInvocation(ctx, id);
    assert.equal(result.status, 'done');assert.ok(gridBeforeCompile);assert.ok(incremental);
    assert.ok(result.cells.flat().every(c => c?.verdict === 'OK'));
    assert.ok(phases.includes('compiling solutions'));
    assert.ok(result.cells.flat().every(c => c && c.timeMs >= 0 && c.wallMs !== undefined));
    assert.ok(result.cells.flat().some(c => c && c.timeMs > 0));
    console.log('Batch CPU/wall ms:', result.cells.flat().map(c => [c?.timeMs, c?.wallMs]));
    const sleeper = 'solutions/sleep.cpp';
    await fs.writeFile(path.join(p.dir, sleeper), '#include <windows.h>\nint main(){Sleep(300);}');
    const prog = await f.judge.require(ctx, sleeper, 'Solution');
    const timing = await f.judge.runner.run({argv:prog.argv,build:prog.build,cwd:p.dir,timeLimitMs:1000,wallLimitMs:3000});
    assert.ok(timing.wallMs >= 250);assert.ok(timing.timeMs < timing.wallMs / 2);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test('stopping a streaming AI turn keeps received text after reloading the session', { timeout: 20000 }, async () => {
  const f = await fixture();
  let resolveText!: () => void;
  const textReceived = new Promise<void>(r => resolveText = r);
  const hub = new WsHub();
  hub.broadcast = event => { if (event.type === 'ai:event' && event.event.type === 'text') resolveText(); };
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta: { role: 'assistant', content: 'Already received text.' }, finish_reason: null }] }) + '\n\n');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const agent = new AgentService(f.judge, hub, f.contests);
  try {
    await f.global.saveAiEndpoints([{ name: 'mock', protocol: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test', models: ['test'] }]);
    const p = await f.registry.create({ name: 'stream' });
    const session = await agent.create(p.id, { endpoint: 'mock', model: 'test' });
    await agent.send(p.id, session.id, 'hello');
    await textReceived;
    await agent.stopAll();
    const saved = await new AgentService(f.judge, hub, f.contests).get(p.id, session.id);
    assert.ok(saved.transcript.some(t => t.kind === 'assistant' && t.text === 'Already received text.'));
    assert.ok(saved.transcript.some(t => t.kind === 'notice' && /Stopped/.test(t.text)));
  } finally { await agent.stopAll(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await fs.rm(f.home, { recursive: true, force: true }); }
});
