import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { invocationRefs } from '@taskweave/shared';
import { GlobalStore } from '../src/global.js';
import { ProblemRegistry } from '../src/workspace/problems.js';
import { Judge } from '../src/judge/index.js';
import { WsHub } from '../src/ws.js';
import { listInvocations, readInvocation, refOutputPath, runInvocation } from '../src/judge/invocation.js';

const job = () => ({ signal: new AbortController().signal, progress() {} });

test('one invocation runs chosen tests of several testsets; old invocations keep working', { timeout: 180000 }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-invts-'));
  try {
    const global = new GlobalStore(home);
    await global.init();
    global.config.problems.roots = [path.join(home, 'problems')];
    const registry = new ProblemRegistry(global);
    const judge = new Judge(global, registry, new WsHub());
    const p = await registry.create({ name: 'multi' });
    await fs.appendFile(path.join(p.dir, 'problem.toml'), '\n[testsets.pretests]\nmanual = "tests/pretests"\n');
    await fs.mkdir(path.join(p.dir, 'tests/pretests'), { recursive: true });
    const manual = (await fs.readdir(path.join(p.dir, 'tests/manual'))).filter((n) => /^\d+$/.test(n.replace(/\.[^.]*$/, '')) && !/\.(ans|out)$/.test(n));
    assert.ok(manual.length > 0, 'template has manual tests');
    for (const n of manual) await fs.copyFile(path.join(p.dir, 'tests/manual', n), path.join(p.dir, 'tests/pretests', n));
    const ctx = await judge.ctx(p.id);
    const first = Number(manual.sort()[0].replace(/\.[^.]*$/, ''));

    const id = await runInvocation(judge, ctx, ['solutions/std.cpp'], undefined, job(), () => {}, undefined, [
      { testset: 'pretests' },
      { testset: 'tests', tests: [first] },
    ]);
    const inv = await readInvocation(ctx, id);
    assert.equal(inv.status, 'done', inv.error ?? '');
    const refs = invocationRefs(inv);
    // Testsets in the problem's order ("tests" first), each with its chosen tests.
    assert.deepEqual(refs[0], { testset: 'tests', index: first });
    assert.equal(refs.filter((r) => r.testset === 'pretests').length, manual.length);
    assert.equal(inv.testset, 'tests');
    assert.ok(inv.cells[0].every((c) => c?.verdict === 'OK'));
    // Outputs of the same index in two testsets do not overwrite each other.
    const pre = refs.find((r) => r.testset === 'pretests' && r.index === first)!;
    await fs.access(refOutputPath(ctx, inv, 0, refs[0]));
    await fs.access(refOutputPath(ctx, inv, 0, pre));
    assert.notEqual(refOutputPath(ctx, inv, 0, refs[0]), refOutputPath(ctx, inv, 0, pre));
    const summary = (await listInvocations(ctx)).find((s) => s.id === id)!;
    assert.deepEqual(summary.testsets, ['tests', 'pretests']);

    // An invocation stored before `refs` existed.
    const legacy = { ...inv, id: `${id}-old`, refs: undefined };
    assert.deepEqual(invocationRefs(legacy), inv.tests.map((index) => ({ testset: 'tests', index })));
    const single = await readInvocation(ctx, await runInvocation(judge, ctx, ['solutions/std.cpp'], [first], job(), () => {}, 'pretests'));
    assert.deepEqual(invocationRefs(single), [{ testset: 'pretests', index: first }]);
    await fs.access(refOutputPath(ctx, single, 0, { testset: 'pretests', index: first }));
    assert.equal(path.basename(refOutputPath(ctx, single, 0, { testset: 'pretests', index: first })), `${first}.out`);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
