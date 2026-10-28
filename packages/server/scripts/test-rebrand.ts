import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GlobalStore, defaultGlobalDir } from '../src/global.js';
import { LEGACY_ID, LEGACY_STATE, legacyEnv } from '@taskweave/shared';
import { ProblemRegistry } from '../src/workspace/problems.js';
import { ContestRegistry } from '../src/workspace/contests.js';
import { TrashStore } from '../src/workspace/trash.js';
import { Judge } from '../src/judge/index.js';
import { WsHub } from '../src/ws.js';
import { importPackage } from '../src/imports/packages.js';
import { readManifest } from '../src/judge/tests.js';
import { parseData } from '../src/imports/data.js';

test('TaskWeave migrates a legacy installation and preserves configuration, paths and secret bytes', async t => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'taskweave-upgrade-')));
  t.mock.method(os, 'homedir', () => home);
  const variables = ['TASKWEAVE_HOME', legacyEnv('HOME')];
  const before = variables.map(key => process.env[key]); variables.forEach(key => { delete process.env[key]; });
  try {
    const current = path.join(home, '.taskweave'), legacy = path.join(home, LEGACY_STATE);
    assert.equal(defaultGlobalDir(), current);
    await fs.mkdir(legacy); await fs.mkdir(current);
    const root = path.join(legacy, 'problems'); await fs.mkdir(root);
    await fs.writeFile(path.join(legacy, 'config.toml'), '[ui]\nlocale = "en"\ntheme = "light"\n[problems]\nroots = [' + JSON.stringify(root) + ']\n');
    const secrets = '# Keep this comment and formatting\r\n[polygon]\r\nkey = "fixture-key"\r\nsecret = "fixture-secret"\r\n';
    await fs.writeFile(path.join(legacy, 'secrets.toml'), secrets);
    assert.equal(defaultGlobalDir(), current, 'an empty new-name folder must not hide an existing installation');
    const store = new GlobalStore(defaultGlobalDir()); await store.init();
    assert.equal(store.config.ui.locale, 'en'); assert.equal(store.config.ui.theme, 'light');
    assert.equal(await fs.readFile(path.join(current, 'secrets.toml'), 'utf8'), secrets);
    assert.deepEqual(store.config.problems.roots, [path.join(current, 'problems')]);
    await assert.rejects(fs.stat(legacy), /ENOENT/);
    await fs.writeFile(path.join(current, 'config.toml'), '[ui]\nlocale = "zh-CN"\n');
    assert.equal(defaultGlobalDir(), current, 'an explicitly established TaskWeave installation takes precedence');
  } finally {
    variables.forEach((key, i) => { if (before[i] === undefined) delete process.env[key]; else process.env[key] = before[i]; });
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('TASKWEAVE_HOME takes precedence over the legacy environment alias', () => {
  const key = legacyEnv('HOME'), current = process.env.TASKWEAVE_HOME, legacy = process.env[key];
  try {
    delete process.env.TASKWEAVE_HOME; process.env[key] = path.join(os.tmpdir(), 'legacy-home');
    assert.equal(defaultGlobalDir(), path.resolve(process.env[key]!));
    process.env.TASKWEAVE_HOME = path.join(os.tmpdir(), 'new-home');
    assert.equal(defaultGlobalDir(), path.resolve(process.env.TASKWEAVE_HOME));
  } finally {
    if (current === undefined) delete process.env.TASKWEAVE_HOME; else process.env.TASKWEAVE_HOME = current;
    if (legacy === undefined) delete process.env[key]; else process.env[key] = legacy;
  }
});

test('namespace migration retains identities, sessions, answers and original-volume recycle payloads', async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'taskweave-state-upgrade-')));
  const global = new GlobalStore(home); await global.init(); global.config.problems.roots = [path.join(home, 'problems')];
  const registry = new ProblemRegistry(global), contests = new ContestRegistry(registry, global), judge = new Judge(global, registry, new WsHub());
  try {
    const imported = await importPackage(judge, new Map([['one.in', Buffer.from('1')], ['one.out', Buffer.from('original\r\n')]]), { format: 'data', name: 'before' });
    const p = imported.problem, c = await contests.create({ name: 'round', problems: [{ index: 'A', problem: p.id }] });
    const baseline = (await judge.ctx(p.id)).config.tests.answer_baseline!;
    await fs.mkdir(path.join(p.dir, '.taskweave/ai/history'), { recursive: true });
    await fs.writeFile(path.join(p.dir, '.taskweave/ai/history/session.json'), '{"text":"kept history"}');
    await fs.rename(path.join(p.dir, '.taskweave'), path.join(p.dir, LEGACY_STATE));
    await fs.rename(path.join(c.dir, '.taskweave'), path.join(c.dir, LEGACY_STATE));
    const moved = path.join(p.root, 'renamed-folder'); await fs.rename(p.dir, moved);
    assert.equal((await registry.get(p.id)).id, p.id);
    await registry.scan(); await contests.scan();
    assert.equal((await registry.get(p.id)).dir, moved);
    assert.equal((await contests.detail(c.id)).problems[0].summary?.id, p.id);
    assert.equal(await fs.readFile(path.join(moved, '.taskweave/ai/history/session.json'), 'utf8'), '{"text":"kept history"}');
    assert.equal((await judge.ctx(p.id)).config.tests.answer_baseline, baseline);
    const manifest = await readManifest(await judge.ctx(p.id)); assert.ok(manifest);
    assert.equal(manifest.tests[0].answerSize, Buffer.byteLength('original\r\n'));
    const trash = new TrashStore(global, registry, contests), deleted = await trash.recycleProblem(p.id);
    const envelope = path.join(global.dir, 'trash', deleted.key);
    await fs.rename(path.join(envelope, '.taskweave-trash.json'), path.join(envelope, `${LEGACY_STATE}-trash.json`));
    await fs.rename(path.join(p.root, '.taskweave-trash'), path.join(p.root, `${LEGACY_STATE}-trash`));
    assert.equal((await trash.list())[0].originalId, p.id);
    assert.equal((await trash.restore(deleted.key)).id, p.id);
    assert.equal(await fs.readFile(path.join(moved, 'tests/manual/1.ans'), 'utf8'), 'original\r\n');
    await fs.access(path.join(moved, '.taskweave/answers-original', baseline));
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('legacy companion package markers preserve scoring and filenames after namespace changes', () => {
  const plan = parseData(new Map([
    ['in/01.txt', Buffer.from('1')], ['out/01.txt', Buffer.from('2')],
    [`${LEGACY_ID}.yaml`, Buffer.from(JSON.stringify({ format: `${LEGACY_ID}-inout`, version: 1, cases: [{ id: 'one', input: 'in/01.txt', output: 'out/01.txt' }], subtasks: [{ id: 'bundle', aggregation: 'min', points: 73, cases: ['one'] }] }))],
  ]), 'auto');
  assert.equal(plan.groups[0].points, 73); assert.equal(plan.pairs[0].input, 'in/01.txt'); assert.equal(plan.sourceConfig.format, 'taskweave-inout');
});
