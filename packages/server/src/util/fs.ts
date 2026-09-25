import { createHash, randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

export const TMP_MARKER = '.pf-tmp-';

export function sha1(data: string | Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function isDir(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Write via temp file + rename so a crash never leaves a half-written file. */
export async function atomicWrite(file: string, data: string | Buffer): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `${TMP_MARKER}${randomBytes(6).toString('hex')}`);
  await fsp.writeFile(tmp, data);
  try {
    await renameWithRetry(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
}

/** On Windows, rename fails transiently with EPERM/EBUSY while another process (AV, editor) holds the file. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
      await new Promise((r) => setTimeout(r, 20 * 2 ** attempt));
    }
  }
}

export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Copy a directory tree, never overwriting files that already exist in `dest`. */
export async function copyMissing(src: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });
  for (const ent of await fsp.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) await copyMissing(s, d);
    else if (!(await exists(d))) await fsp.copyFile(s, d);
  }
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Resolve `rel` inside `base`, rejecting anything that escapes it (DESIGN §8).
 * Returns the absolute path.
 */
export function safeJoin(base: string, rel: string): string {
  if (rel.includes('\0')) throw new HttpError(400, 'bad_path', 'Invalid path');
  const abs = path.resolve(base, rel);
  const r = path.relative(base, abs);
  if (r === '') return abs;
  if (r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r)) {
    throw new HttpError(403, 'path_outside', `Path escapes its root: ${rel}`);
  }
  return abs;
}
