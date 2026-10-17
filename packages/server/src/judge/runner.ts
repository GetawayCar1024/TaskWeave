import { execFile, spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { RUNNER_SRC } from '../paths.js';
import type { RunStats, RunStatus } from '@polyforge/shared';
import { exists, HttpError, sha1 } from '../util/fs.js';
import { withBuildLocks, verifyBuild, type BuildIdentity } from './buildLock.js';


export interface ProcSpec {
  build?: BuildIdentity;
  /** argv; argv[0] is resolved by CreateProcess (absolute path or on PATH). */
  argv: string[];
  cwd: string;
  stdin?: string;
  stdout?: string;
  stderr?: string;
  timeLimitMs?: number;
  wallLimitMs?: number;
  memoryLimitBytes?: number;
  outputLimitBytes?: number;
  processLimit?: number;
}

/** Serialize measured runs by default to avoid competing for CPU time. */
export const defaultParallel = () => 1;

/** Counting semaphore bounding concurrent runs and compilations. */
export class Semaphore {
  private waiters: (() => void)[] = [];
  private active = 0;
  constructor(private limit: number) {}

  get size() {
    return this.limit;
  }

  /** Change the number of slots; running work finishes, waiting work follows the new size. */
  resize(n: number) {
    this.limit = Math.max(1, n);
    this.pump();
  }

  private pump() {
    while (this.active < this.limit && this.waiters.length) {
      this.active++;
      this.waiters.shift()!();
    }
  }

  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < this.limit) this.active++;
    else await new Promise<void>((r) => this.waiters.push(r));
    try {
      return await fn();
    } finally {
      this.active--;
      this.pump();
    }
  }
}

/** Quote one argument following the MSVC CommandLineToArgvW rules. */
export function quoteArg(a: string): string {
  if (a !== '' && !/[\s"]/.test(a)) return a;
  let out = '"';
  let backslashes = 0;
  for (const ch of a) {
    if (ch === '\\') {
      backslashes++;
    } else if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      out += '\\'.repeat(backslashes) + ch;
      backslashes = 0;
    }
  }
  return out + '\\'.repeat(backslashes * 2) + '"';
}

function specText(p: ProcSpec): string {
  const lines = [`cmd=${p.argv.map(quoteArg).join(' ')}`, `cwd=${p.cwd}`];
  if (p.stdin) lines.push(`stdin=${p.stdin}`);
  if (p.stdout) lines.push(`stdout=${p.stdout}`);
  if (p.stderr) lines.push(`stderr=${p.stderr}`);
  lines.push(`time_limit=${Math.round(p.timeLimitMs ?? 0)}`);
  lines.push(`wall_limit=${Math.round(p.wallLimitMs ?? 0)}`);
  lines.push(`memory_limit=${Math.round(p.memoryLimitBytes ?? 0)}`);
  lines.push(`output_limit=${Math.round(p.outputLimitBytes ?? 0)}`);
  lines.push(`process_limit=${p.processLimit ?? 1}`);
  for (const l of lines) if (l.includes('\n')) throw new HttpError(400, 'bad_spec', 'Newline in run spec');
  return lines.join('\n');
}

interface RawResult {
  status: RunStatus;
  exit_code: number;
  time_ms: number;
  wall_ms: number;
  memory_kb: number;
  idle: boolean;
  error: string;
}

const toStats = (r: RawResult): RunStats => ({
  status: r.status,
  exitCode: r.exit_code,
  timeMs: r.time_ms,
  wallMs: r.wall_ms,
  memoryKb: r.memory_kb,
  idle: r.idle,
  error: r.error || undefined,
});

export class Runner {
  private exe: string | null = null;
  private building: Promise<string> | null = null;
  readonly pool: Semaphore;
  /** Share slots so compilation cannot contend with measured runs in serial mode. */
  readonly compilePool: Semaphore;

  constructor(private binDir: string) {
    this.pool = new Semaphore(defaultParallel());
    this.compilePool = this.pool;
  }

  get workers() {
    return this.pool.size;
  }

  /** Apply the judge.parallel setting (0 = default). */
  setParallel(n: number) {
    const runs = n > 0 ? n : defaultParallel();
    this.pool.resize(runs);

  }

  /** Compile the runner with the local g++ on first use; cached by source hash. */
  async ensure(): Promise<string> {
    if (this.exe) return this.exe;
    if (process.platform !== 'win32') {
      throw new HttpError(501, 'unsupported_platform', 'The runner currently supports Windows only');
    }
    this.building ??= this.build().finally(() => (this.building = null));
    this.exe = await this.building;
    return this.exe;
  }

  private async build(): Promise<string> {
    const src = await fsp.readFile(RUNNER_SRC);
    const exe = path.join(this.binDir, `runner-${sha1(src).slice(0, 12)}.exe`);
    if (!(await exists(exe))) {
      await fsp.mkdir(this.binDir, { recursive: true });
      const tmp = `${exe}.tmp.exe`;
      await new Promise<void>((resolve, reject) => {
        execFile('g++', ['-O2', '-static', '-std=c++17', '-o', tmp, RUNNER_SRC], { timeout: 120_000, windowsHide: true }, (err, _o, stderr) =>
          err ? reject(new HttpError(500, 'runner_build_failed', `Failed to build runner with g++: ${stderr || err.message}`)) : resolve(),
        );
      });
      await fsp.rename(tmp, exe);
      // Drop runners built from older sources.
      for (const f of await fsp.readdir(this.binDir)) {
        if (/^runner-[0-9a-f]+\.exe$/.test(f) && f !== path.basename(exe)) await fsp.rm(path.join(this.binDir, f), { force: true }).catch(() => {});
      }
    }
    return exe;
  }

  private exec(exe: string, args: string[], input: string, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(exe, args, { windowsHide: true, signal });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`runner exited ${code}: ${err || out}`))));
      child.stdin.end(input);
    });
  }

  /** Run one program. Holds a worker slot for the duration. */
  async run(spec: ProcSpec, signal?: AbortSignal): Promise<RunStats> {
    const exe = await this.ensure();
    return withBuildLocks(spec.build ? [spec.build.dir] : [], () => this.pool.use(async () => {
      signal?.throwIfAborted();
      await verifyBuild(spec.build);
      const out = await this.exec(exe, [], specText(spec), signal);
      return toStats(JSON.parse(out) as RawResult);
    }), 'read');
  }

  async runInteractive(sol: ProcSpec, inter: ProcSpec, signal?: AbortSignal): Promise<{ solution: RunStats; interactor: RunStats }> {
    const exe = await this.ensure();
    return withBuildLocks([sol.build?.dir, inter.build?.dir].filter((x): x is string => !!x), () => this.pool.use(async () => {
      signal?.throwIfAborted();
      await verifyBuild(sol.build); await verifyBuild(inter.build);
      const out = await this.exec(exe, [], specText(sol) + '\n[interactor]\n' + specText(inter), signal);
      const r = JSON.parse(out) as { solution: RawResult; interactor: RawResult };
      return { solution: toStats(r.solution), interactor: toStats(r.interactor) };
    }), 'read');
  }
}
