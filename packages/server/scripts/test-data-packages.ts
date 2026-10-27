import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringify, parse } from 'smol-toml';
import type { LightMyRequestResponse } from 'fastify';
import { classifyFile, testsetsOf } from '@polyforge/shared';
import { GlobalStore } from '../src/global.js';
import { ProblemRegistry } from '../src/workspace/problems.js';
import { ContestRegistry } from '../src/workspace/contests.js';
import { FileService, SelfWrites } from '../src/workspace/files.js';
import { ProblemWatcher } from '../src/workspace/watcher.js';
import { JobManager } from '../src/jobs.js';
import { Judge } from '../src/judge/index.js';
import { WsHub } from '../src/ws.js';
import { buildApp } from '../src/app.js';
import { atomicWrite } from '../src/util/fs.js';
import { readZip, ZipWriter } from '../src/util/zip.js';
import { luoguData } from '../src/judge/luogu.js';
import { parseHydroData, parseLuoguData } from '../src/imports/data.js';
import { importPackage, packageCandidates } from '../src/imports/packages.js';
import { readSamples } from '../src/judge/samples.js';
import { contestStatements, equalTestPoints, runContestBatch } from '../src/judge/contest.js';
import { PolygonSync } from '../src/polygon/sync.js';

const zip = (files: Record<string, string | Buffer>) => { const w = new ZipWriter(); for (const [name, bytes] of Object.entries(files)) w.add(name, bytes); return w.finish(); };
const job = () => ({ signal: new AbortController().signal, progress() {} });
async function fixture(run: (f: { dir: string; global: GlobalStore; registry: ProblemRegistry; judge: Judge; contests: ContestRegistry; call: (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: object | Buffer) => Promise<LightMyRequestResponse> }) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-packages-'));
  const global = new GlobalStore(dir); await global.init(); global.config.problems.roots = [path.join(dir, 'problems')];
  const registry = new ProblemRegistry(global), contests = new ContestRegistry(registry, global), hub = new WsHub();
  const judge = new Judge(global, registry, hub), files = new FileService(new SelfWrites()), watcher = new ProblemWatcher(registry, files, hub);
  const app = await buildApp({ global, registry, contests, hub, judge, files, watcher, jobs: new JobManager(hub), token: 'test-only' });
  const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: object | Buffer) => app.inject({ method, url, payload, headers: { host: 'localhost', 'x-polyforge-token': 'test-only', ...(Buffer.isBuffer(payload) ? { 'content-type': 'application/zip' } : {}) } });
  try { await run({ dir, global, registry, judge, contests, call }); }
  finally { await app.close(); await watcher.stop(); await fs.rm(dir, { recursive: true, force: true }); }
}

test('Luogu data.zip round-trips unequal case points, subtask dependencies, limits, samples and extra bytes', async () => fixture(async ({ registry, judge }) => {
  const p = await registry.create({ name: 'source', dataOnly: true });
  for (let i = 1; i <= 3; i++) { await atomicWrite(path.join(p.dir, `tests/manual/${i}.in`), `${i}\r\n`); await atomicWrite(path.join(p.dir, `tests/manual/${i}.ans`), `${i * 2}\n`); }
  const { raw } = await registry.readConfig(await registry.get(p.id));
  const doc = raw as Record<string, any>;
  doc.tests = { answers: 'provided', points: true, groups: true, samples: '2', cases: { 1: { points: 10, time_limit: 500, memory_limit: 64 }, 2: { points: 20 }, 3: { pretest: true } }, group: [
    { name: 'partial', tests: '1-2', points: 30, policy: 'EACH_TEST' }, { name: 'full', tests: '3', points: 70, policy: 'COMPLETE_GROUP', dependencies: ['partial'] },
  ] };
  await atomicWrite(path.join(p.dir, 'problem.toml'), stringify(doc));
  const exported = await luoguData(judge, await judge.ctx(p.id), 'A', job(), ['tests'], { time: 'sum', memory: 'max' });
  const archive = readZip(exported.data);
  assert.ok(archive.has('config.yml') && archive.has('score.txt') && archive.has('1.in'));
  assert.ok([...archive.keys()].every(name => !name.includes('/')));
  const imported = parseLuoguData(archive);
  assert.deepEqual(imported.groups.map(g => [g.name, g.points, g.policy, g.dependencies ?? []]), [['full', 70, 'COMPLETE_GROUP', ['partial']], ['partial', 30, 'EACH_TEST', []]]);
  assert.deepEqual(imported.samples, [2]);
  assert.equal(imported.cases[1].time_limit, 500); assert.equal(imported.cases[1].memory_limit, 64);
  assert.equal(imported.cases[2].points, 20); assert.equal(imported.cases[3].pretest, true);
  archive.set('extra.bin', Buffer.from([0, 255, 13, 10]));
  const result = await importPackage(judge, zip(Object.fromEntries(archive)), { format: 'luogu-data', name: 'round-trip' });
  assert.equal(result.tests, 3); assert.equal(result.problem.dataOnly, true);
  assert.deepEqual(await fs.readFile(path.join(result.problem.dir, 'other/luogu/extra.bin')), Buffer.from([0, 255, 13, 10]));
  assert.equal(classifyFile('other/luogu/extra.bin', null), 'other');
  assert.equal(await fs.readFile(path.join(result.problem.dir, 'tests/manual/1.in'), 'utf8'), '1\r\n');
  const again = await luoguData(judge, await judge.ctx(result.problem.id), 'A', job(), ['tests'], { time: 'sum', memory: 'max' });
  assert.equal(readZip(again.data).get('score.txt')?.toString(), archive.get('score.txt')?.toString());
}));

const hydroConfig = `type: default
time: 2s
memory: 128m
checker_type: default
judge_extra_files: [helper.h]
subtasks:
  - id: 5
    type: min
    score: 30
    cases:
      - input: alpha.in
        output: alpha.ans
        time: 500ms
  - id: 9
    type: sum
    score: 70
    if: [5]
    cases:
      - input: beta.in
        output: beta.out
        score: 20
      - input: gamma.in
        output: gamma.out
        score: 50
`;
const hydroFiles = { 'config.yaml': hydroConfig, 'alpha.in': '1\n', 'alpha.ans': '2\n', 'beta.in': '2\n', 'beta.out': '4\n', 'gamma.in': '3\n', 'gamma.out': '6\n', 'helper.h': '// helper', 'unused.in': 'extra input' };

test('Hydro explicit mappings, IDs, dependencies, limit inheritance and automatic grouped .ans data', () => {
  const p = parseHydroData(readZip(zip(hydroFiles)));
  assert.equal(p.pairs.length, 3); assert.equal(p.pairs[0].output, 'alpha.ans');
  assert.equal(p.cases[1].time_limit, 500); assert.equal(p.cases[2].time_limit, 2000); assert.equal(p.cases[3].memory_limit, 128);
  assert.deepEqual(p.groups[1].dependencies, ['subtask-5']); assert.equal(p.groups[1].points, 70);
  assert.equal(p.used.has('unused.in'), false);
  const auto = parseHydroData(readZip(zip({ '1_1.in': 'a', '1_1.ans': 'b', '2_1.in': 'c', '2_1.out': 'd' })));
  assert.equal(auto.groups.length, 2); assert.ok(auto.groups.every(g => g.policy === 'COMPLETE_GROUP' && g.points === 50));
  const flat = parseHydroData(readZip(zip({ '1.in': 'a', '1.out': 'b', '2.in': 'c', '2.ans': 'd' })));
  assert.equal(flat.groups[0].policy, 'EACH_TEST');
});

test('Hydro whole import preserves multilingual statements, samples, attachments, manifests and extra testdata', async () => fixture(async ({ judge, contests }) => {
  const sample = '\n```input1\n1 2\n```\n```output1\n3\n```\n';
  const files: Record<string, string | Buffer> = {
    'p/problem.yaml': 'pid: P1000\ntitle: Addition\ntag: [math]\nstatements:\n  - { name: zh.md, lang: zh_CN, source: problem_zh.md }\n  - { name: en.md, lang: en, source: problem_en.md }\n',
    'p/problem_zh.md': '求和。 ![图](file://diagram.png)' + sample,
    'p/problem_en.md': 'Add the integers.' + sample,
    'p/additional_file/diagram.png': Buffer.from([137, 80, 78, 71]),
    'p/additional_file/handout.pdf': '%PDF-extra',
    ...Object.fromEntries(Object.entries(hydroFiles).map(([name, bytes]) => [`p/testdata/${name}`, bytes])),
  };
  const bytes = zip(files), choices = packageCandidates(readZip(bytes), { format: 'hydro-problem' });
  assert.equal(choices[0].entry, 'p/'); assert.equal(choices[0].name, 'p1000');
  const result = await importPackage(judge, bytes, { format: 'hydro-problem', entry: 'p/', name: 'hydro' });
  assert.deepEqual(result.problem.status.statementLangs, ['en', 'zh']);
  assert.equal(result.problem.dataOnly, true);
  const body = await fs.readFile(path.join(result.problem.dir, 'statement/en/statement.tex'), 'utf8');
  assert.match(body, /Add the integers/); assert.ok(!body.includes('```input'));
  assert.equal(await fs.readFile(path.join(result.problem.dir, 'other/hydro/additional_file/handout.pdf'), 'utf8'), '%PDF-extra');
  assert.equal(await fs.readFile(path.join(result.problem.dir, 'other/hydro/testdata/unused.in'), 'utf8'), 'extra input');
  assert.equal(await fs.readFile(path.join(result.problem.dir, 'other/hydro/problem.yaml'), 'utf8'), files['p/problem.yaml']);
  const ctx = await judge.ctx(result.problem.id);
  assert.equal((await readSamples(ctx, true, 'zh'))[0].sample.output, '3\n');
  assert.equal((await contestStatements(judge, contests, result.problem.id, 'en', true))[0].samples.length, 1);
  assert.equal(testsetsOf(ctx.config).find(ts => ts.name === 'samples')?.group[0].points, 0);
}));

test('data-only import is scoped to testdata and invalid packages cannot modify an existing problem', async () => fixture(async ({ registry, judge, call }) => {
  const p = await registry.create({ name: 'existing' });
  const statementPath = path.join(p.dir, 'statement/zh/legend.tex');
  const statement = await fs.readFile(statementPath, 'utf8'), original = await fs.readFile(path.join(p.dir, 'problem.toml'), 'utf8');
  await assert.rejects(importPackage(judge, zip({ '1.in': 'missing answer' }), { format: 'luogu-data' }, p.id), /Missing answer/);
  assert.equal(await fs.readFile(path.join(p.dir, 'problem.toml'), 'utf8'), original);
  const response = await call('POST', `/api/problems/${p.id}/import/data?format=hydro-data`, zip({ ...hydroFiles, 'problem.yaml': 'title: MUST NOT REPLACE', 'statement/zh/legend.tex': 'MUST NOT REPLACE' }));
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(await fs.readFile(statementPath, 'utf8'), statement);
  const ctx = await judge.ctx(p.id);
  assert.equal(ctx.config.problem.data_only, false); assert.equal(ctx.config.tests.answers, 'provided');
  assert.equal(ctx.config.solutions[0].source, 'solutions/std.cpp');
  assert.equal(ctx.config.problem.time_limit, 1000); // imported case limits are separate
  assert.equal((await call('GET', `/api/problems/${p.id}/tests`)).json().tests.length, 3);
}));

test('unrepresentable scoring stays visible and blocks export until subtask configuration is edited', async () => fixture(async ({ judge, registry }) => {
  const result = await importPackage(judge, zip({ '1.in': 'a', '1.out': 'b', 'config.yml': '1.out: { score: 100, subtaskId: 1 }', 'score.txt': '@total_score = @time1;' }), { format: 'luogu-data', name: 'scripted' });
  let ctx = await judge.ctx(result.problem.id);
  assert.equal(ctx.config.tests.unresolved_scoring, true);
  await assert.rejects(luoguData(judge, ctx, 'A', job(), ['tests'], { time: 'sum', memory: 'max' }), /not representable/);
  await registry.patch(result.problem.id, { testsets: { tests: { group: [{ name: 'all', tests: '1', points: 100, policy: 'EACH_TEST' }] } } });
  ctx = await judge.ctx(result.problem.id);
  assert.equal(ctx.config.tests.unresolved_scoring, undefined);
  assert.equal((await luoguData(judge, ctx, 'A', job(), ['tests'], { time: 'sum', memory: 'max' })).tests, 1);
  const unequal = await importPackage(judge, zip({ '1.in': 'a', '1.out': 'b', '2.in': 'c', '2.out': 'd', 'config.yml': '1.in: { score: 30 }\n2.in: { score: 70 }' }), { format: 'luogu-data', name: 'unequal' });
  assert.equal(equalTestPoints((await judge.ctx(unequal.problem.id)).config, [1, 2]), false);
}));

test('API import prerequisites, single exports, data-only down.zip and contest LemonLime work without a compiler', async () => fixture(async ({ global, registry, judge, contests, call }) => {
  const roots = global.config.problems.roots; global.config.problems.roots = [];
  let response = await call('POST', '/api/contests/import/polygon', { contestId: 1, name: 'no-root', root: 'C:/should-not-create' });
  assert.equal(response.statusCode, 400); assert.equal(response.json().error, 'no_root');
  global.config.problems.roots = roots;
  for (const [url, payload] of [['/api/contests/import/polygon', { contestId: 1, name: 'no-key' }], ['/api/problems/import/polygon', { polygonId: 1 }]] as const) {
    response = await call('POST', url, payload); assert.equal(response.statusCode, 400); assert.equal(response.json().error, 'no_polygon_credentials');
  }
  response = await call('POST', '/api/problems/import/package?format=luogu-data&name=api-data', zip({ '1.in': 'x\n', '1.out': 'y\n', 'config.yml': '1.in: { score: 100 }' }));
  assert.equal(response.statusCode, 200, response.body);
  const p = response.json().problem;
  await registry.patch(p.id, { samples: '1' });
  for (const [url, body] of [[`/api/problems/${p.id}/build`, {}], [`/api/problems/${p.id}/invocations`, { sources: [] }]] as const) {
    response = await call('POST', url, body); assert.equal(response.statusCode, 400); assert.equal(response.json().error, 'data_only');
  }
  response = await call('POST', `/api/problems/${p.id}/down`, { lang: 'en', samplesOnly: true });
  assert.equal(response.statusCode, 200, response.body);
  const data = readZip(response.rawPayload);
  assert.equal(data.get('api-data/api-data1.out')?.toString(), 'y\n'); assert.ok(!data.has('statement.pdf'));
  const c = await contests.create({ name: 'weak-contest', problems: [{ index: 'A', problem: p.id }] });
  response = await call('POST', `/api/contests/${c.id}/down`, { lang: 'zh', samplesOnly: true }); assert.equal(response.statusCode, 200);
  const result = await runContestBatch({ judge, contests, sync: new PolygonSync(judge) }, c.id, { action: 'export', exportFormat: 'lemonlime' }, job());
  const lemon = readZip(await fs.readFile(path.join(c.dir, '.polyforge/export', result.file!)));
  assert.equal(JSON.parse(lemon.get('weak-contest.cdf')!.toString()).tasks[0].comparisonMode, 1);
  const luogu = await runContestBatch({ judge, contests, sync: new PolygonSync(judge) }, c.id, { action: 'export', exportFormat: 'luogu' }, job());
  const contestZip = readZip(await fs.readFile(path.join(c.dir, '.polyforge/export', luogu.file!)));
  assert.ok(readZip(contestZip.get('api-data/data.zip')!).has('config.yml'));
}));
