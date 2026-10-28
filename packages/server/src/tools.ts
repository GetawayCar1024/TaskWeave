import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolProbe } from '@taskweave/shared';

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], opts: { timeout?: number; cwd?: string } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout ?? 15_000, cwd: opts.cwd, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : -1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !stdout ? err.message : '')) });
    });
  });
}

async function which(tool: string): Promise<string | undefined> {
  const r = process.platform === 'win32' ? await run('where', [tool]) : await run('which', [tool]);
  if (r.code !== 0) return undefined;
  return r.stdout.split(/\r?\n/).find((l) => l.trim())?.trim();
}

const firstLine = (s: string) => s.split(/\r?\n/).find((l) => l.trim())?.trim();

/**
 * Probe a C++ compiler: version, then compile and run a program that includes
 * testlib.h from the shared directory, which is what every validator/checker needs.
 */
async function probeCxx(tool: string, sharedDir: string): Promise<ToolProbe> {
  const p = await which(tool);
  if (!p) return { tool, found: false };
  const v = await run(p, ['--version']);
  const probe: ToolProbe = { tool, found: true, path: p, version: firstLine(v.stdout) };
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'taskweave-probe-'));
  try {
    const src = path.join(dir, 'hello.cpp');
    const exe = path.join(dir, process.platform === 'win32' ? 'hello.exe' : 'hello');
    // testlib aborts programs that never call a register function, so register as a generator.
    await fsp.writeFile(
      src,
      '#include "testlib.h"\n#include <cstdio>\nint main(int argc, char* argv[]) { registerGen(argc, argv, 1); std::puts("hello"); }\n',
    );
    const c = await run(p, ['-std=c++17', '-O0', `-I${sharedDir}`, '-o', exe, src], { timeout: 60_000 });
    if (c.code !== 0) {
      probe.helloWorld = 'failed';
      probe.error = (c.stderr || c.stdout).slice(0, 2000);
      return probe;
    }
    const r = await run(exe, []);
    probe.helloWorld = r.code === 0 && r.stdout.trim() === 'hello' ? 'ok' : 'failed';
    if (probe.helloWorld === 'failed') probe.error = r.stderr.slice(0, 2000);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return probe;
}

async function probePython(tool: string): Promise<ToolProbe> {
  const p = await which(tool);
  if (!p) return { tool, found: false };
  const r = await run(p, ['-c', 'import sys; print(sys.version.split()[0])']);
  // On Windows the Microsoft Store alias exists on PATH but fails to run.
  if (r.code !== 0) return { tool, found: true, path: p, helloWorld: 'failed', error: firstLine(r.stderr) };
  return { tool, found: true, path: p, version: `Python ${r.stdout.trim()}`, helloWorld: 'ok' };
}

async function probeJava(tool: string): Promise<ToolProbe> {
  const p = await which(tool);
  if (!p) return { tool, found: false };
  const r = await run(p, ['-version']);
  // java/javac print their version on stderr
  return { tool, found: true, path: p, version: firstLine(r.stderr || r.stdout), helloWorld: 'skipped' };
}

/** Whether g++ accepts a language standard (C++23 needs GCC 11+). */
async function probeStd(tool: string, std: string): Promise<ToolProbe> {
  const label = `${tool} -std=${std}`;
  const p = await which(tool);
  if (!p) return { tool: label, found: false };
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'taskweave-probe-'));
  try {
    const src = path.join(dir, 'std.cpp');
    await fsp.writeFile(src, 'int main() {}\n');
    const c = await run(p, [`-std=${std}`, '-fsyntax-only', src], { timeout: 60_000 });
    return { tool: label, found: true, path: p, helloWorld: c.code === 0 ? 'ok' : 'failed', ...(c.code ? { error: firstLine(c.stderr || c.stdout) } : {}) };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Version only; `shell` for .bat/.cmd wrappers such as kotlinc on Windows. */
async function probeVersion(tool: string, args: string[], shell = false): Promise<ToolProbe> {
  const p = await which(tool);
  if (!p) return { tool, found: false };
  const r = shell && process.platform === 'win32' ? await run('cmd', ['/c', tool, ...args], { timeout: 60_000 }) : await run(p, args);
  return { tool, found: true, path: p, version: firstLine(r.stdout) || firstLine(r.stderr), helloWorld: 'skipped' };
}

export async function detectTools(sharedDir: string): Promise<ToolProbe[]> {
  return Promise.all([
    probeCxx('g++', sharedDir),
    probeStd('g++', 'c++23'),
    probeCxx('clang++', sharedDir),
    probeVersion('gcc', ['--version']),
    probePython('python'),
    probePython('python3'),
    probePython('pypy3'),
    probeJava('javac'),
    probeJava('java'),
    probeVersion('kotlinc', ['-version'], true),
    probeVersion('rustc', ['--version']),
    probeVersion('go', ['version']),
  ]);
}

/** Subdirectories of `dir` (or drive letters on Windows when `dir` is empty), for the root picker. */
export async function listDirs(dir: string): Promise<{ path: string; parent: string | null; dirs: string[] }> {
  if (!dir) {
    if (process.platform === 'win32') {
      const drives: string[] = [];
      for (let c = 65; c <= 90; c++) {
        const d = `${String.fromCharCode(c)}:\\`;
        try {
          await fsp.access(d);
          drives.push(d);
        } catch {
          /* no such drive */
        }
      }
      return { path: '', parent: null, dirs: drives };
    }
    dir = '/';
  }
  const abs = path.resolve(dir);
  const ents = await fsp.readdir(abs, { withFileTypes: true });
  const dirs = ents
    .filter((e) => e.isDirectory() && !e.name.startsWith('$') && !e.name.startsWith('.'))
    .map((e) => path.join(abs, e.name))
    .sort((a, b) => a.localeCompare(b));
  const parent = path.dirname(abs);
  return { path: abs, parent: parent === abs ? (process.platform === 'win32' ? '' : null) : parent, dirs };
}
