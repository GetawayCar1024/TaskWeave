/**
 * Polygon sync against the in-process mock (scripts/mock-polygon.ts): samples and their
 * statement input / output, points, deletions, baselines after a partial pull, deleted
 * problems, testsets found by probing, unsafe names, client retries.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import { GlobalStore } from '../src/global.js';
import { ProblemRegistry } from '../src/workspace/problems.js';
import { ContestRegistry } from '../src/workspace/contests.js';
import { Judge } from '../src/judge/index.js';
import { WsHub } from '../src/ws.js';
import { PolygonSync } from '../src/polygon/sync.js';
import { PolygonClient, PolygonError } from '../src/polygon/client.js';
import { applyItem, untrackedItems, localItems } from '../src/polygon/items.js';
import { contestPull, contestRepull, contestSyncStatus } from '../src/polygon/contestSync.js';
import { UsageLog } from '../src/ai/usage.js';
import { problems as mockState, startMockPolygon } from './mock-polygon.js';

let mock: Awaited<ReturnType<typeof startMockPolygon>>;
let dir: string;
let global: GlobalStore;
let registry: ProblemRegistry;
let judge: Judge;
let sync: PolygonSync;
let poly: PolygonClient;
const job = { signal: new AbortController().signal, progress: () => {} } as never;

before(async () => {
  mock = await startMockPolygon();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-psync-'));
  global = new GlobalStore(dir);
  await global.init();
  global.config.problems.roots = [path.join(dir, 'problems')];
  registry = new ProblemRegistry(global);
  judge = new Judge(global, registry, new WsHub());
  sync = new PolygonSync(judge);
  await global.saveSecrets({ polygon: { key: mock.key, secret: mock.secret, apiUrl: mock.url } });
  poly = new PolygonClient({ apiUrl: mock.url, key: mock.key, secret: mock.secret });
});
after(async () => {
  await mock.close();
  await fs.rm(dir, { recursive: true, force: true });
});

async function editToml(p: { dir: string }, fn: (doc: Record<string, any>) => void) {
  const file = path.join(p.dir, 'problem.toml');
  const doc = parse(await fs.readFile(file, 'utf8')) as Record<string, any>;
  fn(doc);
  await fs.writeFile(file, stringify(doc));
}
async function pushAll(id: string, commit = true) {
  const diff = await sync.pushPreview(await judge.ctx(id));
  const keys = diff.items.filter((i) => i.status !== 'unchanged').map((i) => i.key);
  return { diff, result: await sync.push(await judge.ctx(id), { keys, commit, buildPackage: false }, job) };
}
async function pullTaken(id: string, req = {}) {
  const pre = await sync.pullPreview(await judge.ctx(id), req);
  const take = pre.items.filter((i) => i.takeRemote).map((i) => i.key);
  return { pre, res: await sync.pull(await judge.ctx(id), { take }) };
}
const statusOf = (pre: { items: { key: string; status: string; takeRemote: boolean }[] }, key: string) => pre.items.find((i) => i.key === key);

test('samples and their statement input / output are pulled from Polygon (manual and generated tests)', async () => {
  const p = await registry.create({ name: 'psync-samples', title: { en: 'Samples' } });
  // A stale base of an earlier binding is dropped when the problem is created on Polygon.
  await fs.mkdir(path.join(p.dir, '.polyforge', 'sync-base'), { recursive: true });
  await fs.writeFile(path.join(p.dir, '.polyforge', 'sync-base', 'stale.json'), '{}');
  const { result } = await pushAll(p.id);
  await assert.rejects(fs.access(path.join(p.dir, '.polyforge', 'sync-base', 'stale.json')));
  const pid = result.polygonId;
  assert.equal(mockState.get(pid)!.tests[1].useInStatements, true);

  await poly.call('problem.saveTest', { problemId: pid, testset: 'tests', testIndex: 1, testOutputForStatements: 'M-OUT' });
  await poly.call('problem.saveTest', { problemId: pid, testset: 'tests', testIndex: 2, testUseInStatements: true, testInputForStatements: 'S-IN\r\n', testOutputForStatements: 'S-OUT' });
  await poly.call('problem.saveTest', { problemId: pid, testset: 'tests', testIndex: 3, testUseInStatements: true });
  const { pre } = await pullTaken(p.id);
  assert.equal(statusOf(pre, 'test:1')?.status, 'remote');
  assert.equal(statusOf(pre, 'sample:2')?.status, 'remote-only');
  const doc = parse(await fs.readFile(path.join(p.dir, 'problem.toml'), 'utf8')) as any;
  assert.equal(doc.tests.samples, '1-3');
  assert.equal(await fs.readFile(path.join(p.dir, 'tests/manual/01.statement.out'), 'utf8'), 'M-OUT\n');
  assert.equal(await fs.readFile(path.join(p.dir, 'tests/_statement/02.in'), 'utf8'), 'S-IN\n');
  assert.equal(await fs.readFile(path.join(p.dir, 'tests/_statement/02.out'), 'utf8'), 'S-OUT\n');
  const again = await sync.pullPreview(await judge.ctx(p.id));
  assert.deepEqual(again.items.filter((i) => i.status !== 'same' && i.kind !== 'file').map((i) => i.key), []);

  // Unmarked on Polygon: the local sample goes by default, its statement files with it.
  await poly.call('problem.saveTest', { problemId: pid, testset: 'tests', testIndex: 2, testUseInStatements: false, testInputForStatements: '', testOutputForStatements: '' });
  const { pre: pre2 } = await pullTaken(p.id);
  assert.deepEqual(statusOf(pre2, 'sample:2'), { ...statusOf(pre2, 'sample:2'), status: 'local-only', takeRemote: true });
  assert.equal((parse(await fs.readFile(path.join(p.dir, 'problem.toml'), 'utf8')) as any).tests.samples, '1,3');
  await assert.rejects(fs.access(path.join(p.dir, 'tests/_statement/02.in')));

  // Taking a sample and "delete the untracked statement file" in one pull keeps the new file.
  await fs.writeFile(path.join(p.dir, 'tests/_statement/04.in'), 'old');
  await poly.call('problem.saveTest', { problemId: pid, testset: 'tests', testIndex: 4, testUseInStatements: true, testInputForStatements: 'NEW' });
  const pre3 = await sync.pullPreview(await judge.ctx(p.id));
  assert.equal(statusOf(pre3, 'file:tests/_statement/04.in')?.status, 'local-only');
  await sync.pull(await judge.ctx(p.id), { take: pre3.items.filter((i) => i.status !== 'same').map((i) => i.key) });
  assert.equal(await fs.readFile(path.join(p.dir, 'tests/_statement/04.in'), 'utf8'), 'NEW\n');

  // Nothing changed: the commit answers committed=false, reported as a warning.
  await poly.call('problem.commitChanges', { problemId: pid });
  const noop = await sync.push(await judge.ctx(p.id), { keys: [], commit: true, buildPackage: false }, job);
  assert.ok(noop.warnings.some((w) => /did not commit: No changes/.test(w)), noop.warnings.join('|'));
});

test('points-only changes are pushed, fractional points as they are; time limit warnings', async () => {
  const p = await registry.create({ name: 'psync-points' });
  await editToml(p, (d) => {
    Object.assign(d.tests, { groups: true, points: true, group: [{ name: 'g1', tests: '1-2', points: 10.5 }, { name: 'g2', tests: '3-4', points: 20, policy: 'EACH_TEST' }] });
  });
  const { result } = await pushAll(p.id);
  const t = mockState.get(result.polygonId)!.tests;
  assert.deepEqual([t[1].points, t[2].points, t[3].points, t[4].points], [0, 10.5, 10, 10]);
  await editToml(p, (d) => (d.tests.group[0].points = 12.25));
  const diff = await sync.pushPreview(await judge.ctx(p.id));
  assert.equal(diff.items.find((i) => i.key === 'groups')?.status, 'modified');
  await sync.push(await judge.ctx(p.id), { keys: diff.items.filter((i) => i.status !== 'unchanged').map((i) => i.key), commit: true, buildPackage: false }, job);
  assert.equal(mockState.get(result.polygonId)!.tests[2].points, 12.25);
  assert.ok((await sync.pullPreview(await judge.ctx(p.id))).items.every((i) => i.status === 'same' || i.kind === 'file'));

  await editToml(p, (d) => (d.problem.time_limit = 1234));
  const warn = await sync.pushPreview(await judge.ctx(p.id));
  assert.ok(warn.warnings.some((w) => /1234 ms.*multiples of 50.*use 1250 ms/.test(w)), warn.warnings.join('|'));
});

test('local deletions are deleted on Polygon; failures are collected', async () => {
  const p = await registry.create({ name: 'psync-delete', title: { en: 'Del', zh: '删' } });
  await fs.writeFile(path.join(p.dir, 'solutions/wa.cpp'), 'int main(){}\n');
  await fs.writeFile(path.join(p.dir, 'validator-tests/01.valid.in'), '1\n1\n');
  await fs.writeFile(path.join(p.dir, 'statement/images/pic.png'), 'png');
  await fs.writeFile(path.join(p.dir, 'tests/manual/05.in'), '1\n5\n');
  await editToml(p, (d) => d.solutions.push({ source: 'solutions/wa.cpp', tag: 'WA' }));
  const { result } = await pushAll(p.id);
  const pid = result.polygonId;
  const st = mockState.get(pid)!;
  assert.ok(st.solutions['wa.cpp'] && st.validatorTests[1] && st.statementResources['pic.png'] && st.tests[5]?.manual && st.statements.english);

  await fs.rm(path.join(p.dir, 'solutions/wa.cpp'));
  await fs.rm(path.join(p.dir, 'validator-tests/01.valid.in'));
  await fs.rm(path.join(p.dir, 'statement/images/pic.png'));
  await fs.rm(path.join(p.dir, 'tests/manual/05.in'));
  await fs.rm(path.join(p.dir, 'statement/en'), { recursive: true });
  await editToml(p, (d) => {
    d.solutions = d.solutions.filter((s: any) => s.source !== 'solutions/wa.cpp');
    delete d.problem.title.en;
  });
  const diff = await sync.pushPreview(await judge.ctx(p.id));
  const deleted = diff.items.filter((i) => i.status === 'deleted');
  assert.ok(deleted.every((i) => i.deletable), JSON.stringify(deleted));
  for (const k of ['solution:wa.cpp', 'validatorTest:1', 'statementResource:pic.png', 'test:5', 'statement:english:legend']) assert.ok(deleted.some((i) => i.key === k), k);
  // One of them is gone on Polygon already: that counts as deleted, not as a failure.
  delete st.statementResources['pic.png'];
  await sync.push(await judge.ctx(p.id), { keys: diff.items.filter((i) => i.status !== 'unchanged').map((i) => i.key), commit: true, buildPackage: false }, job);
  assert.equal(st.solutions['wa.cpp'], undefined);
  assert.equal(st.validatorTests[1], undefined);
  assert.equal(st.tests[5], undefined);
  assert.equal(st.statements.english, undefined, 'a language without sections is deleted as a whole');
  assert.ok(st.statements.chinese);
  assert.ok((await sync.pushPreview(await judge.ctx(p.id))).items.every((i) => i.status === 'unchanged'));

  // A source still used by the Polygon script cannot go: the failure is reported, the rest is pushed.
  st.source['extra.cpp'] = { text: Buffer.from('x') };
  await fs.writeFile(path.join(p.dir, 'generators/extra.cpp'), 'x');
  await editToml(p, (d) => d.generators.push({ source: 'generators/extra.cpp' }));
  await pushAll(p.id);
  st.script += '\nextra > $';
  await fs.rm(path.join(p.dir, 'generators/extra.cpp'));
  await editToml(p, (d) => (d.generators = d.generators.filter((g: any) => g.source !== 'generators/extra.cpp')));
  await fs.writeFile(path.join(p.dir, 'solutions/std.cpp'), (await fs.readFile(path.join(p.dir, 'solutions/std.cpp'), 'utf8')) + '// edit\n');
  const d2 = await sync.pushPreview(await judge.ctx(p.id));
  await assert.rejects(sync.push(await judge.ctx(p.id), { keys: ['source:extra.cpp', 'solution:std.cpp'], commit: false, buildPackage: false }, job), /1 failed[\s\S]*delete source:extra\.cpp/);
  assert.ok(d2.items.some((i) => i.key === 'source:extra.cpp' && i.status === 'deleted'));
  assert.match(mockState.get(pid)!.solutions['std.cpp'].text.toString(), /\/\/ edit/);
});

test('deleted manual tests go from the top down, a missing one counts as deleted; self-test indices stay', async () => {
  const p = await registry.create({ name: 'psync-delete-tests' });
  for (const i of [5, 6]) await fs.writeFile(path.join(p.dir, `tests/manual/0${i}.in`), `1\n${i}\n`);
  for (const [i, v] of [[1, 'valid'], [2, 'invalid'], [3, 'valid']] as const) await fs.writeFile(path.join(p.dir, `validator-tests/0${i}.${v}.in`), `${i}\n`);
  const { result } = await pushAll(p.id);
  const st = mockState.get(result.polygonId)!;
  assert.ok(st.tests[5] && st.tests[6] && st.validatorTests[3]);
  delete st.tests[6];
  for (const i of [5, 6]) await fs.rm(path.join(p.dir, `tests/manual/0${i}.in`));
  await fs.rm(path.join(p.dir, 'validator-tests/02.invalid.in'));
  const diff = await sync.pushPreview(await judge.ctx(p.id));
  assert.deepEqual(diff.items.filter((i) => i.kind === 'validatorTest' && i.status !== 'unchanged').map((i) => `${i.key}:${i.status}`), ['validatorTest:2:deleted']);
  await sync.push(await judge.ctx(p.id), { keys: diff.items.filter((i) => i.status !== 'unchanged').map((i) => i.key), commit: true, buildPackage: false }, job);
  assert.equal(st.tests[5], undefined);
  assert.equal(st.validatorTests[2], undefined);
  assert.equal(st.validatorTests[3]?.input, '3\n');
  assert.ok((await sync.pushPreview(await judge.ctx(p.id))).items.every((i) => i.status === 'unchanged'));
});

test('an untaken conflict keeps its base; a contest pull refuses it; re-pull takes everything', async () => {
  const p = await registry.create({ name: 'psync-conflict' });
  const { result } = await pushAll(p.id);
  const pid = result.polygonId;
  const syncFile = path.join(p.dir, '.polyforge', 'sync.json');
  const synced = JSON.parse(await fs.readFile(syncFile, 'utf8'));
  const baseHash = synced.items['solution:std.cpp'];
  await fs.writeFile(path.join(p.dir, 'solutions/std.cpp'), '// local\n');
  await poly.call('problem.saveSolution', { problemId: pid, name: 'std.cpp', file: Buffer.from('// polygon\n'), tag: 'MA' });
  await poly.call('problem.saveFile', { problemId: pid, type: 'resource', name: 'extra.txt', file: Buffer.from('r') });
  await poly.call('problem.commitChanges', { problemId: pid });
  const pre = await sync.pullPreview(await judge.ctx(p.id));
  assert.equal(statusOf(pre, 'solution:std.cpp')?.status, 'conflict');
  const res = await sync.pull(await judge.ctx(p.id), { take: [] });
  assert.ok(res.warnings.some((w) => w.includes('solution:std.cpp')));
  const s = JSON.parse(await fs.readFile(syncFile, 'utf8'));
  assert.equal(s.items['solution:std.cpp'], baseHash, 'the base of an untaken conflict is kept');
  assert.equal(s.items['resource:extra.txt'], undefined);
  assert.equal(s.revision, synced.revision, 'the revision with untaken changes is not recorded as synced');
  assert.equal(statusOf(await sync.pullPreview(await judge.ctx(p.id)), 'solution:std.cpp')?.status, 'conflict');
  const push = await sync.pushPreview(await judge.ctx(p.id));
  assert.ok(push.warnings.some((w) => /not pulled: .*solution:std\.cpp/.test(w)), push.warnings.join('|'));

  const contests = new ContestRegistry(registry, global);
  const contest = await contests.create({ name: 'psync-round', problems: [{ index: 'A', problem: p.id }] });
  const deps = { judge, contests, sync };
  const refused = await contestPull(deps, contest.id, { problems: [{ problem: p.id, take: ['resource:extra.txt'] }] }, job);
  assert.match(refused.problems[0].error ?? '', /Resolve the conflicts/);
  await assert.rejects(fs.access(path.join(p.dir, 'files/extra.txt')));

  await fs.writeFile(path.join(p.dir, 'files/local-only.txt'), 'mine');
  const repulled = await contestRepull(deps, contest.id, {}, job);
  assert.equal(repulled.problems[0].error, undefined);
  assert.equal(await fs.readFile(path.join(p.dir, 'solutions/std.cpp'), 'utf8'), '// polygon\n');
  assert.equal(await fs.readFile(path.join(p.dir, 'files/extra.txt'), 'utf8'), 'r');
  assert.equal(await fs.readFile(path.join(p.dir, 'files/local-only.txt'), 'utf8'), 'mine', 'local-only items stay without deleteLocal');
  await contestRepull(deps, contest.id, { deleteLocal: true }, job);
  await assert.rejects(fs.access(path.join(p.dir, 'files/local-only.txt')));
  assert.equal((await contestSyncStatus(deps, contest.id)).rows[0].state, 'same');

  // Deleted on Polygon: said so in push, pull and the contest status.
  await fetch(mock.url.replace(/api\/$/, `__delete?problem=${pid}`));
  assert.match((await sync.pushPreview(await judge.ctx(p.id))).warnings[0], /was deleted on Polygon/);
  await assert.rejects(sync.pullPreview(await judge.ctx(p.id)), /was deleted on Polygon/);
  const status = await contestSyncStatus(deps, contest.id);
  assert.equal(status.rows[0].state, 'deleted');
  assert.ok(status.warnings.some((w) => w.includes('was deleted on Polygon')));
});

test('testsets other than "tests" are found by probing and pulled with samples', async () => {
  const p = await registry.create({ name: 'psync-testsets' });
  const { result } = await pushAll(p.id);
  const pid = result.polygonId;
  for (const name of ['pretests', 'extra']) {
    await fetch(mock.url.replace(/api\/$/, `__testset?problem=${pid}&name=${name}`));
    await poly.call('problem.saveTest', { problemId: pid, testset: name, testIndex: 1, testInput: '1\n7\n', testUseInStatements: true, testOutputForStatements: '7' });
    await poly.call('problem.saveScript', { problemId: pid, testset: name, source: 'gen_random 5 5 > $' });
    await poly.call('problem.saveTest', { problemId: pid, testset: name, testIndex: 2, testUseInStatements: true });
  }
  const pre = await sync.pullPreview(await judge.ctx(p.id), { testsets: ['extra'] });
  assert.deepEqual(pre.testsets?.sort(), ['extra', 'pretests']);
  await sync.pull(await judge.ctx(p.id), { take: pre.items.filter((i) => i.takeRemote).map((i) => i.key) });
  const doc = parse(await fs.readFile(path.join(p.dir, 'problem.toml'), 'utf8')) as any;
  assert.equal(doc.testsets.pretests.samples, '1-2');
  assert.equal(doc.testsets.extra.script, 'tests/script-extra.txt');
  assert.equal(await fs.readFile(path.join(p.dir, 'tests/pretests/01.in'), 'utf8'), '1\n7\n');
  assert.equal(await fs.readFile(path.join(p.dir, 'tests/pretests/01.statement.out'), 'utf8'), '7\n');
  assert.ok((await sync.pullPreview(await judge.ctx(p.id))).items.every((i) => i.status === 'same' || i.kind === 'file'));
  // Local sample change in a testset is pushed (flags of generated tests too).
  await editToml(p, (d) => (d.testsets.pretests.samples = '2'));
  await pushAll(p.id);
  const ts = mockState.get(pid)!.extraTestsets.pretests.tests;
  assert.deepEqual([!!ts[1].useInStatements, !!ts[2].useInStatements], [false, true]);
  await assert.rejects(sync.pullPreview(await judge.ctx(p.id), { testsets: ['../x'] }), /Invalid testset/);
});

test('statement input / output of generated samples in other testsets are pushed and pulled', async () => {
  const p = await registry.create({ name: 'psync-ts-statement' });
  const { result } = await pushAll(p.id);
  const pid = result.polygonId;
  await fetch(mock.url.replace(/api\/$/, `__testset?problem=${pid}&name=pretests`));
  await fs.writeFile(path.join(p.dir, 'tests/script-pretests.txt'), 'gen_random 5 5 > $\ngen_random 6 6 > $\n');
  await editToml(p, (d) => ((d.testsets ??= {}).pretests = { script: 'tests/script-pretests.txt', samples: '1-2' }));
  const stDir = path.join(p.dir, 'tests/_statement/pretests');
  await fs.mkdir(stDir, { recursive: true });
  await fs.writeFile(path.join(stDir, '01.in'), 'P-IN\r\n');
  await fs.writeFile(path.join(stDir, '01.out'), 'P-OUT');
  const { diff } = await pushAll(p.id);
  assert.equal(diff.items.find((i) => i.key === 'testset:pretests')?.status, 'new');
  const ts = mockState.get(pid)!.extraTestsets.pretests.tests;
  assert.deepEqual([ts[1].useInStatements, ts[1].inputForStatement, ts[1].outputForStatement], [true, 'P-IN\n', 'P-OUT\n']);
  assert.deepEqual([ts[2].useInStatements, ts[2].inputForStatement ?? ''], [true, '']);
  const same = await sync.pullPreview(await judge.ctx(p.id));
  assert.deepEqual(same.items.filter((i) => i.status !== 'same').map((i) => i.key), [], 'statement files are tracked, hashes match');

  // Changed on Polygon: the input is replaced, the output file goes, test 2 gets one.
  await poly.call('problem.saveTest', { problemId: pid, testset: 'pretests', testIndex: 1, testInputForStatements: 'R-IN', testOutputForStatements: '' });
  await poly.call('problem.saveTest', { problemId: pid, testset: 'pretests', testIndex: 2, testOutputForStatements: 'R2-OUT' });
  const { pre } = await pullTaken(p.id);
  assert.equal(statusOf(pre, 'testset:pretests')?.status, 'remote');
  assert.equal(await fs.readFile(path.join(stDir, '01.in'), 'utf8'), 'R-IN\n');
  await assert.rejects(fs.access(path.join(stDir, '01.out')));
  assert.equal(await fs.readFile(path.join(stDir, '02.out'), 'utf8'), 'R2-OUT\n');
  assert.deepEqual((await sync.pullPreview(await judge.ctx(p.id))).items.filter((i) => i.status !== 'same').map((i) => i.key), []);

  // Removed locally (and test 2 no longer a sample): cleared on Polygon.
  await fs.rm(path.join(stDir, '01.in'));
  await editToml(p, (d) => (d.testsets.pretests.samples = '1'));
  const { diff: d2 } = await pushAll(p.id);
  assert.equal(d2.items.find((i) => i.key === 'testset:pretests')?.status, 'modified');
  assert.deepEqual([ts[1].useInStatements, ts[1].inputForStatement], [true, '']);
  assert.deepEqual([!!ts[2].useInStatements, ts[2].outputForStatement ?? ''], [false, '']);
  assert.ok((await sync.pushPreview(await judge.ctx(p.id))).items.every((i) => i.status === 'unchanged'));
});

test('unsafe names from Polygon are rejected; OI-only statement files are never pull items', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-unsafe-'));
  try {
    const ac = { dir: d, doc: {}, written: new Set<string>() };
    for (const it of [
      { key: 'solution:x', kind: 'solution' as const, label: '', text: '', meta: { tag: 'OK' }, extra: { name: '../evil.cpp' } },
      { key: 'resource:x', kind: 'resource' as const, label: '', bytes: Buffer.from(''), extra: { name: '..\\evil' } },
      { key: 'statement:x', kind: 'statement' as const, label: '', text: 'x', extra: { lang: '../../x', section: 'legend' } },
      { key: 'testset:x', kind: 'testset' as const, label: '', extra: { testset: '../x', content: { script: '', tests: {}, groupsEnabled: false, groups: [] } } },
    ]) await assert.rejects(applyItem(ac, it), /Unsafe/);
    await assert.rejects(fs.access(path.join(path.dirname(d), 'evil.cpp')));
  } finally { await fs.rm(d, { recursive: true, force: true }); }

  const p = await registry.create({ name: 'psync-oi-files' });
  await fs.writeFile(path.join(p.dir, 'statement/zh/constraints.tex'), '$n \\le 10$');
  await fs.mkdir(path.join(p.dir, 'statement/zh/samples'), { recursive: true });
  await fs.writeFile(path.join(p.dir, 'statement/zh/samples/1.tex'), 'note');
  const ctx = await judge.ctx(p.id);
  const extra = await untrackedItems(p.dir, ctx.config, (await localItems(judge, ctx)).items);
  assert.ok(!extra.some((i) => i.path?.startsWith('statement/zh/')), extra.map((i) => i.key).join());
  const pre = await sync.pushPreview(ctx);
  assert.ok(pre.warnings.some((w) => /OI-only statement files are not synced.*constraints\.tex/.test(w)));
});

test('client retries only transport failures of idempotent methods and aborts in flight', async () => {
  const hits: Record<string, number> = {};
  let hang = false;
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    const method = req.url!.split('/').pop()!;
    hits[method] = (hits[method] ?? 0) + 1;
    if (hang) return; // never answers
    if (method === 'problems.list' && hits[method] < 3) return res.writeHead(503).end('busy');
    if (method === 'problem.commitChanges') return res.writeHead(502).end('bad gateway');
    if (method === 'problem.info') return res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'FAILED', comment: 'nope' }));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'OK', result: [] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api/`;
    const c = new PolygonClient({ apiUrl: url, key: 'k', secret: 's', retryDelayMs: 1 });
    assert.deepEqual(await c.call('problems.list'), []);
    assert.equal(hits['problems.list'], 3);
    await assert.rejects(c.call('problem.commitChanges', { problemId: 1 }), /HTTP 502/);
    assert.equal(hits['problem.commitChanges'], 1, 'never repeated: it is not idempotent');
    await assert.rejects(c.call('problem.info', { problemId: 1 }), PolygonError);
    assert.equal(hits['problem.info'], 1);
    hang = true;
    const ac = new AbortController();
    const slow = new PolygonClient({ apiUrl: url, key: 'k', secret: 's', signal: ac.signal, retryDelayMs: 1 });
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(slow.call('problem.files', { problemId: 1 }));
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(hits['problem.files'], 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('a failed usage log write does not break later ones', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-usage-'));
  try {
    await fs.writeFile(path.join(d, 'blocker'), '');
    const log = new UsageLog({ cacheDir: path.join(d, 'blocker', 'sub') } as never);
    const rec = { at: new Date().toISOString(), endpoint: 'e', protocol: 'openai', model: 'm', problem: 'p', session: 's', usage: { input: 1, output: 1, cacheRead: 0 } } as never;
    await assert.rejects(log.append(rec));
    (log as any).file = path.join(d, 'ok', 'ai-usage.jsonl');
    await log.append(rec);
    assert.equal((await log.records()).length, 1);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});
