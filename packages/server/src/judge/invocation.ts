import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { checkTag, type Invocation, type InvocationCell, type InvocationSummary } from '@polyforge/shared';
import type { JobCtx } from '../jobs.js';
import { atomicWrite, exists, HttpError } from '../util/fs.js';
import type { Program } from './compiler.js';
import { runChecker, runSolution, withTmp } from './execute.js';
import type { Judge, ProblemCtx } from './index.js';
import { answerPath, generateTests, inputPath } from './tests.js';

const MAX_SAVED_OUTPUT = 16 * 1024 * 1024;

export const runsDir = (ctx: ProblemCtx) => path.join(ctx.work, 'runs');
const invPath = (ctx: ProblemCtx, id: string) => path.join(runsDir(ctx), `${id}.json`);
export const outputPath = (ctx: ProblemCtx, id: string, sol: number, test: number) =>
  path.join(runsDir(ctx), id, String(sol), `${test}.out`);

function newId(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

export async function readInvocation(ctx: ProblemCtx, id: string): Promise<Invocation> {
  if (!/^[\w-]+$/.test(id)) throw new HttpError(400, 'bad_id', 'Invalid invocation id');
  try {
    return JSON.parse(await fsp.readFile(invPath(ctx, id), 'utf8')) as Invocation;
  } catch {
    throw new HttpError(404, 'invocation_not_found', `Invocation not found: ${id}`);
  }
}

export async function listInvocations(ctx: ProblemCtx): Promise<InvocationSummary[]> {
  const names = (await fsp.readdir(runsDir(ctx)).catch(() => [] as string[])).filter((n) => n.endsWith('.json')).sort().reverse();
  const out: InvocationSummary[] = [];
  for (const n of names.slice(0, 50)) {
    try {
      const inv = JSON.parse(await fsp.readFile(path.join(runsDir(ctx), n), 'utf8')) as Invocation;
      out.push({
        id: inv.id,
        createdAt: inv.createdAt,
        status: inv.status,
        solutions: inv.solutions.length,
        tests: inv.tests.length,
        ok: inv.solutions.every((s) => s.expectation?.ok !== false && s.compile?.ok !== false),
      });
    } catch {
      /* skip corrupt */
    }
  }
  return out;
}

/**
 * Run solutions × tests. Tests are (re)generated first — cheap when cached. The
 * invocation file is rewritten as cells complete so clients can show live progress.
 */
export async function runInvocation(
  judge: Judge,
  ctx: ProblemCtx,
  sources: string[],
  onlyTests: number[] | undefined,
  job: JobCtx,
  onStart: (id: string) => void,
): Promise<string> {
  if (sources.length === 0) throw new HttpError(400, 'no_solutions', 'Select at least one solution');
  const id = newId();
  const inv: Invocation = {
    id,
    createdAt: new Date().toISOString(),
    status: 'running',
    timeLimit: ctx.limits.timeLimitMs,
    memoryLimit: ctx.limits.memoryLimitMb,
    tests: [],
    solutions: sources.map((source) => ({ source, tag: ctx.config.solutions.find((s) => s.source === source)?.tag })),
    cells: [],
  };
  await fsp.mkdir(runsDir(ctx), { recursive: true });
  let saving: Promise<void> = Promise.resolve();
  let dirty = false;
  const save = () => {
    dirty = false;
    saving = saving.then(() => atomicWrite(invPath(ctx, id), JSON.stringify(inv)));
    return saving;
  };
  await save();
  onStart(id);
  const timer = setInterval(() => dirty && save(), 300);

  try {
    job.progress(0, 0, 'generating tests');
    const manifest = await generateTests(judge, ctx, { signal: job.signal, progress: (d, t) => job.progress(0, 0, `generating tests ${d}/${t}`) });
    const wanted = onlyTests ? new Set(onlyTests) : null;
    const tests = manifest.tests.filter((t) => !wanted || wanted.has(t.index));
    inv.tests = tests.map((t) => t.index);
    inv.cells = sources.map(() => tests.map(() => null));

    const checkerSrc = ctx.config.checker?.source;
    if (!checkerSrc) throw new HttpError(400, 'no_checker', 'No checker configured');
    const [checker, interactor] = await Promise.all([
      judge.require(ctx, checkerSrc, 'Checker'),
      ctx.config.problem.interactive && ctx.config.interactor ? judge.require(ctx, ctx.config.interactor.source, 'Interactor') : undefined,
    ]);
    if (ctx.config.problem.interactive && !interactor) throw new HttpError(400, 'no_interactor', 'Interactive problem without an interactor');

    const programs: (Program | undefined)[] = await Promise.all(
      sources.map(async (src, i) => {
        const out = await judge.compile(ctx, src);
        inv.solutions[i].compile = out.result;
        return out.program;
      }),
    );
    dirty = true;

    const total = programs.filter(Boolean).length * tests.length;
    let done = 0;
    job.progress(0, total, 'running');

    const tasks: Promise<void>[] = [];
    tests.forEach((t, ti) => {
      programs.forEach((prog, si) => {
        const setCell = (c: InvocationCell) => {
          inv.cells[si][ti] = c;
          dirty = true;
        };
        if (!prog) return setCell({ verdict: 'SKIP', timeMs: 0, memoryKb: 0, message: 'compilation error' });
        tasks.push(
          (async () => {
            const inFile = inputPath(ctx, t.index);
            const ansFile = answerPath(ctx, t.index);
            if (t.error || t.valid === false || !(await exists(inFile)) || !(await exists(ansFile))) {
              setCell({ verdict: 'SKIP', timeMs: 0, memoryKb: 0, message: t.error ?? (t.valid === false ? 'invalid test' : 'no answer') });
              return;
            }
            await withTmp(ctx.ref.dir, async (tmp) => {
              const r = await runSolution(judge.runner, prog, inFile, ctx.limits, tmp, { interactor, signal: job.signal });
              const cell: InvocationCell = {
                verdict: r.verdict,
                timeMs: r.run.timeMs,
                memoryKb: r.run.memoryKb,
                exitCode: r.run.exitCode,
                message: r.message,
              };
              if (r.verdict === 'OK') {
                const c = await runChecker(judge.runner, checker, { input: inFile, output: r.outputFile, answer: ansFile }, tmp, job.signal);
                cell.verdict = c.verdict;
                cell.message = c.message;
                cell.points = c.points;
              }
              const st = await fsp.stat(r.outputFile).catch(() => null);
              if (st && st.size <= MAX_SAVED_OUTPUT) {
                const dest = outputPath(ctx, id, si, t.index);
                await fsp.mkdir(path.dirname(dest), { recursive: true });
                await fsp.copyFile(r.outputFile, dest);
                cell.hasOutput = true;
              }
              setCell(cell);
            });
            job.progress(++done, total, 'running');
          })(),
        );
      });
    });
    const settled = await Promise.allSettled(tasks);
    job.signal.throwIfAborted();
    const failed = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult | undefined;
    if (failed) throw failed.reason;
    inv.status = 'done';
  } catch (e) {
    inv.status = job.signal.aborted ? 'cancelled' : 'failed';
    if (!job.signal.aborted) inv.error = (e as Error).message;
    throw e;
  } finally {
    clearInterval(timer);
    inv.solutions.forEach((s, i) => {
      const cells = inv.cells[i] ?? [];
      if (s.compile?.ok !== false) s.expectation = checkTag(s.tag, cells, inv.timeLimit);
      const ran = cells.filter((c): c is InvocationCell => !!c && c.verdict !== 'SKIP');
      s.maxTimeMs = ran.length ? Math.max(...ran.map((c) => c.timeMs)) : undefined;
      s.maxMemoryKb = ran.length ? Math.max(...ran.map((c) => c.memoryKb)) : undefined;
    });
    await save();
  }
  return id;
}
