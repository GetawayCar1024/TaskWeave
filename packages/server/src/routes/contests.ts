import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { CONTEST_ACTIONS, type ContestBatchRequest, type ContestImportRequest, type ContestPullRequest, type CreateContestRequest, type UpdateContestRequest } from '@polyforge/shared';
import { contestPull, contestPullPreview, contestSyncStatus } from '../polygon/contestSync.js';
import type { JobManager } from '../jobs.js';
import { contestExportDir, contestStatements, importContest, runContestBatch, type ContestDeps } from '../judge/contest.js';
import { contestTex } from '../judge/statementTex.js';
import { HttpError } from '../util/fs.js';
import type { WsHub } from '../ws.js';

/** Contest jobs use `contest:<id>` as their owner so the contest page can find them. */
export const contestJobOwner = (id: string) => `contest:${id}`;

export function contestRoutes(app: FastifyInstance, deps: ContestDeps, jobs: JobManager, hub: WsHub) {
  const { contests, judge } = deps;
  type P = { Params: { id: string } };

  app.get('/api/contests', async () => contests.list());

  app.post<{ Body: CreateContestRequest }>('/api/contests', async (req, reply) => {
    const c = await contests.create(req.body ?? ({} as CreateContestRequest));
    hub.broadcast({ type: 'contests:changed' });
    return reply.code(201).send(c);
  });

  app.get<P>('/api/contests/:id', async (req) => contests.detail(req.params.id));
  app.get<P>('/api/contests/:id/attachments', async (req, reply) => {
    const { config } = await contests.config(req.params.id);
    if (config.contest.type !== 'oi') throw new HttpError(400, 'oi_only', 'Attachments are only available for OI contests');
    const { ZipWriter } = await import('../util/zip.js');
    const { addAttachments } = await import('../workspace/attachments.js');
    const zip = new ZipWriter();
    for (const p of config.problems) {
      const ctx = await judge.ctx(p.problem);
      await addAttachments(zip, ctx.ref.dir, `${p.index}/${ctx.config.problem.name}/`);
    }
    return reply.type('application/zip').header('content-disposition', `attachment; filename="${config.contest.name}-attachments.zip"`).send(zip.finish());
  });
  app.get<P>('/api/contests/:id/batch/latest', async req => {
    const ref = await contests.get(req.params.id);
    return JSON.parse(await fsp.readFile(path.join(ref.dir, '.polyforge', 'batches', 'latest.json'), 'utf8').catch(() => 'null'));
  });

  app.put<P & { Body: UpdateContestRequest }>('/api/contests/:id', async (req) => {
    if (req.body?.problems) {
      const current = await contests.detail(req.params.id);
      const owners = new Set([contestJobOwner(req.params.id), ...current.problems.map(p => p.problem)]);
      if (jobs.list().some(j => j.status === 'running' && owners.has(j.problemId))) throw new HttpError(409, 'busy', 'Wait for running contest/problem tasks before changing indices');
    }
    const d = await contests.update(req.params.id, req.body ?? {});
    hub.broadcast({ type: 'contests:changed' });
    return d;
  });

  app.delete<P>('/api/contests/:id', async (req) => {
    await contests.remove(req.params.id);
    hub.broadcast({ type: 'contests:changed' });
    return { ok: true };
  });

  /** Statements or tutorials as a self-contained .tex (a .zip when there are images). */
  app.get<P & { Querystring: { lang?: string; doc?: string; breaks?: string; toc?: string } }>('/api/contests/:id/tex', async (req, reply) => {
    const ref = await contests.get(req.params.id);
    const lang = /^[a-z]{2,8}$/.test(req.query.lang ?? '') ? req.query.lang! : 'zh';
    const doc = req.query.doc === 'tutorials' ? 'tutorials' : 'statements';
    const r = await contestTex(judge, contests, ref.id, lang, doc, req.query.breaks !== '0', req.query.toc !== '0');
    const file = `${ref.id}-${doc}-${lang}.${r.ext}`;
    return reply
      .type(r.ext === 'zip' ? 'application/zip' : 'application/x-tex; charset=utf-8')
      .header('content-disposition', `attachment; filename="${file}"`)
      .send(r.data);
  });

  app.get<P & { Querystring: { lang?: string } }>('/api/contests/:id/statements', async (req) => {
    const lang = req.query.lang ?? 'en';
    if (!/^[a-z]{2,8}$/.test(lang)) throw new HttpError(400, 'bad_lang', 'Invalid language');
    return contestStatements(judge, contests, req.params.id, lang);
  });

  app.post<P & { Body: ContestBatchRequest }>('/api/contests/:id/batch', async (req) => {
    const body = req.body;
    if (!body || !CONTEST_ACTIONS.includes(body.action)) throw new HttpError(400, 'bad_request', `action must be one of ${CONTEST_ACTIONS.join(', ')}`);
    const ref = await contests.get(req.params.id);
    const owner = contestJobOwner(ref.id);
    const running = jobs.running(owner, 'contest');
    if (running) throw new HttpError(409, 'busy', 'Another batch is running for this contest');
    return jobs.start('contest', owner, async (job) => {
      const r = await runContestBatch(deps, ref.id, body, job);
      if (body.action === 'polygon-push') hub.broadcast({ type: 'problems:changed' });
      return r;
    });
  });

  // ---- Polygon sync of the whole contest: status, then pull only what changed there ----
  app.get<P>('/api/contests/:id/polygon/status', async (req) => contestSyncStatus(deps, (await contests.get(req.params.id)).id));

  const exclusive = (id: string, run: (job: Parameters<Parameters<JobManager['start']>[2]>[0]) => Promise<unknown>) => {
    const owner = contestJobOwner(id);
    if (jobs.running(owner, 'contest')) throw new HttpError(409, 'busy', 'Another batch is running for this contest');
    return jobs.start('contest', owner, run);
  };
  app.post<P & { Body: { problems?: string[] } }>('/api/contests/:id/polygon/pull-preview', async (req) => {
    const ref = await contests.get(req.params.id);
    const problems = Array.isArray(req.body?.problems) ? req.body.problems.map(String) : [];
    if (!problems.length) throw new HttpError(400, 'bad_request', 'problems required');
    return exclusive(ref.id, (job) => contestPullPreview(deps, ref.id, problems, job));
  });
  app.post<P & { Body: ContestPullRequest }>('/api/contests/:id/polygon/pull', async (req) => {
    const ref = await contests.get(req.params.id);
    const body = req.body;
    if (!body || !Array.isArray(body.problems)) throw new HttpError(400, 'bad_request', 'problems required');
    return exclusive(ref.id, async (job) => {
      const r = await contestPull(deps, ref.id, body, job);
      hub.broadcast({ type: 'problems:changed' });
      return r;
    });
  });

  app.get<{ Params: { id: string; file: string } }>('/api/contests/:id/export/:file', async (req, reply) => {
    const ref = await contests.get(req.params.id);
    if (!/^[\w.-]+\.zip$/.test(req.params.file)) throw new HttpError(400, 'bad_file', 'Invalid file name');
    const data = await fsp.readFile(path.join(contestExportDir(ref), req.params.file)).catch(() => {
      throw new HttpError(404, 'file_not_found', 'Export not found');
    });
    return reply.type('application/zip').header('content-disposition', `attachment; filename="${req.params.file}"`).send(data);
  });

  app.post<{ Body: ContestImportRequest }>('/api/contests/import/polygon', async (req) => {
    const body = req.body;
    if (!body || !Number.isInteger(body.contestId) || !body.name) throw new HttpError(400, 'bad_request', 'contestId and name required');
    return jobs.start('contest-import', '', async (job) => {
      try { return await importContest(deps, body, job); }
      finally {
        await deps.afterImport?.();
        hub.broadcast({ type: 'problems:changed' });
        hub.broadcast({ type: 'contests:changed' });
      }
    });
  });
}
