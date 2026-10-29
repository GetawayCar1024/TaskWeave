import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { LightMyRequestResponse } from 'fastify';
import type { ContestPackageUpload, PackageBatchResult, PackageItem } from '@taskweave/shared';
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
  const call: Call = (method, url, payload) => app.inject({ method, url, payload, headers: { host: 'localhost', 'x-taskweave-token': 'fixture', ...(Buffer.isBuffer(payload) ? { 'content-type': 'application/zip' } : {}) } });
  try { await run({ home, registry, call }); }
  finally { await watcher.stop(); await app.close(); await fs.rm(home, { recursive: true, force: true }); }
}
const zip = (files: Record<string, string>) => { const z = new ZipWriter(); Object.entries(files).forEach(([file, value]) => z.add(file, value)); return z.finish(); };

test('auto detection reports the concrete format and uses it for the staged import', async () => fixture(async ({ call }) => {
  const response = await call('POST', '/api/packages/uploads?format=auto', zip({ '1.in': '1', '1.out': '2' }));
  assert.equal(response.statusCode, 200, response.body);
  const upload = response.json(), [item] = upload.items; assert.equal(item.format, 'data');
  const imported = await call('POST', '/api/packages/import', { items: [{ uploadId: upload.id, unit: item.unit, format: item.format, entry: item.entry, name: 'automatic' }] });
  assert.equal(imported.statusCode, 200, imported.body); assert.equal(imported.json().items[0].result.tests, 1);
}));

const fps = '<?xml version="1.0" encoding="UTF-8"?><fps version="1.6"><item><title>FPS Sum</title><time_limit unit="s">1</time_limit><memory_limit unit="mb">128</memory_limit>'
  + '<description>Add.</description><test_input>1 2</test_input><test_output>3</test_output></item></fps>';
const polygon = '<problem short-name="poly"><names><name language="english" value="Poly"/></names><judging input-file="" output-file=""><testset name="tests">'
  + '<time-limit>1000</time-limit><memory-limit>268435456</memory-limit><test-count>1</test-count><input-path-pattern>tests/%02d</input-path-pattern>'
  + '<answer-path-pattern>tests/%02d.a</answer-path-pattern><tests><test method="manual"/></tests></testset></judging></problem>';
const mixed = () => zip({ 'README.md': 'shared note', 'poly/problem.xml': polygon, 'poly/tests/01': '1', 'poly/tests/01.a': '1',
  'hydro/problem.yaml': 'title: Hydro One\n', 'hydro/testdata/1.in': '2', 'hydro/testdata/1.out': '4', 'sets/fps.xml': fps,
  'plain/data/1.in': '5', 'plain/data/1.out': '25', 'joi/in/01.txt': '6', 'joi/out/01.txt': '36' });

test('each problem of a mixed archive is detected and imported with its own format', async () => fixture(async ({ registry, call }) => {
  const upload = (await call('POST', '/api/packages/uploads', mixed())).json();
  assert.deepEqual(upload.items.map((item: PackageItem) => [item.unit, item.format, item.name, item.error]), [
    ['hydro/', 'hydro-problem', 'hydro', undefined], ['joi/', 'joi', 'joi', undefined], ['plain/data/', 'data', 'plain', undefined],
    ['poly/', 'polygon-package', 'poly', undefined], ['sets/fps.xml', 'fps', 'fps-sum', undefined]]);
  const selection = upload.items.map((item: PackageItem) => ({ uploadId: upload.id, unit: item.unit, format: item.format, entry: item.entry, name: item.name }));
  const response = await call('POST', '/api/packages/import', { items: selection });
  assert.equal(response.statusCode, 200, response.body);
  const result: PackageBatchResult = response.json();
  assert.deepEqual(result.items.map(item => [item.result?.problem.name, item.result?.tests, item.error]), [['hydro', 1, undefined], ['joi', 1, undefined], ['plain', 1, undefined], ['poly', 1, undefined], ['fps-sum', 1, undefined]]);
  // Shared files reach every package that keeps archive extras; other problems never leak in.
  const poly = result.items[3].result!.problem.dir;
  assert.equal(await fs.readFile(path.join(poly, 'other/polygon/archive/README.md'), 'utf8'), 'shared note');
  await assert.rejects(fs.access(path.join(poly, 'other/polygon/archive/hydro/problem.yaml')));
  assert.equal((await registry.list()).length, 5);
}));

test('a unit can be re-inspected with another format and auto restores the detected one', async () => fixture(async ({ call }) => {
  const upload = (await call('POST', '/api/packages/uploads', mixed())).json();
  const data = (await call('POST', `/api/packages/uploads/${upload.id}/inspect`, { unit: 'hydro/', format: 'data' })).json();
  assert.deepEqual(data.map((item: PackageItem) => [item.unit, item.format, item.entry, item.tests]), [['hydro/', 'data', 'hydro/testdata/', 1]]);
  const auto = (await call('POST', `/api/packages/uploads/${upload.id}/inspect`, { unit: 'hydro/', format: 'auto' })).json();
  assert.deepEqual(auto.map((item: PackageItem) => item.format), ['hydro-problem']);
  const wrong = (await call('POST', `/api/packages/uploads/${upload.id}/inspect`, { unit: 'sets/fps.xml', format: 'polygon-package' })).json();
  assert.ok(wrong[0].error);
}));

test('a batch is validated as a whole and one conflict imports nothing', async () => fixture(async ({ registry, call }) => {
  await registry.create({ name: 'taken' });
  const upload = (await call('POST', '/api/packages/uploads', mixed())).json();
  const selection = upload.items.map((item: PackageItem, i: number) => ({ uploadId: upload.id, unit: item.unit, format: item.format, entry: item.entry, name: ['taken', 'twin', 'twin', 'Bad', 'fine'][i], timeLimit: i === 4 ? 0.5 : 1000 }));
  const validation = (await call('POST', '/api/packages/validate', { items: selection })).json();
  assert.deepEqual(validation.items.map((item: { error?: string }) => item.error), ['Problem name already exists: taken', 'Duplicate problem name in this import: twin', 'Duplicate problem name in this import: twin',
    'Name must be lowercase letters, digits and dashes (up to 64 characters).', 'Time limit must be a positive whole number of milliseconds.']);
  const response = (await call('POST', '/api/packages/import', { items: selection })).json();
  assert.equal(response.rejected, true); assert.equal(response.items[0].error, 'Problem name already exists: taken');
  assert.deepEqual((await registry.list()).map(p => p.name), ['taken']);
  const lemon = (await call('POST', '/api/packages/validate', { items: [{ uploadId: upload.id, format: 'lemonlime', name: 'x' }] })).json();
  assert.match(lemon.items[0].error, /whole contests/);
}));

test('contest packages stage, validate and import through the API', async () => fixture(async ({ registry, call }) => {
  const cdf = JSON.stringify({ contestTitle: 'Round', tasks: [{ sourceFileName: 'Echo_1', problemTitle: 'Echo', testCases: [{ fullScore: 100, timeLimit: 1000, memoryLimit: 256, inputFiles: ['Echo_1/1.in'], outputFiles: ['Echo_1/1.out'] }] }] });
  const upload: ContestPackageUpload = (await call('POST', '/api/contest-packages/uploads', zip({ 'round.cdf': cdf, 'data/Echo_1/1.in': '1', 'data/Echo_1/1.out': '1' }))).json();
  const [contest] = upload.contests;
  assert.deepEqual([contest.name, contest.tasks[0].name, contest.tasks[0].sourceName], ['round', 'echo-1', 'Echo_1']);
  const req = { uploadId: upload.id, entry: contest.entry, name: contest.name, title: { en: contest.title }, tasks: contest.tasks.map(task => ({ key: task.key, include: true, name: task.name, title: task.title })) };
  assert.deepEqual((await call('POST', '/api/contest-packages/validate', req)).json(), { errors: [], tasks: {} });
  const imported = await call('POST', '/api/contest-packages/import', req);
  assert.equal(imported.statusCode, 200, imported.body);
  const problem = (await registry.list())[0];
  assert.equal(problem.name, 'echo-1');
  const detail = (await call('GET', `/api/problems/${problem.id}`)).json();
  assert.equal(detail.config.problem.source_name, 'Echo_1');
  assert.equal((await call('POST', '/api/contest-packages/import', req)).statusCode, 409);
}));

test('an unpacked folder imports like a ZIP and the compatibility manifest is ready when import returns', async () => fixture(async ({ home, call }) => {
  const directory = path.join(home, 'already unpacked'); await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, '01.in'), '7\n'); await fs.writeFile(path.join(directory, '01.out'), 'answer\r\n');
  const staged = await call('POST', '/api/packages/directories', { path: directory, format: 'auto' });
  assert.equal(staged.statusCode, 200, staged.body);
  const upload = staged.json(), [item] = upload.items;
  const response = await call('POST', '/api/packages/import', { items: [{ uploadId: upload.id, unit: item.unit, format: item.format, entry: item.entry, name: 'folder-import' }] });
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json().items[0].result; assert.ok(result, response.body);
  const manifest = JSON.parse(await fs.readFile(path.join(result.problem.dir, '.taskweave/tests/manifest.json'), 'utf8'));
  assert.equal(manifest.ok, true); assert.equal(manifest.tests.length, 1);
  assert.equal(manifest.tests[0].originalInput, '01.in');
  assert.equal(await fs.readFile(path.join(result.problem.dir, '.taskweave/tests/1.ans'), 'utf8'), 'answer\r\n');
  assert.equal(await fs.readFile(path.join(directory, '01.out'), 'utf8'), 'answer\r\n');
}));

test('compatibility ZIP imports materialize the initial scan before returning', async () => fixture(async ({ call }) => {
  const response = await call('POST', '/api/problems/import/package?format=data&name=scanned', zip({ '1.in': '3', '1.out': '6' }));
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json();
  const manifest = JSON.parse(await fs.readFile(path.join(result.problem.dir, '.taskweave/tests/manifest.json'), 'utf8'));
  assert.equal(manifest.ok, true); assert.equal(manifest.tests.length, 1);
}));
