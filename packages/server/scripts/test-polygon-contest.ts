import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GlobalStore } from '../src/global.js';
import { ProblemRegistry } from '../src/workspace/problems.js';
import { ContestRegistry } from '../src/workspace/contests.js';
import { FileService, SelfWrites } from '../src/workspace/files.js';
import { ProblemWatcher } from '../src/workspace/watcher.js';
import { Judge } from '../src/judge/index.js';
import { JobManager } from '../src/jobs.js';
import { WsHub } from '../src/ws.js';
import { buildApp } from '../src/app.js';
import type { LightMyRequestResponse } from 'fastify';
import { runContestBatch, contestExportDir } from '../src/judge/contest.js';
import { PolygonSync } from '../src/polygon/sync.js';
import { ZipWriter, readZip } from '../src/util/zip.js';
import { polygonContests, importPolygonContest } from '../src/imports/polygon-contest.js';
import type { ContestPackageImportRequest, ContestPackageImportResult, ContestPackageUpload } from '@taskweave/shared';

const zip = (files: Record<string, string | Buffer>) => { const writer = new ZipWriter(); for (const [name, data] of Object.entries(files)) writer.add(name, data); return writer.finish(); };
const problem = (name: string, answer: string): Record<string, string> => ({
  'problem.xml': `<problem short-name="${name}"><names><name language="english" value="${name}"/></names><judging input-file="" output-file=""><testset name="tests"><time-limit>1000</time-limit><memory-limit>268435456</memory-limit><test-count>1</test-count><input-path-pattern>tests/%02d</input-path-pattern><answer-path-pattern>tests/%02d.a</answer-path-pattern><tests><test method="manual" points="100"/></tests></testset></judging></problem>`,
  'tests/01': '1 2\r\n', 'tests/01.a': answer,
});
const bundle = () => {
  const files: Record<string, string | Buffer> = {
    'round/contest.xml': '<contest><names><name language="english" value="Example Round"/><name language="chinese" value="示例比赛"/></names><problems><problem index="C" path="problems/one"/><problem index="A" path="problems/two"/></problems></contest>',
    'round/README.txt': 'shared contest note',
  };
  for (const [key, value] of Object.entries(problem('sum_orig', '3\r\n'))) files['round/problems/one/' + key] = value;
  for (const [key, value] of Object.entries(problem('product', '2\n'))) files['round/problems/two/' + key] = value;
  return files;
};
type Call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object | Buffer) => Promise<LightMyRequestResponse>;
async function fixture(run: (ctx: { home: string; judge: Judge; registry: ProblemRegistry; contests: ContestRegistry; call: Call }) => Promise<void>) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tw-polygon-contest-')));
  const global = new GlobalStore(home); await global.init(); global.config.problems.roots = [path.join(home, 'problems')];
  const registry = new ProblemRegistry(global), contests = new ContestRegistry(registry, global), hub = new WsHub();
  const files = new FileService(new SelfWrites()), watcher = new ProblemWatcher(registry, files, hub), judge = new Judge(global, registry, hub);
  const app = await buildApp({ global, registry, contests, hub, files, watcher, judge, jobs: new JobManager(hub), token: 'fixture' });
  const call: Call = (method, url, payload) => app.inject({ method, url, payload, headers: { host: 'localhost', 'x-taskweave-token': 'fixture', ...(Buffer.isBuffer(payload) ? { 'content-type': 'application/zip' } : {}) } });
  try { await run({ home, judge, registry, contests, call }); }
  finally { await watcher.stop(); await app.close(); await fs.rm(home, { recursive: true, force: true }); }
}
function request(files: Map<string, Buffer>, name = 'polygon-round'): ContestPackageImportRequest {
  const candidate = polygonContests(files)[0];
  return { uploadId: 'direct', format: 'polygon-package', entry: candidate.entry, name, title: { en: candidate.title }, lang: 'en',
    tasks: candidate.tasks.map(task => ({ key: task.key, include: !task.error, name: task.name, title: task.title })) };
}

test('Polygon contest ZIP stages and imports through the contest API with declared order and indices', async () => fixture(async ({ call, registry }) => {
  const raw = zip(bundle());
  const staged = await call('POST', '/api/contest-packages/uploads', raw);
  assert.equal(staged.statusCode, 200, staged.body);
  const upload: ContestPackageUpload = staged.json();
  assert.equal(upload.contests[0].format, 'polygon-package');
  assert.deepEqual(upload.contests[0].tasks.map(task => task.index), ['C', 'A']);
  const req = { ...request(readZip(raw)), uploadId: upload.id };
  req.tasks[0].name = 'renamed-sum';
  const checked = await call('POST', '/api/contest-packages/validate', req);
  assert.deepEqual(checked.json(), { errors: [], tasks: {} });
  const response = await call('POST', '/api/contest-packages/import', req);
  assert.equal(response.statusCode, 200, response.body);
  const imported: ContestPackageImportResult = response.json();
  assert.equal(imported.contest.type, 'cf');
  assert.deepEqual(imported.contest.problems.map(item => item.index), ['C', 'A']);
  assert.equal((await registry.detail(imported.problems[0].id)).config!.problem.source_name, 'sum_orig');
  assert.equal(await fs.readFile(path.join(imported.problems[0].dir, 'tests/manual/1.in'), 'utf8'), '1 2\r\n');
  assert.equal(await fs.readFile(path.join(imported.contest.dir, 'files/polygon/README.txt'), 'utf8'), 'shared contest note');
  await fs.access(path.join(imported.contest.dir, 'files/polygon/contest.xml'));
}));

test('all selected Polygon problems are validated before writes and publication failures roll back', async () => fixture(async ({ judge, contests, registry }) => {
  const archive = readZip(zip(bundle())), req = request(archive);
  req.tasks[1].name = req.tasks[0].name;
  await assert.rejects(importPolygonContest(judge, contests, archive, req), /Duplicate problem name/);
  assert.equal((await registry.list()).length, 0);
  req.tasks[1].name = 'product';
  const create = contests.create.bind(contests);
  contests.create = async () => { throw new Error('injected publication failure'); };
  await assert.rejects(importPolygonContest(judge, contests, archive, req), /injected publication failure/);
  assert.equal((await registry.list()).length, 0);
  contests.create = create;
}));

test('a problem finalization failure also removes its unpublished directory', async () => fixture(async ({ judge, contests, registry }) => {
  const archive = readZip(zip(bundle()));
  const ctx = judge.ctx.bind(judge);
  judge.ctx = async (id: string) => {
    const value = await ctx(id);
    if (value.config.problem.name === 'product') throw new Error('injected finalization failure');
    return value;
  };
  await assert.rejects(importPolygonContest(judge, contests, archive, request(archive)), /injected finalization failure/);
  assert.deepEqual(await registry.list(), []);
  assert.deepEqual(await contests.list(), []);
}));

test('nested problem ZIPs and unpacked Polygon directories both import as a contest', async () => fixture(async ({ judge, contests }) => {
  const archive = readZip(zip({ 'contest.xml': '<contest><problems><problem index="B" path="second.zip"/><problem index="A" path="first.zip"/></problems></contest>',
    'first.zip': zip(problem('first', '3')), 'second.zip': zip(problem('second', '2')) }));
  const imported = await importPolygonContest(judge, contests, archive, request(archive));
  assert.deepEqual(imported.contest.problems.map(item => item.index), ['B', 'A']);
  assert.equal(await fs.readFile(path.join(imported.problems[0].dir, 'tests/manual/1.ans'), 'utf8'), '2');
  const loose = bundle(); delete loose['round/contest.xml'];
  const looseArchive = readZip(zip(loose));
  const inferred = await importPolygonContest(judge, contests, looseArchive, request(looseArchive, 'inferred-round'));
  assert.equal(inferred.problems.length, 2);
  assert.deepEqual(inferred.contest.problems.map(item => item.index), ['A', 'B']);
}));

test('case-insensitive Polygon descriptors retain titles and original source names', async () => fixture(async ({ judge, contests, registry }) => {
  const files = bundle();
  const descriptor = 'round/problems/one/problem.xml';
  files['round/problems/one/PROBLEM.XML.POLYGON'] = String(files[descriptor]).replace('</names>', '<name language="chinese" value="求和"/></names>');
  delete files[descriptor];
  const archive = readZip(zip(files)), candidate = polygonContests(archive)[0];
  assert.equal(candidate.tasks[0].error, undefined);
  const req = request(archive);
  req.tasks[0].title = 'Sum';
  const result = await importPolygonContest(judge, contests, archive, req);
  const config = (await registry.detail(result.problems[0].id)).config!;
  assert.equal(config.problem.source_name, 'sum_orig');
  assert.deepEqual(config.problem.title, { en: 'Sum', zh: '求和' });
}));

test('an archived CDF does not hide a Polygon contest descriptor', async () => fixture(async ({ call }) => {
  const files = bundle();
  files['round/legacy.cdf'] = JSON.stringify({ version: '1.0', contestTitle: 'Legacy', tasks: [], contestants: [] });
  const staged = await call('POST', '/api/contest-packages/uploads', zip(files));
  assert.equal(staged.statusCode, 200, staged.body);
  const upload: ContestPackageUpload = staged.json();
  assert.equal(upload.contests[0].format, 'polygon-package');
  const result = await call('POST', '/api/contest-packages/import', { ...request(readZip(zip(files))), uploadId: upload.id });
  assert.equal(result.statusCode, 200, result.body);
}));

test('directory staging, excluded problems and folder-local name uniqueness are preserved', async () => fixture(async ({ home, call, registry }) => {
  const folder = path.join(home, 'unpacked');
  for (const [file, bytes] of Object.entries(bundle())) {
    const target = path.join(folder, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
  }
  const archive = readZip(zip(bundle()));
  for (const [i, problemFolder] of ['first', 'second'].entries()) {
    await fs.mkdir(path.join(home, 'problems', problemFolder), { recursive: true });
    const staged = await call('POST', '/api/contest-packages/directories', { path: folder });
    assert.equal(staged.statusCode, 200, staged.body);
    const req = { ...request(archive, `round-${i + 1}`), uploadId: staged.json().id, problemFolder };
    req.tasks[1].include = false;
    const response = await call('POST', '/api/contest-packages/import', req);
    assert.equal(response.statusCode, 200, response.body);
    const result: ContestPackageImportResult = response.json();
    assert.deepEqual(result.contest.problems.map(item => item.index), ['C']);
    assert.equal(await fs.readFile(path.join(result.contest.dir, 'files/polygon/problems/two/tests/01.a'), 'utf8'), '2\n');
  }
  assert.deepEqual((await registry.list()).map(item => item.name), ['sum-orig', 'sum-orig']);
}));

test('native Polygon contest export can be imported as a whole contest again', async () => fixture(async ({ judge, contests, registry }) => {
  const original = readZip(zip(bundle()));
  const first = await importPolygonContest(judge, contests, original, request(original));
  const sync = new PolygonSync(judge);
  const exported = await runContestBatch({ judge, contests, sync }, first.contest.id, { action: 'export', exportFormat: 'polygon' }, { signal: new AbortController().signal, progress() {} });
  assert.ok(exported.items.every(item => item.ok), JSON.stringify(exported));
  const archive = readZip(await fs.readFile(path.join(contestExportDir(await contests.get(first.contest.id)), exported.file!)));
  const req = { ...request(archive, 'round-trip'), problemFolder: 'round-trip' };
  await fs.mkdir(path.join(judge.registry.roots[0], req.problemFolder));
  const second = await importPolygonContest(judge, contests, archive, req);
  assert.deepEqual(second.contest.problems.map(item => item.index), ['C', 'A']);
  for (let i = 0; i < first.problems.length; i++) {
    const a = (await registry.detail(first.problems[i].id)).config!, b = (await registry.detail(second.problems[i].id)).config!;
    assert.deepEqual(b.tests.group, a.tests.group);
    assert.equal(await fs.readFile(path.join(second.problems[i].dir, 'tests/manual/1.ans'), 'utf8'), i ? '2\n' : '3\r\n');
  }
}));

test('invalid paths, XML entities and broken included problems cannot write partial contests', async () => fixture(async ({ judge, contests, registry }) => {
  const files = bundle();
  files['round/contest.xml'] = '<contest><problems><problem index="A" path="../outside"/></problems></contest>';
  const archive = readZip(zip(files)), req = request(archive);
  req.tasks[0].include = true;
  await assert.rejects(importPolygonContest(judge, contests, archive, req));
  assert.equal((await registry.list()).length, 0);
  const bad = readZip(zip({ 'contest.xml': '<!DOCTYPE contest [<!ENTITY x SYSTEM "file:///secret">]><contest>&x;</contest>' }));
  assert.match(polygonContests(bad)[0].error ?? '', /entity|DTDs/i);
  const broken = bundle(); broken['round/problems/two/problem.xml'] = '<problem>broken';
  const invalid = readZip(zip(broken)), invalidReq = request(invalid);
  invalidReq.tasks.forEach(task => { task.include = true; });
  await assert.rejects(importPolygonContest(judge, contests, invalid, invalidReq));
  assert.equal((await registry.list()).length, 0);
}));
