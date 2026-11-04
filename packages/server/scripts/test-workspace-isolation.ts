import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Sandbox } from '../src/ai/sandbox.js';
import { FileService, SelfWrites } from '../src/workspace/files.js';
import { copyNormalized } from '../src/judge/execute.js';
import { navigationTarget } from '../../desktop/src/navigation.js';

test('desktop navigation compares origins and blocks non-web protocol handlers', () => {
  const origin = 'http://127.0.0.1:4523';
  assert.equal(navigationTarget(origin + '/problem/a', origin), 'internal');
  assert.equal(navigationTarget('https://example.com/', origin), 'external');
  for (const url of ['http://127.0.0.1:4523@example.com/', 'file:///C:/Windows/System32/cmd.exe', 'javascript:alert(1)', 'ms-settings:privacy', 'not a URL']) assert.equal(navigationTarget(url, origin), 'blocked');
  assert.equal(navigationTarget('http://127.0.0.1:4524/', origin), 'external');
});

test('AI and file operations reject directory links, hard links and traversal', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'taskweave-path-isolation-'));
  try {
    const real = path.join(home, 'real'), work = path.join(home, 'work'), outside = path.join(home, 'private');
    await Promise.all([real, work, outside].map(dir => fs.mkdir(dir)));
    const secret = path.join(outside, 'secret.txt');
    await fs.writeFile(secret, 'unchanged');
    await fs.symlink(outside, path.join(work, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.link(secret, path.join(work, 'hard.txt'));
    const sandbox = new Sandbox(real, work, new Set());
    const files = new FileService(new SelfWrites());
    for (const name of ['alias/secret.txt', 'hard.txt', '../private/secret.txt']) {
      await assert.rejects(sandbox.read(name));
      await assert.rejects(sandbox.write(name, 'changed'));
      await assert.rejects(files.read(work, name));
      await assert.rejects(files.write(work, name, 'changed'));
    }
    await assert.rejects(copyNormalized(path.join(work, 'hard.txt'), path.join(real, 'copied')));
    await fs.symlink(outside, path.join(real, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.mkdir(path.join(work, 'regular'));
    sandbox.touched.add('alias/secret.txt');
    await assert.rejects(sandbox.accept(['alias/secret.txt']));
    assert.equal(await fs.readFile(secret, 'utf8'), 'unchanged');
    await sandbox.write('safe.txt', 'safe');
    assert.deepEqual(await sandbox.accept(['safe.txt']), ['safe.txt']);
    assert.equal(await fs.readFile(path.join(real, 'safe.txt'), 'utf8'), 'safe');
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
