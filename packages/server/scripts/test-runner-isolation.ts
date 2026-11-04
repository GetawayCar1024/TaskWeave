import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { Runner, type ProcSpec } from '../src/judge/runner.js';
import { GlobalStore } from '../src/global.js';
import { ProblemRegistry } from '../src/workspace/problems.js';
import { Judge } from '../src/judge/index.js';
import { WsHub } from '../src/ws.js';
import { prepareRuntime } from '../src/judge/runtime.js';

test('a compiled submission name cannot grant trusted-runtime directory access', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'taskweave-runtime-name-'));
  try {
    const executable = path.join(home, process.platform === 'win32' ? 'python.exe' : 'python');
    await fs.writeFile(executable, 'fixture');
    const prepared = await prepareRuntime({ argv: [executable], cwd: home, build: { dir: home, hash: 'fixture' } });
    assert.deepEqual(prepared.runtimePaths, []);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

const supported = { skip: !['win32', 'linux'].includes(process.platform) };
const source = String.raw`#ifdef _WIN32
#include <winsock2.h>
#include <windows.h>
#else
#include <sys/socket.h>
#include <arpa/inet.h>
#include <unistd.h>
#endif
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <string>
int main(int argc, char** argv) {
  std::string mode = argv[1];
  if (mode == "read") {
    std::ifstream file(argv[2]);
    std::cout << (file.is_open() ? "ALLOWED" : "DENIED");
  } else if (mode == "write") {
    std::ofstream file(argv[2]);
    std::cout << (file.is_open() ? "ALLOWED" : "DENIED");
    if (file.is_open()) file << "changed";
  } else if (mode == "env") {
    std::cout << (std::getenv("TASKWEAVE_ISOLATION_SENTINEL") ? "ALLOWED" : "DENIED");
  } else if (mode == "network") {
#ifdef _WIN32
    WSADATA data; WSAStartup(MAKEWORD(2, 2), &data);
#endif
    auto fd = socket(AF_INET, SOCK_STREAM, 0);
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(std::atoi(argv[2]));
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    std::cout << (connect(fd, reinterpret_cast<sockaddr*>(&address), sizeof address) == 0 ? "ALLOWED" : "DENIED");
#ifdef _WIN32
    closesocket(fd); WSACleanup();
#else
    close(fd);
#endif
  } else if (mode == "io") {
    std::ofstream("local.txt") << "scratch";
    std::cout << std::cin.rdbuf();
#ifdef _WIN32
  } else if (mode == "spawn") {
    STARTUPINFOA startup{}; startup.cb = sizeof startup;
    PROCESS_INFORMATION child{};
    std::string command = std::string("\"") + argv[2] + "\" --version";
    if (!CreateProcessA(nullptr, command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &child)) {
      std::cout << "CreateProcess error " << GetLastError(); return 1;
    }
    WaitForSingleObject(child.hProcess, INFINITE);
    DWORD code; GetExitCodeProcess(child.hProcess, &code);
    CloseHandle(child.hProcess); CloseHandle(child.hThread);
    std::cout << "child exit " << code;
    return code ? 1 : 0;
#endif
  }
  return 0;
}`;

async function fixture(fn: (runner: Runner, spec: (mode: string, args?: string[]) => ProcSpec, home: string, work: string) => Promise<void>) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'taskweave-isolation-'));
  const work = path.join(home, 'work'), programs = path.join(home, 'programs'), outside = path.join(home, 'private');
  const exe = path.join(programs, process.platform === 'win32' ? 'probe.exe' : 'probe');
  await Promise.all([work, programs, outside].map(dir => fs.mkdir(dir)));
  await fs.writeFile(path.join(programs, 'probe.cpp'), source);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'private sentinel');
  execFileSync('g++', ['-std=c++17', '-O2', ...(process.platform === 'win32' ? ['-static'] : []), path.join(programs, 'probe.cpp'), '-o', exe, ...(process.platform === 'win32' ? ['-lws2_32'] : [])], { windowsHide: true });
  const runner = new Runner(path.join(home, 'runner'));
  const spec = (mode: string, args: string[] = []): ProcSpec => ({ argv: [exe, mode, ...args], cwd: work, stdout: path.join(work, 'stdout'), stderr: path.join(work, 'stderr'), timeLimitMs: 2000, wallLimitMs: 5000, memoryLimitBytes: 256 * 1024 * 1024 });
  try { await fn(runner, spec, home, work); }
  finally { await fs.rm(home, { recursive: true, force: true }); }
}

test('runner denies reading and changing files outside its workspace', supported, async () => fixture(async (runner, spec, home, work) => {
  for (const processLimit of [1, 4]) for (const mode of ['read', 'write']) {
    const run = await runner.run({ ...spec(mode, [path.join(home, 'private/secret.txt')]), processLimit });
    assert.equal(run.status, 'OK', JSON.stringify(run));
    assert.equal(await fs.readFile(path.join(work, 'stdout'), 'utf8'), 'DENIED', `${mode} escaped the workspace`);
    assert.equal(await fs.readFile(path.join(home, 'private/secret.txt'), 'utf8'), 'private sentinel');
  }
}));

test('runner does not inherit host credentials through the environment', supported, async () => fixture(async (runner, spec, _home, work) => {
  const previous = process.env.TASKWEAVE_ISOLATION_SENTINEL;
  process.env.TASKWEAVE_ISOLATION_SENTINEL = 'private sentinel';
  try {
    const run = await runner.run(spec('env'));
    assert.equal(run.status, 'OK', JSON.stringify(run));
    assert.equal(await fs.readFile(path.join(work, 'stdout'), 'utf8'), 'DENIED');
  } finally {
    if (previous === undefined) delete process.env.TASKWEAVE_ISOLATION_SENTINEL;
    else process.env.TASKWEAVE_ISOLATION_SENTINEL = previous;
  }
}));

test('runner cannot connect to the local TaskWeave API or other network services', supported, async () => fixture(async (runner, spec, _home, work) => {
  let connected = false;
  const server = net.createServer(socket => { connected = true; socket.end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const run = await runner.run(spec('network', [String(address.port)]));
    assert.equal(run.status, 'OK', JSON.stringify(run));
    assert.equal(await fs.readFile(path.join(work, 'stdout'), 'utf8'), 'DENIED');
    assert.equal(connected, false);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}));

test('isolated runner still supports inherited input and workspace output', supported, async () => fixture(async (runner, spec, home, work) => {
  const input = path.join(home, 'private/input.in');
  await fs.writeFile(input, '1 2\n');
  const run = await runner.run({ ...spec('io'), stdin: input });
  assert.equal(run.status, 'OK', JSON.stringify(run));
  assert.equal((await fs.readFile(path.join(work, 'stdout'), 'utf8')).replace(/\r\n/g, '\n'), '1 2\n');
  assert.equal(await fs.readFile(path.join(work, 'local.txt'), 'utf8'), 'scratch');
}));

test('Windows compiler sandbox allows its own toolchain subprocesses', { skip: process.platform !== 'win32' }, async () => fixture(async (runner, spec, _home, work) => {
  const root = path.dirname(path.dirname(execFileSync('where.exe', ['g++'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]));
  const child = execFileSync('g++', ['-print-prog-name=cc1plus'], { encoding: 'utf8' }).trim();
  const read = await runner.run({ ...spec('read', [child]), runtimePaths: [root] });
  assert.equal(read.status, 'OK', JSON.stringify(read));
  assert.equal(await fs.readFile(path.join(work, 'stdout'), 'utf8'), 'ALLOWED', 'authorized toolchain files are readable');
  const run = await runner.run({ ...spec('spawn', [child]), processLimit: 4, runtimePaths: [root] });
  assert.equal(run.status, 'OK', JSON.stringify(run) + '\n' + await fs.readFile(path.join(work, 'stdout'), 'utf8'));
}));

test('Python retains its standard library but cannot access host files', supported, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'taskweave-python-isolation-'));
  try {
    const work = path.join(home, 'work'); await fs.mkdir(work);
    const secret = path.join(home, 'secret.txt'), script = path.join(home, 'probe.py');
    await fs.writeFile(secret, 'unchanged');
    await fs.writeFile(script, `import json, os, pathlib, socket, sys\nresults=[]\nfor mode in ('r', 'w'):\n try:\n  f=open(sys.argv[1],mode); f.close(); results.append('ALLOWED')\n except OSError:\n  results.append('DENIED')\npathlib.Path('local.txt').write_text('ok')\nprint(json.dumps(results))\n`);
    const runner = new Runner(path.join(home, 'bin'));
    const result = await runner.run({ argv: [process.platform === 'win32' ? 'python' : 'python3', script, secret], readPaths: [script], cwd: work,
      stdout: path.join(work, 'stdout'), stderr: path.join(work, 'stderr'), wallLimitMs: 5000, memoryLimitBytes: 256 * 1024 * 1024 });
    assert.equal(result.status, 'OK', JSON.stringify(result) + '\n' + await fs.readFile(path.join(work, 'stderr'), 'utf8'));
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(work, 'stdout'), 'utf8')), ['DENIED', 'DENIED']);
    assert.equal(await fs.readFile(secret, 'utf8'), 'unchanged');
    assert.equal(await fs.readFile(path.join(work, 'local.txt'), 'utf8'), 'ok');
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('compiler dependencies cannot read answers, private state or files outside the problem', supported, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'taskweave-compile-isolation-'));
  try {
    const global = new GlobalStore(home); await global.init(); global.config.problems.roots = [path.join(home, 'problems')];
    const registry = new ProblemRegistry(global), judge = new Judge(global, registry, new WsHub());
    const problem = await registry.create({ name: 'includes' });
    const secret = path.join(home, 'secret.h'); await fs.writeFile(secret, 'private sentinel');
    await fs.mkdir(path.join(problem.dir, '.taskweave'), { recursive: true });
    await fs.writeFile(path.join(problem.dir, '.taskweave/secret.h'), 'private sentinel');
    for (const include of [secret.replace(/\\/g, '/'), '.taskweave/secret.h', 'tests/manual/01.in']) {
      await fs.writeFile(path.join(problem.dir, 'probe.cpp'), `#include "${include}"\nint main(){}\n`);
      const result = await judge.compile(await judge.ctx(problem.id), 'probe.cpp');
      assert.equal(result.result.ok, false);
      assert.match(result.result.log, /outside|private state|test data/);
      assert.ok(!result.result.log.includes('private sentinel'));
    }
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('Linux output links cannot make the privileged parent read a host file', { skip: process.platform !== 'linux' }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'taskweave-output-isolation-'));
  try {
    const work = path.join(home, 'work'); await fs.mkdir(work);
    const script = path.join(home, 'link.py'), secret = path.join(home, 'secret.txt');
    await fs.writeFile(secret, 'private sentinel');
    await fs.writeFile(script, "import os, sys\nos.unlink('stdout')\nos.symlink(sys.argv[1], 'stdout')\n");
    const runner = new Runner(path.join(home, 'bin'));
    await assert.rejects(runner.run({ argv: ['python3', script, secret], readPaths: [script], cwd: work,
      stdout: path.join(work, 'stdout'), stderr: path.join(work, 'stderr'), wallLimitMs: 5000 }), /links|private file/);
    assert.equal(await fs.readFile(secret, 'utf8'), 'private sentinel');
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
