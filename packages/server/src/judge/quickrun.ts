import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { QuickRunRequest, QuickRunResponse } from '@polyforge/shared';
import { exists, HttpError } from '../util/fs.js';
import { readHead, runChecker, runSolution, withTmp } from './execute.js';
import type { Judge, ProblemCtx } from './index.js';
import { answerPath, inputPath } from './tests.js';

const OUTPUT_PREVIEW = 64 * 1024;

/** "Run" button in the editor: compile the current file and run it on custom input or a test. */
export async function quickRun(judge: Judge, ctx: ProblemCtx, req: QuickRunRequest): Promise<QuickRunResponse> {
  const out = await judge.compile(ctx, req.source);
  if (!out.program) return { compile: out.result, stdout: '', stderr: '' };
  const interactive = ctx.config.problem.interactive;
  const interactor = interactive && ctx.config.interactor ? await judge.require(ctx, ctx.config.interactor.source, 'Interactor') : undefined;

  return withTmp(ctx.ref.dir, async (tmp) => {
    let inFile: string;
    if (req.test !== undefined) {
      inFile = inputPath(ctx, req.test);
      if (!(await exists(inFile))) throw new HttpError(404, 'test_not_found', `Test ${req.test} has not been generated`);
    } else {
      inFile = path.join(tmp, 'input.txt');
      await fsp.writeFile(inFile, req.input ?? '');
    }
    const stderrFile = path.join(tmp, 'stderr.txt');
    const r = await runSolution(judge.runner, out.program!, inFile, ctx.limits, tmp, { interactor, stderrFile });
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
    const ans = req.test !== undefined ? answerPath(ctx, req.test) : null;
    if (r.verdict === 'OK' && ans && (await exists(ans)) && ctx.config.checker) {
      const checker = await judge.require(ctx, ctx.config.checker.source, 'Checker');
      res.checker = await runChecker(judge.runner, checker, { input: inFile, output: r.outputFile, answer: ans }, tmp);
      res.verdict = res.checker.verdict;
    }
    return res;
  });
}
