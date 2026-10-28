import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { isSourceFile, parseIndexList, type CompileResult, type InvocationSelection, type QuickRunRequest, type StressRequest, type TestFileResponse } from '@taskweave/shared';
import type { JobManager } from '../jobs.js';
import type { Judge } from '../judge/index.js';
import { listInvocations, readInvocation, refOutputPath, runInvocation } from '../judge/invocation.js';
import { quickRun } from '../judge/quickrun.js';
import { runStress } from '../judge/stress.js';
import { exportDir, exportPackage } from '../judge/package.js';
import { localChecks } from '../judge/checks.js';
import { runCheckerTests, runValidatorTests } from '../judge/selftest.js';
import { addManualTest, removeTest, answerPath, generateTests, inputPath, overviewPath, publicManifest, readManifest, requireTestset, sampleStatementPaths } from '../judge/tests.js';
import { HttpError, safeJoin, exists, atomicWrite } from '../util/fs.js';
import { readSamples } from '../judge/samples.js';
import { buildProblemDataPackage, requireLuoguOptions } from '../judge/problemExport.js';
import { requireFullProblem } from '../judge/index.js';
import type { ProblemExportRequest } from '@taskweave/shared';
import type { RegenerateAnswersRequest } from '@taskweave/shared';
import { answerBackupInfo, recoverAnswerTransaction } from '../workspace/answerBackups.js';
import { regenerateAnswers, restoreOriginalAnswers } from '../judge/answers.js';

const PREVIEW = 64 * 1024;

async function preview(file: string, bytes = PREVIEW): Promise<TestFileResponse> {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
  } catch {
    throw new HttpError(404, 'file_not_found', 'File not found');
  }
  try {
    const size = (await fh.stat()).size;
    const buf = Buffer.alloc(Math.min(size, bytes));
    await fh.read(buf, 0, buf.length, 0);
    return { content: buf.toString('utf8'), size, truncated: size > bytes };
  } finally {
    await fh.close();
  }
}

export function judgeRoutes(app: FastifyInstance, judge: Judge, jobs: JobManager) {
  app.get<{ Params: { id: string }; Querystring: { lang?: string } }>('/api/problems/:id/statement-samples', async req => {
    const lang = req.query.lang;
    if (lang !== undefined && !/^[a-z]{2,8}$/.test(lang)) throw new HttpError(400, 'bad_lang', 'Invalid language');
    return (await readSamples(await judge.ctx(req.params.id), false, lang)).map(row => row.sample);
  });
  type P = { Params: { id: string } };
  app.get<P & { Querystring: { testset?: string } }>('/api/problems/:id/answers/original', async req => {
    const ctx = await judge.ctx(req.params.id); await recoverAnswerTransaction(ctx.ref.dir);
    return answerBackupInfo(ctx.ref.dir, requireTestset(ctx, req.query.testset));
  });
  const answerJob = async (id: string, run: (ctx: Awaited<ReturnType<Judge['ctx']>>, job: import('../jobs.js').JobCtx) => Promise<unknown>) => {
    const ctx = await judge.ctx(id);
    if (jobs.list().some(job => job.status === 'running' && (job.problemId === id || job.kind === 'contest'))) throw new HttpError(409, 'busy', 'Wait for problem and contest jobs before changing outputs.');
    return jobs.start('answers', id, async job => {
      try { return await run(ctx, job); }
      finally { judge.hub.broadcast({ type: 'problem:changed', problemId: id }); }
    });
  };
  app.post<P & { Body: RegenerateAnswersRequest }>('/api/problems/:id/answers/regenerate', async req => answerJob(req.params.id, (ctx, job) => regenerateAnswers(judge, ctx, req.body ?? {} as RegenerateAnswersRequest, job)));
  app.post<P & { Body: { testset?: string } }>('/api/problems/:id/answers/restore', async req => answerJob(req.params.id, (ctx, job) => restoreOriginalAnswers(ctx, req.body?.testset ?? 'tests', job)));

  /** Compile the given sources, or every program referenced by problem.toml. */
  app.post<P & { Body: { sources?: string[] } }>('/api/problems/:id/build', async (req) => {
    const ctx = await judge.ctx(req.params.id);
    requireFullProblem(ctx);
    let sources = req.body?.sources;
    if (!sources?.length) {
      const c = ctx.config;
      sources = [c.validator?.source, c.checker?.source, c.interactor?.source, ...c.solutions.map((s) => s.source), ...c.generators.map((g) => g.source)].filter(
        (s): s is string => !!s,
      );
      sources = [...new Set(sources)];
    }
    for (const s of sources) if (!s.startsWith('std:') && !isSourceFile(s)) throw new HttpError(400, 'not_source', `Not a source file: ${s}`);
    const results: CompileResult[] = await Promise.all(sources.map(async (s) => (await judge.compile(ctx, s)).result));
    return results;
  });

  type TS = { Querystring: { testset?: string } };

  app.post<P & TS>('/api/problems/:id/tests/generate', async (req) => {
    const ctx = await judge.ctx(req.params.id);
    const ts = requireTestset(ctx, req.query.testset).name;
    const running = jobs.running(ctx.ref.id, 'generate');
    if (running) return running;
    return jobs.start('generate', ctx.ref.id, (job) => generateTests(judge, ctx, job, ts));
  });

  /** Add a manual test (optionally as a sample) with the next suitable index. */
  app.post<P & { Body: { input?: string; answer?: string; sample?: boolean; testset?: string; statementInput?: string; statementOutput?: string } }>('/api/problems/:id/tests/manual', async (req) => {
    const ctx = await judge.ctx(req.params.id);
    if (typeof req.body?.input !== 'string') throw new HttpError(400, 'bad_request', 'input required');
    const r = await addManualTest(ctx, req.body.input, { answer: req.body.answer, sample: req.body.sample, testset: req.body.testset, statementInput: req.body.statementInput, statementOutput: req.body.statementOutput });
    if (r.samples !== undefined) await judge.registry.patch(ctx.ref.id, { testsets: { [r.testset]: { samples: r.samples, largeSamples: r.largeSamples ?? '' } } });
    return r;
  });

  /** Remove a test: a manual test's files are deleted, a script test loses its line. */
  app.delete<{ Params: { id: string; n: string }; Querystring: { testset?: string; source?: string } }>('/api/problems/:id/tests/:n', async (req) => {
    const ctx = await judge.ctx(req.params.id);
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'bad_test', 'Invalid test index');
    const r = await removeTest(ctx, n, { testset: req.query.testset, source: req.query.source });
    if (r.samples !== undefined) await judge.registry.patch(ctx.ref.id, { testsets: { [r.testset]: { samples: r.samples, largeSamples: r.largeSamples ?? '' } } });
    return r;
  });

  app.get<P & TS>('/api/problems/:id/tests', async (req) => {
    const ctx = await judge.ctx(req.params.id);
    const ts = requireTestset(ctx, req.query.testset);
    const m = await readManifest(ctx, ts.name);
    if (m) {
      // problem.toml may have changed since the tests were generated.
      const samples = new Set(parseIndexList(ts.samples ?? ''));
      const large = new Set(parseIndexList(ts.largeSamples ?? ''));
      await Promise.all(m.tests.map(async t => {
        t.sample = samples.has(t.index) || undefined;
        t.largeSample = (t.sample && large.has(t.index)) || undefined;
        const sp = sampleStatementPaths(t, ts.name);
        t.statementInput = t.sample && await exists(safeJoin(ctx.ref.dir, sp.input)) ? sp.input : undefined;
        t.statementOutput = t.sample && await exists(safeJoin(ctx.ref.dir, sp.output)) ? sp.output : undefined;
      }));
    }
    return m ? publicManifest(m) : null;
  });

  app.get<{ Params: { id: string; n: string; kind: string } } & TS>('/api/problems/:id/tests/:n/:kind', async (req) => {
    const ctx = await judge.ctx(req.params.id);
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'bad_test', 'Invalid test index');
    // What the statement shows (custom NN.statement.in / .out, else the test itself).
    if (req.params.kind === 'statement-in' || req.params.kind === 'statement-out') {
      const ts = requireTestset(ctx, req.query.testset).name;
      const t = (await readManifest(ctx, ts))?.tests.find((x) => x.index === n);
      const candidate = t ? sampleStatementPaths(t, ts)[req.params.kind === 'statement-in' ? 'input' : 'output'] : undefined;
      const rel = candidate && await exists(safeJoin(ctx.ref.dir, candidate)) ? candidate : undefined;
      return preview(rel ? safeJoin(ctx.ref.dir, rel) : req.params.kind === 'statement-in' ? inputPath(ctx, n, ts) : answerPath(ctx, n, ts));
    }
    const file = { in: inputPath, ans: answerPath, overview: overviewPath }[req.params.kind];
    if (!file) throw new HttpError(400, 'bad_kind', 'kind must be in, ans, overview, statement-in or statement-out');
    return preview(file(ctx, n, requireTestset(ctx, req.query.testset).name));
  });

  app.post<P & { Body: QuickRunRequest }>('/api/problems/:id/run', async (req) => {
    const ctx = await judge.ctx(req.params.id);
    if (!req.body?.source) throw new HttpError(400, 'bad_request', 'source required');
    return quickRun(judge, ctx, req.body);
  });

  /** Body: one testset (`testset` + optional `tests`), or `selection` spanning several testsets. */
  app.post<P & { Body: { sources: string[]; tests?: number[]; testset?: string; selection?: InvocationSelection } }>('/api/problems/:id/invocations', async (req) => {
    const ctx = await judge.ctx(req.params.id);
    requireFullProblem(ctx);
    const sources = req.body?.sources ?? [];
    const testset = requireTestset(ctx, req.body?.testset).name;
    const selection = Array.isArray(req.body?.selection) ? req.body.selection : undefined;
    if (selection?.some((s) => typeof s?.testset !== 'string' || (s.tests !== undefined && (!Array.isArray(s.tests) || s.tests.some((n) => !Number.isInteger(n) || n < 1)))))
      throw new HttpError(400, 'bad_request', 'Invalid test selection');
    for (const s of selection ?? []) requireTestset(ctx, s.testset);
    let invId = '';
    let resolveStart!: () => void;
    const started = new Promise<void>((r) => (resolveStart = r));
    const job = jobs.start('invocation', ctx.ref.id, (j) =>
      runInvocation(judge, ctx, sources, req.body?.tests, j, (id) => {
        invId = id;
        resolveStart();
      }, testset, selection).finally(resolveStart),
    );
    await started;
    return { job, invocationId: invId };
  });

  app.get<P>('/api/problems/:id/invocations', async (req) => listInvocations(await judge.ctx(req.params.id)));

  app.get<{ Params: { id: string; inv: string } }>('/api/problems/:id/invocations/:inv', async (req) =>
    readInvocation(await judge.ctx(req.params.id), req.params.inv),
  );

  app.get<{ Params: { id: string; inv: string; sol: string; test: string } } & TS>(
    '/api/problems/:id/invocations/:inv/output/:sol/:test',
    async (req) => {
      const ctx = await judge.ctx(req.params.id);
      const inv = await readInvocation(ctx, req.params.inv);
      const sol = Number(req.params.sol);
      const test = Number(req.params.test);
      if (!Number.isInteger(sol) || sol < 0 || !Number.isInteger(test) || test < 1) throw new HttpError(400, 'bad_test', 'Invalid test index');
      const testset = req.query.testset ? requireTestset(ctx, req.query.testset).name : (inv.testset ?? 'tests');
      return preview(refOutputPath(ctx, inv, sol, { testset, index: test }));
    },
  );

  app.post<P>('/api/problems/:id/validator-tests', async (req) => {
    const ctx = await judge.ctx(req.params.id);
    return jobs.start('validator-tests', ctx.ref.id, (job) => runValidatorTests(judge, ctx, job));
  });

  app.post<P>('/api/problems/:id/checker-tests', async (req) => {
    const ctx = await judge.ctx(req.params.id);
    return jobs.start('checker-tests', ctx.ref.id, (job) => runCheckerTests(judge, ctx, job));
  });

  /** 对拍: generate random tests until the solution disagrees with the reference. */
  app.post<P & { Body: StressRequest }>('/api/problems/:id/stress', async (req) => {
    const ctx = await judge.ctx(req.params.id);
    const body = req.body;
    if (!body?.generator || !body.solution || typeof body.args !== 'string') throw new HttpError(400, 'bad_request', 'generator, args and solution are required');
    const running = jobs.running(ctx.ref.id, 'stress');
    if (running) return running;
    return jobs.start('stress', ctx.ref.id, (job) => runStress(judge, ctx, body, job));
  });

  app.get<P>('/api/problems/:id/checks', async (req) => localChecks(judge, await judge.ctx(req.params.id)));

  /** Polygon-style package (zip) with tests, statements and all programs. */
  app.post<P & { Body: ProblemExportRequest }>('/api/problems/:id/export', async (req) => {
    const ctx = await judge.ctx(req.params.id);
    const format = req.body?.format;
    if (jobs.running(ctx.ref.id, 'export')) throw new HttpError(409, 'busy', 'Another export is running for this problem');
    if (format === 'luogu' || format === 'hydro' || format === 'joi' || format === 'fps') {
      if (format === 'luogu' && req.body.luogu) requireLuoguOptions(req.body.luogu);
      return jobs.start('export', ctx.ref.id, async job => {
        const result = await buildProblemDataPackage(judge, ctx, format, job, req.body);
        const file = format === 'luogu' ? `data-${Date.now()}.zip` : `${ctx.config.problem.name}-${format}-${Date.now()}.${format === 'fps' ? 'xml' : 'zip'}`;
        await atomicWrite(path.join(exportDir(ctx), file), result.data);
        return { file, size: result.data.length, tests: result.tests, warnings: result.warnings };
      });
    }
    if (req.body?.format && req.body.format !== 'polygon') throw new HttpError(400, 'bad_request', 'Unknown export format');
    return jobs.start('export', ctx.ref.id, (job) => exportPackage(judge, ctx, job, undefined, req.body?.format === 'polygon'));
  });
  app.get<{ Params: { id: string; file: string } }>('/api/problems/:id/export/:file', async (req, reply) => {
    const ctx = await judge.ctx(req.params.id);
    if (!/^[\w.-]+\.(zip|xml)$/.test(req.params.file)) throw new HttpError(400, 'bad_file', 'Invalid file name');
    const data = await fsp.readFile(path.join(exportDir(ctx), req.params.file)).catch(() => {
      throw new HttpError(404, 'file_not_found', 'Export not found');
    });
    return reply.type(req.params.file.endsWith('.xml') ? 'application/xml; charset=utf-8' : 'application/zip').header('content-disposition', `attachment; filename="${/^data-\d+\.zip$/.test(req.params.file) ? 'data.zip' : req.params.file}"`).send(data);
  });

  app.get<{ Querystring: { problem?: string } }>('/api/jobs', async (req) => jobs.list(req.query.problem));
  app.get<{ Params: { job: string } }>('/api/jobs/:job', async (req) => jobs.get(req.params.job));
  app.post<{ Params: { job: string } }>('/api/jobs/:job/cancel', async (req) => jobs.cancel(req.params.job));
}
