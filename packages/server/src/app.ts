import { promises as fsp } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import {
  TOKEN_HEADER,
  type CreateProblemRequest,
  type MoveFileRequest,
  type PatchProblemRequest,
  type SettingsResponse,
  type WriteFileRequest,
} from '@polyforge/shared';
import { parse as parseToml } from 'smol-toml';
import type { GlobalStore } from './global.js';
import type { JobManager } from './jobs.js';
import type { Judge } from './judge/index.js';
import { judgeRoutes } from './routes/judge.js';
import { samePath } from './global.js';
import { listShared, stdRefToPath } from './sharedFiles.js';
import { detectTools, listDirs } from './tools.js';
import { HttpError, exists, safeJoin } from './util/fs.js';
import { FileService } from './workspace/files.js';
import { ProblemRegistry } from './workspace/problems.js';
import type { ProblemWatcher } from './workspace/watcher.js';
import type { WsHub } from './ws.js';

export interface AppDeps {
  global: GlobalStore;
  registry: ProblemRegistry;
  files: FileService;
  watcher: ProblemWatcher;
  hub: WsHub;
  judge: Judge;
  jobs: JobManager;
  token: string;
  /** Built frontend to serve; omitted in dev (Vite serves it). */
  webDist?: string;
}

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { global, registry, files, watcher, hub, token } = deps;
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 * 1024 });

  await app.register(fastifyWebsocket);

  // DESIGN §8: reject DNS-rebinding hosts and require the launch token on API/WS.
  app.addHook('onRequest', async (req, reply) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (!ALLOWED_HOSTS.has(host)) return reply.code(403).send({ error: 'forbidden_host', message: 'Forbidden host' });
    const isApi = req.url.startsWith('/api/');
    const isWs = req.url.startsWith('/ws');
    if (!isApi && !isWs) return;
    // WebSockets and <img src> (statement images) cannot send headers.
    const queryOk = isWs || /^\/api\/problems\/[^/]+\/raw\//.test(req.url);
    const given = req.headers[TOKEN_HEADER] ?? (queryOk ? new URL(req.url, 'http://x').searchParams.get('token') : null);
    if (given !== token) return reply.code(401).send({ error: 'unauthorized', message: 'Missing or invalid token' });
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    const e = err as Error & { statusCode?: number; code?: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.code ?? 'bad_request', message: e.message });
    console.error('[polyforge]', err);
    return reply.code(500).send({ error: 'internal', message: e.message });
  });

  app.get('/ws', { websocket: true }, (socket) => hub.add(socket));

  // ---- settings ----
  const settings = (): SettingsResponse => ({ config: global.config, globalDir: global.dir });

  app.get('/api/settings', async () => settings());

  app.put<{ Body: unknown }>('/api/settings', async (req) => {
    const before = global.config.problems.roots;
    await global.saveConfig(req.body);
    const after = global.config.problems.roots;
    const rootsChanged = before.length !== after.length || before.some((r, i) => !samePath(r, after[i]));
    if (rootsChanged) {
      for (const r of after) await fsp.mkdir(r, { recursive: true });
      await watcher.start();
      hub.broadcast({ type: 'problems:changed' });
    }
    hub.broadcast({ type: 'settings:changed' });
    return settings();
  });

  app.get('/api/languages', async () => global.readLanguages());
  app.put<{ Body: { text: string } }>('/api/languages', async (req) => {
    if (typeof req.body?.text !== 'string') throw new HttpError(400, 'bad_request', 'text required');
    return global.writeLanguages(req.body.text);
  });

  app.post('/api/tools/detect', async () => detectTools(global.sharedDir));

  app.get<{ Querystring: { path?: string } }>('/api/fs/dirs', async (req) => {
    try {
      return await listDirs(req.query.path ?? '');
    } catch (e) {
      throw new HttpError(400, 'bad_dir', (e as Error).message);
    }
  });

  // ---- shared files ----
  app.get('/api/shared', async () => listShared(global.sharedDir));
  /** Parsed defs.toml (statement macros, DESIGN §4.6). */
  app.get('/api/shared/defs', async () => {
    try {
      return parseToml(await fsp.readFile(path.join(global.sharedDir, 'defs.toml'), 'utf8'));
    } catch (e) {
      throw new HttpError(500, 'bad_defs', `defs.toml: ${(e as Error).message}`);
    }
  });
  app.get<{ Params: { '*': string } }>('/api/shared/file/*', async (req) => files.read(global.sharedDir, req.params['*']));

  // ---- problems ----
  app.get('/api/problems', async () => ({ roots: registry.roots, problems: await registry.list() }));

  app.post<{ Body: CreateProblemRequest }>('/api/problems', async (req, reply) => {
    const summary = await registry.create(req.body ?? ({} as CreateProblemRequest));
    hub.broadcast({ type: 'problems:changed' });
    return reply.code(201).send(summary);
  });

  app.get<{ Params: { id: string } }>('/api/problems/:id', async (req) => registry.detail(req.params.id));

  app.patch<{ Params: { id: string }; Body: PatchProblemRequest }>('/api/problems/:id', async (req) => {
    const detail = await registry.patch(req.params.id, req.body ?? {});
    hub.broadcast({ type: 'problem:changed', problemId: req.params.id });
    return detail;
  });

  type FileParams = { Params: { id: string; '*': string } };

  app.get<FileParams>('/api/problems/:id/files/*', async (req) => {
    const ref = await registry.get(req.params.id);
    return files.read(ref.dir, req.params['*']);
  });

  app.put<FileParams & { Body: WriteFileRequest }>('/api/problems/:id/files/*', async (req) => {
    const ref = await registry.get(req.params.id);
    if (typeof req.body?.content !== 'string') throw new HttpError(400, 'bad_request', 'content required');
    const hash = await files.write(ref.dir, req.params['*'], req.body.content, req.body.baseHash);
    return { hash };
  });

  app.delete<FileParams>('/api/problems/:id/files/*', async (req) => {
    const ref = await registry.get(req.params.id);
    await files.remove(ref.dir, req.params['*']);
    return { ok: true };
  });

  /** Raw bytes of a problem file (statement images). */
  app.get<FileParams>('/api/problems/:id/raw/*', async (req, reply) => {
    const ref = await registry.get(req.params.id);
    const abs = safeJoin(ref.dir, req.params['*']);
    const data = await fsp.readFile(abs).catch(() => {
      throw new HttpError(404, 'file_not_found', 'File not found');
    });
    const ext = path.extname(abs).toLowerCase();
    const types: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.pdf': 'application/pdf' };
    return reply.type(types[ext] ?? 'application/octet-stream').header('cache-control', 'no-cache').send(data);
  });

  judgeRoutes(app, deps.judge, deps.jobs);

  app.post<{ Params: { id: string }; Body: MoveFileRequest }>('/api/problems/:id/move', async (req) => {
    const ref = await registry.get(req.params.id);
    await files.move(ref.dir, req.body.from, req.body.to);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { path: string } }>('/api/problems/:id/mkdir', async (req) => {
    const ref = await registry.get(req.params.id);
    await files.mkdir(ref.dir, req.body.path);
    return { ok: true };
  });

  /** "复制到本题" (DESIGN §3.1): copy a shared file (e.g. `std:ncmp`) into the problem. */
  app.post<{ Params: { id: string }; Body: { source: string; to: string } }>('/api/problems/:id/copy-shared', async (req) => {
    const ref = await registry.get(req.params.id);
    const rel = stdRefToPath(req.body.source) ?? req.body.source;
    const src = safeJoin(global.sharedDir, rel);
    const dest = safeJoin(ref.dir, req.body.to);
    if (await exists(dest)) throw new HttpError(409, 'exists', `Target exists: ${req.body.to}`);
    const content = await fsp.readFile(src, 'utf8').catch(() => {
      throw new HttpError(404, 'file_not_found', `Shared file not found: ${req.body.source}`);
    });
    const hash = await files.write(ref.dir, req.body.to, content);
    return { hash };
  });

  app.all('/api/*', async (req) => {
    throw new HttpError(404, 'not_found', `No route: ${req.method} ${req.url}`);
  });

  // ---- frontend ----
  if (deps.webDist) {
    await app.register(fastifyStatic, { root: deps.webDist, wildcard: false });
    // SPA fallback: unknown GETs render index.html so client-side routes work on reload.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !path.extname(req.url.split('?')[0])) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not_found', message: 'Not found' });
    });
  }

  return app;
}
