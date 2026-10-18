import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import {
  PROBLEM_NAME_RE,
  judgeMode,
  polygonFeatureWarnings,
  testsetsOf,
  type ImportRequest,
  type ItemContent,
  type PolygonProblem,
  type ProblemSummary,
  type PullItem,
  type PullPreview,
  type PullRequest,
  type PushItem,
  type PushPreview,
  type PushRequest,
} from '@polyforge/shared';
import type { JobCtx } from '../jobs.js';
import type { Judge, ProblemCtx } from '../judge/index.js';
import { atomicWrite, exists, HttpError, looksBinary } from '../util/fs.js';
import { PROBLEM_FILE } from '../workspace/problems.js';
import { PolygonClient } from './client.js';
import { buildAndVerify } from './buildPackage.js';
import { merge3, mergeMeta } from './merge.js';
import {
  applyItem,
  DELETABLE_KINDS,
  itemDisplay,
  itemHash,
  localItems,
  pushItem,
  PUSH_ORDER,
  remoteItems,
  removeLocal,
  untrackedItems,
  TESTSET,
  type Item,
} from './items.js';

/** `.polyforge/sync.json`: hashes of every item as of the last push/pull (DESIGN §3.2). */
interface SyncState {
  polygonId?: number;
  revision?: number;
  /** Polygon had uncommitted edits at `revision` when this sync ran (they are in the base). */
  uncommitted?: boolean;
  lastSync?: string;
  items: Record<string, string>;
}

const syncPath = (ctx: ProblemCtx) => path.join(ctx.work, 'sync.json');

async function readSync(ctx: ProblemCtx): Promise<SyncState> {
  try {
    const s = JSON.parse(await fsp.readFile(syncPath(ctx), 'utf8')) as SyncState;
    // State recorded for another Polygon problem is meaningless for this binding.
    if (ctx.config.polygon.id !== undefined && s.polygonId !== undefined && s.polygonId !== ctx.config.polygon.id) return { items: {} };
    return { ...s, items: s.items ?? {} };
  } catch {
    return { items: {} };
  }
}

async function writeSync(ctx: ProblemCtx, s: SyncState) {
  await atomicWrite(syncPath(ctx), JSON.stringify(s, null, 1));
}

/**
 * Content of text items as of the last sync (`.polyforge/sync-base/`), the common
 * ancestor for three-way merges. Binary items only need their hash.
 */
interface BaseSnapshot {
  text: string;
  meta?: Record<string, unknown>;
}
const baseDir = (ctx: ProblemCtx) => path.join(ctx.work, 'sync-base');
const baseFile = (ctx: ProblemCtx, key: string) => path.join(baseDir(ctx), `${createHash('sha1').update(key).digest('hex')}.json`);

async function saveBase(ctx: ProblemCtx, it: Item) {
  if (it.text === undefined) return;
  await atomicWrite(baseFile(ctx, it.key), JSON.stringify({ key: it.key, text: it.text, meta: it.meta }));
}
async function loadBase(ctx: ProblemCtx, key: string): Promise<BaseSnapshot | null> {
  try {
    return JSON.parse(await fsp.readFile(baseFile(ctx, key), 'utf8')) as BaseSnapshot;
  } catch {
    return null;
  }
}
async function dropBase(ctx: ProblemCtx, key: string) {
  await fsp.rm(baseFile(ctx, key), { force: true });
}

/** The merge of local and remote against the recorded base, if one is possible. */
function mergeItems(l: Item, r: Item, base: BaseSnapshot): Item | null {
  // Testsets are structured data: take one side instead of merging lines.
  if (l.kind === 'testset') return null;
  if (l.text === undefined || r.text === undefined) return null;
  const m = merge3(l.text, base.text, r.text);
  return { ...l, text: m.text, meta: mergeMeta(l.meta, base.meta, r.meta), extra: { ...l.extra, mergeConflicts: m.conflicts } };
}

const byOrder = (a: { kind: string; key: string }, b: { kind: string; key: string }) =>
  PUSH_ORDER.indexOf(a.kind as never) - PUSH_ORDER.indexOf(b.kind as never) || a.key.localeCompare(b.key, undefined, { numeric: true });

const extraTestsets = (ctx: ProblemCtx) => testsetsOf(ctx.config).map((t) => t.name).filter((n) => n !== TESTSET);

const strip = ({ text: _t, bytes, meta: _m, extra: _e, ...rest }: Item) => ({ ...rest, binary: bytes ? looksBinary(bytes) : false });

export class PolygonSync {
  /** Last fetched remote items per problem, for diffs and pull. */
  private remoteCache = new Map<string, { polygonId: number; items: Item[] }>();

  constructor(private judge: Judge) {}

  async client(): Promise<PolygonClient> {
    const c = await this.judge.global.polygonCredentials();
    return new PolygonClient(c);
  }

  async problemInfo(client: PolygonClient, id: number): Promise<PolygonProblem | undefined> {
    const list = await client.call<PolygonProblem[]>('problems.list', { id });
    const found = list.find((p) => p.id === id);
    if (!found) throw new HttpError(404, 'polygon_not_found', `Polygon problem #${id} was deleted or you no longer have access. Unbind it or choose another problem.`);
    return found;
  }

  async listProblems(): Promise<PolygonProblem[]> {
    return (await this.client()).call<PolygonProblem[]>('problems.list', {});
  }

  async testConnection(): Promise<{ ok: true; problems: number; ms: number }> {
    const t0 = Date.now();
    const list = await this.listProblems();
    return { ok: true, problems: list.length, ms: Date.now() - t0 };
  }

  /** Local side of the sync state, without asking Polygon (the contest status table). */
  async localStatus(ctx: ProblemCtx): Promise<{ changes: number; syncedRevision?: number; syncedUncommitted: boolean; tomlChanged: boolean; warnings: string[] }> {
    if (judgeMode(ctx.config.problem) === 'grader') throw new HttpError(400, 'grader_polygon', 'Grader problems cannot connect to Polygon.');
    if (ctx.config.problem.type === 'oi') throw new HttpError(400, 'oi_polygon', 'OI problems cannot sync with Polygon');
    const { items, warnings } = await localItems(this.judge, ctx);
    const sync = await readSync(ctx);
    const keys = new Set(items.map((i) => i.key));
    const changes = items.filter((it) => sync.items[it.key] !== itemHash(it)).length + Object.keys(sync.items).filter((k) => !keys.has(k)).length;
    return { changes, syncedRevision: sync.revision, syncedUncommitted: !!sync.uncommitted, tomlChanged: false, warnings };
  }

  // ---- push ----

  async pushPreview(ctx: ProblemCtx): Promise<PushPreview> {
    if (judgeMode(ctx.config.problem) === 'grader') return { name: ctx.config.problem.name, blocked: true, items: [], warnings: ['Grader problems cannot connect to Polygon.'] };
    if (ctx.config.problem.type === 'oi') throw new HttpError(400, 'oi_polygon', 'OI problems cannot sync with Polygon');
    const { items, warnings } = await localItems(this.judge, ctx);
    const sync = await readSync(ctx);
    const seen = new Set<string>();
    const out: PushItem[] = items.map((it) => {
      seen.add(it.key);
      const base = sync.items[it.key];
      return { ...strip(it), status: base === undefined ? 'new' : base === itemHash(it) ? 'unchanged' : 'modified' };
    });
    for (const key of Object.keys(sync.items)) {
      if (seen.has(key)) continue;
      const kind = key.split(':')[0] as PushItem['kind'];
      out.push({ key, kind, label: key, status: 'deleted' });
      if (!DELETABLE_KINDS.has(kind)) warnings.push(`${key} was removed locally; Polygon has no delete API, remove it there by hand if needed`);
    }
    out.sort(byOrder);
    const preview: PushPreview = {
      blocked: polygonFeatureWarnings(ctx.config).length > 0,
      polygonId: ctx.config.polygon.id,
      name: ctx.config.problem.name,
      items: out,
      warnings,
      lastSync: sync.lastSync,
      syncedRevision: sync.revision,
    };
    if (ctx.config.polygon.id !== undefined) {
      try {
        const info = await this.problemInfo(await this.client(), ctx.config.polygon.id);
        preview.remoteRevision = info?.revision;
        if (sync.revision !== undefined && info?.revision !== undefined && info.revision !== sync.revision) {
          warnings.unshift(`Polygon revision is ${info.revision} but the last sync saw ${sync.revision}: the problem was changed on Polygon. Pull first to avoid overwriting.`);
        }
      } catch (e) {
        warnings.unshift(`Could not reach Polygon: ${(e as Error).message}`);
      }
    }
    return preview;
  }

  async push(ctx: ProblemCtx, req: PushRequest, job: JobCtx): Promise<{ pushed: string[]; warnings: string[]; revision?: number; polygonId: number }> {
    if (req.buildPackage && !req.commit) throw new HttpError(400, 'commit_required', 'Commit changes before building a package');
    const scoringWarnings = polygonFeatureWarnings(ctx.config);
    if (scoringWarnings.length) throw new HttpError(400, 'polygon_scoring', scoringWarnings.join('\n'));
    if (judgeMode(ctx.config.problem) === 'grader') throw new HttpError(400, 'grader_polygon', 'Grader problems cannot connect to Polygon.');
    if (ctx.config.problem.type === 'oi') throw new HttpError(400, 'oi_polygon', 'OI problems cannot sync with Polygon');
    const client = await this.client();
    const warnings: string[] = [];
    let polygonId = ctx.config.polygon.id;
    if (polygonId !== undefined) await this.problemInfo(client, polygonId);
    const sync = await readSync(ctx);

    if (polygonId === undefined) {
      job.progress(0, 0, 'problem.create');
      const created = await client.call<PolygonProblem>('problem.create', { name: ctx.config.problem.name });
      polygonId = created.id;
      await this.judge.registry.patch(ctx.ref.id, { polygonId });
      sync.items = {};
    }
    sync.polygonId = polygonId;

    this.remoteCache.delete(ctx.ref.id);
    const { items, warnings: localWarnings } = await localItems(this.judge, ctx);
    warnings.push(...localWarnings);
    const want = new Set(req.keys);
    const todo = items.filter((it) => want.has(it.key)).sort(byOrder);
    const deleted = [...want].filter((k) => !items.some((it) => it.key === k) && DELETABLE_KINDS.has(k.split(':')[0] as never));
    const total = todo.length + deleted.length + (req.commit ? 1 : 0) + (req.buildPackage ? 1 : 0);
    let done = 0;
    const pushed: string[] = [];
    const pc = { client, problemId: polygonId, warn: (m: string) => warnings.push(m) };
    // New manual tests and the script's "> $" numbering: Polygon numbers generated tests
    // when the script is saved, so a manual test cannot take an index a generated one has.
    const manual = todo.filter((it) => it.kind === 'test');
    const script = items.find((it) => it.kind === 'script');
    let resaveScript = false;
    const failures: string[] = [];
    try {
      if (manual.length && script) {
        const remote = await client.call<{ index: number; manual: boolean }[]>('problem.tests', { problemId: polygonId, testset: TESTSET, noInputs: true }).catch(() => []);
        const generated = new Set(remote.filter((t) => !t.manual).map((t) => t.index));
        if (manual.some((it) => generated.has(it.extra?.index))) {
          job.progress(done, total, 'problem.saveScript (clear generated tests)');
          await client.call('problem.saveScript', { problemId: polygonId, testset: TESTSET, source: '' });
          // Polygon has no script now: make sure it is sent again, even after a failure.
          delete sync.items[script.key];
        }
        resaveScript = true;
      }
      for (const it of todo) {
        job.signal.throwIfAborted();
        job.progress(done, total, it.label);
        try {
          await pushItem(pc, it);
        } catch (e) {
          failures.push(`${it.label}: ${(e as Error).message}`);
          done++;
          continue;
        }
        sync.items[it.key] = itemHash(it);
        await saveBase(ctx, it);
        pushed.push(it.key);
        done++;
      }
      for (const key of deleted) {
        job.signal.throwIfAborted();
        const [kind, ...rest] = key.split(':');
        const stub: Item =
          kind === 'statement'
            ? { key, kind: 'statement', label: key, extra: { lang: rest[0], section: rest[1] } }
            : { key, kind: 'sample', label: key, extra: { index: Number(rest[0]) } };
        job.progress(done, total, `clear ${key}`);
        await pushItem(pc, stub, true);
        delete sync.items[key];
        await dropBase(ctx, key);
        pushed.push(key);
        done++;
      }
      // Renumber the generated tests around the manual ones, also when the script text is unchanged.
      if (resaveScript && script && !todo.includes(script)) {
        job.progress(done, total, script.label);
        await pushItem(pc, script);
        sync.items[script.key] = itemHash(script);
        await saveBase(ctx, script);
        if (!pushed.includes(script.key)) pushed.push(script.key);
      }
    } finally {
      // Keep what made it, so a retry only sends the rest.
      sync.lastSync = new Date().toISOString();
      await writeSync(ctx, sync);
    }
    if (failures.length) throw new HttpError(502, 'partial_push', `Pushed ${pushed.length} items; ${failures.length} failed. Successful items are saved for retry. Check Polygon source language and compiler diagnostics; local compilation does not guarantee remote compatibility.\n${failures.join('\n')}`);
    if (req.commit) {
      job.progress(done++, total, 'problem.commitChanges');
      await client.call('problem.commitChanges', { problemId: polygonId, minorChanges: false, message: req.message?.trim() || 'PolyForge sync' });
    }
    if (req.buildPackage) {
      job.progress(done++, total, 'problem.buildPackage');
      try { warnings.push(...await buildAndVerify(client, polygonId, req.packageType === 'full', job)); }
      catch (e) { if (job.signal.aborted) throw e; warnings.push(`buildPackage: ${(e as Error).message}. Check Polygon compiler configuration and build diagnostics (including __int128 support).`); }
    }
    const info = await this.problemInfo(client, polygonId).catch(() => undefined);
    sync.revision = info?.revision;
    sync.uncommitted = info?.modified || undefined;
    await writeSync(ctx, sync);
    return { pushed, warnings, revision: sync.revision, polygonId };
  }

  // ---- pull ----

  async pullPreview(ctx: ProblemCtx): Promise<PullPreview> {
    if (judgeMode(ctx.config.problem) === 'grader') throw new HttpError(400, 'grader_polygon', 'Grader problems cannot connect to Polygon.');
    if (ctx.config.problem.type === 'oi') throw new HttpError(400, 'oi_polygon', 'OI problems cannot sync with Polygon');
    const polygonId = ctx.config.polygon.id;
    if (polygonId === undefined) throw new HttpError(400, 'not_bound', 'This problem is not bound to a Polygon problem');
    await this.problemInfo(await this.client(), polygonId);
    const remote = await remoteItems(await this.client(), polygonId, extraTestsets(ctx));
    this.remoteCache.set(ctx.ref.id, { polygonId, items: remote });
    const { items: local, warnings } = await this.pullLocal(ctx);
    const sync = await readSync(ctx);
    const L = new Map(local.map((i) => [i.key, i]));
    const R = new Map(remote.map((i) => [i.key, i]));
    const out: PullItem[] = [];
    for (const key of new Set([...L.keys(), ...R.keys()])) {
      const l = L.get(key);
      const r = R.get(key);
      const lh = l && itemHash(l);
      const rh = r && itemHash(r);
      const base = sync.items[key];
      const it = strip((l ?? r)!);
      if (l && r) {
        if (lh === rh) out.push({ ...it, status: 'same', takeRemote: false });
        else if (base === lh) out.push({ ...it, status: 'remote', takeRemote: true });
        else if (base === rh) out.push({ ...it, status: 'local', takeRemote: false });
        else {
          const base = await loadBase(ctx, key);
          const m = base && mergeItems(l, r, base);
          out.push({ ...it, status: 'conflict', takeRemote: false, mergeable: !!m, mergeConflicts: m ? (m.extra?.mergeConflicts as number) : undefined });
        }
      } else if (r) {
        out.push({ ...it, status: 'remote-only', takeRemote: true });
      } else {
        // Present locally only: deleted on Polygon if it was synced before, else new locally.
        out.push({ ...it, status: 'local-only', takeRemote: false });
      }
    }
    out.sort(byOrder);
    return { polygonId, items: out, warnings };
  }

  async itemContent(ctx: ProblemCtx, key: string): Promise<ItemContent> {
    if (judgeMode(ctx.config.problem) === 'grader') throw new HttpError(400, 'grader_polygon', 'Grader problems cannot connect to Polygon.');
    if (ctx.config.problem.type === 'oi') throw new HttpError(400, 'oi_polygon', 'OI problems cannot sync with Polygon');
    const { items } = key.startsWith('file:') ? await this.pullLocal(ctx) : await localItems(this.judge, ctx);
    const l = items.find((i) => i.key === key);
    const id = ctx.config.polygon.id;
    let cached = this.remoteCache.get(ctx.ref.id);
    // The push dialog asks for diffs without a prior pull: fetch Polygon's state once.
    if (id !== undefined && cached?.polygonId !== id) {
      cached = { polygonId: id, items: await remoteItems(await this.client(), id, extraTestsets(ctx)) };
      this.remoteCache.set(ctx.ref.id, cached);
    }
    const r = cached?.items.find((i) => i.key === key);
    const out: ItemContent = { key, local: l ? itemDisplay(l) : null, remote: r ? itemDisplay(r) : null, binary: [l, r].some(i => i?.bytes && looksBinary(i.bytes)) };
    const base = l && r && itemHash(l) !== itemHash(r) ? await loadBase(ctx, key) : null;
    const m = base && mergeItems(l!, r!, base);
    if (m) {
      out.merged = itemDisplay(m);
      out.mergeConflicts = m.extra?.mergeConflicts as number;
    }
    return out;
  }

  /** Local items for a pull: the synced ones plus files nothing accounts for (deletable). */
  private async pullLocal(ctx: ProblemCtx) {
    const r = await localItems(this.judge, ctx);
    return { ...r, items: [...r.items, ...(await untrackedItems(ctx.ref.dir, ctx.config, r.items))] };
  }

  /** Apply the chosen remote items locally; everything seen on Polygon becomes the new base. */
  async pull(ctx: ProblemCtx, req: PullRequest): Promise<{ applied: string[]; merged: string[]; conflicts: string[]; warnings: string[] }> {
    if (judgeMode(ctx.config.problem) === 'grader') throw new HttpError(400, 'grader_polygon', 'Grader problems cannot connect to Polygon.');
    if (ctx.config.problem.type === 'oi') throw new HttpError(400, 'oi_polygon', 'OI problems cannot sync with Polygon');
    const cached = this.remoteCache.get(ctx.ref.id);
    if (!cached || cached.polygonId !== ctx.config.polygon.id) throw new HttpError(409, 'stale_preview', 'Fetch the Polygon state first');
    const { items: local } = await this.pullLocal(ctx);
    const L = new Map(local.map((i) => [i.key, i]));
    const R = new Map(cached.items.map((i) => [i.key, i]));
    const take = new Set(req.take);
    const mergeKeys = new Set((req.merge ?? []).filter((k) => !take.has(k)));
    const sync = await readSync(ctx);
    const problemFile = path.join(ctx.ref.dir, PROBLEM_FILE);
    const doc = parse(await fsp.readFile(problemFile, 'utf8')) as Record<string, any>;
    const remoteConfig = R.get('config')?.meta;
    const languages = (await this.judge.global.readLanguages()).languages;
    const sourceLanguages = Object.fromEntries(Object.entries(languages).filter(([, lang]) => lang.polygon).map(([id, lang]) => [lang.polygon!, id]));
    const ac = { dir: ctx.ref.dir, doc, remoteConfig, sourceLanguages, written: new Set<string>() };
    const applied: string[] = [];
    // Sources before config, so role paths resolve to files that exist.
    const keys = [...take].sort((a, b) => byOrder({ kind: a.split(':')[0], key: a }, { kind: b.split(':')[0], key: b }));
    for (const key of keys) {
      const r = R.get(key);
      const l = L.get(key);
      if (r) await applyItem({ ...ac, local: l }, r);
      else if (l) await removeLocal({ ...ac, local: l }, l);
      else continue;
      applied.push(key);
    }
    const merged: string[] = [];
    const conflicts: string[] = [];
    for (const key of mergeKeys) {
      const l = L.get(key);
      const r = R.get(key);
      const base = await loadBase(ctx, key);
      const m = l && r && base && mergeItems(l, r, base);
      if (!m) continue;
      await applyItem({ ...ac, local: l }, m);
      merged.push(key);
      if ((m.extra?.mergeConflicts as number) > 0) conflicts.push(key);
    }
    if (doc.solutions?.length && !doc.solutions.some((s: any) => s.tag === 'MA')) doc.solutions[0].tag = 'MA';
    // Rewriting drops comments: only when something was actually applied.
    if (applied.length || merged.length) await atomicWrite(problemFile, stringify(doc) + '\n');
    // Polygon's state is now the common ancestor for every key it has.
    for (const [key, r] of R) {
      sync.items[key] = itemHash(r);
      await saveBase(ctx, r);
    }
    for (const key of Object.keys(sync.items)) {
      if (R.has(key)) continue;
      delete sync.items[key];
      await dropBase(ctx, key);
    }
    sync.polygonId = cached.polygonId;
    sync.lastSync = new Date().toISOString();
    try {
      const info = await this.problemInfo(await this.client(), cached.polygonId);
      sync.revision = info?.revision;
      sync.uncommitted = info?.modified || undefined;
    } catch {
      /* keep the old revision */
    }
    await writeSync(ctx, sync);

    // Items whose local form differs from Polygon's after writing reveal a lossy mapping.
    const fresh = await this.judge.ctx(ctx.ref.id);
    const after = new Map((await localItems(this.judge, fresh)).items.map((i) => [i.key, i]));
    const warnings: string[] = [];
    for (const key of applied) {
      const r = R.get(key);
      const a = after.get(key);
      if (r && a && itemHash(a) !== itemHash(r)) warnings.push(`${key}: the local copy does not round-trip exactly`);
    }
    if (conflicts.length) warnings.unshift(`Merged with conflict markers (<<<<<<< / >>>>>>>), resolve them in the editor: ${conflicts.join(', ')}`);
    return { applied, merged, conflicts, warnings };
  }

  // ---- import ----

  async importProblem(req: ImportRequest, job: JobCtx, known?: PolygonProblem): Promise<ProblemSummary> {
    const client = await this.client();
    job.progress(0, 3, 'problems.list');
    const info = known ?? await this.problemInfo(client, req.polygonId);
    if (!info) throw new HttpError(404, 'polygon_not_found', `Polygon problem ${req.polygonId} not found or not accessible`);
    const name = (req.name?.trim() || info.name).toLowerCase();
    if (!PROBLEM_NAME_RE.test(name)) throw new HttpError(400, 'invalid_name', `Invalid local name: ${name}`);
    const roots = this.judge.registry.roots;
    const root = req.root ?? roots[0];
    if (!root) throw new HttpError(400, 'no_root', 'No problem root directory configured');
    const dir = path.join(root, name);
    if (await exists(dir)) throw new HttpError(409, 'exists', `Folder already exists: ${dir}`);

    await fsp.mkdir(dir, { recursive: true });
    await atomicWrite(path.join(dir, PROBLEM_FILE), stringify({ problem: { name }, polygon: { id: req.polygonId } }) + '\n');
    try {
      await this.judge.registry.scan();
      const ref = (await this.judge.registry.list()).find((p) => path.resolve(p.dir) === path.resolve(dir));
      if (!ref) throw new Error('imported problem not found after scan');
      job.progress(1, 3, 'downloading from Polygon');
      const ctx = await this.judge.ctx(ref.id);
      const preview = await this.pullPreview(ctx);
      job.progress(2, 3, 'writing files');
      const res = await this.pull(ctx, { take: preview.items.filter((i) => i.status !== 'local-only').map((i) => i.key) });
      if (res.warnings.length) console.warn('[polyforge] import:', res.warnings.join('; '));
      job.progress(3, 3, 'done');
      return (await this.judge.registry.list()).find((p) => p.id === ref.id)!;
    } catch (e) {
      await fsp.rm(dir, { recursive: true, force: true });
      await this.judge.registry.scan();
      throw e;
    }
  }
}
