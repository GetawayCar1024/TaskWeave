import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { FileContent, FileNode } from '@polyforge/shared';
import { atomicWrite, exists, HttpError, looksBinary, safeJoin, sha1, TMP_MARKER, toPosix, validateFileName } from '../util/fs.js';

/** Directories never shown in the tree nor watched. */
export const HIDDEN_DIRS = new Set(['.polyforge', '.git', 'node_modules']);

/** Files larger than this are returned truncated (read-only in the editor). */
const MAX_EDITABLE = 4 * 1024 * 1024;
const PREVIEW_BYTES = 256 * 1024;

export async function buildTree(dir: string, relBase = ''): Promise<FileNode[]> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nodes: FileNode[] = [];
  for (const ent of entries) {
    if (ent.name.startsWith(TMP_MARKER)) continue;
    const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (HIDDEN_DIRS.has(ent.name)) continue;
      nodes.push({ name: ent.name, path: rel, type: 'dir', children: await buildTree(abs, rel) });
    } else if (ent.isFile()) {
      const st = await fsp.stat(abs).catch(() => null);
      nodes.push({ name: ent.name, path: rel, type: 'file', size: st?.size ?? 0 });
    }
  }
  nodes.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true })));
  return nodes;
}

/**
 * Hashes of files we just wrote ourselves, so the watcher can drop the resulting
 * change event instead of echoing it back to the browser (DESIGN §4.1).
 */
export class SelfWrites {
  private map = new Map<string, { hash: string; at: number }>();

  record(abs: string, hash: string) {
    this.map.set(key(abs), { hash, at: Date.now() });
  }

  /** True if `hash` for `abs` is our own recent write. Entries expire after 10 s. */
  consume(abs: string, hash: string | undefined): boolean {
    const k = key(abs);
    const e = this.map.get(k);
    if (!e) return false;
    if (Date.now() - e.at > 10_000) {
      this.map.delete(k);
      return false;
    }
    if (e.hash !== hash) return false;
    this.map.delete(k);
    return true;
  }
}

const key = (abs: string) => (process.platform === 'win32' ? path.resolve(abs).toLowerCase() : path.resolve(abs));

export class FileService {
  constructor(public selfWrites: SelfWrites) {}

  async read(base: string, rel: string): Promise<FileContent> {
    const abs = safeJoin(base, rel);
    let st;
    try {
      st = await fsp.stat(abs);
    } catch {
      throw new HttpError(404, 'file_not_found', `File not found: ${rel}`);
    }
    if (!st.isFile()) throw new HttpError(400, 'not_a_file', `Not a file: ${rel}`);
    const truncated = st.size > MAX_EDITABLE;
    let buf: Buffer;
    if (truncated) {
      const fh = await fsp.open(abs, 'r');
      try {
        buf = Buffer.alloc(PREVIEW_BYTES);
        const { bytesRead } = await fh.read(buf, 0, PREVIEW_BYTES, 0);
        buf = buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    } else {
      buf = await fsp.readFile(abs);
    }
    const binary = looksBinary(buf);
    return {
      path: toPosix(path.relative(base, abs)),
      content: binary ? '' : buf.toString('utf8'),
      hash: truncated ? '' : sha1(buf),
      binary: binary || undefined,
      truncated: truncated || undefined,
      size: st.size,
    };
  }

  async hashOf(abs: string): Promise<string | undefined> {
    try {
      const st = await fsp.stat(abs);
      if (!st.isFile() || st.size > MAX_EDITABLE) return undefined;
      return sha1(await fsp.readFile(abs));
    } catch {
      return undefined;
    }
  }

  async write(base: string, rel: string, content: string, baseHash?: string): Promise<string> {
    validateFileName(rel);
    const abs = safeJoin(base, rel);
    if (abs === path.resolve(base)) throw new HttpError(400, 'bad_path', 'Empty path');
    if (baseHash !== undefined) {
      const current = await this.hashOf(abs);
      // baseHash '' means "file should not exist yet".
      if ((current ?? '') !== baseHash) {
        throw new HttpError(409, 'conflict', 'File was modified on disk since it was loaded');
      }
    }
    const hash = sha1(content);
    this.selfWrites.record(abs, hash);
    await atomicWrite(abs, content);
    return hash;
  }

  async remove(base: string, rel: string): Promise<void> {
    const abs = safeJoin(base, rel);
    if (abs === path.resolve(base)) throw new HttpError(400, 'bad_path', 'Refusing to delete the problem folder');
    if (!(await exists(abs))) throw new HttpError(404, 'file_not_found', `Not found: ${rel}`);
    await fsp.rm(abs, { recursive: true });
  }

  async move(base: string, from: string, to: string): Promise<void> {
    validateFileName(to);
    const a = safeJoin(base, from);
    const b = safeJoin(base, to);
    const root = path.resolve(base);
    if (a === root || b === root) throw new HttpError(400, 'bad_path', 'Invalid move');
    if (!(await exists(a))) throw new HttpError(404, 'file_not_found', `Not found: ${from}`);
    if (await exists(b)) throw new HttpError(409, 'exists', `Target exists: ${to}`);
    await fsp.mkdir(path.dirname(b), { recursive: true });
    await fsp.rename(a, b);
  }

  async mkdir(base: string, rel: string): Promise<void> {
    validateFileName(rel);
    await fsp.mkdir(safeJoin(base, rel), { recursive: true });
  }
}
