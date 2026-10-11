import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileService, SelfWrites } from '../src/workspace/files.js';
import { GlobalStore } from '../src/global.js';
import { ProblemRegistry } from '../src/workspace/problems.js';
import { PolygonSync } from '../src/polygon/sync.js';
import { Sandbox } from '../src/ai/sandbox.js';
import { Judge } from '../src/judge/index.js';
import { WsHub } from '../src/ws.js';
import { JobManager } from '../src/jobs.js';
import { ContestRegistry } from '../src/workspace/contests.js';
import { ProblemWatcher } from '../src/workspace/watcher.js';
import { buildApp } from '../src/app.js';
import { quickRun } from '../src/judge/quickrun.js';
import { applyItem, itemHash, pushItem } from '../src/polygon/items.js';
import { runStress } from '../src/judge/stress.js';
import { renderMarkdown } from '../../web/src/lib/markdown.js';
import { verifyBuild, withBuildLocks } from '../src/judge/buildLock.js';

test('Markdown renders tables and links while escaping untrusted HTML', () => {
  const html = renderMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |\n\n[docs](https://example.com)\n<script>alert(1)</script>\n[x](javascript:alert(1))');
  assert.match(html, /<table>/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('href="javascript:'));
});

test('root paths are canonical before starting the Windows watcher', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-watch-'));
  let watcher: ProblemWatcher | undefined;
  try {
    const global = new GlobalStore(dir);
    await global.init();
    const root = path.join(dir, 'problems');
    await fs.mkdir(root);
    await global.saveConfig({ ...global.config, problems: { roots: [root] } });
    assert.equal(global.config.problems.roots[0], realpathSync.native(root));
    const registry = new ProblemRegistry(global);
    watcher = new ProblemWatcher(registry, new FileService(new SelfWrites()), new WsHub());
    await watcher.start();
    await registry.create({ name: 'watched-problem' });
    await new Promise(r => setTimeout(r, 350));
    await watcher.stop();
  } finally { await watcher?.stop(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('one executable per source across edits, failures, concurrent requests and legacy migration', { timeout: 60_000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-cache-'));
  try {
    const global = new GlobalStore(dir);
    await global.init();
    global.config.problems.roots = [path.join(dir, 'problems')];
    const registry = new ProblemRegistry(global);
    const p = await registry.create({ name: 'cache-test' });
    const judge = new Judge(global, registry, new WsHub());
    const source = 'solutions/cache.cpp';
    const compile = async (value: number) => {
      await fs.writeFile(path.join(p.dir, source), `int main(){return ${value};}`);
      const result = await judge.compile(await judge.ctx(p.id), source);
      assert.ok(result.program, result.result.log);
      return result.program!;
    };
    const first = await compile(0);
    const second = await compile(1);
    assert.equal(first.argv[0], second.argv[0], 'edits must reuse the same executable path');
    assert.notEqual(first.hash, second.hash);
    await assert.rejects(verifyBuild(first.build), /source changed/);
    await verifyBuild(second.build);
    const build = path.join(p.dir, '.polyforge', 'build');
    assert.deepEqual(await fs.readdir(build), [path.basename(first.build!.dir)]);
    const concurrent = await Promise.all(Array.from({ length: 4 }, async () => judge.compile(await judge.ctx(p.id), source)));
    assert.ok(concurrent.every(r => r.result.cached && r.program?.hash === second.hash));
    const languageChange = await judge.compiler.compile(p.dir, source, 'cpp20');
    assert.ok(languageChange.program, languageChange.result.log);
    assert.equal(languageChange.program.argv[0], second.argv[0]);
    assert.deepEqual(await fs.readdir(build), [path.basename(first.build!.dir)]);
    // An identically named source in another folder must not alias this slot.
    await fs.writeFile(path.join(p.dir, 'generators/cache.cpp'), 'int main(){return 1;}');
    const other = await judge.compile(await judge.ctx(p.id), 'generators/cache.cpp');
    assert.notEqual(other.program?.argv[0], second.argv[0]);
    await fs.writeFile(path.join(p.dir, source), 'this does not compile');
    const failed = await judge.compile(await judge.ctx(p.id), source);
    assert.equal(failed.result.ok, false);
    assert.equal(failed.program, undefined);
    await assert.rejects(fs.access(second.argv[0]));
    await compile(0);
    // Simulate a content-addressed directory left by an older PolyForge version.
    const legacy = path.join(build, '0123456789abcdef');
    await fs.mkdir(legacy);
    await fs.writeFile(path.join(legacy, 'compile.json'), JSON.stringify({ source: first.srcPath, ok: true, log: '' }));
    await fs.writeFile(path.join(legacy, 'cache.exe'), 'legacy');
    judge.compiler.canPrune = () => true;
    await new Promise(r => setTimeout(r, 1300));
    await judge.compiler.waitForMaintenance();
    const dirs = await fs.readdir(build);
    assert.deepEqual(dirs.sort(), [path.basename(first.build!.dir), path.basename(other.program!.build!.dir)].sort());
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('rebuilding a slot waits for a running executable to finish', async () => {
  const dir = path.join(os.tmpdir(), 'pf-lock-test');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  const run = withBuildLocks([dir], async () => { order.push('run'); await held; order.push('finished'); }, 'read');
  const run2 = withBuildLocks([dir], async () => { order.push('run2'); await held; }, 'read');
  const compile = withBuildLocks([dir], async () => { order.push('compile'); });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['run', 'run2']);
  release();
  await Promise.all([run, run2, compile]);
  assert.deepEqual(order, ['run', 'run2', 'finished', 'compile']);
});

test('AI directory deletion reviews every child; scratch persists but never enters change set', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-ai-'));
  try {
    const real = path.join(dir, 'real');
    await fs.mkdir(path.join(real, 'nested'), { recursive: true });
    await fs.writeFile(path.join(real, 'nested', 'a.txt'), 'original');
    const sb = new Sandbox(real, path.join(dir, 'work'), new Set());
    await sb.sync();
    await sb.write('scratch/temp.cpp', 'int main() {}');
    await sb.sync();
    assert.equal((await sb.read('scratch/temp.cpp')).toString(), 'int main() {}');
    assert.deepEqual(await sb.changes(), []);
    await sb.remove('nested');
    assert.deepEqual((await sb.changes()).map(c => c.path), ['nested/a.txt']);
    await sb.accept(['nested/a.txt']);
    await assert.rejects(fs.access(path.join(real, 'nested', 'a.txt')));
    await sb.clearScratch();
    await assert.rejects(sb.read('scratch/temp.cpp'));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('Polygon compiler selection changes the sync hash; solutions use Solution files', async () => {
  const item = { key: 'solution:1.cpp', kind: 'solution' as const, label: '1.cpp', text: 'int main() {}', meta: { tag: 'OK' }, extra: { name: '1.cpp', sourceType: 'cpp.g++17' } };
  assert.notEqual(itemHash(item), itemHash({ ...item, extra: { ...item.extra, sourceType: 'cpp.g++20' } }));
  const methods: string[] = [];
  await pushItem({ client: { call: async (method: string) => { methods.push(method); } } as never, problemId: 1, warn: () => {} }, item);
  assert.deepEqual(methods, ['problem.saveSolution']);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-language-'));
  try {
    const doc: Record<string, any> = {};
    await applyItem({ dir, doc, written: new Set(), sourceLanguages: { 'cpp.g++17': 'cpp17' } }, item);
    assert.equal(doc.source_languages['solutions/1.cpp'], 'cpp17');
    assert.equal(doc.polygon_source_types['solutions/1.cpp'], 'cpp.g++17');
    doc.solutions[0].tag = 'MA';
    await applyItem({ dir, doc, written: new Set() }, { ...item, meta: { tag: 'MA' }, extra: { name: 'other.cpp', sourceType: 'remote-only-compiler' } });
    assert.deepEqual(doc.solutions.filter((s: any) => s.tag === 'MA').map((s: any) => s.source), ['solutions/other.cpp']);
    assert.equal(doc.polygon_source_types['solutions/other.cpp'], 'remote-only-compiler');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
  const sent: { method: string; params: any }[] = [];
  const pc = { client: { call: async (method: string, params: any) => { sent.push({ method, params }); } } as never, problemId: 1, warn: () => {} };
  await pushItem(pc, { key: 'sample:1', kind: 'sample', label: 'sample', extra: { index: 1 }, meta: {} });
  assert.equal(sent[0].params.testInputForStatements, '');
  assert.equal(sent[0].params.testOutputForStatements, '');
  await pushItem(pc, { key: 'testset:pretests', kind: 'testset', label: 'pretests', extra: { testset: 'pretests', content: { script: 'gen > 2', tests: { 1: 'input' }, groupsEnabled: true, groups: [{ name: 'small', pointsPolicy: 'COMPLETE_GROUP', dependencies: [], tests: '1-2' }], points: { 1: 10 } } } });
  assert.ok(sent.some(c => c.method === 'problem.saveScript' && c.params.testset === 'pretests'));
  assert.ok(sent.some(c => c.method === 'problem.setTestGroup' && c.params.testIndices === '1,2'));
  assert.ok(sent.some(c => c.method === 'problem.saveTest' && c.params.testPoints === 10));
});

test('workspace API maintains roles, language folders, samples and validates custom runs', { timeout: 120_000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-api-'));
  const global = new GlobalStore(dir);
  await global.init();
  global.config.problems.roots = [path.join(dir, 'problems')];
  const registry = new ProblemRegistry(global);
  const hub = new WsHub();
  const files = new FileService(new SelfWrites());
  const watcher = new ProblemWatcher(registry, files, hub);
  const judge = new Judge(global, registry, hub);
  const jobs = new JobManager(hub);
  const contests = new ContestRegistry(registry, global);
  const app = await buildApp({ global, registry, contests, files, watcher, hub, judge, jobs, token: 'test-only' });
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH', url: string, payload?: object) => {
    const r = await app.inject({ method, url, payload, headers: { host: 'localhost', 'x-polyforge-token': 'test-only' } });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  try {
    const p = await registry.create({ name: 'api-test' });
    const base = `/api/problems/${p.id}`;
    await call('PUT', `${base}/files/solution/1.cpp`, { content: '#include <cstdio>\nint main(){ puts("0"); }', baseHash: '' });
    assert.equal((await registry.detail(p.id)).config!.solutions.find(s => s.source === 'solution/1.cpp')?.tag, 'OK');
    await call('POST', `${base}/move`, { from: 'solution/1.cpp', to: 'solution/2.cpp' });
    assert.equal((await registry.detail(p.id)).config!.solutions.some(s => s.source === 'solution/1.cpp'), false);
    await call('PATCH', base, { language: { source: 'solution/2.cpp', lang: 'cpp20' } });
    assert.equal(judge.langOf((await registry.detail(p.id)).config!, 'solution/2.cpp'), 'cpp20');
    await call('POST', `${base}/mkdir`, { path: 'statement/ja' });
    assert.ok((await registry.detail(p.id)).tree.find(f => f.name === 'statement')?.children?.find(f => f.name === 'ja')?.children?.some(f => f.name === 'legend.tex'));
    await fs.mkdir(path.join(p.dir, '.polyforge', 'tests'), { recursive: true });
    await fs.writeFile(path.join(p.dir, '.polyforge', 'tests', '1.in'), '3\n1 2 3\n');
    await fs.writeFile(path.join(p.dir, '.polyforge', 'tests', '1.ans'), '6\n');
    await fs.writeFile(path.join(p.dir, '.polyforge', 'tests', 'manifest.json'), JSON.stringify({ generatedAt: 'old', testset: 'tests', tests: [{ index: 1, origin: 'manual', source: 'tests/manual/01.in' }], errors: [], ok: true }));
    assert.equal((await call('GET', `${base}/files/.polyforge/tests/1.in`)).content, '3\n1 2 3\n');
    await call('PUT', `${base}/files/tests/manual/01.statement.out`, { content: 'override' });
    assert.equal((await call('GET', `${base}/tests/1/statement-out`)).content, 'override');
    await call('DELETE', `${base}/files/tests/manual/01.statement.out`);
    assert.equal((await call('GET', `${base}/tests/1/statement-out`)).content, '6\n');
    await call('PATCH', base, { samples: '' });
    assert.equal((await call('GET', `${base}/tests`)).tests[0].sample, undefined);
    assert.equal(jobs.list().length, 0, 'changing sample metadata must not schedule judging');
    await call('PUT', `${base}/files/files/extra.tex`, { content: '\\textbf{resource text}' });
    const sync = new PolygonSync(judge);
    const resource = await sync.itemContent(await judge.ctx(p.id), 'resource:extra.tex');
    assert.equal(resource.binary, false);
    assert.match(resource.local!, /resource text/);
    await registry.patch(p.id, { polygonId: 123 });
    const calls: { method: string; params: any }[] = [];
    let failSolution = true;
    sync.client = async () => ({
      call: async (method: string, params: any) => {
        calls.push({ method, params });
        if (method === 'problems.list') return [{ id: 123, revision: 1, name: p.name }];
        if (method === 'problem.saveSolution' && failSolution) throw new Error('remote compilation failed');
        return {};
      },
    }) as never;
    const syncJob = { signal: new AbortController().signal, progress: () => {} };
    await assert.rejects(sync.push(await judge.ctx(p.id), { keys: ['solution:std.cpp', 'statement:english:input'], commit: true, buildPackage: true }, syncJob), /Successful items are saved for retry/);
    assert.ok(calls.some(c => c.method === 'problem.saveStatement'), 'an independent statement is uploaded after a solution failure');
    assert.ok(!calls.some(c => c.method === 'problem.commitChanges' || c.method === 'problem.buildPackage'));
    failSolution = false;
    const diff = await sync.pushPreview(await judge.ctx(p.id));
    assert.equal(diff.items.find(i => i.key === 'statement:english:input')?.status, 'unchanged');
    assert.equal(diff.items.find(i => i.key === 'solution:std.cpp')?.status, 'new');
    await sync.push(await judge.ctx(p.id), { keys: ['solution:std.cpp'], commit: true, buildPackage: true, packageType: 'full' }, syncJob);
    assert.equal(calls.find(c => c.method === 'problem.buildPackage')?.params.full, true);
    const contest = await contests.create({ name: 'regression-round', problems: [{ index: 'A', problem: p.id }] });
    await call('PUT', `/api/contests/${contest.id}`, { statement: { subtitle: '第二轮认证', session: '提高级', schedule: '14:30–18:30', compileOptions: '-O2 -std=c++17', instructions: '1. 请检查文件名。\n2. 使用标准输入输出。' } });
    await registry.patch(p.id, { samples: '1' });
    for (const style of ['oi', 'cf']) {
      const tex = await app.inject({ method: 'GET', url: `/api/contests/${contest.id}/tex?lang=zh&style=${style}`, headers: { host: 'localhost', 'x-polyforge-token': 'test-only' } });
      assert.equal(tex.statusCode, 200, tex.body);
      assert.match(tex.body, /\\begin\{document\}/);
      assert.match(tex.body, /margin=20mm/);
      assert.ok(!tex.body.includes('fancyhead'));
    }
    const batch = await call('POST', `/api/contests/${contest.id}/batch`, { action: 'checks' });
    while (jobs.get(batch.id).status === 'running') await new Promise(r => setTimeout(r, 10));
    assert.equal((await call('GET', `/api/contests/${contest.id}/batch/latest`)).items[0].problem, p.id);
    const ctx = await judge.ctx(p.id);
    await assert.rejects(quickRun(judge, ctx, { source: 'solution/2.cpp', input: '0\n\n' }), /Invalid custom input/);
    const wrong = await quickRun(judge, ctx, { source: 'solution/2.cpp', input: '3\n1 2 3\n' });
    assert.equal(wrong.verdict, 'WA', JSON.stringify(wrong));
    const experiment = await quickRun(judge, ctx, { source: 'solution/2.cpp', input: 'arbitrary text' }, { experiment: true });
    assert.equal(experiment.verdict, 'OK');
    await fs.writeFile(path.join(p.dir, 'generators', 'fixed.cpp'), '#include <cstdio>\nint main(){puts("3\\n1 2 3");}');
    const manualBefore = await fs.readdir(path.join(p.dir, 'tests', 'manual'));
    const stress = await runStress(judge, ctx, { generator: 'generators/fixed.cpp', solution: 'solution/2.cpp', args: '', maxIterations: 1 }, syncJob);
    assert.equal(stress.found, true);
    assert.equal(stress.counterexample?.savedAs, undefined);
    assert.deepEqual(await fs.readdir(path.join(p.dir, 'tests', 'manual')), manualBefore);
    await call('DELETE', `${base}/files/solution/2.cpp`);
    assert.equal((await registry.detail(p.id)).config!.solutions.some(s => s.source === 'solution/2.cpp'), false);
    await call('DELETE', `${base}/cache`);
    assert.ok(await fs.readFile(path.join(p.dir, 'problem.toml')));
    assert.ok(await fs.readFile(path.join(p.dir, '.polyforge', 'sync.json')));
    await assert.rejects(fs.access(path.join(p.dir, '.polyforge', 'tests')));
  } finally { await app.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('contest short name can change without moving its identity or losing settings and history', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-contest-name-'));
  try {
    const global = new GlobalStore(dir);
    await global.init();
    const registry = new ProblemRegistry(global);
    const contests = new ContestRegistry(registry, global);
    global.config.problems.roots = [path.join(dir, 'problems')];
    await registry.create({ name: 'existing-problem' });
    const first = await contests.create({ name: 'round-one', title: { zh: '模拟赛' }, problems: [{ index: 'A', problem: 'existing-problem' }] });
    await contests.create({ name: 'round-two' });
    const history = path.join(first.dir, '.polyforge', 'batches');
    await fs.mkdir(history, { recursive: true });
    await fs.writeFile(path.join(history, 'latest.json'), '{"items":[]}');
    const renamed = await contests.update(first.id, { name: ' round-renamed ' });
    assert.equal(renamed.summary.name, 'round-renamed');
    assert.equal(renamed.summary.id, first.id);
    assert.equal(renamed.summary.dir, first.dir);
    assert.equal(renamed.summary.title.zh, '模拟赛');
    assert.equal(renamed.problems[0].problem, 'existing-problem');
    assert.equal(await fs.readFile(path.join(history, 'latest.json'), 'utf8'), '{"items":[]}');
    await assert.rejects(contests.update(first.id, { name: 'round-two' }), /already exists/);
    await assert.rejects(contests.create({ name: 'round-renamed' }), /already exists/);
    for (const name of ['', '../escape', 'MixedCase', 'two words']) await assert.rejects(contests.update(first.id, { name }), /lowercase/);
    await contests.scan();
    assert.equal((await contests.detail(first.id)).summary.name, 'round-renamed');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('file creation rejects Windows-invalid names, but accepts nested numeric filenames', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-path-'));
  const files = new FileService(new SelfWrites());
  try {
    await files.write(dir, 'solution/1.cpp', 'int main() {}', '');
    for (const name of ['bad?.cpp', 'CON.cpp', 'trailing.', 'space /x.cpp', '../escape.cpp']) {
      await assert.rejects(files.write(dir, name, '', ''), Error, name);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('changing the main solution demotes the previous MA', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-main-'));
  try {
    const global = new GlobalStore(dir);
    await global.init();
    const root = path.join(dir, 'problems');
    global.config.problems.roots = [root];
    const registry = new ProblemRegistry(global);
    const p = await registry.create({ name: 'main-test' });
    await fs.writeFile(path.join(p.dir, 'solutions', 'other.cpp'), 'int main() {}');
    const detail = await registry.patch(p.id, { solution: { source: 'solutions/other.cpp', tag: 'MA' } });
    assert.deepEqual(detail.config!.solutions.filter(s => s.tag === 'MA').map(s => s.source), ['solutions/other.cpp']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('deleted or inaccessible Polygon problem is reported explicitly', async () => {
  const sync = new PolygonSync({} as never);
  await assert.rejects(sync.problemInfo({ call: async () => [] } as never, 123), /123.*(deleted|access)|not found/i);
});

test('building a Polygon package without committing is rejected before network access', async () => {
  const sync = new PolygonSync({} as never);
  await assert.rejects(sync.push({} as never, { keys: [], commit: false, buildPackage: true }, {} as never), /commit/i);
});
