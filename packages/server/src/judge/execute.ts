import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { CheckerOutcome, RunStats, Verdict } from '@polyforge/shared';
import type { Program } from './compiler.js';
import type { Runner } from './runner.js';

const MB = 1024 * 1024;

/** Limits for trusted helper programs (generators, validators, checkers, interactors). */
export const HELPER_LIMITS = { timeLimitMs: 30_000, wallLimitMs: 60_000, memoryLimitBytes: 1024 * MB, outputLimitBytes: 1024 * MB };

export interface ProblemLimits {
  timeLimitMs: number;
  memoryLimitMb: number;
  /** "stdin" or a file name the solution reads. */
  input: string;
  /** "stdout" or a file name the solution writes. */
  output: string;
}

export async function readHead(file: string, bytes = 4096): Promise<string> {
  try {
    const fh = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const { bytesRead } = await fh.read(buf, 0, bytes, 0);
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return '';
  }
}

/**
 * Copy `src` to `dest` converting CRLF to LF. Tests are stored with LF (as on Polygon);
 * programs writing through a text-mode stdout on Windows emit CRLF.
 */
export async function copyNormalized(src: string, dest: string): Promise<void> {
  const buf = await fsp.readFile(src);
  if (buf.indexOf(0x0d) < 0) return fsp.writeFile(dest, buf);
  const out = Buffer.allocUnsafe(buf.length);
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) continue;
    out[n++] = buf[i];
  }
  await fsp.writeFile(dest, out.subarray(0, n));
}

/** Per-run scratch directory inside the problem's .polyforge (avoids non-ASCII temp paths). */
export async function withTmp<T>(problemDir: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = path.join(problemDir, '.polyforge', 'tmp', randomBytes(6).toString('hex'));
  await fsp.mkdir(dir, { recursive: true });
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export function describeRun(r: RunStats): string {
  if (r.status === 'IE') return r.error ?? 'failed to start';
  if (r.status === 'TL') return r.idle ? 'idleness limit exceeded' : `time limit exceeded (${r.timeMs} ms)`;
  if (r.status === 'ML') return `memory limit exceeded (${Math.round(r.memoryKb / 1024)} MB)`;
  if (r.status === 'OL') return 'output limit exceeded';
  if (r.status === 'RE') return `exit code ${exitCodeName(r.exitCode)}`;
  return 'ok';
}

const NT_STATUS: Record<number, string> = {
  0xc0000005: 'ACCESS_VIOLATION',
  0xc00000fd: 'STACK_OVERFLOW',
  0xc0000094: 'INTEGER_DIVIDE_BY_ZERO',
  0xc0000409: 'STACK_BUFFER_OVERRUN',
  0xc0000374: 'HEAP_CORRUPTION',
  0xc000001d: 'ILLEGAL_INSTRUCTION',
  0xc0000135: 'DLL_NOT_FOUND',
  0xc0000139: 'ENTRYPOINT_NOT_FOUND',
  0xc0000142: 'DLL_INIT_FAILED',
};

export function exitCodeName(code: number): string {
  const name = NT_STATUS[code >>> 0];
  return name ? `0x${(code >>> 0).toString(16)} (${name})` : String(code);
}

/** Run a helper program (generator/validator) with stdin → stdout files. */
export function runHelper(
  runner: Runner,
  prog: Program,
  args: string[],
  io: { cwd: string; stdin?: string; stdout?: string; stderr?: string },
  signal?: AbortSignal,
): Promise<RunStats> {
  return runner.run({ build: prog.build, argv: [...prog.argv, ...args], ...io, ...HELPER_LIMITS }, signal);
}

/** testlib exit codes → verdict. */
export function checkerVerdict(exitCode: number): Verdict {
  if (exitCode === 0) return 'OK';
  if (exitCode === 1) return 'WA';
  if (exitCode === 2) return 'PE';
  if (exitCode === 3) return 'FAIL';
  if (exitCode === 4) return 'WA'; // _dirt
  if (exitCode === 7) return 'OK'; // _points
  if (exitCode === 8) return 'WA'; // unexpected eof
  if (exitCode >= 16 && exitCode < 16 + 200) return 'WA'; // _partially
  return 'FAIL';
}

export async function runChecker(
  runner: Runner,
  checker: Program,
  files: { input: string; output: string; answer: string },
  cwd: string,
  signal?: AbortSignal,
): Promise<CheckerOutcome> {
  const stderr = path.join(cwd, `checker-${randomBytes(3).toString('hex')}.txt`);
  const r = await runner.run(
    { build: checker.build, argv: [...checker.argv, files.input, files.output, files.answer], cwd, stderr, ...HELPER_LIMITS },
    signal,
  );
  const message = (await readHead(stderr, 2000)).trim();
  if (r.status !== 'OK' && r.status !== 'RE') return { verdict: 'FAIL', message: `checker: ${describeRun(r)}` };
  const verdict = checkerVerdict(r.exitCode);
  const outcome: CheckerOutcome = { verdict, message: message || (verdict === 'FAIL' ? `checker exit code ${r.exitCode}` : '') };
  const points = message.match(/^points\s+([\d.]+)/i);
  if (points) outcome.points = Number(points[1]);
  return outcome;
}

export interface SolutionRun {
  run: RunStats;
  /** Verdict from resource usage and the interactor alone (before the checker). */
  verdict: Verdict;
  message?: string;
  /** Where the output ended up (for checker / saving). */
  outputFile: string;
}

/**
 * Run a solution on one input under the problem's limits. For interactive problems
 * `outputFile` is the interactor's output (what the checker and answer use).
 */
export async function runSolution(
  runner: Runner,
  sol: Program,
  inputFile: string,
  limits: ProblemLimits,
  dir: string,
  opts: { interactor?: Program; signal?: AbortSignal; stderrFile?: string } = {},
): Promise<SolutionRun> {
  const spec = {
    argv: sol.argv,
    build: sol.build,
    cwd: dir,
    stderr: opts.stderrFile ?? path.join(dir, 'stderr.txt'),
    timeLimitMs: limits.timeLimitMs,
    wallLimitMs: limits.timeLimitMs * 3,
    memoryLimitBytes: limits.memoryLimitMb * MB,
    outputLimitBytes: 256 * MB,
  };

  if (opts.interactor) {
    const tout = path.join(dir, 'tout.txt');
    const { solution, interactor } = await runner.runInteractive(
      spec,
      {
        argv: [...opts.interactor.argv, inputFile, tout],
        build: opts.interactor.build,
        cwd: dir,
        stderr: path.join(dir, 'interactor-stderr.txt'),
        timeLimitMs: HELPER_LIMITS.timeLimitMs,
        wallLimitMs: spec.wallLimitMs + 1000,
        memoryLimitBytes: HELPER_LIMITS.memoryLimitBytes,
      },
      opts.signal,
    );
    const imsg = (await readHead(path.join(dir, 'interactor-stderr.txt'), 2000)).trim();
    // Resource verdicts of the solution win; then the interactor's opinion; then a crash.
    if (solution.status === 'TL' || solution.status === 'ML' || solution.status === 'IE') {
      return { run: solution, verdict: solution.status, message: describeRun(solution), outputFile: tout };
    }
    if (interactor.status !== 'OK' && interactor.status !== 'RE') {
      return { run: solution, verdict: 'FAIL', message: `interactor: ${describeRun(interactor)}`, outputFile: tout };
    }
    const iv = checkerVerdict(interactor.exitCode);
    if (iv !== 'OK') return { run: solution, verdict: iv, message: imsg, outputFile: tout };
    if (solution.status !== 'OK') return { run: solution, verdict: solution.status, message: describeRun(solution), outputFile: tout };
    return { run: solution, verdict: 'OK', message: imsg, outputFile: tout };
  }

  let stdin: string | undefined = inputFile;
  if (limits.input !== 'stdin') {
    await fsp.copyFile(inputFile, path.join(dir, limits.input));
    stdin = undefined;
  }
  const toStdout = limits.output === 'stdout';
  const outputFile = toStdout ? path.join(dir, 'stdout.txt') : path.join(dir, limits.output);
  const run = await runner.run({ ...spec, stdin, stdout: toStdout ? outputFile : undefined }, opts.signal);
  if (!toStdout && run.status === 'OK' && !(await fsp.stat(outputFile).catch(() => null))) {
    await fsp.writeFile(outputFile, '');
  }
  const verdict: Verdict = run.status === 'OK' ? 'OK' : run.status;
  return { run, verdict, message: run.status === 'OK' ? undefined : describeRun(run), outputFile };
}
