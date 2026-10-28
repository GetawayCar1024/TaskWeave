import type { FastifyInstance } from 'fastify';
import type { CreateAiSessionRequest, SaveAiEndpoint } from '@taskweave/shared';
import { contestOwner, type AgentService } from '../ai/agent.js';
import { createProvider, defaultModel } from '../ai/provider.js';
import type { GlobalStore } from '../global.js';
import { HttpError } from '../util/fs.js';

/** AI routes (DESIGN §7): endpoints, agent sessions, change review. */
export function aiRoutes(app: FastifyInstance, global: GlobalStore, agent: AgentService) {
  app.get('/api/ai/endpoints', async () => global.maskedAiEndpoints());
  app.put<{ Body: SaveAiEndpoint[] }>('/api/ai/endpoints', async (req) => {
    if (!Array.isArray(req.body)) throw new HttpError(400, 'bad_request', 'array of endpoints required');
    return global.saveAiEndpoints(req.body);
  });

  app.post<{ Body: { name: string; model?: string } }>('/api/ai/endpoints/test', async (req) => {
    const ep = await global.aiEndpoint(req.body?.name);
    return (await createProvider(ep)).test(req.body?.model || defaultModel(ep));
  });

  app.post<{ Body: { name: string } }>('/api/ai/endpoints/models', async (req) => {
    const ep = await global.aiEndpoint(req.body?.name);
    try {
      return await (await createProvider(ep)).listModels();
    } catch (e) {
      throw new HttpError(502, 'models_failed', `This endpoint does not provide a model list (${(e as Error).message}). Enter the model names by hand, then use Test connection.`);
    }
  });

  app.get('/api/ai/usage', async () => agent.usageLog.stats());
  app.delete('/api/ai/usage', async () => {
    await agent.usageLog.clear();
    return { ok: true };
  });

  type P = { Params: { id: string } };
  type S = { Params: { id: string; sid: string } };

  // The same session routes for problems and for whole contests (owner "contest:<id>").
  const owners: [string, (id: string) => string][] = [
    ['/api/problems/:id', (id) => id],
    ['/api/contests/:id', contestOwner],
  ];
  for (const [base, own] of owners) {
    app.delete<S>(`${base}/ai/sessions/:sid/scratch`, async req => {
      await agent.clearScratch(own(req.params.id), req.params.sid);
      return { ok: true };
    });
    app.get<P>(`${base}/ai/sessions`, async (req) => agent.list(own(req.params.id)));
    app.post<P & { Body: CreateAiSessionRequest }>(`${base}/ai/sessions`, async (req) => agent.create(own(req.params.id), req.body ?? {}));
    app.post<P & { Body: CreateAiSessionRequest }>(`${base}/ai/review`, async (req) => agent.startReview(own(req.params.id), req.body ?? {}));

    app.get<S>(`${base}/ai/sessions/:sid`, async (req) => agent.get(own(req.params.id), req.params.sid));
    app.patch<S & { Body: { title?: string; endpoint?: string; model?: string } }>(`${base}/ai/sessions/:sid`, async (req) =>
      agent.update(own(req.params.id), req.params.sid, req.body ?? {}),
    );
    app.delete<S>(`${base}/ai/sessions/:sid`, async (req) => {
      await agent.remove(own(req.params.id), req.params.sid);
      return { ok: true };
    });
    app.post<S & { Body: { text: string } }>(`${base}/ai/sessions/:sid/messages`, async (req) =>
      agent.send(own(req.params.id), req.params.sid, String(req.body?.text ?? '')),
    );
    app.post<S>(`${base}/ai/sessions/:sid/cancel`, async (req) => {
      agent.cancel(own(req.params.id), req.params.sid);
      return { ok: true };
    });

    app.get<S>(`${base}/ai/sessions/:sid/changes`, async (req) => agent.changes(own(req.params.id), req.params.sid));
    app.get<S & { Querystring: { path: string } }>(`${base}/ai/sessions/:sid/changes/content`, async (req) => {
      if (!req.query.path) throw new HttpError(400, 'bad_request', 'path required');
      return agent.changeContent(own(req.params.id), req.params.sid, req.query.path);
    });
    app.post<S & { Body: { paths: string[] } }>(`${base}/ai/sessions/:sid/changes/accept`, async (req) =>
      agent.accept(own(req.params.id), req.params.sid, req.body?.paths ?? []),
    );
    app.post<S & { Body: { paths: string[] } }>(`${base}/ai/sessions/:sid/changes/reject`, async (req) =>
      agent.reject(own(req.params.id), req.params.sid, req.body?.paths ?? []),
    );
  }
}
