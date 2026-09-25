import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { CONTEST_ACTIONS, type ContestBatchRequest, type ContestImportRequest, type CreateContestRequest, type UpdateContestRequest } from '@polyforge/shared';
import type { JobManager } from '../jobs.js';
import { contestExportDir, contestStatements, importContest, runContestBatch, type ContestDeps } from '../judge/contest.js';
import { printToPdf } from '../pdf.js';
import { HttpError } from '../util/fs.js';
import type { WsHub } from '../ws.js';

/** Contest jobs use `contest:<id>` as their owner so the contest page can find them. */
export const contestJobOwner = (id: string) => `contest:${id}`;

export function contestRoutes(app: FastifyInstance, deps: ContestDeps, jobs: JobManager, hub: WsHub, token: string) {
  const { contests, judge } = deps;
  type P = { Params: { id: string } };

  app.get('/api/contests', async () => contests.list());

  app.post<{ Body: CreateContestRequest }>('/api/contests', async (req, reply) => {
    const c = await contests.create(req.body ?? ({} as CreateContestRequest));
    hub.broadcast({ type: 'contests:changed' });
    return reply.code(201).send(c);
  });

  app.get<P>('/api/contests/:id', async (req) => contests.detail(req.params.id));

  app.put<P & { Body: UpdateContestRequest }>('/api/contests/:id', async (req) => {
    const d = await contests.update(req.params.id, req.body ?? {});
    hub.broadcast({ type: 'contests:changed' });
    return d;
  });

  app.delete<P>('/api/contests/:id', async (req) => {
    await contests.remove(req.params.id);
    hub.broadcast({ type: 'contests:changed' });
    return { ok: true };
  });

  /** The print page (statements or tutorials) as a PDF, rendered by a headless Edge / Chrome. */
  app.get<P & { Querystring: { lang?: string; doc?: string } }>('/api/contests/:id/pdf', async (req, reply) => {
    const ref = await contests.get(req.params.id);
    const lang = /^[a-z]{2,8}$/.test(req.query.lang ?? '') ? req.query.lang! : 'zh';
    const doc = req.query.doc === 'tutorials' ? 'tutorials' : 'statements';
    // The page is served where the UI is (the Vite dev server in development).
    const referer = req.headers.referer ? new URL(req.headers.referer).origin : null;
    const origin = referer && /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(referer) ? referer : `http://${req.headers.host}`;
    const url = `${origin}/c/${encodeURIComponent(ref.id)}/print?doc=${doc}&lang=${lang}&token=${encodeURIComponent(token)}`;
    const pdf = await printToPdf(url);
    const file = `${ref.id}-${doc}-${lang}.pdf`;
    return reply.type('application/pdf').header('content-disposition', `attachment; filename="${file}"`).send(pdf);
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
      const r = await importContest(deps, body, job);
      hub.broadcast({ type: 'problems:changed' });
      hub.broadcast({ type: 'contests:changed' });
      return r;
    });
  });
}
