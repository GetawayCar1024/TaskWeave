import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { groupLayout, problemTomlSchema, sampleNotePath, testsetOf } from '@taskweave/shared';
import { GlobalStore } from '../src/global.js';
import { ProblemRegistry } from '../src/workspace/problems.js';
import { Judge } from '../src/judge/index.js';
import { WsHub } from '../src/ws.js';
import { lemonTestCases } from '../src/judge/lemonlime.js';
import { luoguConfig, luoguLayout, luoguScript } from '../src/judge/luogu.js';
import { equalTestPoints } from '../src/judge/contest.js';
import { answerPath, generateTests, inputPath, removeTest } from '../src/judge/tests.js';
import { readSamples } from '../src/judge/samples.js';
import { localChecks } from '../src/judge/checks.js';

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-subtasks-'));
  const global = new GlobalStore(home); await global.init();
  global.config.problems.roots = [path.join(home, 'problems')];
  const registry = new ProblemRegistry(global);
  const judge = new Judge(global, registry, new WsHub());
  return { home, registry, judge };
}
const job = () => ({ signal: new AbortController().signal, progress() {} });
const parse = (tests: object) => problemTomlSchema.parse({ problem: { name: 'p' }, tests });

test('LemonLime spreads 100 points over more than 100 ungrouped tests', () => {
  const rows = lemonTestCases(parse({}), Array.from({ length: 150 }, (_, i) => i + 1), 'p');
  assert.equal(rows.reduce((a, r) => a + r.fullScore, 0), 100);
  assert.ok(rows.every(r => r.fullScore === 0 || r.fullScore === 1));
  const seven = lemonTestCases(parse({}), [1, 2, 3, 4, 5, 6, 7], 'p').map(r => r.fullScore);
  assert.deepEqual(seven, [14, 14, 14, 14, 14, 15, 15]);
  // Other testsets are prefixed and dependency numbers continue after the previous testsets.
  const c = problemTomlSchema.parse({ problem: { name: 'p' }, tests: { points: true }, testsets: { extra: { groups: true, group: [{ name: 'a', tests: '1', points: 10 }, { name: 'b', tests: '2', points: 5, dependencies: ['a'] }] } } });
  const extra = lemonTestCases(c, [1, 2], 'p', 'extra', 4);
  assert.deepEqual(extra[1].inputFiles, ['p/extra-2.in', '5_lemon_SUbtaskDEPENDENCE_fLAg']);
});

test('EACH_TEST points are integers that add up exactly', () => {
  const ts = testsetOf(parse({ points: true, groups: true, group: [{ name: 'g', tests: '1-4', points: 10, policy: 'EACH_TEST' }] }))!;
  assert.deepEqual(Object.values(groupLayout(ts, true).points), [2, 2, 3, 3]);
});

test('Luogu layout and scoring script: bundles, transitive dependencies, loose tests and aggregation', () => {
  const c = parse({ points: true, groups: true, group: [
    { name: 'full', tests: '4-5', points: 60, dependencies: ['part'] },
    { name: 'part', tests: '2-3', points: 25, policy: 'EACH_TEST', dependencies: ['basic'] },
    { name: 'basic', tests: '1', points: 15 },
  ] });
  const warnings: string[] = [];
  const { cases, subtasks } = luoguLayout(c, [{ name: 'tests', tests: [1, 2, 3, 4, 5, 6] }], warnings);
  assert.deepEqual(subtasks.map(s => [s.id, s.points, s.policy, s.dependencies]), [[0, 0, 'EACH_TEST', []], [1, 60, 'COMPLETE_GROUP', [2, 3]], [2, 25, 'EACH_TEST', [3]], [3, 15, 'COMPLETE_GROUP', []]]);
  assert.deepEqual(cases.map(x => [x.k, x.score, x.subtask]), [[1, 15, 3], [2, 12, 2], [3, 13, 2], [4, 30, 1], [5, 30, 1], [6, 0, 0]]);
  const script = luoguScript(subtasks, { time: 'sum', memory: 'max' });
  assert.match(script, /^@total_score = 0;\n@total_score = @total_score \+ @score0;\n/);
  assert.match(script, /if \(@status1 == AC\) and \(@status2 == AC\) and \(@status3 == AC\); then\n {4}@total_score = @total_score \+ 60;\nfi/);
  assert.match(script, /if \(@status3 == AC\); then\n {4}@total_score = @total_score \+ @score2;\nfi/);
  assert.match(script, /if @total_score == 100; then\n {4}@final_status = AC;\nelse\n {4}@final_status = UNAC;\nfi/);
  assert.match(script, /@final_time = @time0 \+ @time1 \+ @time2 \+ @time3;/);
  assert.match(script, /@final_memory = @memory0;\nif @memory1 > @final_memory; then\n {4}@final_memory = @memory1;\nfi/);
  assert.ok(!/;\s*fi;/.test(script), 'fi takes no semicolon');
  assert.match(luoguConfig(c, cases), /^1\.in:\n {2}timeLimit: 1000\n {2}memoryLimit: 262144\n {2}score: 15\n {2}subtaskId: 3\n/);
  // Incompatible fractional points are reported rather than silently rounded.
  c.tests.group![2].points = 15.5;
  assert.throws(() => luoguLayout(c, [{ name: 'tests', tests: [1, 2, 3, 4, 5] }], warnings), /integer scores/);
  const plain = luoguLayout(parse({}), [{ name: 'tests', tests: [1, 2, 3] }, { name: 'tests', tests: [1, 2] }], []);
  assert.deepEqual(plain.cases.map(x => x.score), [33, 33, 34, 50, 50]);
  assert.deepEqual(plain.subtasks.map(s => s.id), [0, 1]);
  assert.throws(() => luoguLayout(c, [{ name: 'tests', tests: [1, 2, 3, 4] }], []), /missing tests/);
});

test('"Equal points" is No for uneven subtask points', () => {
  const groups = (group: object[]) => parse({ points: true, groups: true, group });
  assert.equal(equalTestPoints(groups([{ name: 'a', tests: '1-2', points: 20 }, { name: 'b', tests: '3-5', points: 30 }]), [1, 2, 3, 4, 5]), false);
  assert.equal(equalTestPoints(groups([{ name: 'a', tests: '1-3', points: 10 }]), [1, 2, 3]), true);
  assert.equal(equalTestPoints(groups([{ name: 'a', tests: '1-2', points: 20 }, { name: 'b', tests: '3-4', points: 30 }]), [1, 2, 3, 4]), false);
  assert.equal(equalTestPoints(groups([{ name: 'a', tests: '1-2', points: 20 }]), [1, 2, 3]), false);
  assert.equal(equalTestPoints(parse({}), [1, 2, 3, 4]), true);
  assert.equal(equalTestPoints(parse({}), [1, 2, 3]), false);
});

test('multi-test generators fill {a-b} from files 1..k; failing tests lose stale answers', { timeout: 180_000 }, async () => {
  const f = await fixture();
  try {
    const p = await f.registry.create({ name: 'multi' });
    const gen = (fail: boolean) => `#include <cstdio>\nint main(){${fail ? 'return 1;' : ''}for(int k=1;k<=3;k++){char n[8];sprintf(n,"%d",k);FILE*f=fopen(n,"w");fprintf(f,"1\\n%d\\n",k*7);fclose(f);}}\n`;
    await fs.writeFile(path.join(p.dir, 'generators/multi.cpp'), gen(false));
    // The generator writes files 1..3; test 2 must get file "1", not file "2".
    await fs.writeFile(path.join(p.dir, 'tests/script.txt'), 'multi > {2-4}\n');
    const ctx = await f.judge.ctx(p.id);
    let m = await generateTests(f.judge, ctx, job());
    assert.ok(m.ok, m.errors.join('\n'));
    assert.equal(await fs.readFile(inputPath(ctx, 2), 'utf8'), '1\n7\n');
    assert.equal(await fs.readFile(inputPath(ctx, 4), 'utf8'), '1\n21\n');
    assert.equal(await fs.readFile(answerPath(ctx, 4), 'utf8'), '21\n');
    await fs.writeFile(path.join(p.dir, 'generators/multi.cpp'), gen(true));
    m = await generateTests(f.judge, await f.judge.ctx(p.id), job());
    assert.ok(!m.ok);
    for (const i of [2, 3, 4]) await assert.rejects(fs.access(answerPath(ctx, i)));
    await fs.access(answerPath(ctx, 1));
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test('groups validate with their own validator; checks report a missing one', { timeout: 180_000 }, async () => {
  const f = await fixture();
  try {
    const p = await f.registry.create({ name: 'groupval' });
    await fs.writeFile(path.join(p.dir, 'small.cpp'), '#include "testlib.h"\nint main(int argc,char**argv){registerValidation(argc,argv);int n=inf.readInt(1,5,"n");inf.readEoln();for(int i=0;i<n;i++){inf.readInt(1,1000000000,"a");if(i+1<n)inf.readSpace();}inf.readEoln();inf.readEof();}\n');
    await f.registry.patch(p.id, { testsets: { tests: { groups: true, group: [{ name: 'small', tests: '1-2', validator: 'small.cpp' }, { name: 'big', tests: '3-4' }] } } });
    assert.equal((await f.registry.detail(p.id)).config?.tests.group?.find(g => g.name === 'small')?.validator, 'small.cpp');
    const m = await generateTests(f.judge, await f.judge.ctx(p.id), job());
    // Test 2 (n = 10) breaks the group validator; test 3 (n = 1000) passes the problem validator.
    assert.equal(m.tests.find(t => t.index === 2)?.valid, false);
    assert.equal(m.tests.find(t => t.index === 3)?.valid, true);
    await f.registry.patch(p.id, { testsets: { tests: { group: [{ name: 'small', tests: '1-2', validator: 'gone.cpp' }, { name: 'big', tests: '3-4' }] } } });
    assert.ok((await localChecks(f.judge, await f.judge.ctx(p.id))).some(c => c.code === 'groupValidatorMissing'));
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test('samples of other testsets, OI notes and sample marks after removing a test', { timeout: 180_000 }, async () => {
  const f = await fixture();
  try {
    const p = await f.registry.create({ name: 'samples' });
    await fs.mkdir(path.join(p.dir, 'tests/pretests'), { recursive: true });
    await fs.writeFile(path.join(p.dir, 'tests/pretests/01.in'), '2\n3 4\n');
    await f.registry.patch(p.id, { testsets: { pretests: { script: null }, tests: { samples: '1,4', largeSamples: '4' } } });
    await f.registry.patch(p.id, { testsets: { pretests: { samples: '1' } } });
    await fs.mkdir(path.join(p.dir, 'statement/zh/samples'), { recursive: true });
    await fs.writeFile(path.join(p.dir, sampleNotePath('zh', 1, 'pretests')), '因为 $3+4=7$。\n');
    let ctx = await f.judge.ctx(p.id);
    for (const ts of ['tests', 'pretests']) assert.ok((await generateTests(f.judge, ctx, job(), ts)).ok);
    const rows = await readSamples(ctx, true, 'zh');
    assert.deepEqual(rows.map(r => [r.sample.testset, r.sample.index, r.sample.number, !!r.sample.large]), [['tests', 1, 1, false], ['tests', 4, 2, true], ['pretests', 1, 3, false]]);
    assert.equal(rows[2].sample.output, '7\n');
    assert.match(rows[2].sample.note ?? '', /3\+4=7/);
    assert.equal(rows[0].sample.note, undefined);
    // Removing manual test 1 moves the "$" tests down: sample 4 becomes 3.
    const r = await removeTest(ctx, 1, { testset: 'tests' });
    assert.deepEqual([r.samples, r.largeSamples], ['3', '3']);
    await f.registry.patch(p.id, { testsets: { tests: { samples: r.samples, largeSamples: r.largeSamples } } });
    ctx = await f.judge.ctx(p.id);
    assert.deepEqual([ctx.config.tests.samples, ctx.config.tests.large_samples], ['3', '3']);
    await assert.rejects(f.registry.patch(p.id, { testsets: { pretests: { largeSamples: '2' } } }), /subset/);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});
