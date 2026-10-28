import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { testsetOf } from '@taskweave/shared';
import { GlobalStore } from '../src/global.js';
import { ProblemRegistry } from '../src/workspace/problems.js';
import { ContestRegistry } from '../src/workspace/contests.js';
import { TrashStore } from '../src/workspace/trash.js';
import { Judge } from '../src/judge/index.js';
import { WsHub } from '../src/ws.js';
import { atomicWrite, exists } from '../src/util/fs.js';
import { ZipWriter, readZip } from '../src/util/zip.js';
import { importPackage } from '../src/imports/packages.js';
import { regenerateAnswers, restoreOriginalAnswers } from '../src/judge/answers.js';
import { answerBackupInfo, recoverAnswerTransaction, replaceAnswerFiles } from '../src/workspace/answerBackups.js';
import { readManifest } from '../src/judge/tests.js';
import { listShared } from '../src/sharedFiles.js';
import { addLemonProblem, addLemonBuildScripts, lemonHost } from '../src/judge/lemonlime.js';

const job = () => ({ signal: new AbortController().signal, progress() {} });
const zip = (files: Record<string, string | Buffer>) => { const writer = new ZipWriter(); for (const [name, bytes] of Object.entries(files)) writer.add(name, bytes); return writer.finish(); };
async function fixture(run: (judge: Judge, home: string) => Promise<void>) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-complete-'));
  try {
    const global = new GlobalStore(home); await global.init(); global.config.problems.roots = [path.join(home, 'problems')];
    await run(new Judge(global, new ProblemRegistry(global), new WsHub()), home);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
}

test('compatibility outputs can be regenerated repeatedly and restored to exact import-time bytes', async () => fixture(async judge => {
  const original = Buffer.from([0, 255, 13, 10]);
  const p = (await importPackage(judge, zip({ '1.in': '2\n', '1.out': 'old\r\n', '2.in': '3\n', '2.out': original }), { format: 'data', name: 'outputs' })).problem;
  const source = 'solutions/output.cpp';
  await atomicWrite(path.join(p.dir, source), '#include <iostream>\nint main(){int n;std::cin>>n;std::cout<<n*2<<"\\n";}\n');
  await judge.registry.patch(p.id, { solution: { source, tag: 'MA' } });
  let ctx = await judge.ctx(p.id);
  const before = ctx.config.tests.answer_baseline;
  assert.ok(before); assert.equal((await answerBackupInfo(p.dir, testsetOf(ctx.config)!)).origin, 'import');
  await regenerateAnswers(judge, ctx, { source }, job());
  assert.equal((await fs.readFile(path.join(p.dir, 'tests/manual/1.ans'), 'utf8')).trim(), '4');
  await atomicWrite(path.join(p.dir, source), '#include <iostream>\nint main(){int n;std::cin>>n;std::cout<<n*3<<"\\n";}\n');
  await regenerateAnswers(judge, await judge.ctx(p.id), { source }, job());
  assert.equal((await fs.readFile(path.join(p.dir, 'tests/manual/2.ans'), 'utf8')).trim(), '9');
  ctx = await judge.ctx(p.id); assert.equal(ctx.config.tests.answer_baseline, before);
  await fs.rm(path.join(ctx.work, 'tests'), { recursive: true, force: true });
  await restoreOriginalAnswers(ctx, 'tests', job());
  assert.equal(await fs.readFile(path.join(p.dir, 'tests/manual/1.ans'), 'utf8'), 'old\r\n');
  assert.deepEqual(await fs.readFile(path.join(p.dir, 'tests/manual/2.ans')), original);
  assert.equal((await readManifest(ctx))!.tests[0].answerSize, 5);
  assert.deepEqual(await fs.readdir(path.join(ctx.work, 'answers-original')), [before]);
}));

test('failed solution runs keep every previous output; legacy snapshots are explicitly marked', async () => fixture(async judge => {
  const p = await judge.registry.create({ name: 'legacy-outputs', dataOnly: true });
  for (const i of [1, 2]) { await atomicWrite(path.join(p.dir, `tests/manual/${i}.in`), `${i}\n`); await atomicWrite(path.join(p.dir, `tests/manual/${i}.ans`), `before-${i}`); }
  const source = 'solutions/fails.cpp';
  await atomicWrite(path.join(p.dir, source), '#include <iostream>\nint main(){int n;std::cin>>n;if(n==2)return 1;std::cout<<"new";}\n');
  await judge.registry.patch(p.id, { solution: { source, tag: 'MA' } });
  await assert.rejects(regenerateAnswers(judge, await judge.ctx(p.id), { source }, job()), /Test 2: RE/);
  for (const i of [1, 2]) assert.equal(await fs.readFile(path.join(p.dir, `tests/manual/${i}.ans`), 'utf8'), `before-${i}`);
  const info = await answerBackupInfo(p.dir, testsetOf((await judge.ctx(p.id)).config)!);
  assert.equal(info.origin, 'existing');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(regenerateAnswers(judge, await judge.ctx(p.id), { source }, { ...job(), signal: controller.signal }));
}));

test('answer publication rollback and interrupted-transaction recovery retain the immediate previous outputs', async () => fixture(async (judge, home) => {
  const p = await judge.registry.create({ name: 'transaction', dataOnly: true });
  const one = path.join(p.dir, 'tests/manual/1.ans'), two = path.join(p.dir, 'tests/manual/2.ans');
  await atomicWrite(one, 'previous-1'); await atomicWrite(two, 'previous-2');
  const fresh = path.join(home, 'fresh.ans'); await fs.writeFile(fresh, 'new');
  const rename = fs.rename; let failed = false;
  fs.rename = async (from, to) => { if (String(to) === two && !failed) { failed = true; throw new Error('injected publication error'); } return rename(from, to); };
  try { await assert.rejects(replaceAnswerFiles(p.dir, [{ output: 'tests/manual/1.ans', from: fresh }, { output: 'tests/manual/2.ans', from: fresh }], job().signal), /injected/); }
  finally { fs.rename = rename; }
  assert.equal(await fs.readFile(one, 'utf8'), 'previous-1'); assert.equal(await fs.readFile(two, 'utf8'), 'previous-2');
  const transaction = path.join(p.dir, '.taskweave/answer-transaction');
  await atomicWrite(path.join(transaction, '1.ans'), 'previous-1');
  await atomicWrite(path.join(transaction, 'journal.json'), JSON.stringify({ version: 1, committed: false, files: [{ output: 'tests/manual/1.ans', previous: '1.ans' }] }));
  await fs.writeFile(one, 'partially-published');
  await Promise.all([recoverAnswerTransaction(p.dir), recoverAnswerTransaction(p.dir)]);
  assert.equal(await fs.readFile(one, 'utf8'), 'previous-1');
}));

test('Lemon templates use the real six-argument protocol and reject incorrect outputs', { timeout: 180000 }, async () => fixture(async (judge, home) => {
  const shared = await listShared(judge.global.sharedDir); assert.equal(shared.lemonCheckers.length, 6);
  const cases: Record<string, [string, string, string]> = {
    ncmp: ['1 2\n', '1\n2\n', '1 3\n'], wcmp: ['alpha beta\n', 'alpha\n beta\n', 'alpha gamma\n'],
    lcmp: ['alpha beta\ngamma\n', 'alpha\t beta\ngamma\n', 'alpha\nbeta gamma\n'],
    fcmp: ['alpha beta\n', 'alpha beta\n', 'alpha  beta\n'], rcmp6: ['1.0\n', '1.0000002\n', '1.1\n'], yesno: ['YES\n', 'yEs\n', 'NO\n'],
  };
  const p = await judge.registry.create({ name: 'checkers', dataOnly: true });
  for (const [name, [answer, good, bad]] of Object.entries(cases)) {
    const compiled = await judge.compiler.compile(p.dir, `lemon:${name}`); assert.ok(compiled.program, compiled.result.log);
    const dir = path.join(home, name); await fs.mkdir(dir); await fs.writeFile(path.join(dir, 'in'), ''); await fs.writeFile(path.join(dir, 'ans'), answer);
    for (const [text, expected] of [[good, 37], [bad, 0]] as const) {
      await fs.writeFile(path.join(dir, 'out'), text);
      execFileSync(compiled.program.argv[0], ['in', 'out', 'ans', '37', 'score', 'message'], { cwd: dir, windowsHide: true });
      assert.equal(Number(await fs.readFile(path.join(dir, 'score'), 'utf8')), expected, name);
    }
  }
}));

test('Lemon archives select target filenames and root scripts compile all supplied checker sources', { timeout: 180000 }, async () => fixture(async (judge, home) => {
  const p = (await importPackage(judge, zip({ '1.in': '1', '1.out': '2' }), { format: 'data', name: 'portable-checker' })).problem;
  await judge.registry.patch(p.id, { lemonChecker: 'lemon:ncmp' });
  const ctx = await judge.ctx(p.id);
  for (const target of ['windows', 'linux'] as const) {
    const writer = new ZipWriter(); const result = await addLemonProblem(judge, ctx, 'A', writer, job(), ['tests'], false, target);
    assert.equal(result.task.specialJudge, `portable-checker/checker${target === 'windows' ? '.exe' : ''}`);
    addLemonBuildScripts(writer, [result.checkerBuild!]);
    const files = readZip(writer.finish());
    assert.ok(files.has('compile-checkers.cmd') && files.has('compile-checkers.sh'));
    assert.ok(files.has('data/portable-checker/checker-sources/shared/lemon/testlib.h'));
    if (target !== lemonHost()) assert.ok(!files.has('data/' + result.task.specialJudge));
    if (target === 'linux') {
      const script = path.join(home, 'compile-checkers.sh'); await fs.writeFile(script, files.get('compile-checkers.sh')!);
      const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
      if (process.platform !== 'win32' || await exists(bash)) execFileSync(bash, ['-n', script], { windowsHide: true });
    }
    if (target === 'windows' && process.platform === 'win32') {
      const root = path.join(home, 'compile all with spaces'); await fs.mkdir(root);
      for (const [file, bytes] of files) await atomicWrite(path.join(root, file), bytes);
      await fs.rm(path.join(root, 'data', result.task.specialJudge), { force: true });
      execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'compile-checkers.cmd'], { cwd: root, windowsHide: true });
      await fs.access(path.join(root, 'data', result.task.specialJudge));
    }
  }
}));

test('new local-volume trash preserves identity, restores, and removes payloads without recursive copies', async () => fixture(async (judge, home) => {
  const contests = new ContestRegistry(judge.registry, judge.global), trash = new TrashStore(judge.global, judge.registry, contests);
  const p = await judge.registry.create({ name: 'local-trash', dataOnly: true }); await atomicWrite(path.join(p.dir, 'tests/manual/1.in'), 'keep');
  let entry = await trash.recycleProblem(p.id); assert.ok(entry.trash.includes('.taskweave-trash'));
  assert.equal((await trash.restore(entry.key)).id, p.id);
  assert.equal(await fs.readFile(path.join(p.dir, 'tests/manual/1.in'), 'utf8'), 'keep');
  entry = await trash.recycleProblem(p.id); await trash.remove(entry.key); await assert.rejects(fs.access(entry.trash));
  assert.deepEqual(await trash.list(), []);
}));
