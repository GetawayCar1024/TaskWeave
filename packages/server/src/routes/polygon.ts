import type { FastifyInstance } from 'fastify';
import type { ImportRequest, PullRequest, PushRequest, SaveSecretsRequest } from '@polyforge/shared';
import type { JobManager } from '../jobs.js';
import type { Judge } from '../judge/index.js';
import type { PolygonSync } from '../polygon/sync.js';
import { HttpError } from '../util/fs.js';
import type { WsHub } from '../ws.js';

/** Polygon routes (DESIGN §7): secrets, diff/push, pull, import. */
export function polygonRoutes(app: FastifyInstance, judge: Judge, sync: PolygonSync, jobs: JobManager, hub: WsHub) {
  type P = { Params: { id: string } };

  app.get('/api/secrets', async () => judge.global.maskedSecrets());
  app.put<{ Body: SaveSecretsRequest }>('/api/secrets', async (req) => judge.global.saveSecrets(req.body ?? { polygon: {} }));

  app.post('/api/polygon/test', async () => sync.testConnection());
  app.get('/api/polygon/problems', async () => sync.listProblems());

  app.post<P>('/api/problems/:id/polygon/diff', async (req) => sync.pushPreview(await judge.ctx(req.params.id)));

  app.post<P & { Body: PushRequest }>('/api/problems/:id/polygon/push', async (req) => {
    const ctx = await judge.ctx(req.params.id);
    const body = req.body;
    if (!body || !Array.isArray(body.keys)) throw new HttpError(400, 'bad_request', 'keys required');
    const running = jobs.list(ctx.ref.id).find((j) => j.kind === 'polygon-push' && j.status === 'running');
    if (running) return running;
    return jobs.start('polygon-push', ctx.ref.id, async (job) => {
      const r = await sync.push(ctx, body, job);
      hub.broadcast({ type: 'problem:changed', problemId: ctx.ref.id });
      return r;
    });
  });

  app.post<P>('/api/problems/:id/polygon/pull-preview', async (req) => sync.pullPreview(await judge.ctx(req.params.id)));

  app.post<P & { Body: PullRequest }>('/api/problems/:id/polygon/pull', async (req) => {
    const ctx = await judge.ctx(req.params.id);
    const r = await sync.pull(ctx, { take: req.body?.take ?? [] });
    hub.broadcast({ type: 'problem:changed', problemId: ctx.ref.id });
    return r;
  });

  app.get<P & { Querystring: { key: string } }>('/api/problems/:id/polygon/content', async (req) => {
    if (!req.query.key) throw new HttpError(400, 'bad_request', 'key required');
    return sync.itemContent(await judge.ctx(req.params.id), req.query.key);
  });

  app.post<{ Body: ImportRequest }>('/api/problems/import/polygon', async (req) => {
    const body = req.body;
    if (!body || !Number.isInteger(body.polygonId)) throw new HttpError(400, 'bad_request', 'polygonId required');
    return jobs.start('polygon-import', '', async (job) => {
      const summary = await sync.importProblem(body, job);
      hub.broadcast({ type: 'problems:changed' });
      return summary;
    });
  });
}
