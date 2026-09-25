import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { isSourceFile, type CompileResult, type QuickRunRequest, type StressRequest, type TestFileResponse } from '@polyforge/shared';
import type { JobManager } from '../jobs.js';
import type { Judge } from '../judge/index.js';
import { listInvocations, outputPath, readInvocation, runInvocation } from '../judge/invocation.js';
import { quickRun } from '../judge/quickrun.js';
import { runStress } from '../judge/stress.js';
import { exportDir, exportPackage } from '../judge/package.js';
import { localChecks } from '../judge/checks.js';
import { runCheckerTests, runValidatorTests } from '../judge/selftest.js';
import { addManualTest, answerPath, generateTests, inputPath, overviewPath, publicManifest, readManifest, requireTestset } from '../judge/tests.js';
import { HttpError, safeJoin } from '../util/fs.js';

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
  type P = { Params: { id: string } };

  /** Compile the given sources, or every program referenced by problem.toml. */
  app.post<P & { Body: { sources?: string[] } }>('/api/problems/:id/build', async (req) => {
    const ctx = await judge.ctx(req.params.id);
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
  app.post<P & { Body: { input?: string; sample?: boolean; testset?: string; statementOutput?: string } }>('/api/problems/:id/tests/manual', async (req) => {
    const ctx = await judge.ctx(req.params.id);
    if (typeof req.body?.input !== 'string') throw new HttpError(400, 'bad_request', 'input required');
    const r = await addManualTest(ctx, req.body.input, { sample: req.body.sample, testset: req.body.testset, statementOutput: req.body.statementOutput });
    if (r.samples !== undefined) await judge.registry.patch(ctx.ref.id, { samples: r.samples });
    return r;
  });

  app.get<P & TS>('/api/problems/:id/tests', async (req) => {
    const ctx = await judge.ctx(req.params.id);
    const m = await readManifest(ctx, requireTestset(ctx, req.query.testset).name);
    return m ? publicManifest(m) : null;
  });

  app.get<{ Params: { id: string; n: string; kind: string } } & TS>('/api/problems/:id/tests/:n/:kind', async (req) => {
    const ctx = await judge.ctx(req.params.id);
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'bad_test', 'Invalid test index');
    // "statement": what the statement shows as output (custom NN.out, else the answer).
    if (req.params.kind === 'statement') {
      const m = await readManifest(ctx);
      const rel = m?.tests.find((t) => t.index === n)?.statementOutput;
      return preview(rel ? safeJoin(ctx.ref.dir, rel) : answerPath(ctx, n));
    }
    const file = { in: inputPath, ans: answerPath, overview: overviewPath }[req.params.kind];
    if (!file) throw new HttpError(400, 'bad_kind', 'kind must be in, ans, overview or statement');
    return preview(file(ctx, n, requireTestset(ctx, req.query.testset).name));
  });

  app.post<P & { Body: QuickRunRequest }>('/api/problems/:id/run', async (req) => {
    const ctx = await judge.ctx(req.params.id);
    if (!req.body?.source) throw new HttpError(400, 'bad_request', 'source required');
    return quickRun(judge, ctx, req.body);
  });

  app.post<P & { Body: { sources: string[]; tests?: number[]; testset?: string } }>('/api/problems/:id/invocations', async (req) => {
    const ctx = await judge.ctx(req.params.id);
    const sources = req.body?.sources ?? [];
    const testset = requireTestset(ctx, req.body?.testset).name;
    let invId = '';
    let resolveStart!: () => void;
    const started = new Promise<void>((r) => (resolveStart = r));
    const job = jobs.start('invocation', ctx.ref.id, (j) =>
      runInvocation(judge, ctx, sources, req.body?.tests, j, (id) => {
        invId = id;
        resolveStart();
      }, testset).finally(resolveStart),
    );
    await started;
    return { job, invocationId: invId };
  });

  app.get<P>('/api/problems/:id/invocations', async (req) => listInvocations(await judge.ctx(req.params.id)));

  app.get<{ Params: { id: string; inv: string } }>('/api/problems/:id/invocations/:inv', async (req) =>
    readInvocation(await judge.ctx(req.params.id), req.params.inv),
  );

  app.get<{ Params: { id: string; inv: string; sol: string; test: string } }>(
    '/api/problems/:id/invocations/:inv/output/:sol/:test',
    async (req) => {
      const ctx = await judge.ctx(req.params.id);
      await readInvocation(ctx, req.params.inv);
      return preview(outputPath(ctx, req.params.inv, Number(req.params.sol), Number(req.params.test)));
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
  app.post<P>('/api/problems/:id/export', async (req) => {
    const ctx = await judge.ctx(req.params.id);
    return jobs.start('export', ctx.ref.id, (job) => exportPackage(judge, ctx, job));
  });
  app.get<{ Params: { id: string; file: string } }>('/api/problems/:id/export/:file', async (req, reply) => {
    const ctx = await judge.ctx(req.params.id);
    if (!/^[\w.-]+\.zip$/.test(req.params.file)) throw new HttpError(400, 'bad_file', 'Invalid file name');
    const data = await fsp.readFile(path.join(exportDir(ctx), req.params.file)).catch(() => {
      throw new HttpError(404, 'file_not_found', 'Export not found');
    });
    return reply.type('application/zip').header('content-disposition', `attachment; filename="${req.params.file}"`).send(data);
  });

  app.get<{ Querystring: { problem?: string } }>('/api/jobs', async (req) => jobs.list(req.query.problem));
  app.get<{ Params: { job: string } }>('/api/jobs/:job', async (req) => jobs.get(req.params.job));
  app.post<{ Params: { job: string } }>('/api/jobs/:job/cancel', async (req) => jobs.cancel(req.params.job));
}
