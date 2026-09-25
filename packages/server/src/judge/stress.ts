import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { StressRequest, StressResult } from '@polyforge/shared';
import type { JobCtx } from '../jobs.js';
import { atomicWrite, exists, HttpError } from '../util/fs.js';
import { copyNormalized, describeRun, readHead, runChecker, runHelper, runSolution, withTmp } from './execute.js';
import type { Judge, ProblemCtx } from './index.js';
import { splitArgs } from './script.js';

/** Arguments for one iteration: `{seed}` / `{i}` are replaced, otherwise the seed is appended. */
export function stressArgs(template: string, seed: number): string[] {
  const hasSlot = /\{(seed|i)\}/.test(template);
  const filled = template.replace(/\{(seed|i)\}/g, String(seed));
  return [...splitArgs(filled), ...(hasSlot ? [] : [String(seed)])];
}

/**
 * Stress testing (对拍, DESIGN §4.2): generate random tests until a solution disagrees
 * with the reference, then keep the counterexample as a manual test.
 */
export async function runStress(judge: Judge, ctx: ProblemCtx, req: StressRequest, job: JobCtx): Promise<StressResult> {
  const maxIterations = Math.min(Math.max(req.maxIterations ?? 1000, 1), 100_000);
  const deadline = Date.now() + Math.min(Math.max(req.timeLimitSec ?? 60, 1), 3600) * 1000;
  const referenceSrc = req.reference || judge.mainSolution(ctx.config);
  if (!referenceSrc) throw new HttpError(400, 'no_reference', 'No reference solution: tag one solution MA or pick one');
  if (!ctx.config.checker) throw new HttpError(400, 'no_checker', 'No checker configured');

  const gens = await judge.generators(ctx);
  const genSrc = gens.get(req.generator) ?? req.generator;
  const [gen, reference, candidate, checker, validator, interactor] = await Promise.all([
    judge.require(ctx, genSrc, 'Generator'),
    judge.require(ctx, referenceSrc, 'Reference solution'),
    judge.require(ctx, req.solution, 'Solution'),
    judge.require(ctx, ctx.config.checker.source, 'Checker'),
    ctx.config.validator ? judge.require(ctx, ctx.config.validator.source, 'Validator') : undefined,
    ctx.config.problem.interactive && ctx.config.interactor ? judge.require(ctx, ctx.config.interactor.source, 'Interactor') : undefined,
  ]);

  const base = req.seedStart ?? 1;
  let done = 0;
  let found: StressResult['counterexample'];
  const batch = Math.max(1, Math.min(judge.runner.workers, 8));

  const iterate = (seed: number) =>
    withTmp(ctx.ref.dir, async (tmp): Promise<StressResult['counterexample'] | null> => {
      const args = stressArgs(req.args, seed);
      const genOut = path.join(tmp, 'gen.txt');
      const g = await runHelper(judge.runner, gen, args, { cwd: tmp, stdout: genOut, stderr: path.join(tmp, 'gen.err') }, job.signal);
      if (g.status !== 'OK') throw new HttpError(400, 'generator_failed', `Generator failed on "${args.join(' ')}": ${describeRun(g)} ${(await readHead(path.join(tmp, 'gen.err'), 500)).trim()}`);
      const input = path.join(tmp, 'input.txt');
      await copyNormalized(genOut, input);
      if (validator) {
        const v = await runHelper(judge.runner, validator, [], { cwd: tmp, stdin: input, stderr: path.join(tmp, 'val.err') }, job.signal);
        if (v.status !== 'OK') throw new HttpError(400, 'invalid_test', `Generator produced an invalid test ("${args.join(' ')}"): ${(await readHead(path.join(tmp, 'val.err'), 500)).trim()}`);
      }
      const refDir = path.join(tmp, 'ref');
      const solDir = path.join(tmp, 'sol');
      await fsp.mkdir(refDir);
      await fsp.mkdir(solDir);
      const ref = await runSolution(judge.runner, reference, input, ctx.limits, refDir, { interactor, signal: job.signal });
      if (ref.verdict !== 'OK') throw new HttpError(400, 'reference_failed', `Reference solution got ${ref.verdict} on "${args.join(' ')}"${ref.message ? `: ${ref.message}` : ''}`);
      const sol = await runSolution(judge.runner, candidate, input, ctx.limits, solDir, { interactor, signal: job.signal });
      let verdict = sol.verdict;
      let message = sol.message ?? '';
      if (verdict === 'OK') {
        const c = await runChecker(judge.runner, checker, { input, output: sol.outputFile, answer: ref.outputFile }, tmp, job.signal);
        verdict = c.verdict;
        message = c.message;
      }
      if (verdict === 'OK') return null;
      return {
        seed,
        args: args.join(' '),
        verdict,
        message,
        input: await fsp.readFile(input, 'utf8'),
        expected: (await readHead(ref.outputFile, 16 * 1024)).replace(/\r\n/g, '\n'),
        output: (await readHead(sol.outputFile, 16 * 1024)).replace(/\r\n/g, '\n'),
      };
    });

  let stoppedBy: StressResult['stoppedBy'] = 'iterations';
  outer: while (done < maxIterations) {
    if (job.signal.aborted) {
      stoppedBy = 'cancelled';
      break;
    }
    if (Date.now() > deadline) {
      stoppedBy = 'time';
      break;
    }
    const seeds = Array.from({ length: Math.min(batch, maxIterations - done) }, (_, k) => base + done + k);
    const results = await Promise.all(seeds.map(iterate));
    done += seeds.length;
    job.progress(done, maxIterations, `seed ${seeds[seeds.length - 1]}`);
    for (const r of results) {
      if (r) {
        found = r;
        stoppedBy = 'found';
        break outer;
      }
    }
  }

  if (found && req.saveCounterexample !== false) {
    const dir = path.join(ctx.ref.dir, 'tests', 'manual');
    await fsp.mkdir(dir, { recursive: true });
    let n = 1;
    while (await exists(path.join(dir, `stress-${String(n).padStart(2, '0')}.in`))) n++;
    const name = `stress-${String(n).padStart(2, '0')}.in`;
    await atomicWrite(path.join(dir, name), found.input);
    found.savedAs = `tests/manual/${name}`;
  }
  return { iterations: done, found: !!found, stoppedBy, counterexample: found };
}
