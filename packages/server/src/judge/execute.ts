import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { CheckerOutcome, CheckerScoring, RunStats, Verdict } from '@taskweave/shared';
import type { Program } from './compiler.js';
import type { ProcSpec, Runner } from './runner.js';
import { confinedPath, safeJoin, validateFileName } from '../util/fs.js';

const MB = 1024 * 1024;

/** Limits for trusted helper programs (generators, validators, checkers, interactors). */
export const HELPER_LIMITS = { timeLimitMs: 30_000, wallLimitMs: 60_000, memoryLimitBytes: 1024 * MB, outputLimitBytes: 1024 * MB };

export const programSpec = (program: Program): Pick<ProcSpec, 'argv' | 'build' | 'readPaths'> => ({ argv: program.argv, build: program.build, readPaths: program.readPaths });

/** Never let a program trick the privileged parent into following an output link. */
export async function regularOutput(file: string, root?: string): Promise<boolean> {
  if (root) try { await confinedPath(root, path.relative(root, file)); } catch { return false; }
  const stat = await fsp.lstat(file).catch(() => null);
  return !!stat?.isFile() && stat.nlink === 1;
}

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
  if (!await regularOutput(src)) throw new Error('Refusing to copy a non-regular or linked program output');
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

/** Per-run scratch directory inside the problem's .taskweave (avoids non-ASCII temp paths). */
export async function withTmp<T>(problemDir: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = path.join(problemDir, '.taskweave', 'tmp', randomBytes(6).toString('hex'));
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
  io: { cwd: string; stdin?: string; stdout?: string; stderr?: string; readPaths?: string[]; writePaths?: string[] },
  signal?: AbortSignal,
): Promise<RunStats> {
  return runner.run({ ...programSpec(prog), ...io, argv: [...prog.argv, ...args], readPaths: [...(prog.readPaths ?? []), ...(io.readPaths ?? [])], ...HELPER_LIMITS }, signal);
}

/** testlib exit codes → verdict. */
export function checkerVerdict(exitCode: number): Verdict {
  if (exitCode === 0) return 'OK';
  if (exitCode === 1) return 'WA';
  if (exitCode === 2) return 'PE';
  if (exitCode === 3) return 'FAIL';
  if (exitCode === 4) return 'WA'; // _dirt
  if (exitCode === 7) return 'FAIL'; // _points needs its numeric report, not just an exit code.
  if (exitCode === 8) return 'WA'; // unexpected eof
  return 'FAIL';
}

/** Testlib's stderr protocol disambiguates _pc exits (which overlap other codes). */
export function checkerOutcome(exitCode: number, message: string, scoring: CheckerScoring = 'fraction', maximum = 100): CheckerOutcome {
  const partial = /^partially correct \((\d+)\)(?:\s|$)/i.exec(message);
  const points = /^points\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(?=\s|$)/i.exec(message);
  if (partial || points) {
    const value = Number((partial ?? points)![1]);
    if (!Number.isFinite(value) || value < 0) return { verdict: 'FAIL', message: 'Checker returned invalid points' };
    if (!partial && scoring === 'points') return { verdict: value >= maximum && value > 0 ? 'OK' : value > 0 ? 'PC' : 'WA', message, points: value };
    const fraction = scoring === 'hydro' ? value > 1 ? value / 100 : value : partial || scoring === 'percent' ? value / 100 : value;
    if (fraction > 1) return { verdict: 'FAIL', message: 'Checker fraction is outside 0..1; select the correct checker scoring unit' };
    return { verdict: partial && scoring === 'hydro' && fraction > 0 ? 'PC' : fraction === 1 ? 'OK' : fraction === 0 ? 'WA' : 'PC', message, fraction };
  }
  if (exitCode === 7 || /^points\b/i.test(message)) return { verdict: 'FAIL', message: 'Unsupported checker points report (quitpi needs an explicit scoring implementation)' };
  const verdict = checkerVerdict(exitCode);
  return { verdict, message: message || (verdict === 'FAIL' ? `checker exit code ${exitCode}` : '') };
}

export async function runChecker(
  runner: Runner,
  checker: Program,
  files: { input: string; output: string; answer: string },
  cwd: string,
  signal?: AbortSignal,
  maximum = 100,
): Promise<CheckerOutcome> {
  const stderr = path.join(cwd, `checker-${randomBytes(3).toString('hex')}.txt`);
  const r = await runner.run(
    { ...programSpec(checker), argv: [...checker.argv, files.input, files.output, files.answer],
      readPaths: [...(checker.readPaths ?? []), files.input, files.output, files.answer], cwd, stderr, ...HELPER_LIMITS },
    signal,
  );
  const message = (await readHead(stderr, 2000)).trim();
  if (r.status !== 'OK' && r.status !== 'RE') return { verdict: 'FAIL', message: `checker: ${describeRun(r)}` };
  if (checker.checkerProtocol === 'lemon-native' && r.exitCode === 4) return { verdict: 'OL', message };
  return checkerOutcome(r.exitCode, message, checker.checkerScoring, maximum);
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
  // Sibling workspaces keep interactor verdicts and reference data out of reach.
  const work = await fsp.mkdtemp(path.join(dir, 'solution-'));
  const spec = {
    ...programSpec(sol),
    cwd: work,
    stderr: opts.stderrFile ?? path.join(dir, 'stderr.txt'),
    timeLimitMs: limits.timeLimitMs,
    wallLimitMs: limits.timeLimitMs * 3,
    memoryLimitBytes: limits.memoryLimitMb * MB,
    outputLimitBytes: 256 * MB,
  };

  if (opts.interactor) {
    const interDir = await fsp.mkdtemp(path.join(dir, 'interactor-'));
    let tout = path.join(interDir, 'tout.txt');
    const { solution, interactor } = await runner.runInteractive(
      spec,
      {
        ...programSpec(opts.interactor),
        argv: [...opts.interactor.argv, inputFile, tout],
        readPaths: [...(opts.interactor.readPaths ?? []), inputFile],
        cwd: interDir,
        stderr: path.join(dir, 'interactor-stderr.txt'),
        timeLimitMs: HELPER_LIMITS.timeLimitMs,
        wallLimitMs: spec.wallLimitMs + 1000,
        memoryLimitBytes: HELPER_LIMITS.memoryLimitBytes,
      },
      opts.signal,
    );
    const validOutput = await regularOutput(tout, interDir);
    if (!validOutput) { tout = path.join(dir, `invalid-output-${randomBytes(6).toString('hex')}`); await fsp.writeFile(tout, ''); }
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
    if (!validOutput) return { run: solution, verdict: 'IE', message: 'Interactor output is not a regular private file', outputFile: tout };
    return { run: solution, verdict: 'OK', message: imsg, outputFile: tout };
  }

  let stdin: string | undefined = inputFile;
  if (limits.input !== 'stdin') {
    validateFileName(limits.input);
    const input = safeJoin(work, limits.input);
    await fsp.mkdir(path.dirname(input), { recursive: true });
    await fsp.copyFile(inputFile, input);
    stdin = undefined;
  }
  const toStdout = limits.output === 'stdout';
  if (!toStdout) validateFileName(limits.output);
  const outputFile = toStdout ? path.join(work, 'stdout.txt') : safeJoin(work, limits.output);
  const run = await runner.run({ ...spec, stdin, stdout: toStdout ? outputFile : undefined }, opts.signal);
  if (!toStdout && run.status === 'OK' && !(await fsp.stat(outputFile).catch(() => null))) {
    await fsp.writeFile(outputFile, '');
  }
  if (!await regularOutput(outputFile, work)) {
    const safeOutput = path.join(dir, `invalid-output-${randomBytes(6).toString('hex')}`);
    await fsp.writeFile(safeOutput, '');
    return { run, verdict: run.status === 'OK' ? 'IE' : run.status, message: 'Output is not a regular private file', outputFile: safeOutput };
  }
  const verdict: Verdict = run.status === 'OK' ? 'OK' : run.status;
  return { run, verdict, message: run.status === 'OK' ? undefined : describeRun(run), outputFile };
}
