import { promises as fs, existsSync, readdirSync, renameSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import { LEGACY_ID, LEGACY_NAME, LEGACY_STATE } from '@taskweave/shared';
import { atomicWrite, HttpError } from '../util/fs.js';

/** Rename only the application's own state directory, preserving identity and all bytes. */
export async function migrateWorkspaceState(directory: string): Promise<void> {
  await renameState(path.join(directory, LEGACY_STATE), path.join(directory, '.taskweave'));
}
const moving = new Map<string, Promise<void>>();
function renameState(from: string, to: string): Promise<void> {
  const key = process.platform === 'win32' ? from.toLowerCase() : from;
  let work = moving.get(key);
  if (!work) { work = moveState(from, to).finally(() => moving.delete(key)); moving.set(key, work); }
  return work;
}
async function moveState(from: string, to: string): Promise<void> {
  const old = await fs.lstat(from).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!old) return;
  if (old.isSymbolicLink()) throw new HttpError(400, 'migration_link', `Cannot migrate linked application state: ${from}`);
  const current = await fs.lstat(to).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (current) {
    if (old.isDirectory() && current.isDirectory() && !current.isSymbolicLink() && !(await fs.readdir(to)).length) await fs.rmdir(to);
    else throw new HttpError(409, 'migration_conflict', `Both old and new application state exist: ${from} / ${to}. Keep both copies and resolve the conflict before opening this workspace.`);
  }
  await fs.rename(from, to);
}

/** Called before creating any new default-profile files. An empty target is harmless. */
export function migrateDefaultProfile(parent: string): string {
  const current = path.join(parent, '.taskweave'), old = path.join(parent, LEGACY_STATE);
  if (existsSync(path.join(current, 'config.toml')) || !existsSync(path.join(old, 'config.toml'))) return current;
  if (existsSync(current)) {
    if (readdirSync(current).length) throw new HttpError(409, 'migration_conflict', 'The new profile already contains files. Resolve the old/new profile conflict before upgrading.');
    rmdirSync(current);
  }
  renameSync(old, current);
  return current;
}

export function migrateDesktopProfile(parent: string): string {
  const current = path.join(parent, 'TaskWeave');
  if (existsSync(current)) return current;
  for (const name of [LEGACY_NAME, 'Taskweave']) {
    const old = path.join(parent, name);
    if (existsSync(old)) { renameSync(old, current); break; }
  }
  return current;
}
function profilePath(home: string, value: unknown): unknown {
  if (path.basename(home) !== '.taskweave' || typeof value !== 'string' || !path.isAbsolute(value)) return value;
  const old = path.join(path.dirname(home), LEGACY_STATE);
  if (existsSync(old)) return value;
  const relative = path.relative(old, value);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep) ? path.join(home, relative) : value;
}
export async function migrateProfilePaths(home: string): Promise<void> {
  const file = path.join(home, 'config.toml'), before = await fs.readFile(file, 'utf8');
  let doc: Record<string, any>;
  try { doc = parse(before) as Record<string, any>; } catch { return; }
  const old = JSON.stringify(doc);
  if (Array.isArray(doc.problems?.roots)) doc.problems.roots = doc.problems.roots.map((root: string) => profilePath(home, root));
  if (doc.contests?.dir) doc.contests.dir = profilePath(home, doc.contests.dir);
  if (JSON.stringify(doc) === old) return;
  const backup = path.join(home, 'migration', 'profile-config.toml');
  if (!existsSync(backup)) await atomicWrite(backup, before);
  await atomicWrite(file, stringify(doc));
}

/** Older recycle entries may still point at payloads on their original volume. */
export async function migrateTrashEntry(directory: string): Promise<void> {
  const old = path.join(directory, `${LEGACY_STATE}-trash.json`), current = path.join(directory, '.taskweave-trash.json');
  if (await fs.stat(old).catch(() => null)) await renameState(old, current);
  const file = await fs.readFile(current, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!file) { await migrateWorkspaceState(directory); return; }
  let meta: Record<string, any>;
  try { meta = JSON.parse(file); } catch { return; }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return;
  const home = path.dirname(path.dirname(directory));
  const original = JSON.stringify(meta);
  for (const key of ['originalRoot', 'originalDir']) if (meta[key]) meta[key] = profilePath(home, meta[key]);
  if (JSON.stringify(meta) !== original) await atomicWrite(current, JSON.stringify(meta, null, 2));
  if (meta.version === 2 && typeof meta.originalRoot === 'string' && path.isAbsolute(meta.originalRoot)) {
    await renameState(path.join(meta.originalRoot, `${LEGACY_STATE}-trash`), path.join(meta.originalRoot, '.taskweave-trash'));
  }
  // A restored workspace is migrated by its registry; no copies of answer data are made here.
}

/** Package manifests keep their original bytes; normalize only the parsed extension fields. */
export function packageMetadata<T extends Record<string, any>>(value: T): T {
  if (value.taskweave === undefined && value[LEGACY_ID] !== undefined) return { ...value, taskweave: value[LEGACY_ID] };
  return value;
}
