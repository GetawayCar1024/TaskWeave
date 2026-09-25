import type { FastifyInstance } from 'fastify';
import type { CreateAiSessionRequest, SaveAiEndpoint } from '@polyforge/shared';
import type { AgentService } from '../ai/agent.js';
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
      throw new HttpError(502, 'models_failed', `Could not list models: ${(e as Error).message}`);
    }
  });

  type P = { Params: { id: string } };
  type S = { Params: { id: string; sid: string } };

  app.get<P>('/api/problems/:id/ai/sessions', async (req) => agent.list(req.params.id));
  app.post<P & { Body: CreateAiSessionRequest }>('/api/problems/:id/ai/sessions', async (req) => agent.create(req.params.id, req.body ?? {}));
  app.get<S>('/api/problems/:id/ai/sessions/:sid', async (req) => agent.get(req.params.id, req.params.sid));
  app.patch<S & { Body: { title?: string; endpoint?: string; model?: string } }>('/api/problems/:id/ai/sessions/:sid', async (req) =>
    agent.update(req.params.id, req.params.sid, req.body ?? {}),
  );
  app.delete<S>('/api/problems/:id/ai/sessions/:sid', async (req) => {
    await agent.remove(req.params.id, req.params.sid);
    return { ok: true };
  });
  app.post<S & { Body: { text: string } }>('/api/problems/:id/ai/sessions/:sid/messages', async (req) =>
    agent.send(req.params.id, req.params.sid, String(req.body?.text ?? '')),
  );
  app.post<S>('/api/problems/:id/ai/sessions/:sid/cancel', async (req) => {
    agent.cancel(req.params.id, req.params.sid);
    return { ok: true };
  });

  app.get<S>('/api/problems/:id/ai/sessions/:sid/changes', async (req) => agent.changes(req.params.id, req.params.sid));
  app.get<S & { Querystring: { path: string } }>('/api/problems/:id/ai/sessions/:sid/changes/content', async (req) => {
    if (!req.query.path) throw new HttpError(400, 'bad_request', 'path required');
    return agent.changeContent(req.params.id, req.params.sid, req.query.path);
  });
  app.post<S & { Body: { paths: string[] } }>('/api/problems/:id/ai/sessions/:sid/changes/accept', async (req) =>
    agent.accept(req.params.id, req.params.sid, req.body?.paths ?? []),
  );
  app.post<S & { Body: { paths: string[] } }>('/api/problems/:id/ai/sessions/:sid/changes/reject', async (req) =>
    agent.reject(req.params.id, req.params.sid, req.body?.paths ?? []),
  );
}
