import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Runner, type ProcSpec } from '../src/judge/runner.js';

const linux = { skip: process.platform !== 'linux' };
const source = `#include <iostream>
#include <string>
#include <vector>
#include <cstdlib>
#include <csignal>
#include <unistd.h>
#include <sys/wait.h>
#include <fstream>
int main(int argc, char** argv) {
  std::string mode = argv[1];
  if (mode == "args") { for (int i = 2; i < argc; ++i) std::cout << std::string(argv[i]).size() << ":" << argv[i] << "\\n"; }
  else if (mode == "cat") std::cout << std::cin.rdbuf();
  else if (mode == "cpu") { volatile unsigned long long x = 1; for (;;) x = x * 3 + 1; }
  else if (mode == "sleep") sleep(30);
  else if (mode == "memory") { for (;;) { volatile char* p = new char[1024 * 1024]; for (int i = 0; i < 1024 * 1024; ++i) p[i] = 1; usleep(3000); } }
  else if (mode == "output") { std::string s(4096, 'x'); for (;;) std::cout << s << std::flush; }
  else if (mode == "crash") raise(SIGSEGV);
  else if (mode == "solution") { int n; if (!(std::cin >> n)) return 11; std::cout << n * 2 << std::endl; }
  else if (mode == "interactor") { std::cout << 21 << std::endl; int n; if (!(std::cin >> n) || n != 42) return 12; }
  else if (mode == "eof-solution") { int n, count = 0; while (std::cin >> n) ++count; return count == 1 ? 0 : 13; }
  else if (mode == "eof-interactor") std::cout << 1 << std::endl;
  else if (mode == "fork") {
    pid_t child = fork(); if (!child) { std::ofstream(argv[2]) << getpid() << std::endl; sleep(30); return 0; }
    if (child < 0) return 14; waitpid(child, nullptr, 0);
  }
  return 0;
}`;
async function fixture(run: (runner: Runner, spec: (mode: string, extra?: Partial<ProcSpec>) => ProcSpec, home: string, exe: string) => Promise<void>) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'taskweave-linux-'));
  const code = path.join(home, 'fixture.cpp'), exe = path.join(home, 'fixture');
  await fs.writeFile(code, source);
  execFileSync('g++', ['-std=c++17', '-O2', code, '-o', exe]);
  const runner = new Runner(path.join(home, 'bin'));
  const spec = (mode: string, extra: Partial<ProcSpec> = {}): ProcSpec => ({ argv: [exe, mode], cwd: home, stdout: path.join(home, 'stdout'), stderr: path.join(home, 'stderr'), timeLimitMs: 2000, wallLimitMs: 5000, memoryLimitBytes: 256 * 1024 * 1024, ...extra });
  try { await run(runner, spec, home, exe); } finally { await fs.rm(home, { recursive: true, force: true }); }
}

test('Linux runner preserves argv, Unicode paths and exact redirected bytes', linux, async () => fixture(async (runner, spec, home, exe) => {
  const args = ['two words', 'quote"', 'back\\slash', '', '你好', '=value'];
  const run = await runner.run(spec('args', { argv: [exe, 'args', ...args] }));
  assert.equal(run.status, 'OK', run.error ?? ''); assert.ok(run.memoryKb > 0); assert.ok(run.wallMs >= run.timeMs - 30);
  assert.equal(await fs.readFile(path.join(home, 'stdout'), 'utf8'), args.map(arg => `${Buffer.byteLength(arg)}:${arg}\n`).join(''));
  const input = path.join(home, '输入 空格.in'), output = path.join(home, '答案 输出');
  const bytes = Buffer.from([0, 255, 13, 10, 42]); await fs.writeFile(input, bytes);
  assert.equal((await runner.run(spec('cat', { stdin: input, stdout: output }))).status, 'OK');
  assert.deepEqual(await fs.readFile(output), bytes);
}));

test('Linux runner enforces CPU, idle wall, memory and output limits', linux, async () => fixture(async (runner, spec, home) => {
  const cpu = await runner.run(spec('cpu', { timeLimitMs: 150, wallLimitMs: 3000 }));
  assert.equal(cpu.status, 'TL'); assert.equal(cpu.idle, false); assert.ok(cpu.timeMs >= 140 && cpu.timeMs < 2000, JSON.stringify(cpu));
  const wall = await runner.run(spec('sleep', { timeLimitMs: 500, wallLimitMs: 150 }));
  assert.equal(wall.status, 'TL'); assert.equal(wall.idle, true); assert.ok(wall.wallMs >= 140 && wall.wallMs < 2000);
  const memory = await runner.run(spec('memory', { memoryLimitBytes: 32 * 1024 * 1024 }));
  assert.equal(memory.status, 'ML', JSON.stringify(memory)); assert.ok(memory.memoryKb >= 32 * 1024);
  const output = await runner.run(spec('output', { outputLimitBytes: 128 * 1024 }));
  assert.equal(output.status, 'OL'); assert.ok((await fs.stat(path.join(home, 'stdout'))).size <= 128 * 1024);
}));

test('Linux runner separates start failures from crashes and closes interactive pipes for EOF', linux, async () => fixture(async (runner, spec, home) => {
  const missing = await runner.run(spec('cat', { argv: [path.join(home, 'absent')] }));
  assert.equal(missing.status, 'IE'); assert.match(missing.error ?? '', /exec/i);
  const crash = await runner.run(spec('crash')); assert.equal(crash.status, 'RE'); assert.equal(crash.exitCode, 128 + 11);
  for (const prefix of ['', 'eof-']) {
    const paired = await runner.runInteractive(spec(prefix + 'solution'), spec(prefix + 'interactor', { stderr: path.join(home, 'interactor-stderr') }));
    assert.equal(paired.solution.status, 'OK', JSON.stringify(paired)); assert.equal(paired.interactor.status, 'OK', JSON.stringify(paired));
  }
}));

test('Linux runner limits child processes and cancels a running process tree', linux, async () => fixture(async (runner, spec, home, exe) => {
  const pidFile = path.join(home, 'child.pid');
  const limited = await runner.run(spec('fork', { argv: [exe, 'fork', pidFile], processLimit: 1 }));
  assert.equal(limited.status, 'RE'); assert.match(limited.error ?? '', /process limit/i);
  await fs.rm(pidFile, { force: true });
  const controller = new AbortController();
  const running = runner.run(spec('fork', { argv: [exe, 'fork', pidFile], processLimit: 2 }), controller.signal);
  const checked = assert.rejects(running, /abort/i);
  let pid: number | undefined;
  for (let i = 0; i < 100 && !pid; i++) {
    pid = Number(await fs.readFile(pidFile, 'utf8').catch(() => '')) || undefined;
    if (!pid) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(pid, 'fixture child started'); controller.abort(); await checked;
  for (let i = 0; i < 100; i++) {
    if (!await fs.stat(`/proc/${pid}`).catch(() => null)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Cancelled child ${pid} is still present`);
}));
