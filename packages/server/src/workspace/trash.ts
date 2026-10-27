import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse } from 'smol-toml';
import type { RestoreTrashRequest, TrashEntry } from '@polyforge/shared';
import { samePath, type GlobalStore } from '../global.js';
import { atomicWrite, exists, HttpError, safeJoin, validateFileName } from '../util/fs.js';
import type { ProblemRef, ProblemRegistry } from './problems.js';
import type { ContestRegistry } from './contests.js';

const META = '.polyforge-trash.json';
type Metadata = Omit<TrashEntry, 'key' | 'size' | 'legacy' | 'error'> & { version: 1; folder: string };
const within = (parent: string, child: string) => { const rel = path.relative(parent, child); return rel === '' || rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };

async function directorySize(dir: string): Promise<number> {
  let size = 0;
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, ent.name);
    if (ent.isSymbolicLink()) continue;
    size += ent.isDirectory() ? await directorySize(file) : (await fs.stat(file)).size;
  }
  return size;
}

/** Publish a complete cross-drive copy before removing the original. Failed cleanup leaves the copy recoverable. */
async function moveDirectory(from: string, to: string) {
  try { await fs.rename(from, to); return; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e; }
  const staging = path.join(path.dirname(to), `.pf-copy-${randomBytes(6).toString('hex')}`);
  try {
    await fs.cp(from, staging, { recursive: true, dereference: false, verbatimSymlinks: true, force: false, errorOnExist: true });
    if (await exists(to)) throw new HttpError(409, 'exists', `Folder already exists: ${to}`);
    await fs.rename(staging, to);
  } catch (e) { await fs.rm(staging, { recursive: true, force: true }); throw e; }
  await fs.rm(from, { recursive: true, force: true });
}

/** Managed entries plus the problem folders produced by earlier PolyForge versions. */
export class TrashStore {
  readonly dir: string;
  constructor(private global: GlobalStore, private problems: ProblemRegistry, private contests: ContestRegistry) {
    this.dir = path.join(global.dir, 'trash');
  }

  private async entryDir(key: string) {
    if (typeof key !== 'string' || /[\\/]/.test(key)) throw new HttpError(400, 'bad_trash_entry', 'Invalid trash entry');
    validateFileName(key);
    const dir = safeJoin(this.dir, key), stat = await fs.lstat(dir).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new HttpError(404, 'trash_not_found', 'Trash entry not found');
    return dir;
  }

  private async inspect(key: string): Promise<{ entry: TrashEntry; payload: string; folder: string }> {
    const dir = await this.entryDir(key);
    const legacy = await exists(path.join(dir, 'problem.toml'));
    if (legacy) {
      const raw = parse(await fs.readFile(path.join(dir, 'problem.toml'), 'utf8')) as Record<string, any>;
      const folder = key.replace(/-\d{8}-\d{6}$/, '');
      const identity = (await fs.readFile(path.join(dir, '.polyforge/identity'), 'utf8').catch(() => '')).trim();
      return { payload: dir, folder, entry: { key, kind: 'problem', name: raw.problem?.name ?? folder, title: raw.problem?.title ?? {},
        originalId: identity || folder, deletedAt: (await fs.stat(dir)).mtime.toISOString(), size: await directorySize(dir), legacy: true } };
    }
    if (!await exists(path.join(dir, META))) throw new HttpError(404, 'trash_not_found', 'Trash entry not found');
    const meta: Metadata = JSON.parse(await fs.readFile(path.join(dir, META), 'utf8'));
    if (meta.version !== 1 || !['problem', 'contest'].includes(meta.kind) || typeof meta.folder !== 'string' || /[\\/]/.test(meta.folder)) throw new HttpError(400, 'bad_trash_entry', 'Invalid trash metadata');
    validateFileName(meta.folder);
    const payload = path.join(dir, 'content'), stat = await fs.lstat(payload).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new HttpError(400, 'bad_trash_entry', 'Trash content is missing');
    return { payload, folder: meta.folder, entry: { key, kind: meta.kind, name: meta.name, title: meta.title, deletedAt: meta.deletedAt,
      originalDir: meta.originalDir, originalRoot: meta.originalRoot, originalId: meta.originalId, size: await directorySize(payload) } };
  }

  async list(): Promise<TrashEntry[]> {
    await fs.mkdir(this.dir, { recursive: true });
    const entries: TrashEntry[] = [];
    for (const ent of await fs.readdir(this.dir, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.isSymbolicLink() || ent.name.startsWith('.')) continue;
      const dir = path.join(this.dir, ent.name);
      if (!await exists(path.join(dir, META)) && !await exists(path.join(dir, 'problem.toml'))) continue;
      try { entries.push((await this.inspect(ent.name)).entry); }
      catch (e) { entries.push({ key: ent.name, kind: 'problem', name: ent.name, title: {}, size: 0, deletedAt: '', error: (e as Error).message }); }
    }
    return entries.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }

  private async put(kind: Metadata['kind'], ref: ProblemRef, name: string, title: Record<string, string>) {
    if ((await fs.lstat(ref.dir)).isSymbolicLink()) throw new HttpError(400, 'bad_trash_entry', 'Cannot recycle a linked workspace');
    const deletedAt = new Date().toISOString();
    const key = `${kind}-${deletedAt.replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`;
    const dir = path.join(this.dir, key), payload = path.join(dir, 'content');
    const meta: Metadata = { version: 1, kind, name, title, deletedAt, originalDir: ref.dir, originalRoot: ref.root, originalId: ref.id, folder: path.basename(ref.dir) };
    await atomicWrite(path.join(dir, META), JSON.stringify(meta, null, 2));
    try { await moveDirectory(ref.dir, payload); }
    catch (e) {
      // A cross-drive cleanup error must not discard the only complete remaining copy.
      if (!await exists(payload)) await fs.rm(dir, { recursive: true, force: true });
      throw e;
    }
    await this.problems.scan(); await this.contests.scan();
    return { key, trash: payload };
  }

  async recycleProblem(id: string) {
    const ref = await this.problems.get(id), summary = await this.problems.summary(ref);
    return this.put('problem', ref, summary.name, summary.title);
  }

  async recycleContest(id: string) {
    const { summary } = await this.contests.detail(id), ref = await this.contests.get(id);
    if ((await this.problems.scan()).some(p => within(ref.dir, p.dir)) || this.problems.roots.some(root => within(ref.dir, root))) {
      throw new HttpError(400, 'shared_contest_folder', 'Move the contest to its own folder before recycling it.');
    }
    return this.put('contest', ref, summary.name, summary.title);
  }

  async restore(key: string, req: RestoreTrashRequest = {}): Promise<{ kind: TrashEntry['kind']; id: string }> {
    const { entry, payload, folder } = await this.inspect(key);
    const root = entry.kind === 'contest' ? this.contests.dir : this.problems.requireRoot(req.root ??
      (entry.originalRoot && this.problems.roots.some(root => samePath(root, entry.originalRoot!)) ? entry.originalRoot : this.problems.roots[0]));
    const target = safeJoin(root, folder);
    if (await exists(target)) throw new HttpError(409, 'exists', `Restore destination already exists: ${target}`);
    if (entry.kind === 'problem' && (await this.problems.scan()).some(p => p.id === entry.originalId)) throw new HttpError(409, 'exists', 'A problem with this identity already exists.');
    if (entry.kind === 'contest' && (await this.contests.list()).some(c => c.id === entry.originalId || c.name === entry.name)) throw new HttpError(409, 'exists', 'A contest with this identity or name already exists.');
    await fs.mkdir(root, { recursive: true });
    await moveDirectory(payload, target);
    if (!entry.legacy) await fs.rm(await this.entryDir(key), { recursive: true, force: true });
    const refs = entry.kind === 'problem' ? await this.problems.scan() : await this.contests.scan();
    const restored = refs.find(ref => samePath(ref.dir, target));
    if (!restored) throw new HttpError(500, 'restore_failed', 'Restored workspace could not be loaded');
    return { kind: entry.kind, id: restored.id };
  }

  async remove(key: string) {
    await this.removeMany([key]);
  }

  async removeMany(keys: string[]) {
    const dirs = await Promise.all([...new Set(keys)].map(async key => {
      const dir = await this.entryDir(key);
      if (!await exists(path.join(dir, META)) && !await exists(path.join(dir, 'problem.toml'))) throw new HttpError(404, 'trash_not_found', 'Trash entry not found');
      return dir;
    }));
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}
