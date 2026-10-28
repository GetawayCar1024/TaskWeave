import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GlobalStore } from '../src/global.js';
import { ProblemRegistry } from '../src/workspace/problems.js';
import { Judge } from '../src/judge/index.js';
import { WsHub } from '../src/ws.js';
import { inspectPackage, importPackage } from '../src/imports/packages.js';
import { readCdf } from '../src/imports/cdf.js';
import { ZipWriter, readZip } from '../src/util/zip.js';
import { addLemonProblem } from '../src/judge/lemonlime.js';
import { directoryPackage } from '../src/imports/input.js';

const legacy = Buffer.from('IBERJ4pDAAAArwAAASx4nFWPSwrCQBBEXxCyEBFx7cJ9iOIRdOXCS8R8NKATMRH0xh7D6skYkWEy1V1dVR1gwYGSExk5L5ZU1DzpeHBXHyLdMVsxie5OVUwr9io0CWgljVM9HepGbxeZluCxJ9WpleTEmneq6ZvPNZxzFnbiS+XYbCdkm/TVUZpancpv8PONpUh0LL3wfKbsi3TGmWMbJgsYvXvoP7Ow7ZrN8AfWn//1vw58AGE8Jks=', 'base64');
const task = () => ({ sourceFileName: 'road', problemTitle: 'Road', standardInputCheck: true, standardOutputCheck: true, taskType: 0, comparisonMode: 1, realPrecision: 6, specialJudge: '', testCases: [
  { fullScore: 30, timeLimit: 1000, memoryLimit: 256, inputFiles: ['Road/1.IN', 'Road/2.in'], outputFiles: ['Road/1.ans', 'Road/2.ans'] },
  { fullScore: 70, timeLimit: 2000, memoryLimit: 512, inputFiles: ['Road/2.in', '1_lemon_SUbtaskDEPENDENCE_fLAg'], outputFiles: ['Road/2.ans'] },
] });
const zip = (values: Record<string, string | Buffer>) => { const zip = new ZipWriter(); for (const [name, data] of Object.entries(values)) zip.add(name, data); return zip.finish(); };
const packageFiles = (tasks: object[] = [task()]): Record<string, string | Buffer> => ({ 'wrapper/contest.cdf': JSON.stringify({ version: '1.0', contestTitle: 'Fixture', tasks, contestants: [] }),
  'wrapper/data/road/1.in': '1\n', 'wrapper/data/road/1.out': '2\r\n', 'wrapper/data/road/2.in': '2\n', 'wrapper/data/road/2.out': '4\n', 'wrapper/data/road/extra.in': 'unconfigured', 'wrapper/source/alice/road.cpp': 'not a reference solution' });
async function fixture(run: (judge: Judge, registry: ProblemRegistry) => Promise<void>) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tw-lemon-import-')));
  const global = new GlobalStore(home); await global.init(); global.config.problems.roots = [path.join(home, 'problems')];
  const registry = new ProblemRegistry(global), judge = new Judge(global, registry, new WsHub());
  try { await run(judge, registry); } finally { await fs.rm(home, { recursive: true, force: true }); }
}

test('Lemon JSON import resolves inventory differences, preserves shared bundles and excludes contestant code from solutions', async () => fixture(async (judge, registry) => {
  const bytes = zip(packageFiles()), candidates = inspectPackage(bytes, { format: 'auto' });
  assert.equal(candidates.length, 1); assert.equal(candidates[0].tests, 2); assert.equal(candidates[0].error, undefined);
  assert.ok(candidates[0].warnings?.some(warning => warning.includes('corrected')));
  const imported = await importPackage(judge, bytes, { format: 'lemonlime', name: 'lemon-road' });
  const config = (await registry.detail(imported.problem.id)).config!;
  assert.deepEqual(config.tests.group?.map(group => [group.tests, group.points, group.dependencies ?? [], group.time_limit]), [['1-2', 30, [], 1000], ['2', 70, ['subtask-1'], 2000]]);
  assert.equal(config.solutions.length, 0); assert.equal(config.lemon_comparison?.mode, 'ignore-spaces');
  assert.equal(await fs.readFile(path.join(imported.problem.dir, 'tests/manual/1.ans'), 'utf8'), '2\r\n');
  await fs.access(path.join(imported.problem.dir, 'other/lemonlime/source/alice/road.cpp'));
  const output = new ZipWriter(); const result = await addLemonProblem(judge, await judge.ctx(imported.problem.id), 'A', output, { signal: new AbortController().signal, progress() {} });
  assert.equal(result.task.comparisonMode, 1); assert.equal(result.task.specialJudge, ''); assert.deepEqual(result.task.testCases.map(row => row.fullScore), [30, 70]);
}));

test('Lemon missing or ambiguous references are preview errors and cannot publish partial problems', async () => fixture(async (judge, registry) => {
  const files = packageFiles(); delete files['wrapper/data/road/2.out'];
  const bytes = zip(files), preview = inspectPackage(bytes, { format: 'auto' });
  assert.match(preview[0].error ?? '', /Missing file referenced/);
  await assert.rejects(importPackage(judge, bytes, { format: 'lemonlime', name: 'missing' }), /Missing file referenced/); assert.equal((await registry.list()).length, 0);
  const invalid = task(); invalid.testCases[1].inputFiles.push('2_lemon_SUbtaskDEPENDENCE_fLAg');
  assert.match(inspectPackage(zip(packageFiles([invalid])), { format: 'lemonlime' })[0].error ?? '', /invalid preceding dependency/);
}));

test('empty CDF task lists offer unconfigured pairs with explicit warnings and no inferred scores', async () => fixture(async judge => {
  const files = packageFiles([]); delete files['wrapper/data/road/extra.in'];
  const result = await importPackage(judge, zip(files), { format: 'auto', name: 'unconfigured' });
  const config = (await judge.registry.detail(result.problem.id)).config!;
  assert.equal(result.tests, 2); assert.equal(config.tests.points, false); assert.equal(config.tests.groups, false);
  assert.ok(result.warnings.some(warning => warning.includes('without scores')));
}));

test('legacy CDF decodes Qt fields and verifies checksum before decompression', async () => fixture(async judge => {
  const decoded = readCdf(legacy); assert.equal(decoded.contestTitle, 'Legacy fixture'); assert.equal(decoded.tasks[0].sourceFileName, 'sum');
  const imported = await importPackage(judge, zip({ 'old/contest.cdf': legacy, 'old/data/sum/1.in': '1 2\n', 'old/data/sum/1.ans': '3\n' }), { format: 'auto', name: 'old-cdf' });
  assert.equal(imported.tests, 1); assert.equal(imported.problem.name, 'old-cdf');
  const damaged = Buffer.from(legacy); damaged[15] ^= 1; assert.throws(() => readCdf(damaged), /checksum/i);
}));

test('Lemon Testlib SPJ imports retain mode 5 when exporting another native package', async () => fixture(async judge => {
  const spj = task(); spj.comparisonMode = 5; spj.specialJudge = 'road/checker.exe'; spj.testCases = [spj.testCases[0]];
  const files = packageFiles([spj]);
  files['wrapper/data/road/checker.cpp'] = '#include "testlib.h"\nint main(int argc, char** argv) { registerTestlibCmd(argc, argv); quitf(_ok, "fixture"); }\n';
  const imported = await importPackage(judge, zip(files), { format: 'auto', name: 'testlib-spj' });
  const output = new ZipWriter(), result = await addLemonProblem(judge, await judge.ctx(imported.problem.id), 'A', output, { signal: new AbortController().signal, progress() {} }, undefined, false, process.platform === 'win32' ? 'linux' : 'windows');
  assert.equal(result.task.comparisonMode, 5); assert.ok(result.task.specialJudge); assert.ok(result.checkerBuild);
  assert.equal((await judge.ctx(imported.problem.id)).config.checker?.source.endsWith('checker.cpp'), true);
}));

test('binary-only Lemon special judges remain visible and cannot silently export a built-in comparison', async () => fixture(async (judge, registry) => {
  const spj = task(); spj.comparisonMode = 4; spj.specialJudge = 'road/checker.exe'; spj.testCases = [spj.testCases[0]];
  const files = packageFiles([spj]); files['wrapper/data/road/checker.exe'] = Buffer.from([77, 90, 0, 0, 5]);
  const imported = await importPackage(judge, zip(files), { format: 'lemonlime', name: 'binary-spj' });
  assert.ok((await judge.ctx(imported.problem.id)).config.problem.unresolved_judge);
  assert.deepEqual(await fs.readFile(path.join(imported.problem.dir, 'other/lemonlime/data/road/checker.exe')), files['wrapper/data/road/checker.exe']);
  let ctx = await judge.ctx(imported.problem.id);
  const build = () => addLemonProblem(judge, ctx, 'A', new ZipWriter(), { signal: new AbortController().signal, progress() {} });
  await assert.rejects(build, /special judge.*source/i);
  await registry.patch(imported.problem.id, { title: { en: 'Keep unresolved' } });
  assert.ok((await judge.ctx(imported.problem.id)).config.problem.unresolved_judge);
  await registry.patch(imported.problem.id, { lemonComparison: { mode: 'lines', precision: 3 } });
  ctx = await judge.ctx(imported.problem.id);
  assert.equal((await build()).task.comparisonMode, 0);
}));

test('Lemon duplicate occurrences and original metadata files survive import and re-export', async () => fixture(async judge => {
  const repeated = task(); repeated.testCases[0].inputFiles.push('Road/1.IN'); repeated.testCases[0].outputFiles.push('Road/1.ans');
  const files = packageFiles([{ ...repeated, extraMetadata: null }]);
  files['wrapper/IMPORT.md'] = 'Original package instructions';
  const imported = await importPackage(judge, zip(files), { format: 'auto', name: 'repeat-cases' });
  assert.equal(imported.tests, 3);
  assert.equal(await fs.readFile(path.join(imported.problem.dir, 'other/lemonlime/IMPORT.md'), 'utf8'), 'Original package instructions');
  assert.deepEqual(await fs.readFile(path.join(imported.problem.dir, 'other/lemonlime/contest.cdf')), Buffer.from(files['wrapper/contest.cdf']));
  const output = new ZipWriter(), result = await addLemonProblem(judge, await judge.ctx(imported.problem.id), 'A', output, { signal: new AbortController().signal, progress() {} });
  assert.equal(result.task.testCases[0].inputFiles.length, 3); assert.equal(result.task.testCases[1].fullScore, 70);
  const packed = readZip(output.finish());
  assert.deepEqual(packed.get('data/repeat-cases/1.in'), packed.get('data/repeat-cases/3.in'));
}));

test('Lemon directory selection keeps CDF roots independent and native real precision intact', async () => fixture(async judge => {
  const first = task(), second = task(); first.comparisonMode = 0; second.comparisonMode = 3; second.realPrecision = 18;
  const files = packageFiles([first]);
  for (const [name, data] of Object.entries(packageFiles([second]))) files[name.replace('wrapper/', 'second/')] = name.endsWith('1.out') ? 'second answer' : data;
  const directory = path.join(judge.global.dir, 'unpacked');
  for (const [name, data] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true }); await fs.writeFile(path.join(directory, name), data); }
  const bytes = await directoryPackage(directory), preview = inspectPackage(bytes, { format: 'auto' });
  assert.deepEqual(preview.map(item => item.entry).sort(), ['second/contest.cdf#1', 'wrapper/contest.cdf#1']);
  await assert.rejects(importPackage(judge, bytes, { format: 'auto' }), /Select a LemonLime task/);
  const imported = await importPackage(judge, bytes, { format: 'auto', entry: 'second/contest.cdf#1', name: 'real-cdf' });
  assert.deepEqual((await judge.ctx(imported.problem.id)).config.lemon_comparison, { mode: 'real', precision: 18 });
  assert.equal(await fs.readFile(path.join(imported.problem.dir, 'tests/manual/1.ans'), 'utf8'), 'second answer');
  assert.match(inspectPackage(Buffer.from(files['wrapper/contest.cdf']), { format: 'auto' })[0].error ?? '', /Missing file referenced/);
}));

test('Lemon source-only checkers recover casing and build a usable native mode-4 export', async () => fixture(async judge => {
  const spj = task(); spj.comparisonMode = 4; spj.specialJudge = 'road/checker.exe'; spj.testCases = [spj.testCases[0]];
  const files = Object.fromEntries(Object.entries(packageFiles([spj])).map(([name, data]) => [name.replace('/data/', '/DATA/'), data]));
  files['wrapper/DATA/road/CHECKER.CPP'] = await fs.readFile(path.join(judge.global.sharedDir, 'lemon/checkers/wcmp.cpp'));
  const imported = await importPackage(judge, zip(files), { format: 'auto', name: 'source-spj' });
  assert.equal((await judge.ctx(imported.problem.id)).config.lemon_checker?.source, 'other/lemonlime/DATA/road/CHECKER.CPP');
  const output = new ZipWriter(), result = await addLemonProblem(judge, await judge.ctx(imported.problem.id), 'A', output, { signal: new AbortController().signal, progress() {} });
  assert.equal(result.task.comparisonMode, 4); assert.ok(result.checkerBuild);
  assert.ok(readZip(output.finish()).has('data/' + result.task.specialJudge));
}));

test('Lemon linked graders preserve build aliases and diagnose missing headers and runtime-file mismatches', async () => fixture(async judge => {
  const interaction = { ...task(), taskType: 2, grader: 'road/grader.cpp', interactor: 'road/supplied.h', interactorName: 'judge.h' };
  const files = packageFiles([interaction]); files['wrapper/data/road/grader.cpp'] = '#include "judge.h"\nint main() { return 0; }'; files['wrapper/data/road/supplied.h'] = '#pragma once\n';
  const imported = await importPackage(judge, zip(files), { format: 'auto', name: 'linked-cdf' }), ctx = await judge.ctx(imported.problem.id);
  assert.equal(ctx.config.problem.judge_mode, 'grader'); assert.deepEqual(ctx.config.grader, { sources: ['grader/__grader.cpp'], headers: ['grader/judge.h'] });
  assert.equal(await fs.readFile(path.join(imported.problem.dir, 'grader/judge.h'), 'utf8'), '#pragma once\n');
  delete files['wrapper/data/road/supplied.h'];
  assert.match(inspectPackage(zip(files), { format: 'auto' })[0].error ?? '', /Missing file referenced.*supplied.h/);
  const invalid = { ...task(), standardInputCheck: false, inputFileName: '../escape' };
  assert.ok(inspectPackage(zip(packageFiles([invalid])), { format: 'auto' })[0].error);
  const collision = { ...task(), taskType: 3, sourceFilesPath: ['road.cpp'], sourceFilesName: ['grader.cpp'], graderFilesPath: ['road/grader.cpp'], graderFilesName: ['grader.cpp'] };
  files['wrapper/contest.cdf'] = JSON.stringify({ tasks: [collision] });
  assert.match(inspectPackage(zip(files), { format: 'auto' })[0].error ?? '', /Conflicting Lemon grader build filenames/);
}));
