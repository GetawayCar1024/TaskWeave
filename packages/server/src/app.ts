import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { contestFile } from './workspace/contestFiles.js';
import { defaultParallel } from './judge/runner.js';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import {
  TOKEN_HEADER,
  LEGACY_ID,
  type CreateProblemRequest,
  type MoveFileRequest,
  type PatchProblemRequest,
  type SettingsResponse,
  type WriteFileRequest,
} from '@taskweave/shared';
import { parseDefsToml, readSharedDefs } from './defs.js';
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
import { createLemonChecker } from './judge/lemonChecker.js';
import { detectTools, listDirs } from './tools.js';
import { findSystemFont, systemFontStatus } from './systemFonts.js';
import { HttpError, exists, safeJoin, validateFileName } from './util/fs.js';
import { FileService } from './workspace/files.js';
import { ProblemRegistry } from './workspace/problems.js';
import { moveProblem } from './workspace/move.js';
import type { ProblemWatcher } from './workspace/watcher.js';
import type { WsHub } from './ws.js';
import { convertStatementMode } from './workspace/statements.js';
import { importPackage, inspectPackage } from './imports/packages.js';
import { PackageUploads } from './imports/uploads.js';
import { TrashStore } from './workspace/trash.js';
import { LibraryFolders } from './workspace/library.js';
import type { CreateLibraryFolderRequest, LibraryLocation } from '@taskweave/shared';
import type { PackageImportOptions, PackageSelection, PackageBatchResult } from '@taskweave/shared';

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
  const trash = new TrashStore(global, registry, deps.contests);
  const library = new LibraryFolders(registry, global);
  let requests = 0;
  let clearingCache = false;
  let relocating = false;
  let importing = false;
  app.addHook('onRequest', async req => {
    if (!req.url.startsWith('/ws')) requests++;
    if (clearingCache && req.url.startsWith('/api/')) throw new HttpError(409, 'busy', 'Cache maintenance in progress');
    if (relocating && req.url.startsWith('/api/')) throw new HttpError(409, 'busy', 'A problem folder is being moved; try again shortly');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const active = deps.jobs.list().filter(job => job.kind === 'answers' && job.status === 'running');
      const problem = /^\/api\/problems\/([^/?]+)/.exec(req.url)?.[1];
      if (active.some(job => problem && job.problemId === decodeURIComponent(problem)) || active.length && /^\/api\/contests\/[^/]+\/batch/.test(req.url)) throw new HttpError(409, 'busy', 'Outputs are being updated. Wait for the operation to finish.');
    }
  });
  app.addHook('onResponse', async req => { if (!req.url.startsWith('/ws')) requests--; });
  const idle = () => !agent.running && !deps.jobs.list().some(j => j.status === 'running');
  const workspaceChange = async <T>(run: () => Promise<T>): Promise<T> => {
    if (relocating || clearingCache || importing) throw new HttpError(409, 'busy', 'Another maintenance operation is running');
    relocating = true;
    const watching = watcher.running;
    try {
      await watcher.stop();
      const result = await run();
      agent.forgetIdle();
      hub.broadcast({ type: 'problems:changed' });
      hub.broadcast({ type: 'contests:changed' });
      hub.broadcast({ type: 'trash:changed' });
      return result;
    } finally { relocating = false; if (watching) await watcher.start(); }
  };
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
  app.addContentTypeParser('application/zip', { parseAs: 'buffer', bodyLimit: 256 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  app.addContentTypeParser(['application/xml', 'text/xml'], { parseAs: 'buffer', bodyLimit: 256 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  // DESIGN §8: reject DNS-rebinding hosts and require the launch token on API/WS.
  app.addHook('onRequest', async (req, reply) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (!ALLOWED_HOSTS.has(host)) return reply.code(403).send({ error: 'forbidden_host', message: 'Forbidden host' });
    const isApi = req.url.startsWith('/api/');
    const isWs = req.url.startsWith('/ws');
    if (!isApi && !isWs) return;
    // WebSockets and <img src> (statement images) cannot send headers; nor can the OI worker's font loader.
    const queryOk = isWs || /^\/api\/problems\/[^/]+\/raw\//.test(req.url) || /^\/api\/contests\/[^/]+\/file\/raw\?/.test(req.url) || /^\/api\/system-fonts\/[a-z]+\?/.test(req.url);
    const given = req.headers[TOKEN_HEADER] ?? req.headers[`x-${LEGACY_ID}-token`] ?? (queryOk ? new URL(req.url, 'http://x').searchParams.get('token') : null);
    if (given !== token) return reply.code(401).send({ error: 'unauthorized', message: 'Missing or invalid token' });
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    if (err instanceof PolygonError) return reply.code(502).send({ error: 'polygon_error', message: err.message });
    const e = err as Error & { statusCode?: number; code?: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.code ?? 'bad_request', message: e.message });
    console.error('[taskweave]', err);
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
      if (!image || typeof image.problem !== 'string' || typeof image.path !== 'string' || !/^image-\d+\.[a-zA-Z0-9]+$/.test(image.name) || image.path.includes('\\')) throw new HttpError(400, 'bad_path', 'Invalid image path');
      if (image.problem.startsWith('contest:')) {
        const ref = await deps.contests.get(image.problem.slice('contest:'.length));
        zip.add(`images/${image.name}`, await fsp.readFile(await contestFile(ref.dir, image.path)));
        continue;
      }
      if (!path.posix.normalize(image.path).startsWith('statement/images/')) throw new HttpError(400, 'bad_path', 'Invalid image path');
      const ref = await registry.get(image.problem);
      zip.add(`images/${image.name}`, await fsp.readFile(safeJoin(ref.dir, image.path)));
    }
    return reply.type('application/zip').send(zip.finish());
  });
  app.get('/api/shutdown/status', async () => ({ runningAi: agent.running }));
  app.post<{ Params: { id: string }; Body: { root: string; folder?: string } }>('/api/problems/:id/relocate', async req => {
    if (!idle()) throw new HttpError(409, 'busy', 'Wait for running tasks before moving a problem');
    if (typeof req.body?.root !== 'string') throw new HttpError(400, 'invalid_root', 'Destination root required');
    if (relocating || clearingCache) throw new HttpError(409, 'busy', 'Another maintenance operation is running');
    relocating = true;
    await watcher.stop();
    try {
      const result = await moveProblem(registry, req.params.id, req.body.root, req.body.folder);
      agent.forgetIdle();
      hub.broadcast({ type: 'problems:changed' });
      return result;
    } finally { relocating = false; await watcher.start(); }
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

  app.get('/api/system-fonts', async () => systemFontStatus(global.dir));
  app.get<{ Params: { key: string } }>('/api/system-fonts/:key', async (req, reply) => {
    const file = await findSystemFont(global.dir, req.params.key);
    if (!file) throw new HttpError(404, 'font_not_found', `Font ${req.params.key} is not installed`);
    const stat = await fsp.stat(file);
    const etag = `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
    reply.header('cache-control', 'private, max-age=86400').header('etag', etag).header('x-content-type-options', 'nosniff');
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.type('application/octet-stream').send(await fsp.readFile(file));
  });

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
      return parseDefsToml(await readSharedDefs(global.sharedDir));
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
    const { ZipWriter } = await import('./util/zip.js');
    const { addAttachments } = await import('./workspace/attachments.js');
    const zip = new ZipWriter();
    await addAttachments(zip, ref.dir);
    return reply.type('application/zip').header('content-disposition', `attachment; filename="${config?.problem.name ?? ref.id}-attachments.zip"`).send(zip.finish());
  });

  app.post<{ Params: { id: string }; Body: { name: string; base64: string } }>('/api/problems/:id/attachments', { bodyLimit: 32 * 1024 * 1024 }, async (req) => {
    const ref = await registry.get(req.params.id);
    const { config } = await registry.readConfig(ref);
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
  app.get<{ Querystring: Omit<LibraryLocation, 'recursive'> & { recursive?: string } }>('/api/library/folders', async req => library.list({ ...req.query, recursive: req.query.recursive === '1' }));
  app.post<{ Body: CreateLibraryFolderRequest }>('/api/library/folders', async req => {
    const result = await library.create(req.body);
    hub.broadcast({ type: 'problems:changed' }); hub.broadcast({ type: 'contests:changed' });
    return result;
  });
  app.post<{ Params: { id: string }; Body: { folder?: string } }>('/api/contests/:id/relocate', async req => {
    if (!idle()) throw new HttpError(409, 'busy', 'Wait for running tasks before moving a contest');
    return workspaceChange(() => deps.contests.move(req.params.id, req.body?.folder));
  });
  app.get('/api/trash', async () => ({ entries: await trash.list(), roots: registry.roots }));
  app.post<{ Params: { key: string }; Body: { root?: string } }>('/api/trash/:key/restore', async req => workspaceChange(() => trash.restore(req.params.key, req.body ?? {})));
  app.delete<{ Params: { key: string } }>('/api/trash/:key', async req => workspaceChange(async () => { await trash.remove(req.params.key); return { ok: true }; }));
  app.delete<{ Body: { entries: string[] } }>('/api/trash', async req => {
    const keys = req.body?.entries;
    if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string')) throw new HttpError(400, 'bad_request', 'Trash entries required');
    return workspaceChange(async () => { await trash.removeMany(keys); return { ok: true }; });
  });

  const loadPackage = async (bytes: Buffer, options: PackageImportOptions, id?: string) => {
    if (!Buffer.isBuffer(bytes)) throw new HttpError(400, 'bad_request', 'Upload a ZIP file.');
    if (!idle() || importing) throw new HttpError(409, 'busy', 'Wait for running tasks before importing data');
    importing = true;
    try {
      const result = await importPackage(deps.judge, bytes, options, id);
      hub.broadcast({ type: 'problems:changed' });
      if (id) hub.broadcast({ type: 'problem:changed', problemId: id });
      return result;
    } finally { importing = false; }
  };
  const packageUploads = new PackageUploads(global.dir);
  app.addHook('onClose', () => packageUploads.dispose());
  app.post<{ Body: Buffer; Querystring: PackageImportOptions }>('/api/packages/uploads', { bodyLimit: 256 * 1024 * 1024 }, async req => packageUploads.stage(req.body, req.query));
  app.post<{ Body: PackageImportOptions & { path: string } }>('/api/packages/directories', async req => packageUploads.stageDirectory(req.body?.path, { ...req.body, format: req.body?.format ?? 'auto' }));
  app.delete<{ Params: { id: string } }>('/api/packages/uploads/:id', async req => { await packageUploads.discard(req.params.id); return { ok: true }; });
  app.post<{ Body: { items: PackageSelection[]; problemId?: string } }>('/api/packages/import', async req => {
    const { items, problemId } = req.body ?? {};
    if (!Array.isArray(items) || !items.length || items.length > 1000 || items.some(item => !item || typeof item.uploadId !== 'string') || problemId && items.length !== 1) throw new HttpError(400, 'bad_request', 'Select problems to import.');
    if (!idle() || importing) throw new HttpError(409, 'busy', 'Wait for running tasks before importing data');
    if (!problemId) for (const item of items) registry.requireRoot(item.root);
    importing = true;
    const results = new Map<PackageSelection, PackageBatchResult['items'][number]>();
    try {
      // Group by upload: one decompression even when a contest archive contains many problems.
      for (const uploadId of new Set(items.map(item => item.uploadId))) {
        const selections = items.filter(item => item.uploadId === uploadId);
        let archive: Map<string, Buffer>;
        try { archive = await packageUploads.read(uploadId, selections[0].format); }
        catch (e) { for (const item of selections) results.set(item, { name: item.name ?? '', error: (e as Error).message }); continue; }
        for (const item of selections) {
          try {
            if (item.format !== selections[0].format) throw new HttpError(400, 'bad_request', 'Mixed formats for one uploaded archive.');
            results.set(item, { name: item.name ?? '', result: await importPackage(deps.judge, archive, item, problemId) });
          } catch (e) { results.set(item, { name: item.name ?? '', error: (e as Error).message }); }
        }
      }
      hub.broadcast({ type: 'problems:changed' });
      if (problemId) hub.broadcast({ type: 'problem:changed', problemId });
      return { items: items.map(item => results.get(item)!) } satisfies PackageBatchResult;
    } finally { importing = false; }
  });
  app.post<{ Body: Buffer; Querystring: PackageImportOptions & { preview?: string } }>('/api/problems/import/package', { bodyLimit: 256 * 1024 * 1024 }, async req => {
    if (req.query.preview === '1') return inspectPackage(req.body, req.query);
    registry.requireRoot(req.query.root);
    return loadPackage(req.body, req.query);
  });
  app.post<{ Params: { id: string }; Body: Buffer; Querystring: PackageImportOptions }>('/api/problems/:id/import/data', { bodyLimit: 256 * 1024 * 1024 }, async req => loadPackage(req.body, req.query, req.params.id));

  app.post<{ Body: CreateProblemRequest }>('/api/problems', async (req, reply) => {
    const summary = await registry.create(req.body ?? ({} as CreateProblemRequest));
    hub.broadcast({ type: 'problems:changed' });
    return reply.code(201).send(summary);
  });

  app.get<{ Params: { id: string } }>('/api/problems/:id', async (req) => registry.detail(req.params.id));
  app.post<{ Params: { id: string }; Body: { lang: string; mode: 'whole' | 'sections' } }>('/api/problems/:id/statement-mode', async req => {
    if (!idle()) throw new HttpError(409, 'busy', 'Wait for running tasks before converting the statement');
    const ref = await registry.get(req.params.id);
    await convertStatementMode(ref.dir, req.body?.lang, req.body?.mode);
    hub.broadcast({ type: 'problem:changed', problemId: ref.id });
    return registry.detail(ref.id);
  });
  app.post<{ Params: { id: string } }>('/api/problems/:id/lemon-checker', async req => {
    const result = await createLemonChecker(deps.judge, req.params.id);
    hub.broadcast({ type: 'problem:changed', problemId: req.params.id });
    return result;
  });

  app.patch<{ Params: { id: string }; Body: PatchProblemRequest }>('/api/problems/:id', async (req) => {
    if (req.body?.name !== undefined && (!idle() || importing)) throw new HttpError(409, 'busy', 'Wait for running tasks before renaming a problem');
    const update = async () => {
      const detail = await registry.patch(req.params.id, req.body ?? {});
      hub.broadcast({ type: 'problem:changed', problemId: req.params.id });
      if (req.body?.name !== undefined) {
        hub.broadcast({ type: 'problems:changed' });
        hub.broadcast({ type: 'contests:changed' });
      }
      return detail;
    };
    const ref = await registry.get(req.params.id);
    const movesFolder = typeof req.body?.name === 'string' && path.basename(ref.dir) !== req.body.name.trim();
    return movesFolder ? workspaceChange(update) : update();
  });

  /** Recycle the complete workspace. Restoring its stable identity reconnects contests. */
  app.delete<{ Params: { id: string } }>('/api/problems/:id', async (req) => {
    const ref = await registry.get(req.params.id);
    const busy = deps.jobs.list(ref.id).find((j) => j.status === 'running');
    if (busy) throw new HttpError(409, 'busy', `A ${busy.kind} job is running for this problem`);
    // Contest batches and contest AI sessions work on every problem of the contest.
    const owners = new Set([ref.id, ...(await deps.contests.list()).filter(c => c.problems.some(p => p.problem === ref.id)).map(c => `contest:${c.id}`)]);
    if (deps.jobs.list().some(j => j.status === 'running' && j.problemId !== ref.id && owners.has(j.problemId))) {
      throw new HttpError(409, 'busy', 'A contest task using this problem is running');
    }
    if (agent.runningFor(owners)) throw new HttpError(409, 'busy', 'An AI session is working on this problem');
    return workspaceChange(async () => ({ ok: true, ...await trash.recycleProblem(ref.id) }));
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
    else {
      // The watcher suppresses our own writes; other views (lists, contests) must still refresh.
      hub.broadcast({ type: 'problem:changed', problemId: ref.id });
      hub.broadcast({ type: 'problems:changed' });
    }
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
    // The token travels in the query string: never let a file (SVG especially) run script.
    // PDFs are left without CSP: Chromium's viewer refuses to render sandboxed documents.
    reply.type(types[ext] ?? 'application/octet-stream').header('cache-control', 'no-cache').header('x-content-type-options', 'nosniff');
    if (ext !== '.pdf') reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
    return reply.send(data);
  });

  judgeRoutes(app, deps.judge, deps.jobs);
  const sync = new PolygonSync(deps.judge);
  polygonRoutes(app, deps.judge, sync, deps.jobs, hub);
  contestRoutes(app, { judge: deps.judge, contests: deps.contests, sync, afterImport: () => watcher.start(), aiRunning: owner => agent.runningFor(new Set([owner])), recycleContest: id => workspaceChange(() => trash.recycleContest(id)) }, deps.jobs, hub);
  aiRoutes(app, global, agent);

  app.delete<{ Params: { id: string } }>('/api/problems/:id/cache', async req => {
    if (requests > 1 || !idle()) throw new HttpError(409, 'busy', 'Wait for running operations before clearing caches');
    clearingCache = true;
    try {
    await deps.judge.compiler.waitForMaintenance();
    const ref = await registry.get(req.params.id);
    for (const name of ['build', 'tests', 'testsets', 'tmp', 'export']) {
      await fsp.rm(safeJoin(ref.dir, `.taskweave/${name}`), { recursive: true, force: true });
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
