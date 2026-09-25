import { promises as fsp } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { isSourceFile, type CompileResult, type QuickRunRequest, type TestFileResponse } from '@polyforge/shared';
import type { JobManager } from '../jobs.js';
import type { Judge } from '../judge/index.js';
import { listInvocations, outputPath, readInvocation, runInvocation } from '../judge/invocation.js';
import { quickRun } from '../judge/quickrun.js';
import { runCheckerTests, runValidatorTests } from '../judge/selftest.js';
import { answerPath, generateTests, inputPath, overviewPath, publicManifest, readManifest } from '../judge/tests.js';
import { HttpError } from '../util/fs.js';

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

  app.post<P>('/api/problems/:id/tests/generate', async (req) => {
    const ctx = await judge.ctx(req.params.id);
    const running = jobs.running(ctx.ref.id, 'generate');
    if (running) return running;
    return jobs.start('generate', ctx.ref.id, (job) => generateTests(judge, ctx, job));
  });

  app.get<P>('/api/problems/:id/tests', async (req) => {
    const ctx = await judge.ctx(req.params.id);
    const m = await readManifest(ctx);
    return m ? publicManifest(m) : null;
  });

  app.get<{ Params: { id: string; n: string; kind: string } }>('/api/problems/:id/tests/:n/:kind', async (req) => {
    const ctx = await judge.ctx(req.params.id);
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'bad_test', 'Invalid test index');
    const file = { in: inputPath, ans: answerPath, overview: overviewPath }[req.params.kind];
    if (!file) throw new HttpError(400, 'bad_kind', 'kind must be in, ans or overview');
    return preview(file(ctx, n));
  });

  app.post<P & { Body: QuickRunRequest }>('/api/problems/:id/run', async (req) => {
    const ctx = await judge.ctx(req.params.id);
    if (!req.body?.source) throw new HttpError(400, 'bad_request', 'source required');
    return quickRun(judge, ctx, req.body);
  });

  app.post<P & { Body: { sources: string[]; tests?: number[] } }>('/api/problems/:id/invocations', async (req) => {
    const ctx = await judge.ctx(req.params.id);
    const sources = req.body?.sources ?? [];
    let invId = '';
    let resolveStart!: () => void;
    const started = new Promise<void>((r) => (resolveStart = r));
    const job = jobs.start('invocation', ctx.ref.id, (j) =>
      runInvocation(judge, ctx, sources, req.body?.tests, j, (id) => {
        invId = id;
        resolveStart();
      }).finally(resolveStart),
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

  app.get<{ Querystring: { problem?: string } }>('/api/jobs', async (req) => jobs.list(req.query.problem));
  app.get<{ Params: { job: string } }>('/api/jobs/:job', async (req) => jobs.get(req.params.job));
  app.post<{ Params: { job: string } }>('/api/jobs/:job/cancel', async (req) => jobs.cancel(req.params.job));
}
