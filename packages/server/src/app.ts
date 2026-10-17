import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultParallel } from './judge/runner.js';
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
import { parseDefsToml } from './defs.js';
import type { GlobalStore } from './global.js';
import type { JobManager } from './jobs.js';
import type { Judge } from './judge/index.js';
import { judgeRoutes } from './routes/judge.js';
import { polygonRoutes } from './routes/polygon.js';
import { aiRoutes } from './routes/ai.js';
import { contestRoutes } from './routes/contests.js';
import { ContestRegistry } from './workspace/contests.js';
import { AgentService } from './ai/agent.js';
import { PolygonError } from './polygon/client.js';
import { PolygonSync } from './polygon/sync.js';
import { samePath } from './global.js';
import { listShared, stdRefToPath } from './sharedFiles.js';
import { detectTools, listDirs } from './tools.js';
import { HttpError, exists, safeJoin, validateFileName } from './util/fs.js';
import { FileService } from './workspace/files.js';
import { ProblemRegistry } from './workspace/problems.js';
import { moveProblem } from './workspace/move.js';
import type { ProblemWatcher } from './workspace/watcher.js';
import type { WsHub } from './ws.js';

export interface AppDeps {
  global: GlobalStore;
  registry: ProblemRegistry;
  contests: ContestRegistry;
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
  const agent = new AgentService(deps.judge, hub, deps.contests);
  let requests = 0;
  let clearingCache = false;
  app.addHook('onRequest', async req => {
    if (!req.url.startsWith('/ws')) requests++;
    if (clearingCache && req.url.startsWith('/api/')) throw new HttpError(409, 'busy', 'Cache maintenance in progress');
  });
  app.addHook('onResponse', async req => { if (!req.url.startsWith('/ws')) requests--; });
  const idle = () => !agent.running && !deps.jobs.list().some(j => j.status === 'running');
  deps.judge.compiler.canPrune = () => requests === 0 && idle();

  await app.register(fastifyWebsocket);

  // Treat an empty JSON body as {} (Fastify rejects it by default), e.g. POST /cancel.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = String(body);
    if (!text.trim()) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch (e) {
      const err = new HttpError(400, 'bad_json', `Invalid JSON: ${(e as Error).message}`);
      done(err, undefined);
    }
  });

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
    if (err instanceof PolygonError) return reply.code(502).send({ error: 'polygon_error', message: err.message });
    const e = err as Error & { statusCode?: number; code?: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.code ?? 'bad_request', message: e.message });
    console.error('[polyforge]', err);
    return reply.code(500).send({ error: 'internal', message: e.message });
  });

  app.get('/ws', { websocket: true }, (socket) => hub.add(socket));

  // ---- settings ----
  const settings = (): SettingsResponse => ({ config: global.config, globalDir: global.dir, cpus: os.availableParallelism(), defaultParallel: defaultParallel() });

  app.get('/api/settings', async () => settings());
  app.post<{ Body: { name: string; markdown: string; images: { problem: string; path: string; name: string }[] } }>('/api/export/markdown', async (req, reply) => {
    const { markdown, images } = req.body ?? {};
    if (typeof markdown !== 'string' || !Array.isArray(images) || images.length > 500) throw new HttpError(400, 'bad_request', 'Invalid Markdown export');
    if (!images.length) return reply.type('text/markdown; charset=utf-8').send(markdown);
    const { ZipWriter } = await import('./util/zip.js');
    const zip = new ZipWriter();
    zip.add('statement.md', markdown);
    for (const image of images) {
      if (!image || typeof image.problem !== 'string' || typeof image.path !== 'string' || !/^image-\d+\.[a-zA-Z0-9]+$/.test(image.name) || image.path.includes('\\') || !path.posix.normalize(image.path).startsWith('statement/images/')) throw new HttpError(400, 'bad_path', 'Invalid image path');
      const ref = await registry.get(image.problem);
      zip.add(`images/${image.name}`, await fsp.readFile(safeJoin(ref.dir, image.path)));
    }
    return reply.type('application/zip').send(zip.finish());
  });
  app.get('/api/shutdown/status', async () => ({ runningAi: agent.running }));
  app.post<{ Params: { id: string }; Body: { root: string } }>('/api/problems/:id/relocate', async req => {
    if (!idle()) throw new HttpError(409, 'busy', 'Wait for running tasks before moving a problem');
    if (typeof req.body?.root !== 'string') throw new HttpError(400, 'invalid_root', 'Destination root required');
    clearingCache = true;
    await watcher.stop();
    try {
      const result = await moveProblem(registry, req.params.id, req.body.root);
      agent.forgetIdle();
      hub.broadcast({ type: 'problems:changed' });
      return result;
    } finally { clearingCache = false; await watcher.start(); }
  });
  app.post('/api/shutdown/stop-ai', async () => { await agent.stopAll(true); return { ok: true }; });

  app.put<{ Body: unknown }>('/api/settings', async (req) => {
    const before = global.config.problems.roots;
    await global.saveConfig(req.body);
    deps.judge.runner.setParallel(global.config.judge?.parallel ?? 0);
    const after = global.config.problems.roots;
    const rootsChanged = before.length !== after.length || before.some((r, i) => !samePath(r, after[i]));
    if (rootsChanged) {
      for (const r of after) await fsp.mkdir(r, { recursive: true });
      await watcher.start();
      hub.broadcast({ type: 'problems:changed' });
    }
    // Contests folder changed (or first set): create it and pick up the contests there.
    await fsp.mkdir(global.contestsDir, { recursive: true });
    await deps.contests.scan();
    hub.broadcast({ type: 'contests:changed' });
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
      return parseDefsToml(await fsp.readFile(path.join(global.sharedDir, 'defs.toml'), 'utf8'));
    } catch (e) {
      throw new HttpError(500, 'bad_defs', `defs.toml: ${(e as Error).message}`);
    }
  });
  app.get<{ Params: { '*': string } }>('/api/shared/file/*', async (req) => files.read(global.sharedDir, req.params['*']));

  // ---- problems ----
  app.post<{ Params: { id: string } }>('/api/problems/:id/convert-oi', async (req, reply) => {
    const summary = await registry.convertToOi(req.params.id);
    hub.broadcast({ type: 'problems:changed' });
    return reply.code(201).send(summary);
  });

  app.get<{ Params: { id: string } }>('/api/problems/:id/attachments', async (req, reply) => {
    const ref = await registry.get(req.params.id);
    const { config } = await registry.readConfig(ref);
    if (config?.problem.type !== 'oi') throw new HttpError(400, 'oi_only', 'Attachments are only available for OI problems');
    const { ZipWriter } = await import('./util/zip.js');
    const { addAttachments } = await import('./workspace/attachments.js');
    const zip = new ZipWriter();
    await addAttachments(zip, ref.dir);
    return reply.type('application/zip').header('content-disposition', `attachment; filename="${config.problem.name}-attachments.zip"`).send(zip.finish());
  });

  app.post<{ Params: { id: string }; Body: { name: string; base64: string } }>('/api/problems/:id/attachments', { bodyLimit: 32 * 1024 * 1024 }, async (req) => {
    const ref = await registry.get(req.params.id);
    const { config } = await registry.readConfig(ref);
    if (config?.problem.type !== 'oi') throw new HttpError(400, 'oi_only', 'Attachments are only available for OI problems');
    const { name, base64 } = req.body ?? {};
    if (typeof name !== 'string' || !/^[^\\/<>:"|?*\x00-\x1f]+$/.test(name) || name.startsWith('.') || /[. ]$/.test(name) || typeof base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new HttpError(400, 'bad_request', 'Invalid attachment');
    const dest = safeJoin(ref.dir, `attachments/${name}`);
    validateFileName(name);
    if ((await fsp.lstat(path.dirname(dest)).catch(() => null))?.isSymbolicLink()) throw new HttpError(400, 'bad_path', 'Attachments directory must not be a symbolic link');
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    try { await fsp.writeFile(dest, Buffer.from(base64, 'base64'), { flag: 'wx' }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new HttpError(409, 'exists', `Attachment already exists: ${name}`); throw e; }
    hub.broadcast({ type: 'problem:changed', problemId: ref.id });
    return { ok: true };
  });
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

  /**
   * Delete a problem: its folder is moved to <global>/trash/<name>-<time> (restore by
   * moving it back). Contests keep their reference, shown as a missing problem.
   */
  app.delete<{ Params: { id: string } }>('/api/problems/:id', async (req) => {
    const ref = await registry.get(req.params.id);
    const busy = deps.jobs.list(ref.id).find((j) => j.status === 'running');
    if (busy) throw new HttpError(409, 'busy', `A ${busy.kind} job is running for this problem`);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
    const dest = path.join(global.dir, 'trash', `${path.basename(ref.dir)}-${stamp}`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    // Drop what can be regenerated (generated tests, builds, invocation outputs,
    // exports, AI sandboxes) so the trash stays small. Polygon sync state and AI
    // conversations are kept, so a restored problem still knows what was pushed.
    const cache = path.join(ref.dir, '.polyforge');
    for (const d of ['tests', 'testsets', 'build', 'runs', 'export', 'tmp']) await fsp.rm(path.join(cache, d), { recursive: true, force: true });
    for (const s of await fsp.readdir(path.join(cache, 'ai')).catch(() => [] as string[])) {
      await fsp.rm(path.join(cache, 'ai', s, 'work'), { recursive: true, force: true });
    }
    // The watcher holds directory handles on Windows; stop it while moving.
    await watcher.stop();
    try {
      await fsp.rename(ref.dir, dest).catch(async (e: NodeJS.ErrnoException) => {
        if (e.code !== 'EXDEV') throw e;
        // Different drive: copy, then remove.
        await fsp.cp(ref.dir, dest, { recursive: true });
        await fsp.rm(ref.dir, { recursive: true, force: true });
      });
    } catch (e) {
      throw new HttpError(500, 'delete_failed', `Could not move the problem folder: ${(e as Error).message}`);
    } finally {
      await watcher.start();
    }
    await registry.scan();
    hub.broadcast({ type: 'problems:changed' });
    hub.broadcast({ type: 'contests:changed' });
    return { ok: true, trash: dest };
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
    if (req.params['*'] !== 'problem.toml') await registry.fileChanged(ref.id, req.params['*']);
    return { hash };
  });

  app.delete<FileParams>('/api/problems/:id/files/*', async (req) => {
    const ref = await registry.get(req.params.id);
    await files.remove(ref.dir, req.params['*']);
    await registry.fileChanged(ref.id, req.params['*'], undefined, true);
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
  const sync = new PolygonSync(deps.judge);
  polygonRoutes(app, deps.judge, sync, deps.jobs, hub);
  contestRoutes(app, { judge: deps.judge, contests: deps.contests, sync, afterImport: () => watcher.start() }, deps.jobs, hub);
  aiRoutes(app, global, agent);

  app.delete<{ Params: { id: string } }>('/api/problems/:id/cache', async req => {
    if (requests > 1 || !idle()) throw new HttpError(409, 'busy', 'Wait for running operations before clearing caches');
    clearingCache = true;
    try {
    await deps.judge.compiler.waitForMaintenance();
    const ref = await registry.get(req.params.id);
    for (const name of ['build', 'tests', 'testsets', 'tmp', 'export']) {
      await fsp.rm(safeJoin(ref.dir, `.polyforge/${name}`), { recursive: true, force: true });
    }
    hub.broadcast({ type: 'problem:changed', problemId: ref.id });
    return { ok: true };
    } finally { clearingCache = false; }
  });

  app.post<{ Params: { id: string }; Body: MoveFileRequest }>('/api/problems/:id/move', async (req) => {
    const ref = await registry.get(req.params.id);
    await files.move(ref.dir, req.body.from, req.body.to);
    await registry.fileChanged(ref.id, req.body.from, req.body.to);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { path: string } }>('/api/problems/:id/mkdir', async (req) => {
    const ref = await registry.get(req.params.id);
    await files.mkdir(ref.dir, req.body.path);
    await registry.createStatementLanguage(ref.id, req.body.path);
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
    await app.register(fastifyStatic, {
      root: deps.webDist,
      // Chunks are content-hashed; index.html must always be fresh so that a reload
      // after a rebuild or update picks up the new chunk names.
      setHeaders: (res, file) => {
        if (file.endsWith('index.html')) res.header('cache-control', 'no-cache');
        else if (file.includes(`${path.sep}assets${path.sep}`)) res.header('cache-control', 'public, max-age=31536000, immutable');
      },
    });
    // SPA fallback: unknown GETs render index.html so client-side routes work on reload.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !path.extname(req.url.split('?')[0])) return reply.header('cache-control', 'no-cache').sendFile('index.html');
      return reply.code(404).send({ error: 'not_found', message: 'Not found' });
    });
  }

  return app;
}
