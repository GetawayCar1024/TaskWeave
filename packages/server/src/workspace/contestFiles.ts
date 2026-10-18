import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HttpError, safeJoin, validateFileName } from '../util/fs.js';

/** Contest attachments never follow links outside the contest, including junctions. */
export async function contestFile(dir: string, rel: string): Promise<string> {
  validateFileName(rel);
  const root = path.join(dir, 'files');
  const target = safeJoin(root, rel);
  let current = root;
  for (const part of ['', ...rel.replace(/\\/g, '/').split('/')]) {
    if (part) current = path.join(current, part);
    const st = await fs.lstat(current).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; });
    if (st?.isSymbolicLink()) throw new HttpError(403, 'bad_path', 'Contest files cannot follow symbolic links');
  }
  return target;
}

export async function ensureContestFiles(dir: string) {
  const notes = await contestFile(dir, 'notes.tex');
  await fs.mkdir(path.dirname(notes), { recursive: true });
  await fs.writeFile(notes, '', { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
}

export async function contestNotes(dir: string): Promise<string> {
  await ensureContestFiles(dir);
  return fs.readFile(await contestFile(dir, 'notes.tex'), 'utf8');
}
