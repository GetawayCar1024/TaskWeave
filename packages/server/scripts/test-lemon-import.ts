import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ContestPackageImportRequest } from '@taskweave/shared';
import { GlobalStore } from '../src/global.js';
import { ProblemRegistry } from '../src/workspace/problems.js';
import { ContestRegistry } from '../src/workspace/contests.js';
import { Judge } from '../src/judge/index.js';
import { WsHub } from '../src/ws.js';
import { importPackage } from '../src/imports/packages.js';
import { packageItems } from '../src/imports/units.js';
import { importLemonContest, lemonContests, validateLemonContest } from '../src/imports/lemon.js';
import { readCdf } from '../src/imports/cdf.js';
import { ZipWriter, readZip } from '../src/util/zip.js';
import { addLemonProblem } from '../src/judge/lemonlime.js';
import { directoryPackage, readPackageArchive } from '../src/imports/input.js';

const legacy = Buffer.from('IBERJ4pDAAAArwAAASx4nFWPSwrCQBBEXxCyEBFx7cJ9iOIRdOXCS8R8NKATMRH0xh7D6skYkWEy1V1dVR1gwYGSExk5L5ZU1DzpeHBXHyLdMVsxie5OVUwr9io0CWgljVM9HepGbxeZluCxJ9WpleTEmneq6ZvPNZxzFnbiS+XYbCdkm/TVUZpancpv8PONpUh0LL3wfKbsi3TGmWMbJgsYvXvoP7Ow7ZrN8AfWn//1vw58AGE8Jks=', 'base64');
const task = () => ({ sourceFileName: 'road', problemTitle: 'Road', standardInputCheck: true, standardOutputCheck: true, taskType: 0, comparisonMode: 1, realPrecision: 6, specialJudge: '', testCases: [
  { fullScore: 30, timeLimit: 1000, memoryLimit: 256, inputFiles: ['Road/1.IN', 'Road/2.in'], outputFiles: ['Road/1.ans', 'Road/2.ans'] },
  { fullScore: 70, timeLimit: 2000, memoryLimit: 512, inputFiles: ['Road/2.in', '1_lemon_SUbtaskDEPENDENCE_fLAg'], outputFiles: ['Road/2.ans'] },
] });
const sum = () => ({ sourceFileName: 'sum', problemTitle: 'Sum', taskType: 0, comparisonMode: 0, testCases: [{ fullScore: 100, timeLimit: 1000, memoryLimit: 128, inputFiles: ['sum/1.in', 'sum/2.in'], outputFiles: ['sum/1.out', 'sum/2.out'] }] });
const zip = (values: Record<string, string | Buffer>) => { const zip = new ZipWriter(); for (const [name, data] of Object.entries(values)) zip.add(name, data); return zip.finish(); };
const packageFiles = (tasks: object[] = [task()]): Record<string, string | Buffer> => ({ 'wrapper/contest.cdf': JSON.stringify({ version: '1.0', contestTitle: 'Fixture', tasks, contestants: [] }),
  'wrapper/data/road/1.in': '1\n', 'wrapper/data/road/1.out': '2\r\n', 'wrapper/data/road/2.in': '2\n', 'wrapper/data/road/2.out': '4\n', 'wrapper/data/road/extra.in': 'unconfigured',
  'wrapper/data/sum/1.in': '1 2\n', 'wrapper/data/sum/1.out': '3\n', 'wrapper/data/sum/2.in': '5 5\n', 'wrapper/data/sum/2.out': '10\n', 'wrapper/source/alice/road.cpp': 'not a reference solution' });
const job = () => ({ signal: new AbortController().signal, progress() {} });

async function fixture(run: (ctx: { judge: Judge; registry: ProblemRegistry; contests: ContestRegistry }) => Promise<void>) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tw-lemon-import-')));
  const global = new GlobalStore(home); await global.init(); global.config.problems.roots = [path.join(home, 'problems')];
  const registry = new ProblemRegistry(global), judge = new Judge(global, registry, new WsHub()), contests = new ContestRegistry(registry, global);
  try { await run({ judge, registry, contests }); } finally { await fs.rm(home, { recursive: true, force: true }); }
}
/** The request the dialog sends for the n-th CDF: every valid task, with the proposed names. */
function request(archive: Map<string, Buffer>, overrides: Partial<ContestPackageImportRequest> = {}, contest = 0): ContestPackageImportRequest {
  const candidate = lemonContests(archive)[contest];
  return { uploadId: 'staged', entry: candidate.entry, name: 'fixture-round', title: { en: candidate.title }, lang: 'en',
    tasks: candidate.tasks.map(task => ({ key: task.key, include: !task.error, name: task.name, title: task.title })), ...overrides };
}
const importAll = async (judge: Judge, contests: ContestRegistry, bytes: Buffer, overrides: Partial<ContestPackageImportRequest> = {}) => {
  const archive = readPackageArchive(bytes);
  return importLemonContest(judge, contests, archive, request(archive, overrides));
};

test('a LemonLime contest imports every task in order and keeps unused originals with the contest', async () => fixture(async ({ judge, registry, contests }) => {
  const bytes = zip(packageFiles([task(), sum()])), [candidate] = lemonContests(readPackageArchive(bytes));
  assert.equal(candidate.title, 'Fixture'); assert.equal(candidate.name, 'fixture');
  assert.deepEqual(candidate.tasks.map(item => [item.name, item.tests, item.error]), [['road', 2, undefined], ['sum', 2, undefined]]);
  assert.ok(candidate.tasks[0].warnings?.some(warning => warning.includes('corrected')));
  const imported = await importAll(judge, contests, bytes);
  assert.equal(imported.contest.type, 'oi');
  assert.deepEqual(imported.contest.problems.map(p => [p.index, p.problem]), [['A', imported.problems[0].id], ['B', imported.problems[1].id]]);
  const road = imported.problems[0], config = (await registry.detail(road.id)).config!;
  assert.deepEqual(config.tests.group?.map(group => [group.tests, group.points, group.dependencies ?? [], group.time_limit]), [['1-2', 30, [], 1000], ['2', 70, ['subtask-1'], 2000]]);
  assert.equal(config.solutions.length, 0); assert.equal(config.lemon_comparison?.mode, 'ignore-spaces'); assert.equal(config.problem.source_name, undefined);
  assert.equal(await fs.readFile(path.join(road.dir, 'tests/manual/1.ans'), 'utf8'), '2\r\n');
  // Each problem keeps its own extras and task configuration, not its tests twice or another task's files.
  assert.equal(await fs.readFile(path.join(road.dir, 'other/lemonlime/data/road/extra.in'), 'utf8'), 'unconfigured');
  assert.equal(JSON.parse(await fs.readFile(path.join(road.dir, 'other/lemonlime/task.json'), 'utf8')).sourceFileName, 'road');
  await assert.rejects(fs.access(path.join(road.dir, 'other/lemonlime/data/road/1.in')));
  await assert.rejects(fs.access(path.join(road.dir, 'other/lemonlime/data/sum')));
  const files = path.join(imported.contest.dir, 'files');
  assert.equal(await fs.readFile(path.join(files, 'lemonlime/contest.cdf'), 'utf8'), packageFiles([task(), sum()])['wrapper/contest.cdf']);
  assert.equal(await fs.readFile(path.join(files, 'lemonlime/source/alice/road.cpp'), 'utf8'), 'not a reference solution');
  await assert.rejects(fs.access(path.join(files, 'lemonlime/data/road/1.in')));
  assert.match(await fs.readFile(path.join(files, 'lemonlime-import.md'), 'utf8'), /A: road/);
  const result = await addLemonProblem(judge, await judge.ctx(road.id), 'A', new ZipWriter(), job());
  assert.equal(result.task.comparisonMode, 1); assert.equal(result.task.specialJudge, ''); assert.deepEqual(result.task.testCases.map(row => row.fullScore), [30, 70]);
  assert.deepEqual((await registry.detail(imported.problems[1].id)).config!.lemon_comparison, { mode: 'lines', precision: 3 });
}));

test('excluded tasks stay in the contest originals and are not imported', async () => fixture(async ({ judge, contests }) => {
  const archive = readPackageArchive(zip(packageFiles([task(), sum()]))), req = request(archive);
  req.tasks[0].include = false;
  const imported = await importLemonContest(judge, contests, archive, req);
  assert.deepEqual(imported.problems.map(p => p.name), ['sum']); assert.deepEqual(imported.contest.problems.map(p => p.index), ['A']);
  assert.equal(await fs.readFile(path.join(imported.contest.dir, 'files/lemonlime/data/road/1.out'), 'utf8'), '2\r\n');
}));

test('missing references are task errors; a missing file is never repaired from another task folder', async () => fixture(async ({ judge, registry, contests }) => {
  const files = packageFiles([task(), sum()]); delete files['wrapper/data/road/2.out'];
  const preview = lemonContests(readPackageArchive(zip(files)));
  assert.match(preview[0].tasks[0].error ?? '', /Missing file referenced/); assert.equal(preview[0].tasks[1].error, undefined);
  const archive = readPackageArchive(zip(files)), req = request(archive); req.tasks[0].include = true;
  await assert.rejects(importLemonContest(judge, contests, archive, req), /Missing file referenced/);
  assert.equal((await registry.list()).length, 0); assert.equal((await contests.list()).length, 0);
  const crossTask = packageFiles([{ ...sum(), testCases: [{ fullScore: 100, timeLimit: 1000, memoryLimit: 128, inputFiles: ['sum/1.in'], outputFiles: ['sum/extra.in'] }] }]);
  assert.match(lemonContests(readPackageArchive(zip(crossTask)))[0].tasks[0].error ?? '', /Missing file referenced by configuration: sum\/extra\.in/);
  const invalid = task(); invalid.testCases[1].inputFiles.push('2_lemon_SUbtaskDEPENDENCE_fLAg');
  assert.match(lemonContests(readPackageArchive(zip(packageFiles([invalid]))))[0].tasks[0].error ?? '', /invalid preceding dependency/);
}));

test('the whole contest is validated before anything is written, and later failures roll back', async () => fixture(async ({ judge, registry, contests }) => {
  await registry.create({ name: 'road' });
  const archive = readPackageArchive(zip(packageFiles([task(), sum()])));
  const check = await validateLemonContest(judge, contests, request(archive));
  assert.deepEqual(check, { errors: [], tasks: { 1: 'Problem name already exists in this folder: road' } });
  assert.deepEqual((await validateLemonContest(judge, contests, request(archive, { tasks: request(archive).tasks.map(item => ({ ...item, name: 'same' })) }))).tasks, { 1: 'Duplicate problem name in the same folder: same', 2: 'Duplicate problem name in the same folder: same' });
  // Another problem folder may reuse the name.
  await fs.mkdir(path.join(judge.registry.roots[0], 'NOIP'));
  assert.deepEqual(await validateLemonContest(judge, contests, request(archive, { problemFolder: 'NOIP' })), { errors: [], tasks: {} });
  assert.match((await validateLemonContest(judge, contests, request(archive, { name: 'Bad Name' }))).errors[0], /lowercase/);
  await assert.rejects(importLemonContest(judge, contests, archive, request(archive)), /Problem name already exists in this folder: road/);
  assert.deepEqual((await registry.list()).map(p => p.name), ['road']); assert.equal((await contests.list()).length, 0);
  const create = contests.create.bind(contests);
  contests.create = async () => { throw new Error('disk full'); };
  const renamed = request(archive); renamed.tasks[0].name = 'noip-road';
  await assert.rejects(importLemonContest(judge, contests, archive, renamed), /disk full/);
  assert.deepEqual((await registry.list()).map(p => p.name), ['road']);
  contests.create = create;
  const imported = await importLemonContest(judge, contests, archive, renamed);
  // A renamed short name keeps the original LemonLime source name for contestants and re-export.
  const ctx = await judge.ctx(imported.problems[0].id);
  assert.equal(ctx.config.problem.name, 'noip-road'); assert.equal(ctx.config.problem.source_name, 'road');
  const output = new ZipWriter(), exported = await addLemonProblem(judge, ctx, 'A', output, job());
  assert.equal(exported.task.sourceFileName, 'road'); assert.equal(exported.task.inputFileName, 'road.in');
  assert.ok(readZip(output.finish()).has('data/road/1.in'));
}));

test('problem imports reject LemonLime packages and point to contest import', async () => fixture(async ({ judge, registry }) => {
  const bytes = zip(packageFiles());
  assert.match(packageItems(readPackageArchive(bytes))[0].error ?? '', /whole contests/);
  await assert.rejects(importPackage(judge, bytes, { format: 'auto', name: 'single' }), /whole contests/);
  await assert.rejects(importPackage(judge, bytes, { format: 'lemonlime', name: 'single' }), /whole contests/);
  assert.equal((await registry.list()).length, 0);
}));

test('empty CDF task lists offer unconfigured data folders as unscored problems', async () => fixture(async ({ judge, contests }) => {
  const files = packageFiles([]); delete files['wrapper/data/road/extra.in'];
  const [candidate] = lemonContests(readPackageArchive(zip(files)));
  assert.deepEqual(candidate.tasks.map(item => [item.key, item.name, item.tests]), [['data:road', 'road', 2], ['data:sum', 'sum', 2]]);
  const result = await importAll(judge, contests, zip(files));
  const config = (await judge.registry.detail(result.problems[0].id)).config!;
  assert.equal(config.tests.points, false); assert.equal(config.tests.groups, false);
  assert.ok(result.warnings.some(warning => warning.includes('without scores')));
}));

test('legacy CDF decodes Qt fields and verifies checksum before decompression', async () => fixture(async ({ judge, contests }) => {
  const decoded = readCdf(legacy); assert.equal(decoded.contestTitle, 'Legacy fixture'); assert.equal(decoded.tasks[0].sourceFileName, 'sum');
  const imported = await importAll(judge, contests, zip({ 'old/contest.cdf': legacy, 'old/data/sum/1.in': '1 2\n', 'old/data/sum/1.ans': '3\n' }), { name: 'legacy-round' });
  assert.equal(imported.problems[0].name, 'sum');
  const damaged = Buffer.from(legacy); damaged[15] ^= 1; assert.throws(() => readCdf(damaged), /checksum/i);
}));

test('Lemon Testlib SPJ imports retain mode 5 when exporting another native package', async () => fixture(async ({ judge, contests }) => {
  const spj = task(); spj.comparisonMode = 5; spj.specialJudge = 'road/checker.exe'; spj.testCases = [spj.testCases[0]];
  const files = packageFiles([spj]);
  files['wrapper/data/road/checker.cpp'] = '#include "testlib.h"\nint main(int argc, char** argv) { registerTestlibCmd(argc, argv); quitf(_ok, "fixture"); }\n';
  const imported = await importAll(judge, contests, zip(files)), id = imported.problems[0].id;
  const result = await addLemonProblem(judge, await judge.ctx(id), 'A', new ZipWriter(), job(), undefined, false, process.platform === 'win32' ? 'linux' : 'windows');
  assert.equal(result.task.comparisonMode, 5); assert.ok(result.task.specialJudge); assert.ok(result.checkerBuild);
  assert.equal((await judge.ctx(id)).config.checker?.source, 'other/lemonlime/data/road/checker.cpp');
}));

test('binary-only Lemon special judges remain visible and cannot silently export a built-in comparison', async () => fixture(async ({ judge, registry, contests }) => {
  const spj = task(); spj.comparisonMode = 4; spj.specialJudge = 'road/checker.exe'; spj.testCases = [spj.testCases[0]];
  const files = packageFiles([spj]); files['wrapper/data/road/checker.exe'] = Buffer.from([77, 90, 0, 0, 5]);
  const imported = await importAll(judge, contests, zip(files)), problem = imported.problems[0];
  assert.ok((await judge.ctx(problem.id)).config.problem.unresolved_judge);
  assert.deepEqual(await fs.readFile(path.join(problem.dir, 'other/lemonlime/data/road/checker.exe')), files['wrapper/data/road/checker.exe']);
  let ctx = await judge.ctx(problem.id);
  const build = () => addLemonProblem(judge, ctx, 'A', new ZipWriter(), job());
  await assert.rejects(build, /special judge.*source/i);
  await registry.patch(problem.id, { title: { en: 'Keep unresolved' } });
  assert.ok((await judge.ctx(problem.id)).config.problem.unresolved_judge);
  await registry.patch(problem.id, { lemonComparison: { mode: 'lines', precision: 3 } });
  ctx = await judge.ctx(problem.id);
  assert.equal((await build()).task.comparisonMode, 0);
}));

test('Lemon duplicate occurrences and original metadata files survive import and re-export', async () => fixture(async ({ judge, contests }) => {
  const repeated = task(); repeated.testCases[0].inputFiles.push('Road/1.IN'); repeated.testCases[0].outputFiles.push('Road/1.ans');
  const files = packageFiles([{ ...repeated, extraMetadata: null }]);
  files['wrapper/IMPORT.md'] = 'Original package instructions';
  const imported = await importAll(judge, contests, zip(files), { tasks: [{ key: '1', include: true, name: 'repeat-cases', title: 'Road' }] });
  assert.equal(await fs.readFile(path.join(imported.contest.dir, 'files/lemonlime/IMPORT.md'), 'utf8'), 'Original package instructions');
  assert.equal(JSON.parse(await fs.readFile(path.join(imported.problems[0].dir, 'other/lemonlime/task.json'), 'utf8')).extraMetadata, null);
  const ctx = await judge.ctx(imported.problems[0].id);
  assert.equal(ctx.config.problem.source_name, 'road');
  const output = new ZipWriter(), result = await addLemonProblem(judge, ctx, 'A', output, job());
  assert.equal(result.task.testCases[0].inputFiles.length, 3); assert.equal(result.task.testCases[1].fullScore, 70);
  const packed = readZip(output.finish());
  assert.deepEqual(packed.get('data/road/1.in'), packed.get('data/road/3.in'));
}));

test('Lemon directory selection keeps CDF roots independent and native real precision intact', async () => fixture(async ({ judge, contests }) => {
  const first = task(), second = task(); first.comparisonMode = 0; second.comparisonMode = 3; second.realPrecision = 18;
  const files = packageFiles([first]);
  for (const [name, data] of Object.entries(packageFiles([second]))) files[name.replace('wrapper/', 'second/')] = name.endsWith('road/1.out') ? 'second answer' : data;
  files['README.txt'] = 'archive note';
  const directory = path.join(judge.global.dir, 'unpacked');
  for (const [name, data] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true }); await fs.writeFile(path.join(directory, name), data); }
  const archive = readPackageArchive(await directoryPackage(directory));
  assert.deepEqual(lemonContests(archive).map(item => item.entry), ['second/contest.cdf', 'wrapper/contest.cdf']);
  const imported = await importLemonContest(judge, contests, archive, request(archive, { name: 'second-round' }, 0));
  assert.deepEqual((await judge.ctx(imported.problems[0].id)).config.lemon_comparison, { mode: 'real', precision: 18 });
  assert.equal(await fs.readFile(path.join(imported.problems[0].dir, 'tests/manual/1.ans'), 'utf8'), 'second answer');
  const kept = path.join(imported.contest.dir, 'files/lemonlime');
  assert.equal(await fs.readFile(path.join(kept, 'archive/README.txt'), 'utf8'), 'archive note');
  await assert.rejects(fs.access(path.join(kept, 'archive/wrapper/contest.cdf')));
  assert.match(lemonContests(readPackageArchive(Buffer.from(files['wrapper/contest.cdf'])))[0].tasks[0].error ?? '', /Missing file referenced/);
}));

test('Lemon source-only checkers recover casing and build a usable native mode-4 export', async () => fixture(async ({ judge, contests }) => {
  const spj = task(); spj.comparisonMode = 4; spj.specialJudge = 'road/checker.exe'; spj.testCases = [spj.testCases[0]];
  const files = Object.fromEntries(Object.entries(packageFiles([spj])).map(([name, data]) => [name.replace('/data/', '/DATA/'), data]));
  files['wrapper/DATA/road/CHECKER.CPP'] = await fs.readFile(path.join(judge.global.sharedDir, 'lemon/checkers/wcmp.cpp'));
  const imported = await importAll(judge, contests, zip(files)), ctx = await judge.ctx(imported.problems[0].id);
  assert.equal(ctx.config.lemon_checker?.source, 'other/lemonlime/DATA/road/CHECKER.CPP');
  const output = new ZipWriter(), result = await addLemonProblem(judge, ctx, 'A', output, job());
  assert.equal(result.task.comparisonMode, 4); assert.ok(result.checkerBuild);
  assert.ok(readZip(output.finish()).has('data/' + result.task.specialJudge));
}));

test('Lemon linked graders preserve build aliases and diagnose missing headers and runtime-file mismatches', async () => fixture(async ({ judge, contests }) => {
  const interaction = { ...task(), taskType: 2, grader: 'road/grader.cpp', interactor: 'road/supplied.h', interactorName: 'judge.h' };
  const files = packageFiles([interaction]); files['wrapper/data/road/grader.cpp'] = '#include "judge.h"\nint main() { return 0; }'; files['wrapper/data/road/supplied.h'] = '#pragma once\n';
  const imported = await importAll(judge, contests, zip(files)), ctx = await judge.ctx(imported.problems[0].id);
  assert.equal(ctx.config.problem.judge_mode, 'grader'); assert.deepEqual(ctx.config.grader, { sources: ['grader/__grader.cpp'], headers: ['grader/judge.h'] });
  assert.equal(await fs.readFile(path.join(imported.problems[0].dir, 'grader/judge.h'), 'utf8'), '#pragma once\n');
  delete files['wrapper/data/road/supplied.h'];
  const first = (values: Record<string, string | Buffer>) => lemonContests(readPackageArchive(zip(values)))[0].tasks[0].error ?? '';
  assert.match(first(files), /Missing file referenced.*supplied.h/);
  assert.ok(first(packageFiles([{ ...task(), standardInputCheck: false, inputFileName: '../escape' }])));
  const collision = { ...task(), taskType: 3, sourceFilesPath: ['road.cpp'], sourceFilesName: ['grader.cpp'], graderFilesPath: ['road/grader.cpp'], graderFilesName: ['grader.cpp'] };
  files['wrapper/contest.cdf'] = JSON.stringify({ tasks: [collision] });
  assert.match(first(files), /Conflicting Lemon grader build filenames/);
}));
