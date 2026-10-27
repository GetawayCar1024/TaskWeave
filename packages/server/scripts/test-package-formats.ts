import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { testsetOf } from '@polyforge/shared';
import { GlobalStore } from '../src/global.js';
import { ProblemRegistry } from '../src/workspace/problems.js';
import { Judge } from '../src/judge/index.js';
import { WsHub } from '../src/ws.js';
import { ZipWriter, readZip } from '../src/util/zip.js';
import { importPackage, inspectPackage } from '../src/imports/packages.js';
import { polygonPath, polygonXml } from '../src/imports/polygon.js';
import { parseData } from '../src/imports/data.js';
import { readManifest, generateTests, answerPath, inputPath } from '../src/judge/tests.js';
import { exportPackage } from '../src/judge/package.js';
import { buildProblemDataPackage } from '../src/judge/problemExport.js';
import { PackageUploads } from '../src/imports/uploads.js';

const job = () => ({ signal: new AbortController().signal, progress() {} });
const zip = (files: Record<string, string | Buffer>) => { const writer = new ZipWriter(); for (const [name, value] of Object.entries(files)) writer.add(name, value); return writer.finish(); };
async function fixture(run: (judge: Judge, home: string) => Promise<void>) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-formats-'));
  try {
    const global = new GlobalStore(home); await global.init(); global.config.problems.roots = [path.join(home, 'problems')];
    await run(new Judge(global, new ProblemRegistry(global), new WsHub()), home);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
}

const polygonFixture = (standard = false) => zip({
  'problem.xml': `<problem short-name="poly-source"><names><name language="english" value="A &amp; B"/></names>
    <judging input-file="" output-file=""><testset name="tests"><time-limit>1750</time-limit><memory-limit>805306368</memory-limit>
      <test-count>2</test-count><input-path-pattern>tests/%02d</input-path-pattern><answer-path-pattern>tests/%02d.a</answer-path-pattern>
      <tests><test method="manual" sample="true" group="0" points="0"/><test method="generated" cmd="gen 42" group="0" points="37"/></tests>
      <groups><group name="0" points="37" points-policy="complete-group"/></groups></testset></judging>
    <files><resources><file path="files/helper.h"/></resources><executables><executable><source path="files/gen.cpp" type="cpp.g++17"/></executable></executables></files>
    <assets><checker type="testlib"><source path="files/check.cpp" type="cpp.g++17"/></checker>
      <validators><validator><source path="files/val.cpp" type="cpp.g++17"/><testset><test-count>1</test-count><input-path-pattern>validator-data/%02d</input-path-pattern><tests><test verdict="valid"/></tests></testset></validator></validators>
      <solutions><solution tag="main"><source path="solutions/main.cpp" type="cpp.g++17"/></solution></solutions></assets></problem>`,
  'files/helper.h': '#pragma once\n', 'files/check.cpp': 'int main(){return 0;}\n', 'files/val.cpp': 'int main(){return 0;}\n',
  'files/gen.cpp': '#include <iostream>\nint main(){std::cout<<"4 5\\n";}\n',
  'solutions/main.cpp': '#include <iostream>\nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n";}\n',
  'tests/01': '1 2\r\n', 'tests/01.a': '3\r\n', 'validator-data/01': '1 2\n',
  ...(standard ? {} : { 'tests/02': '4 5\n', 'tests/02.a': '9\n' }),
  'statement-sections/english/legend.tex': 'Add $a$ and $b$.', 'statement-sections/english/input.tex': 'Two integers.',
  'statement-sections/english/example.01': '1 2\n', 'statement-sections/english/example.01.a': '3\n',
  'statements/.html/english/unlisted.css': '.problem { color: black; }',
});

test('JOI directory packages discover multiple problems, preserve names/bytes, and round-trip overlapping subtasks', async () => fixture(async judge => {
  const archive = zip({ 'round/a/in/01-02.txt': '1 2\r\n', 'round/a/out/01-02.txt': '3\r\n', 'round/a/in/02_01.txt': '', 'round/a/out/02_01.txt': '',
    'round/b/in/sample-01.txt': '9\n', 'round/b/out/sample-01.txt': '9\n' });
  const candidates = inspectPackage(archive, { format: 'joi' });
  assert.deepEqual(candidates.map(c => [c.entry, c.tests, c.error]), [['round/a/', 2, undefined], ['round/b/', 1, undefined]]);
  const imported = await importPackage(judge, archive, { format: 'joi', entry: 'round/a/', name: 'joi-source' });
  let ctx = await judge.ctx(imported.problem.id);
  assert.equal(ctx.config.tests.points, false);
  assert.equal((await readManifest(ctx))!.tests[0].originalInput, 'in/01-02.txt');
  assert.equal(await fs.readFile(inputPath(ctx, 1), 'utf8'), '1 2\r\n');
  await judge.registry.patch(imported.problem.id, { points: true, testsets: { tests: { groups: true, group: [
    { name: '0', tests: '1', points: 23, time_limit: 700, memory_limit: 64 },
    { name: '1', tests: '1-2', policy: 'EACH_TEST', test_points: 7, time_limit: 2500, memory_limit: 2048, dependencies: ['0'] },
  ] } } });
  ctx = await judge.ctx(imported.problem.id);
  const exported = await buildProblemDataPackage(judge, ctx, 'joi', job());
  const files = readZip(exported.data); assert.ok(files.has('in/01-02.txt')); assert.ok(files.has('polyforge.yaml'));
  const restored = await importPackage(judge, exported.data, { format: 'joi', name: 'joi-restored' });
  const groups = (await judge.ctx(restored.problem.id)).config.tests.group!;
  assert.deepEqual(groups.map(g => [g.name, g.tests, g.points, g.test_points, g.time_limit, g.memory_limit]), [['0', '1', 23, undefined, 700, 64], ['1', '1-2', 14, 7, 2500, 2048]]);
}));

test('generic data detection reads renamed YAML/JSON configurations by shape', () => {
  const files = new Map([['a.in', Buffer.from('1')], ['a.out', Buffer.from('2')], ['scoring.json', Buffer.from('{"a.in":{"score":233,"timeLimit":22000,"memoryLimit":2097152,"subtaskId":0}}')]]);
  const plan = parseData(files, 'auto'); assert.equal(plan.groups[0].points, 233); assert.equal(plan.cases[1].time_limit, 22000); assert.equal(plan.cases[1].memory_limit, 2048);
  files.delete('scoring.json'); files.set('settings.yml', Buffer.from('subtasks:\n  - id: 0\n    score: 37\n    time: 2s\n    memory: 768m\n    cases: [{input: a.in, output: a.out}]\n'));
  const hydro = parseData(files, 'auto'); assert.equal(hydro.groups[0].points, 37); assert.equal(hydro.cases[1].time_limit, 2000);
  const globalOnly = parseData(new Map([['1.in', Buffer.from('1')], ['1.out', Buffer.from('2')], ['limits.json', Buffer.from('{"time":"3s","memory":"768m"}')]]), 'auto');
  assert.equal(globalOnly.cases[1].time_limit, 3000); assert.equal(globalOnly.cases[1].memory_limit, 768);
});

test('Hydro shared file references stay one test with membership-specific limits, and attachments are not images', async () => fixture(async judge => {
  const archive = zip({ 'problem.yaml': 'title: Shared\n', 'problem.md': 'Body',
    'testdata/config.yaml': 'subtasks:\n  - id: 0\n    score: 20\n    time: 1s\n    cases: [{input: a.in, output: a.out}]\n  - id: 1\n    score: 30\n    time: 2s\n    cases: [{input: a.in, output: a.out}]\n',
    'testdata/a.in': '1', 'testdata/a.out': '1', 'additional_file/sample.in': 'x', 'additional_file/sample.out': 'y', 'additional_file/pic.png': Buffer.from([137, 80, 78, 71]) });
  const imported = await importPackage(judge, archive, { format: 'hydro-problem', name: 'hydro-shared' });
  const ctx = await judge.ctx(imported.problem.id), manifest = await readManifest(ctx);
  assert.equal(manifest!.tests.length, 1);
  assert.deepEqual(manifest!.tests[0].groups?.map(g => g.timeLimit), [1000, 2000]);
  await assert.rejects(fs.access(path.join(ctx.ref.dir, 'statement/images/sample.in')));
  assert.equal(await fs.readFile(path.join(ctx.ref.dir, 'other/hydro/additional_file/sample.in'), 'utf8'), 'x');
  await fs.access(path.join(ctx.ref.dir, 'statement/images/pic.png'));
}));

test('Polygon full archives round-trip native XML, source roles, hidden resources, samples and bundled scores', async () => fixture(async judge => {
  const bytes = polygonFixture(), candidate = inspectPackage(bytes, { format: 'polygon-package' })[0];
  assert.equal(candidate.error, undefined); assert.equal(candidate.tests, 2); assert.equal(candidate.title, 'A & B');
  const imported = await importPackage(judge, bytes, { format: 'polygon-package', name: 'polygon-source' });
  const ctx = await judge.ctx(imported.problem.id), manifest = await readManifest(ctx);
  assert.equal(ctx.config.problem.data_only, false); assert.equal(ctx.config.polygon.id, undefined);
  assert.deepEqual(manifest!.tests.map(test => test.points), [37, 37]);
  assert.equal(manifest!.tests[0].originalInput, 'tests/01');
  assert.equal(ctx.config.solutions[0].source, 'other/polygon/solutions/main.cpp');
  await fs.access(path.join(ctx.ref.dir, 'validator-tests/1.valid.in'));
  await fs.access(path.join(ctx.ref.dir, 'other/polygon/statements/.html/english/unlisted.css'));
  const exported = await exportPackage(judge, ctx, job(), undefined, true);
  const archive = await fs.readFile(path.join(ctx.work, 'export', exported.file));
  const xml = polygonXml(readZip(archive).get('problem.xml'));
  assert.equal(xml.judging.testset.tests.test[0]['@_points'], '0'); assert.equal(xml.judging.testset.tests.test[1]['@_points'], '37');
  const again = await importPackage(judge, archive, { format: 'polygon-package', name: 'polygon-restored' });
  assert.equal((await judge.ctx(again.problem.id)).config.tests.group![0].points, 37);
}));

test('Polygon standard archives preserve supplied answers and explicitly build missing generated data', async () => fixture(async judge => {
  const imported = await importPackage(judge, polygonFixture(true), { format: 'polygon-package', name: 'standard' });
  const ctx = await judge.ctx(imported.problem.id);
  assert.equal(ctx.config.tests.answers, 'generated'); assert.equal(ctx.config.tests.cases?.[1].provided_answer, true);
  const manifest = await generateTests(judge, ctx, job()); assert.equal(manifest.ok, true, manifest.errors.join('\n'));
  assert.equal(await fs.readFile(answerPath(ctx, 1), 'utf8'), '3\r\n'); assert.equal(await fs.readFile(answerPath(ctx, 2), 'utf8'), '9\n');
}));

test('Polygon shared tests are copied natively then reunited by checked provenance on re-import', async () => fixture(async judge => {
  const imported = await importPackage(judge, zip({ '1.in': '1', '1.out': '1' }), { format: 'data', name: 'shared-export' });
  await judge.registry.patch(imported.problem.id, { points: true, testsets: { tests: { groups: true, group: [{ name: '0', tests: '1', points: 30 }, { name: '1', tests: '1', policy: 'EACH_TEST', test_points: 20 }] } } });
  const ctx = await judge.ctx(imported.problem.id), exported = await exportPackage(judge, ctx, job(), undefined, true);
  const bytes = await fs.readFile(path.join(ctx.work, 'export', exported.file));
  assert.equal(polygonXml(readZip(bytes).get('problem.xml')).judging.testset['test-count'], '2');
  const restored = await importPackage(judge, bytes, { format: 'polygon-package', name: 'shared-restored' });
  const manifest = await readManifest(await judge.ctx(restored.problem.id)); assert.equal(manifest!.tests.length, 1);
  assert.deepEqual(manifest!.tests[0].groups?.map(group => group.points), [30, 20]);
}));

test('ZIP previews reject invalid Polygon XML references and XML entities before creating a problem', () => {
  assert.equal(polygonPath('tests/%02d.a', 406), 'tests/406.a');
  assert.throws(() => polygonPath('../outside/%02d', 1));
  assert.throws(() => polygonXml(Buffer.from('<!DOCTYPE problem [<!ENTITY x SYSTEM "file:///x">]><problem/>')), /DTD/);
  const damaged = readZip(polygonFixture()); damaged.delete('tests/01');
  assert.match(inspectPackage(damaged, { format: 'polygon-package' })[0].error!, /Missing input/);
});

test('staged archives are reusable for per-problem settings and are removed when dismissed', async () => fixture(async (judge, home) => {
  const uploads = new PackageUploads(home);
  try {
    const stage = await uploads.stage(zip({ 'a/in/a.txt': '1', 'a/out/a.txt': '2', 'b/in/b.txt': '3', 'b/out/b.txt': '4' }), { format: 'joi' });
    assert.equal(stage.candidates.length, 2);
    const files = await uploads.read(stage.id, 'joi');
    for (const [index, candidate] of stage.candidates.entries()) {
      const result = await importPackage(judge, files, { format: 'joi', entry: candidate.entry, name: `batch-${index}`, timeLimit: 1000 + index, title: { en: `Problem ${index}` } });
      assert.equal(result.problem.timeLimit, 1000 + index); assert.equal(result.problem.title.en, `Problem ${index}`);
    }
    await uploads.discard(stage.id); await assert.rejects(uploads.read(stage.id, 'joi'), /expired/);
  } finally { await uploads.dispose(); }
}));

test('publication tolerates an in-flight pre-import scan and Windows root casing', async () => fixture(async judge => {
  const scan = judge.registry.scan.bind(judge.registry), previous = await scan();
  let stale = true;
  judge.registry.scan = async () => { if (stale) { stale = false; return previous; } return scan(); };
  const root = judge.registry.roots[0];
  const result = await importPackage(judge, zip({ '1.in': '1', '1.out': '2' }), { format: 'data', name: 'new-after-scan', root: process.platform === 'win32' ? root.toUpperCase() : root });
  assert.equal(result.problem.name, 'new-after-scan');
}));

test('incremental compatibility refresh notices source edits, repairs cache edits and removes stale missing answers', async () => fixture(async judge => {
  const imported = await importPackage(judge, zip({ 'input-01.in': '1', 'input-01.out': '2' }), { format: 'data', name: 'incremental' });
  const ctx = await judge.ctx(imported.problem.id), initial = await readManifest(ctx);
  assert.equal((await readManifest(ctx))!.generatedAt, initial!.generatedAt);
  await fs.writeFile(path.join(ctx.ref.dir, 'tests/manual/1.in'), '7');
  await Promise.all([readManifest(ctx), readManifest(ctx), readManifest(ctx)]);
  assert.equal(await fs.readFile(inputPath(ctx, 1), 'utf8'), '7');
  await fs.writeFile(answerPath(ctx, 1), 'tampered'); await readManifest(ctx);
  assert.equal(await fs.readFile(answerPath(ctx, 1), 'utf8'), '2');
  await fs.unlink(path.join(ctx.ref.dir, 'tests/manual/1.ans'));
  assert.equal((await readManifest(ctx))!.ok, false);
  await assert.rejects(fs.access(answerPath(ctx, 1)));
}));

test('uploads recover from cache-directory removal and report expired selections', async () => fixture(async (_judge, home) => {
  const uploads = new PackageUploads(home), bytes = zip({ '1.in': '1', '1.out': '2' });
  try {
    const first = await uploads.stage(bytes, { format: 'data' });
    const parent = path.join(home, 'cache'), directory = (await fs.readdir(parent)).find(name => name.startsWith('package-import-'))!;
    await fs.rm(path.join(parent, directory), { recursive: true });
    const second = await uploads.stage(bytes, { format: 'data' });
    assert.equal((await uploads.read(second.id, 'data')).get('1.in')!.toString(), '1');
    await assert.rejects(uploads.read(first.id, 'data'), /expired/);
  } finally { await uploads.dispose(); }
}));
