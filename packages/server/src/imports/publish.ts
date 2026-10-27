import { promises as fs } from 'node:fs';
import path from 'node:path';
import { stringify } from 'smol-toml';
import { problemTomlSchema, PROBLEM_NAME_RE } from '@polyforge/shared';
import type { Judge } from '../judge/index.js';
import { samePath } from '../global.js';
import { atomicWrite, HttpError, safeJoin } from '../util/fs.js';

/** Publish problem.toml last, so scans never register an incomplete archive import. */
export async function publishProblem(judge: Judge, files: Map<string, Buffer>, doc: Record<string, any>, root?: string) {
  const parsed = problemTomlSchema.safeParse(doc);
  if (!parsed.success) throw new HttpError(400, 'invalid_package', `Imported configuration is invalid: ${parsed.error.message}`);
  const name = parsed.data.problem.name;
  if (!PROBLEM_NAME_RE.test(name)) throw new HttpError(400, 'invalid_name', 'Name must be lowercase letters, digits and dashes (up to 64 characters).');
  const dir = path.join(judge.registry.requireRoot(root), name);
  await fs.mkdir(path.dirname(dir), { recursive: true });
  try { await fs.mkdir(dir); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new HttpError(409, 'exists', `Folder already exists: ${dir}`); throw e; }
  try {
    const entries = [...files]; let next = 0;
    const writes = await Promise.allSettled(Array.from({ length: Math.min(12, entries.length) }, async () => {
      while (next < entries.length) { const [relative, bytes] = entries[next++]; await atomicWrite(safeJoin(dir, relative), bytes); }
    }));
    const failed = writes.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    await atomicWrite(path.join(dir, 'problem.toml'), stringify(doc));
  } catch (e) { await fs.rm(dir, { recursive: true, force: true }); throw e; }
  let ref = (await judge.registry.scan()).find(ref => samePath(ref.dir, dir));
  // A watcher scan started before publication may not have seen problem.toml yet.
  if (!ref) ref = (await judge.registry.scan()).find(ref => samePath(ref.dir, dir));
  if (!ref) throw new HttpError(409, 'import_changed', 'The imported problem directory changed before registration.');
  return judge.registry.summary(ref);
}
