import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { HttpError, exists } from '../util/fs.js';
import type { ProblemRegistry } from './problems.js';
import { libraryParent } from './library.js';
import { samePath } from '../global.js';

async function manifest(root: string, base = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fs.readdir(path.join(root, base), { withFileTypes: true })) {
    const rel = path.join(base, entry.name);
    if (entry.isSymbolicLink()) throw new HttpError(400, 'symlink', 'Move does not support symbolic links');
    if (entry.isDirectory()) result.push(...await manifest(root, rel));
    else result.push(rel + ':' + createHash('sha256').update(await fs.readFile(path.join(root, rel))).digest('hex'));
  }
  return result.sort();
}

export async function moveProblem(registry: ProblemRegistry, id: string, targetRoot: string, folder = '') {
  const ref = await registry.get(id);
  const root = await registry.ensureRoot(targetRoot);
  const parent = await libraryParent(root, folder);
  const destination = path.join(parent, path.basename(ref.dir));
  if (samePath(destination, ref.dir)) return registry.summary(await registry.get(id));
  if (await exists(destination)) throw new HttpError(409, 'exists', 'Destination folder already exists');
  const before = await manifest(ref.dir);
  try { await fs.rename(ref.dir, destination); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    // A hidden staging directory never appears as a partially moved problem.
    const staging = path.join(parent, `.polyforge-move-${randomUUID()}`);
    const backup = path.join(path.dirname(ref.dir), `.polyforge-moved-${randomUUID()}`);
    try {
      await fs.cp(ref.dir, staging, { recursive: true, errorOnExist: true, force: false });
      if (JSON.stringify(await manifest(staging)) !== JSON.stringify(before) || JSON.stringify(await manifest(ref.dir)) !== JSON.stringify(before)) throw new HttpError(409, 'move_changed', 'Files changed during copying; the original is intact');
      await fs.rename(ref.dir, backup);
      try { await fs.rename(staging, destination); }
      catch (error) { await fs.rename(backup, ref.dir); throw error; }
      // The verified destination is authoritative. A locked old file may leave
      // a hidden backup, but cannot produce a second registered problem.
      await fs.rm(backup, { recursive: true, force: true }).catch(error => console.warn(`Moved problem; could not remove backup ${backup}:`, error));
    } finally { await fs.rm(staging, { recursive: true, force: true }).catch(() => {}); }
  }
  // Build identities contain absolute source paths. Source and history stay intact.
  await fs.rm(path.join(destination, '.polyforge', 'build'), { recursive: true, force: true });
  await registry.scan();
  return registry.summary(await registry.get(id));
}
