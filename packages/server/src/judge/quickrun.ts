import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { testsetOf, testsetsOf, testLimitLookup, type QuickRunRequest, type QuickRunResponse } from '@polyforge/shared';
import { exists, HttpError } from '../util/fs.js';
import { readHead, runChecker, runHelper, runSolution, withTmp } from './execute.js';
import type { Judge, ProblemCtx } from './index.js';
import { answerPath, inputPath } from './tests.js';

const OUTPUT_PREVIEW = 64 * 1024;

/** "Run" button in the editor: compile the current file and run it on custom input or a test. */
export async function quickRun(judge: Judge, ctx: ProblemCtx, req: QuickRunRequest, options: { experiment?: boolean } = {}): Promise<QuickRunResponse> {
  // Only solutions are linked with the grader; generators, validators, checkers… never.
  const c = ctx.config;
  const helper = req.source.startsWith('generators/') || [c.checker, c.lemon_checker, c.validator, c.interactor, ...c.generators].some((e) => e?.source === req.source)
    || testsetsOf(c).some((ts) => ts.group.some((g) => g.validator === req.source));
  const out = await judge.compile(ctx, req.source, !options.experiment && !helper);
  if (!out.program) return { compile: out.result, stdout: '', stderr: '' };
  const interactive = !options.experiment && !helper && ctx.config.problem.interactive;
  const interactor = interactive && ctx.config.interactor ? await judge.require(ctx, ctx.config.interactor.source, 'Interactor') : undefined;

  return withTmp(ctx.ref.dir, async (tmp) => {
    let inFile: string;
    if (req.test !== undefined) {
      inFile = inputPath(ctx, req.test, req.testset);
      if (!(await exists(inFile))) throw new HttpError(404, 'test_not_found', `Test ${req.test} has not been generated`);
    } else {
      inFile = path.join(tmp, 'input.txt');
      await fsp.writeFile(inFile, req.input ?? '');
      if (!options.experiment && ctx.config.validator) {
        const validator = await judge.require(ctx, ctx.config.validator.source, 'Validator');
        const err = path.join(tmp, 'validator.err');
        const v = await runHelper(judge.runner, validator, ['--testset', req.testset ?? 'tests'], { cwd: tmp, stdin: inFile, stderr: err });
        if (v.status !== 'OK' || v.exitCode !== 0) throw new HttpError(400, 'invalid_test', `Invalid custom input: ${await readHead(err)}`);
      }
    }
    const stderrFile = path.join(tmp, 'stderr.txt');
    const effective = req.test !== undefined ? testLimitLookup(c, testsetOf(c, req.testset) ?? testsetsOf(c)[0])(req.test) : null;
    const limits = { ...ctx.limits, timeLimitMs: effective?.timeLimit ?? ctx.limits.timeLimitMs, memoryLimitMb: effective?.memoryLimit ?? ctx.limits.memoryLimitMb };
    const r = await runSolution(judge.runner, out.program!, inFile, limits, tmp, { interactor, stderrFile });
    const size = (await fsp.stat(r.outputFile).catch(() => null))?.size ?? 0;
    const res: QuickRunResponse = {
      compile: out.result,
      run: r.run,
      verdict: r.verdict,
      // Text-mode stdout on Windows writes CRLF; show plain lines.
      stdout: (await readHead(r.outputFile, OUTPUT_PREVIEW)).replace(/\r\n/g, '\n'),
      stdoutTruncated: size > OUTPUT_PREVIEW || undefined,
      stderr: (await readHead(stderrFile, OUTPUT_PREVIEW)).replace(/\r\n/g, '\n'),
    };
    if (r.message && r.verdict !== 'OK') res.checker = { verdict: r.verdict, message: r.message };
    let ans = req.test !== undefined ? answerPath(ctx, req.test, req.testset) : null;
    if (!options.experiment && req.test === undefined && !interactive && r.verdict === 'OK' && ctx.config.checker) {
      const main = judge.mainSolution(ctx.config);
      if (main) {
        const reference = await judge.require(ctx, main, 'Main solution');
        const refDir = path.join(tmp, 'reference');
        await fsp.mkdir(refDir);
        const expected = await runSolution(judge.runner, reference, inFile, ctx.limits, refDir);
        if (expected.verdict !== 'OK') throw new HttpError(400, 'reference_failed', `Main solution got ${expected.verdict}`);
        ans = expected.outputFile;
      }
    }
    if (r.verdict === 'OK' && ans && (await exists(ans)) && ctx.config.checker) {
      const checker = await judge.require(ctx, ctx.config.checker.source, 'Checker');
      res.checker = await runChecker(judge.runner, checker, { input: inFile, output: r.outputFile, answer: ans }, tmp);
      res.verdict = res.checker.verdict;
    }
    return res;
  });
}
