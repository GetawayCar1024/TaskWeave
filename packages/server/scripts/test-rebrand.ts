import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GlobalStore, defaultGlobalDir } from '../src/global.js';

test('Taskweave reuses a legacy installation and preserves its configuration and secret bytes', async t => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'taskweave-upgrade-')));
  t.mock.method(os, 'homedir', () => home);
  const variables = ['TASKWEAVE_HOME', 'POLYFORGE_HOME'] as const;
  const before = variables.map(key => process.env[key]); variables.forEach(key => { delete process.env[key]; });
  try {
    const current = path.join(home, '.taskweave'), legacy = path.join(home, '.polyforge');
    assert.equal(defaultGlobalDir(), current);
    await fs.mkdir(legacy); await fs.mkdir(current);
    await fs.writeFile(path.join(legacy, 'config.toml'), '[ui]\nlocale = "en"\ntheme = "light"\n[problems]\nroots = []\n');
    const secrets = '# Keep this comment and formatting\r\n[polygon]\r\nkey = "fixture-key"\r\nsecret = "fixture-secret"\r\n';
    await fs.writeFile(path.join(legacy, 'secrets.toml'), secrets);
    assert.equal(defaultGlobalDir(), legacy, 'an empty new-name folder must not hide an existing installation');
    const store = new GlobalStore(defaultGlobalDir()); await store.init();
    assert.equal(store.config.ui.locale, 'en'); assert.equal(store.config.ui.theme, 'light');
    assert.equal(await fs.readFile(path.join(legacy, 'secrets.toml'), 'utf8'), secrets);
    await fs.writeFile(path.join(current, 'config.toml'), '[ui]\nlocale = "zh-CN"\n');
    assert.equal(defaultGlobalDir(), current, 'an explicitly established Taskweave installation takes precedence');
  } finally {
    variables.forEach((key, i) => { if (before[i] === undefined) delete process.env[key]; else process.env[key] = before[i]; });
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('TASKWEAVE_HOME takes precedence and POLYFORGE_HOME remains a working alias', () => {
  const current = process.env.TASKWEAVE_HOME, legacy = process.env.POLYFORGE_HOME;
  try {
    delete process.env.TASKWEAVE_HOME; process.env.POLYFORGE_HOME = path.join(os.tmpdir(), 'legacy-home');
    assert.equal(defaultGlobalDir(), path.resolve(process.env.POLYFORGE_HOME));
    process.env.TASKWEAVE_HOME = path.join(os.tmpdir(), 'new-home');
    assert.equal(defaultGlobalDir(), path.resolve(process.env.TASKWEAVE_HOME));
  } finally {
    if (current === undefined) delete process.env.TASKWEAVE_HOME; else process.env.TASKWEAVE_HOME = current;
    if (legacy === undefined) delete process.env.POLYFORGE_HOME; else process.env.POLYFORGE_HOME = legacy;
  }
});
