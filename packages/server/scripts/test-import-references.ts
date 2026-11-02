import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseData } from '../src/imports/data.js';
import { readPolygonPackage } from '../src/imports/polygon.js';
import { importPackage, inspectPackage } from '../src/imports/packages.js';
import { luoguScript, type LuoguSubtask } from '../src/judge/luogu.js';
import { GlobalStore } from '../src/global.js';
import { ProblemRegistry } from '../src/workspace/problems.js';
import { Judge } from '../src/judge/index.js';
import { WsHub } from '../src/ws.js';
import { ZipWriter } from '../src/util/zip.js';
const files = (values: Record<string, string>) => new Map(Object.entries(values).map(([name, value]) => [name, Buffer.from(value)]));
const zip = (values: Record<string, string>) => { const writer = new ZipWriter(); for (const [name, value] of Object.entries(values)) writer.add(name, value); return writer.finish(); };

test('Hydro references repair only unique paths and answer suffixes while recording warnings', () => {
  const result = parseData(files({
    'case01.IN': 'input', 'case01.out': 'answer',
    'config.yaml': 'subtasks:\n  - id: 1\n    score: 100\n    type: sum\n    cases:\n      - input: old/case01.in\n        output: old/case01.ans\n',
  }), 'hydro');
  assert.deepEqual(result.pairs.map(pair => [pair.input, pair.output]), [['case01.IN', 'case01.out']]);
  assert.equal(result.warnings.filter(message => message.startsWith('Package reference corrected:')).length, 2);
});

test('Luogu config entries follow actual filename casing; entries for missing files skip their tests', () => {
  const result = parseData(files({ 'One.IN': '1', 'One.OUT': '2', 'config.yml': 'one.in: { score: 73, timeLimit: 2000 }' }), 'luogu');
  assert.equal(result.cases[1].points, 73); assert.equal(result.cases[1].time_limit, 2000);
  assert.ok(result.warnings.some(message => message.includes('one.in -> One.IN')));
  const stale = parseData(files({ '1.in': '1', '1.out': '2', 'config.yml': 'missing.in: { score: 100 }' }), 'luogu');
  assert.deepEqual(stale.pairs.map(pair => pair.input), ['1.in']);
  assert.ok(stale.warnings.includes('Skipped 1 missing test: missing.in'));
  // A test the configuration does not mention still needs its answer.
  assert.throws(() => parseData(files({ '1.in': '1', 'config.yml': '2.in: { score: 100 }' }), 'luogu'), /Missing answer for 1\.in/);
  // Tests without a score share 100 points among the imported ones.
  const shared = parseData(files({ '1.in': 'a', '1.out': 'A', '2.in': 'b', '2.out': 'B', 'config.yml': '1.in: {}\n2.in: {}\n3.in: {}\n' }), 'luogu');
  assert.deepEqual(Object.values(shared.cases).map(c => c.points), [50, 50]);
});

test('ambiguous mappings and conflicting answers are rejected instead of assigning the wrong bytes', () => {
  assert.throws(() => parseData(files({ 'a/1.in': 'a', 'b/1.in': 'b', '1.out': 'answer', 'config.yaml': 'cases: [{ input: old/1.in, output: 1.out }]' }), 'hydro'), /Ambiguous file reference/);
  assert.throws(() => parseData(files({ '1.in': 'a', '1.out': 'answer', '1.ans': 'other answer' }), 'auto'), /Ambiguous answers/);
  assert.throws(() => parseData(files({ '1.in': 'a', '1.out': 'A', '2.in': 'b', 'config.yml': '1.in: { score: 50 }\n1.IN: { score: 60 }\n2.in: { score: 40 }' }), 'luogu'), /Conflicting configuration entries/);
});

test('explicit answer extensions win over suffix recovery after correcting path casing', () => {
  const result = parseData(files({ 'Case.in': 'input', 'Case.ans': 'intended', 'Case.out': 'different', 'config.yaml': 'cases: [{ input: case.in, output: case.ans }]' }), 'hydro');
  assert.equal(result.pairs[0].output, 'Case.ans'); assert.equal(result.pairs[0].outputData.toString(), 'intended');
});

test('Luogu: missing tests keep the scoring script, order and samples of the rest; an emptied subtask passes on its dependencies', () => {
  const subtasks: LuoguSubtask[] = [{ id: 1, label: 'subtask-1', points: 30, policy: 'COMPLETE_GROUP', dependencies: [] },
    { id: 2, label: 'subtask-2', points: 30, policy: 'COMPLETE_GROUP', dependencies: [1] }, { id: 3, label: 'subtask-3', points: 40, policy: 'COMPLETE_GROUP', dependencies: [1, 2] }];
  const metadata = JSON.stringify({ version: 1, subtasks: [{ id: 1, label: 'basic' }, { id: 2, label: 'mid' }, { id: 3, label: 'full' }], samples: [4] });
  const result = parseData(files({ '1.in': 'a', '1.out': 'A', '2.in': 'b', '2.out': 'B', '4.in': 'd', '4.out': 'D', '5.in': 'e without answer',
    'config.yml': `# taskweave-scoring: ${metadata}\n1.in: { score: 30, subtaskId: 1 }\n2.in: { score: 30, subtaskId: 1 }\n3.in: { score: 30, subtaskId: 2 }\n4.in: { score: 40, subtaskId: 3, timeLimit: 2000 }\n5.in: { score: 40, subtaskId: 3 }\n`,
    'score.txt': luoguScript(subtasks, { time: 'sum', memory: 'max' }) }), 'luogu');
  assert.deepEqual(result.pairs.map(pair => pair.input), ['1.in', '2.in', '4.in']);
  assert.equal(result.unresolvedScoring, false);
  assert.deepEqual(result.groups.map(g => [g.name, g.tests, g.points, g.dependencies ?? []]), [['basic', '1-2', 30, []], ['full', '3', 40, ['basic']]]);
  assert.equal(result.cases[3].time_limit, 2000); assert.deepEqual(result.samples, [3]);
  assert.ok(result.warnings.includes('Skipped 2 missing tests: 3.in, 5.out')); assert.ok(result.warnings.includes('Removed empty subtask: mid'));
  // The existing input of a skipped test is not imported as test data.
  assert.equal(result.used.has('5.in'), false);
});

test('Hydro: missing inputs and answers are skipped; sum subtasks lose their points, min subtasks keep theirs', () => {
  const config = `subtasks:
  - { id: 1, type: min, score: 30, cases: [{ input: a.in, output: a.out }] }
  - { id: 2, type: min, score: 30, if: [1], cases: [{ input: b.in, output: b.out }] }
  - { id: 3, type: sum, score: 40, if: [2], cases: [{ input: c.in, output: c.out, score: 15 }, { input: d.in, output: d.ans, score: 25 }, { input: e.in }] }
`;
  const result = parseData(files({ 'config.yaml': config, 'a.in': '1', 'a.out': '1', 'b.out': 'orphan answer', 'c.in': '3', 'c.out': '3', 'd.in': '4', 'e.in': '5' }), 'hydro');
  assert.deepEqual(result.pairs.map(pair => [pair.input, pair.output]), [['a.in', 'a.out'], ['c.in', 'c.out'], ['e.in', '']]);
  assert.deepEqual(result.groups.map(g => [g.name, g.tests, g.points, g.policy, g.dependencies ?? []]), [['subtask-1', '1', 30, 'COMPLETE_GROUP', []], ['subtask-3', '2-3', 15, 'EACH_TEST', ['subtask-1']]]);
  assert.deepEqual(Object.keys(result.groups[1].cases!), ['2', '3']); assert.equal(result.cases[2].points, 15);
  assert.ok(result.warnings.includes('Skipped 2 missing tests: b.in, d.ans')); assert.ok(result.warnings.includes('Removed empty subtask: subtask-2'));
  // An unspecified Hydro output is still allowed, numbered as imported.
  assert.ok(result.warnings.some(message => message.startsWith('Test 3 has no reference output')));
  assert.equal(result.used.has('d.in'), false); assert.equal(result.used.has('b.out'), false);
});

test('TaskWeave companion: a case with a missing file leaves its subtask and samples; the rest are renumbered', () => {
  const companion = `format: taskweave-inout
version: 1
points_enabled: true
cases:
  - { id: 'tests:1', input: in/a.txt, output: out/a.txt, score: 50, sample: true }
  - { id: 'tests:2', input: in/b.txt, output: out/b.txt, score: 30 }
  - { id: 'tests:3', input: in/c.txt, output: out/c.txt, score: 20, sample: true }
  - { id: 'tests:4', input: in/d.txt, output: out/d.txt, score: 10 }
subtasks:
  - { id: easy, aggregation: sum, points: 80, cases: ['tests:1', 'tests:2'], overrides: { 'tests:2': { time_limit: 3000 } } }
  - { id: hard, aggregation: min, points: 20, cases: ['tests:3'], dependencies: [easy] }
`;
  // JOI-style names: a missing out/b.txt is not "found" as in/b.txt, nor a missing in/d.txt as out/d.txt.
  const result = parseData(files({ 'taskweave.yaml': companion, 'in/a.txt': '1', 'out/a.txt': '1', 'in/b.txt': '2', 'in/c.txt': '3', 'out/c.txt': '3', 'out/d.txt': '4' }), 'joi');
  assert.deepEqual(result.pairs.map(pair => pair.input), ['in/a.txt', 'in/c.txt']);
  assert.deepEqual(result.groups.map(g => [g.name, g.tests, g.points, g.dependencies ?? [], g.cases]), [['easy', '1', 50, [], {}], ['hard', '2', 20, ['easy'], undefined]]);
  assert.deepEqual(result.samples, [1, 2]); assert.equal(result.cases[2].original_input, 'in/c.txt');
  assert.deepEqual(result.warnings, ['Skipped 2 missing tests: out/b.txt, in/d.txt']);
});

test('Polygon: tests whose input file is missing are skipped; generated tests, samples and groups follow the renumbering', () => {
  const xml = `<problem short-name="gaps"><names><name language="english" value="Gaps"/></names><judging input-file="" output-file=""><testset name="tests">
    <time-limit>1000</time-limit><memory-limit>268435456</memory-limit><test-count>5</test-count><input-path-pattern>tests/%02d</input-path-pattern><answer-path-pattern>tests/%02d.a</answer-path-pattern>
    <tests><test method="manual" sample="true" group="a" points="10"/><test method="manual" sample="true" group="b" points="20"/><test method="generated" cmd="gen 7" group="c" points="30"/>
      <test method="manual" group="c" points="40"/><test method="manual" group="c" points="50"/></tests>
    <groups><group name="a" points="10" points-policy="each-test"/><group name="b" points="20" points-policy="complete-group"><dependencies><dependency group="a"/></dependencies></group>
      <group name="c" points="120" points-policy="each-test"><dependencies><dependency group="b"/></dependencies></group></groups></testset></judging></problem>`;
  const archive = files({ 'problem.xml': xml, 'tests/01': '1\n', 'tests/01.a': '1\n', 'tests/02.a': 'answer without input\n', 'tests/05': '5\n', 'tests/05.a': '5\n',
    'statement-sections/english/legend.tex': 'Gaps.', 'statement-sections/english/example.01': 'one\n', 'statement-sections/english/example.02': 'two\n' });
  const result = readPolygonPackage(archive, { format: 'polygon-package' }), tests = result.doc.tests;
  assert.equal(result.tests, 3);
  assert.equal(result.local.get('tests/script-tests.txt')?.toString(), 'gen 7 > 2\n');
  assert.equal(result.local.get('tests/manual/3.in')?.toString(), '5\n'); assert.equal(tests.cases[3].original_input, 'tests/05');
  assert.deepEqual(tests.group.map((g: any) => [g.name, g.tests, g.points, g.dependencies ?? []]), [['a', '1', 10, []], ['c', '2-3', 80, ['a']]]);
  assert.equal(tests.samples, '1'); assert.equal(result.local.get('tests/manual/1.statement.in')?.toString(), 'one\n');
  assert.ok(![...result.local.keys()].some(name => /^tests\/manual\/(?:0|2)\./.test(name)));
  assert.ok(result.local.has('other/polygon/tests/02.a'));
  assert.ok(result.warnings.includes('Skipped 2 missing tests: tests/02, tests/04')); assert.ok(result.warnings.includes('Removed empty subtask: b'));
});

test('an import whose tests are all missing still succeeds, shows the notice in its preview and keeps the data files', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-missing-refs-'));
  try {
    const global = new GlobalStore(home); await global.init(); global.config.problems.roots = [path.join(home, 'problems')];
    const judge = new Judge(global, new ProblemRegistry(global), new WsHub());
    const bytes = zip({ 'config.yaml': 'subtasks:\n  - { id: 1, score: 100, cases: [{ input: gone.in, output: gone.out }] }\n', 'stray.in': 'kept' });
    const [preview] = inspectPackage(bytes, { format: 'hydro-data' });
    assert.equal(preview.error, undefined); assert.equal(preview.tests, 0);
    assert.deepEqual(preview.warnings, ['Skipped 1 missing test: gone.in', 'Removed empty subtask: subtask-1']);
    const result = await importPackage(judge, bytes, { format: 'hydro-data', name: 'nothing-left' });
    assert.equal(result.tests, 0); assert.ok(result.warnings.includes('Skipped 1 missing test: gone.in'));
    assert.equal(await fs.readFile(path.join(result.problem.dir, 'other/hydro/stray.in'), 'utf8'), 'kept');
    const config = (await judge.registry.detail(result.problem.id)).config!;
    assert.deepEqual([config.tests.groups, config.tests.group ?? []], [false, []]);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
