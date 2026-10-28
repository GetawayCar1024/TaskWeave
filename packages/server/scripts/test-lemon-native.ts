import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { GlobalStore } from '../src/global.js';
import { ProblemRegistry } from '../src/workspace/problems.js';
import { Judge } from '../src/judge/index.js';
import { WsHub } from '../src/ws.js';
import { addLemonProblem } from '../src/judge/lemonlime.js';
import { ZipWriter, readZip } from '../src/util/zip.js';
import { LEMON_COMPARISON_MODES, type LemonComparison } from '@taskweave/shared';

async function fixture(run: (judge: Judge, registry: ProblemRegistry, home: string) => Promise<void>) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tw-lemon-native-')));
  const global = new GlobalStore(home); await global.init(); global.config.problems.roots = [path.join(home, 'problems')];
  const registry = new ProblemRegistry(global), judge = new Judge(global, registry, new WsHub());
  try { await run(judge, registry, home); } finally { await fs.rm(home, { recursive: true, force: true }); }
}
test('native CDF comparisons use 0/1/3 without compiling or exporting a special judge', async () => fixture(async (judge, registry) => {
  const p = await registry.create({ name: 'native', dataOnly: true });
  await fs.writeFile(path.join(p.dir, 'tests/manual/1.in'), '1'); await fs.writeFile(path.join(p.dir, 'tests/manual/1.ans'), '1');
  await registry.patch(p.id, { points: false, testsets: { tests: { groups: false, group: [] } } });
  judge.compiler.compile = async () => { throw new Error('Native export must not compile a checker'); };
  for (const mode of ['lines', 'ignore-spaces', 'real'] as const) {
    await registry.patch(p.id, { lemonComparison: { mode, precision: 9 } });
    const zip = new ZipWriter();
    const result = await addLemonProblem(judge, await judge.ctx(p.id), 'A', zip, { signal: new AbortController().signal, progress() {} });
    assert.equal(result.task.comparisonMode, LEMON_COMPARISON_MODES[mode]); assert.equal(result.task.specialJudge, ''); assert.equal(result.task.realPrecision, 9);
    assert.equal(result.checkerBuild, undefined); assert.ok(![...readZip(zip.finish()).keys()].some(file => file.includes('checker')));
  }
}));

test('local native comparisons match pinned Lemon EOF, line, chunk and long-double behavior', { timeout: 120000 }, async () => fixture(async (judge, registry, home) => {
  const p = await registry.create({ name: 'local' });
  const dir = path.join(home, '比较器 data'); await fs.mkdir(dir);
  const output = path.join(dir, 'output.txt'), answer = path.join(dir, 'answer.txt'), input = path.join(dir, 'input.txt'); await fs.writeFile(input, '');
  const cases: [LemonComparison['mode'], number, string, string, number][] = [
    ['lines', 3, '1 2\n', '1 2\n', 0], ['lines', 3, '1 2', '1 2\n', 1], ['lines', 3, '1 2\n', '1 2', 0],
    ['lines', 3, '\n1 2\n', '1 2\n', 0], ['lines', 3, 'a'.repeat(32) + '\nb\n', 'a'.repeat(32) + 'b\n', 0],
    ['ignore-spaces', 3, ' 1\t 2 \n\n', '1 2\n', 0], ['ignore-spaces', 3, '1\n2\n', '1 2\n', 2],
    ['ignore-spaces', 3, '1\n2', '1 2', 0], ['ignore-spaces', 3, 'a'.repeat(32) + ' b\n', 'a'.repeat(32) + 'b\n', 0],
    ['real', 6, '0.0000009\n', '0\n', 0], ['real', 6, '0.0000011\n', '0\n', 1],
    ['real', 6, '1000000.9\n', '1000000\n', 0], ['real', 6, '1000001.1\n', '1000000\n', 1],
    ['real', 6, '-inf\n', 'inf\n', 0], ['real', 6, '1\n', 'abc\n', 3], ['real', 6, '1 2\n', '1\n', 4],
    ['real', 6, '1 2\n', '1,2\n', 0], ['real', 18, '9007199254740993\n', '9007199254740992\n', 1],
  ];
  for (const [mode, precision, contestant, reference, verdict] of cases) {
    await registry.patch(p.id, { lemonComparison: { mode, precision } });
    const checker = await judge.checker(await judge.ctx(p.id));
    await fs.writeFile(output, contestant); await fs.writeFile(answer, reference);
    const result = spawnSync(checker.argv[0], [...checker.argv.slice(1), input, output, answer], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, verdict, `${mode}/${precision}: ${JSON.stringify([contestant, reference])}: ${result.stderr}`);
  }
}));
