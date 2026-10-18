import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { convertLemonChecker, createLemonChecker } from '../src/judge/lemonChecker.js';
import { GlobalStore } from '../src/global.js';
import { ProblemRegistry } from '../src/workspace/problems.js';
import { Judge } from '../src/judge/index.js';
import { WsHub } from '../src/ws.js';

test('simple Lemon conversion leaves comments and literals intact and rejects ambiguous APIs', () => {
  const src = String.raw`// registerTestlibCmd(argc, argv);
/*
#include "testlib.h"
*/
#include "testlib.h"
int main(int argc,char **argv) {
  const char* note = "registerTestlibCmd(argc, argv);";
  registerTestlibCmd(argc, argv);
  quitf(_ok, "accepted");
}`;
  const converted = convertLemonChecker(src);
  assert.ok(converted.includes('// registerTestlibCmd(argc, argv);'));
  assert.ok(converted.includes('"registerTestlibCmd(argc, argv);"'));
  assert.ok(converted.includes('registerLemonChecker(argc, argv);'));
  assert.equal(converted.match(/#include "lemon\/testlib.h"/g)?.length, 1);
  assert.throws(() => convertLemonChecker(src.replace('quitf(_ok', 'quitf(_pc(50)')), /manual conversion/);
  assert.throws(() => convertLemonChecker(src.replace('registerTestlibCmd(argc, argv);\n  quitf', 'registerTestlibCmd(argc, argv); registerTestlibCmd(argc, argv);\n  quitf')), /expected one/);
  assert.throws(() => convertLemonChecker(converted), /already uses/);
});

test('converted checker is separate, collision-safe, builds and preserves fractional quitp scoring', { timeout: 60000 }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-lemon-convert-'));
  try {
    const global = new GlobalStore(home); await global.init(); global.config.problems.roots = [path.join(home, 'problems')];
    const registry = new ProblemRegistry(global), judge = new Judge(global, registry, new WsHub());
    const p = await registry.create({ name: 'convert' });
    const first = await createLemonChecker(judge, p.id);
    assert.equal(first.source, 'ncmp-lemon.cpp');
    const original = await fs.readFile(path.join(p.dir, first.source), 'utf8');
    const second = await createLemonChecker(judge, p.id);
    assert.notEqual(first.source, second.source);
    assert.equal(await fs.readFile(path.join(p.dir, first.source), 'utf8'), original);
    assert.equal((await judge.ctx(p.id)).config.checker?.source, 'std:ncmp');
    const standard = await judge.compile(await judge.ctx(p.id), first.source, false);
    assert.ok(standard.result.ok, standard.result.log);
    await fs.writeFile(path.join(p.dir, 'partial.cpp'), '#include "testlib.h"\nint main(int argc,char**argv){registerTestlibCmd(argc,argv);ouf.readInt();quitp(0.5,"half");}\n');
    const before = await fs.readFile(path.join(p.dir, 'partial.cpp'), 'utf8');
    await registry.patch(p.id, { checker: 'partial.cpp' });
    const partial = await createLemonChecker(judge, p.id);
    assert.equal(await fs.readFile(path.join(p.dir, 'partial.cpp'), 'utf8'), before);
    const program = await judge.compile(await judge.ctx(p.id), partial.source, false);
    assert.ok(program.result.ok, program.result.log);
    for (const name of ['in', 'out', 'ans']) await fs.writeFile(path.join(p.dir, name), '1\n');
    execFileSync(program.program!.argv[0], ['in', 'out', 'ans', '40', 'score', 'message'], { cwd: p.dir, windowsHide: true });
    assert.equal((await fs.readFile(path.join(p.dir, 'score'), 'utf8')).trim(), '20');
    assert.equal((await judge.ctx(p.id)).config.lemon_checker?.source, partial.source);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
