import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { LightMyRequestResponse } from 'fastify';
import type { JobInfo } from '@taskweave/shared';
import { GlobalStore } from '../src/global.js';
import { ProblemRegistry } from '../src/workspace/problems.js';
import { ContestRegistry } from '../src/workspace/contests.js';
import { FileService, SelfWrites } from '../src/workspace/files.js';
import { ProblemWatcher } from '../src/workspace/watcher.js';
import { Judge } from '../src/judge/index.js';
import { JobManager } from '../src/jobs.js';
import { WsHub } from '../src/ws.js';
import { buildApp } from '../src/app.js';
import { atomicWrite, exists } from '../src/util/fs.js';
import { ZipWriter, readZip } from '../src/util/zip.js';
import { hydroMarkdown, hydroPackage } from '../src/judge/hydro.js';
import { buildProblemDataPackage } from '../src/judge/problemExport.js';
import { runContestBatch, contestStatements } from '../src/judge/contest.js';
import { PolygonSync } from '../src/polygon/sync.js';
import { inspectPackage, importPackage } from '../src/imports/packages.js';
import { yamlObject } from '../src/imports/data.js';
import { readSamples } from '../src/judge/samples.js';
import { createJobFollower } from '../../web/src/lib/jobFollower.js';

type Call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object | Buffer) => Promise<LightMyRequestResponse>;
async function fixture(run: (ctx: { home: string; global: GlobalStore; registry: ProblemRegistry; contests: ContestRegistry; judge: Judge; call: Call }) => Promise<void>) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pf-release-')));
  const global = new GlobalStore(home); await global.init();
  await global.saveConfig({ ...global.config, problems: { roots: [path.join(home, 'problems')] } });
  const registry = new ProblemRegistry(global), contests = new ContestRegistry(registry, global), hub = new WsHub();
  const judge = new Judge(global, registry, hub), files = new FileService(new SelfWrites()), watcher = new ProblemWatcher(registry, files, hub);
  const app = await buildApp({ global, registry, contests, hub, judge, files, watcher, jobs: new JobManager(hub), token: 'test-only' });
  const call: Call = (method, url, payload) => app.inject({ method, url, payload, headers: { host: 'localhost', 'x-taskweave-token': 'test-only', ...(Buffer.isBuffer(payload) ? { 'content-type': 'application/zip' } : {}) } });
  try { await run({ home, global, registry, contests, judge, call }); }
  finally { await app.close(); await watcher.stop(); await fs.rm(home, { recursive: true, force: true }); }
}
const job = () => ({ signal: new AbortController().signal, progress() {} });
const makeZip = (files: Record<string, string | Buffer>) => { const zip = new ZipWriter(); for (const [name, data] of Object.entries(files)) zip.add(name, data); return zip.finish(); };

test('initial job recovery and an export click share one completion; disposed views never download', async () => {
  const running: JobInfo = { id: 'one', kind: 'contest', problemId: 'contest:round', status: 'running', startedAt: '', progress: { done: 0, total: 1 } };
  let finish!: (job: JobInfo) => void;
  let waits = 0, completions = 0;
  const follower = createJobFollower(async () => { waits++; return new Promise(resolve => finish = resolve); }, () => {}, () => { completions++; });
  const manual = follower.follow(running), recovered = follower.follow({ ...running });
  assert.equal(waits, 1);
  finish({ ...running, status: 'done' });
  await Promise.all([manual, recovered]);
  await follower.follow({ ...running, status: 'done' });
  assert.equal(completions, 1);
  follower.dispose();
  const stale = createJobFollower(async () => new Promise(resolve => finish = resolve), () => {}, () => { completions++; });
  const pending = stale.follow(running); stale.dispose(); finish({ ...running, status: 'done' }); await pending;
  assert.equal(completions, 1);
});

test('renaming a problem updates contest summaries and export names while retaining identity and files', async () => fixture(async ({ registry, contests, judge, call }) => {
  const p = await registry.create({ name: 'old-name', dataOnly: true });
  await atomicWrite(path.join(p.dir, 'tests/manual/1.in'), '1\n'); await atomicWrite(path.join(p.dir, 'tests/manual/1.ans'), '2\n');
  await registry.patch(p.id, { samples: '1' });
  await atomicWrite(path.join(p.dir, '.taskweave/sync.json'), 'history');
  const c = await contests.create({ name: 'round', problems: [{ index: 'A', problem: p.id }] });
  const response = await call('PATCH', `/api/problems/${p.id}`, { name: 'new-name' });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().summary.id, p.id); assert.equal(path.basename(response.json().summary.dir), 'new-name');
  assert.equal((await contests.detail(c.id)).problems[0].summary?.name, 'new-name');
  assert.equal((await contestStatements(judge, contests, c.id, 'en'))[0].samples[0].inputFile, 'new-name/new-name1.in');
  assert.equal(await fs.readFile(path.join(response.json().summary.dir, '.taskweave/sync.json'), 'utf8'), 'history');
  const other = await registry.create({ name: 'taken', dataOnly: true });
  assert.equal((await call('PATCH', `/api/problems/${p.id}`, { name: other.name })).statusCode, 409);
  assert.equal((await call('PATCH', `/api/problems/${p.id}`, { name: '../escape' })).statusCode, 400);
  assert.equal((await registry.detail(p.id)).summary.name, 'new-name');
}));

test('recycle and restore problems/contests, preserve history, reject collisions and protect original identities', async () => fixture(async ({ home, registry, contests, call }) => {
  const p = await registry.create({ name: 'recyclable', dataOnly: true });
  await atomicWrite(path.join(p.dir, 'tests/manual/1.in'), 'original');
  await atomicWrite(path.join(p.dir, 'tests/manual/1.out'), 'answer');
  await atomicWrite(path.join(p.dir, '.taskweave/ai/session/history.json'), '{"history":true}');
  const c = await contests.create({ name: 'recycle-round', problems: [{ index: 'B', problem: p.id }] });
  await atomicWrite(path.join(c.dir, 'files/notes.en.tex'), 'Keep contest notes');
  let response = await call('DELETE', `/api/problems/${p.id}`);
  assert.equal(response.statusCode, 200, response.body); const key = response.json().key;
  assert.equal(await exists(p.dir), false);
  assert.equal((await contests.detail(c.id)).problems[0].summary, null);
  const listed = (await call('GET', '/api/trash')).json().entries;
  assert.equal(listed.length, 1); assert.equal(listed[0].key, key); assert.ok(listed[0].size > 0);
  const replacement = await registry.create({ name: 'recyclable', dataOnly: true });
  assert.notEqual(replacement.id, p.id, 'a new problem must not take the identity reserved in trash');
  assert.equal((await contests.detail(c.id)).problems[0].summary, null);
  assert.equal((await call('POST', `/api/trash/${key}/restore`, {})).statusCode, 409);
  const otherRoot = await registry.ensureRoot(path.join(home, 'other-root'));
  response = await call('POST', `/api/trash/${key}/restore`, { root: otherRoot });
  assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().id, p.id);
  const restored = await registry.get(p.id);
  assert.equal(await fs.readFile(path.join(restored.dir, 'tests/manual/1.in'), 'utf8'), 'original');
  assert.equal(await fs.readFile(path.join(restored.dir, '.taskweave/ai/session/history.json'), 'utf8'), '{"history":true}');
  assert.equal((await contests.detail(c.id)).problems[0].summary?.id, p.id);
  response = await call('DELETE', `/api/contests/${c.id}`); assert.equal(response.statusCode, 200, response.body);
  const contestEntry = (await call('GET', '/api/trash')).json().entries.find((entry: any) => entry.kind === 'contest');
  assert.ok(contestEntry); assert.equal(await exists(restored.dir), true);
  assert.equal((await call('POST', `/api/trash/${contestEntry.key}/restore`, {})).statusCode, 200);
  assert.equal(await fs.readFile(path.join((await contests.get(c.id)).dir, 'files/notes.en.tex'), 'utf8'), 'Keep contest notes');
  response = await call('DELETE', `/api/problems/${replacement.id}`);
  assert.equal((await call('DELETE', `/api/trash/${response.json().key}`)).statusCode, 200);
  assert.equal((await call('GET', '/api/trash')).json().entries.length, 0);
  assert.ok((await call('DELETE', '/api/trash/..%2F..')).statusCode >= 400);
  assert.equal(await exists(restored.dir), true);
}));

test('legacy trash folders can be restored through the manager', async () => fixture(async ({ home, registry, call }) => {
  const p = await registry.create({ name: 'legacy', dataOnly: true });
  const key = 'legacy-20260101-120000', oldTrash = path.join(home, 'trash', key);
  await fs.mkdir(path.dirname(oldTrash), { recursive: true }); await fs.rename(p.dir, oldTrash); await registry.scan();
  const list = (await call('GET', '/api/trash')).json().entries;
  assert.equal(list[0].legacy, true);
  assert.equal((await call('POST', `/api/trash/${key}/restore`, {})).statusCode, 200);
  assert.equal((await registry.get(p.id)).dir, p.dir);
}));

test('ZIP inspection rejects corrupt headers and incomplete packages before enabling import', async () => fixture(async ({ call, registry }) => {
  const valid = makeZip({ '1.in': '1', '1.out': '2', 'config.yml': '1.in: { score: 100 }' });
  const good = await call('POST', '/api/problems/import/package?format=luogu-data&preview=1', valid);
  assert.equal(good.statusCode, 200); assert.equal(good.json()[0].tests, 1); assert.equal(good.json()[0].error, undefined);
  const mismatch = Buffer.from(valid); mismatch.writeUInt16LE(8, 8); // only the local method changes
  assert.throws(() => readZip(mismatch), /does not match/);
  const bad = await call('POST', '/api/problems/import/package?format=luogu-data&name=must-not-exist', mismatch);
  assert.equal(bad.statusCode, 400); assert.equal((await registry.list()).length, 0);
  const missing = await call('POST', '/api/problems/import/package?format=luogu-data&preview=1', makeZip({ '1.in': 'missing answer' }));
  assert.equal(missing.statusCode, 200); assert.match(missing.json()[0].error, /Missing answer/);
  assert.equal((await call('POST', '/api/problems/import/package?format=hydro-problem&preview=1', makeZip({ 'problem.yaml': 'title: Bad', 'testdata/1.in': '1', 'testdata/1.out': '2', 'testdata/config.yaml': 'checker_type: testlib\nchecker: missing.cpp' }))).json()[0].error, 'Missing Hydro program: missing.cpp');
  assert.equal((await call('POST', '/api/problems/import/package?format=luogu-data&preview=1', Buffer.from('not a zip'))).statusCode, 400);
}));

test('Hydro Markdown retains TeX math, formatting, tables and literal code', () => {
  const result = hydroMarkdown('\\textbf{Bold} $a+b$\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```cpp\na < b;\n```', {}, 'en', n => `file://${n}`);
  assert.ok(result.markdown.includes('**Bold**')); assert.ok(result.markdown.includes('$a+b$'));
  assert.ok(result.markdown.includes('| A | B |') || /<table[\s\S]*<b>A<\/b>[\s\S]*<b>B<\/b>[\s\S]*>1<\/td>[\s\S]*>2<\/td>/.test(result.markdown));
  assert.ok(result.markdown.includes('a < b;'));
  assert.deepEqual(result.warnings, []);
});

test('ZIP validation accepts streaming data descriptors and rejects a damaged descriptor', () => {
  const original = makeZip({ '1.in': 'streaming input\n' });
  const centralOffset = original.readUInt32LE(original.length - 6);
  const local = Buffer.from(original.subarray(0, centralOffset)), central = Buffer.from(original.subarray(centralOffset));
  const descriptor = Buffer.alloc(16); descriptor.writeUInt32LE(0x08074b50);
  for (const [source, target] of [[14, 4], [18, 8], [22, 12]]) descriptor.writeUInt32LE(local.readUInt32LE(source), target);
  local.writeUInt16LE(local.readUInt16LE(6) | 8, 6);
  for (const at of [14, 18, 22]) local.writeUInt32LE(0, at);
  central.writeUInt16LE(central.readUInt16LE(8) | 8, 8);
  central.writeUInt32LE(centralOffset + 16, central.length - 6);
  const archive = Buffer.concat([local, descriptor, central]);
  assert.equal(readZip(archive).get('1.in')!.toString(), 'streaming input\n');
  archive[centralOffset + 4] ^= 1;
  assert.throws(() => readZip(archive), /data descriptor/);
});

async function dataProblem(registry: ProblemRegistry, name: string) {
  const p = await registry.create({ name, dataOnly: true, title: { zh: '求和', en: 'Sum' } });
  for (let i = 1; i <= 2; i++) { await atomicWrite(path.join(p.dir, `tests/manual/${i}.in`), `${i} 1\n`); await atomicWrite(path.join(p.dir, `tests/manual/${i}.ans`), `${i + 1}\n`); }
  await registry.patch(p.id, { samples: '1', points: true, testsets: { tests: { groups: true, group: [
    { name: '0-basic', points: 30, tests: '1', policy: 'COMPLETE_GROUP' },
    { name: '1-advanced', points: 70, tests: '2', policy: 'EACH_TEST', dependencies: ['0-basic'] },
  ] } } });
  return p;
}

test('single Hydro packages round-trip statements, data, sample fences, dependencies, programs and assets', async () => fixture(async ({ registry, judge }) => {
  const p = await dataProblem(registry, 'hydro-source');
  for (const lang of ['en', 'zh']) await atomicWrite(path.join(p.dir, `statement/${lang}/legend.tex`), '**Sum** $a+b$\n\n![Diagram](diagram.png)');
  await atomicWrite(path.join(p.dir, 'statement/images/diagram.png'), Buffer.from([137, 80, 78, 71]));
  await atomicWrite(path.join(p.dir, 'checker/custom.cpp'), '#include "testlib.h"\n#include "include/helper.h"\nint main(int argc,char** argv) { registerTestlibCmd(argc,argv); quitf(_ok,"ok"); }');
  await atomicWrite(path.join(p.dir, 'checker/include/helper.h'), '#pragma once\n');
  await atomicWrite(path.join(p.dir, 'private.bin'), Buffer.from([0, 255]));
  await registry.patch(p.id, { checker: 'checker/custom.cpp' });
  const result = await hydroPackage(judge, await judge.ctx(p.id), job(), ['tests']);
  const entries = readZip(result.data), config = yamlObject(entries.get('testdata/config.yaml'), 'config.yaml');
  assert.equal(result.tests, 2); assert.equal(config.subtasks[0].type, 'min'); assert.equal(config.subtasks[0].score, 30);
  assert.deepEqual(config.subtasks[1].if, [1]);
  assert.ok(entries.get('problem_en.md')?.toString().includes('```input1'));
  assert.ok(entries.get('problem_en.md')?.toString().includes('$a+b$'));
  assert.ok(entries.has('additional_file/diagram.png'));
  assert.match(entries.get('testdata/custom.cpp')!.toString(), /#include "helper.h"/);
  assert.ok(config.judge_extra_files.includes('helper.h'));
  assert.ok(![...entries.keys()].some(name => name.startsWith('additional_file/') && name.includes('private')));
  assert.equal(inspectPackage(result.data, { format: 'hydro-problem' })[0].error, undefined);
  const restored = await importPackage(judge, result.data, { format: 'hydro-problem', name: 'hydro-restored' });
  assert.deepEqual(restored.problem.title, { zh: '求和', en: 'Sum' });
  assert.equal((await readSamples(await judge.ctx(restored.problem.id), true, 'en'))[0].sample.output, '2\n');
}));

test('contest Luogu/Hydro archives contain standalone problem packages and persist per-problem aggregation', async () => fixture(async ({ registry, contests, judge }) => {
  const a = await dataProblem(registry, 'alpha'), b = await dataProblem(registry, 'beta');
  const c = await contests.create({ name: 'export-round', problems: [{ index: 'A', problem: a.id }, { index: 'B', problem: b.id }] });
  const deps = { judge, contests, sync: new PolygonSync(judge) };
  const options = { [a.id]: { time: 'min' as const, memory: 'sum' as const }, [b.id]: { time: 'max' as const, memory: 'min' as const } };
  const result = await runContestBatch(deps, c.id, { action: 'export', exportFormat: 'luogu', luoguByProblem: options }, job());
  const outer = readZip(await fs.readFile(path.join(c.dir, '.taskweave/export', result.file!)));
  const first = readZip(outer.get('alpha/data.zip')!), second = readZip(outer.get('beta/data.zip')!);
  assert.match(first.get('score.txt')!.toString(), /@time\d+ < @final_time/);
  assert.match(first.get('score.txt')!.toString(), /@final_memory = @memory\d+ \+ @memory\d+/);
  assert.match(second.get('score.txt')!.toString(), /@time\d+ > @final_time/);
  assert.deepEqual((await judge.ctx(a.id)).config.exports?.luogu, options[a.id]);
  assert.deepEqual((await judge.ctx(b.id)).config.exports?.luogu, options[b.id]);
  const single = await buildProblemDataPackage(judge, await judge.ctx(a.id), 'luogu', job());
  assert.equal(readZip(single.data).get('score.txt')!.toString(), first.get('score.txt')!.toString());
  const hydro = await runContestBatch(deps, c.id, { action: 'export', exportFormat: 'hydro' }, job());
  const hydroOuter = readZip(await fs.readFile(path.join(c.dir, '.taskweave/export', hydro.file!)));
  for (const name of ['alpha', 'beta']) assert.ok(readZip(hydroOuter.get(`${name}/${name}-hydro.zip`)!).has('problem.yaml'));
}));
