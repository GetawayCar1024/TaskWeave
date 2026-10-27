import { promises as fs } from 'node:fs';
import path from 'node:path';
import { judgeMode, testLimitLookup, type AnswerOperationResult, type RegenerateAnswersRequest } from '@polyforge/shared';
import type { JobCtx } from '../jobs.js';
import { exists, HttpError, safeJoin } from '../util/fs.js';
import { ensureOriginalAnswers, originalReplacements, recoverAnswerTransaction, replaceAnswerFiles } from '../workspace/answerBackups.js';
import { runSolution, withTmp } from './execute.js';
import type { Judge, ProblemCtx } from './index.js';
import type { Program } from './compiler.js';
import { planTests, requireTestset } from './tests.js';

const fingerprint = async (file: string) => {
  const stat = await fs.stat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  return stat ? `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}` : null;
};
async function inputPairs(ctx: ProblemCtx, testset: string) {
  const ts = requireTestset(ctx, testset);
  if (!ctx.config.problem.data_only && ts.answers !== 'provided') throw new HttpError(400, 'provided_answers', 'Choose provided answers before regenerating existing data.');
  const errors: string[] = [], planned = await planTests(ctx, errors, testset);
  if (errors.length) throw new HttpError(400, 'invalid_tests', errors.join('\n'));
  if (!planned.length || planned.some(test => !test.manualPath)) throw new HttpError(400, 'invalid_tests', 'Existing input files are required to regenerate answers.');
  return Promise.all(planned.map(async test => {
    const stem = test.source.replace(/\.in$/i, '');
    const output = await exists(safeJoin(ctx.ref.dir, stem + '.ans')) ? stem + '.ans' : await exists(safeJoin(ctx.ref.dir, stem + '.out')) ? stem + '.out' : stem + '.ans';
    return { index: test.index, input: test.source, output,
      inputStamp: await fingerprint(test.manualPath!), outputStamp: await fingerprint(safeJoin(ctx.ref.dir, output)) };
  }));
}

export async function regenerateAnswers(judge: Judge, initial: ProblemCtx, request: RegenerateAnswersRequest, job: JobCtx): Promise<AnswerOperationResult> {
  job.signal.throwIfAborted();
  if (!request.source || !initial.config.solutions.some(solution => solution.source === request.source)) throw new HttpError(400, 'no_solution', 'Choose a registered solution to regenerate outputs.');
  const testset = request.testset ?? 'tests';
  await recoverAnswerTransaction(initial.ref.dir);
  const pairs = await inputPairs(initial, testset);
  await ensureOriginalAnswers(initial.ref.dir, requireTestset(initial, testset), pairs);
  const ctx = await judge.ctx(initial.ref.id), ts = requireTestset(ctx, testset);
  if (ts.manual !== requireTestset(initial, testset).manual) throw new HttpError(409, 'conflict', 'The testset changed while preparing outputs.');
  const configFile = path.join(ctx.ref.dir, 'problem.toml'), configText = await fs.readFile(configFile, 'utf8');
  const mode = judgeMode(ctx.config.problem);
  job.progress(0, pairs.length, 'compiling output solution');
  const compiled = await judge.compiler.compile(ctx.ref.dir, request.source, judge.langOf(ctx.config, request.source), ctx.buildRoot, mode === 'grader' ? ctx.config.grader : undefined);
  judge.hub.broadcast({ type: 'build:done', problemId: ctx.ref.id, result: compiled.result });
  if (!compiled.program) throw new HttpError(400, 'answer_solution', compiled.result.log);
  let interactor: Program | undefined;
  if (mode === 'io') {
    if (!ctx.config.interactor) throw new HttpError(400, 'no_interactor', 'An interactor is required to rebuild interactive outputs.');
    const built = await judge.compiler.compile(ctx.ref.dir, ctx.config.interactor.source, judge.langOf(ctx.config, ctx.config.interactor.source), ctx.buildRoot);
    if (!built.program) throw new HttpError(400, 'answer_solution', built.result.log);
    interactor = built.program;
  }
  await fs.mkdir(path.join(ctx.work, 'tmp'), { recursive: true });
  const stage = await fs.mkdtemp(path.join(ctx.work, 'tmp', 'answers-work-'));
  const limits = testLimitLookup(ctx.config, ts);
  try {
    for (const [position, pair] of pairs.entries()) {
      job.signal.throwIfAborted();
      const input = path.join(stage, `${pair.index}.in`);
      await fs.copyFile(safeJoin(ctx.ref.dir, pair.input), input);
      await withTmp(ctx.ref.dir, async tmp => {
        const limit = limits(pair.index);
        const result = await runSolution(judge.runner, compiled.program!, input, { ...ctx.limits, timeLimitMs: limit.timeLimit, memoryLimitMb: limit.memoryLimit }, tmp, { interactor, signal: job.signal });
        if (result.verdict !== 'OK') throw new HttpError(400, 'answer_solution', `Test ${pair.index}: ${result.verdict}${result.message ? ' — ' + result.message : ''}`);
        await fs.copyFile(result.outputFile, path.join(stage, `${pair.index}.ans`));
      });
      job.progress(position + 1, pairs.length, `generated output ${pair.index}`);
    }
    if (await fs.readFile(configFile, 'utf8') !== configText) throw new HttpError(409, 'conflict', 'problem.toml changed during output generation.');
    const current = await inputPairs(ctx, testset);
    if (JSON.stringify(current) !== JSON.stringify(pairs)) throw new HttpError(409, 'conflict', 'Input or output files changed during generation. Existing outputs were kept.');
    await replaceAnswerFiles(ctx.ref.dir, pairs.map(pair => ({ output: pair.output, from: path.join(stage, `${pair.index}.ans`) })), job.signal);
    return { action: 'regenerate', testset, tests: pairs.length };
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}

export async function restoreOriginalAnswers(ctx: ProblemCtx, testset: string, job: JobCtx): Promise<AnswerOperationResult> {
  await recoverAnswerTransaction(ctx.ref.dir);
  const pairs = await inputPairs(ctx, testset), replacements = await originalReplacements(ctx.ref.dir, requireTestset(ctx, testset), pairs);
  job.signal.throwIfAborted();
  await replaceAnswerFiles(ctx.ref.dir, replacements, job.signal);
  job.progress(replacements.length, replacements.length, 'restored original outputs');
  return { action: 'restore', testset, tests: replacements.length };
}
