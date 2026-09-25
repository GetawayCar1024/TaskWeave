import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { AiChange, AiChangeContent } from '@polyforge/shared';
import { atomicWrite, exists, HttpError, looksBinary, safeJoin, sha1, toPosix } from '../util/fs.js';
import { HIDDEN_DIRS } from '../workspace/files.js';

async function walk(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>(); // rel -> abs
  const rec = async (dir: string, base: string) => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (HIDDEN_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) await rec(abs, rel);
      else if (e.isFile()) out.set(rel, abs);
    }
  };
  await rec(root, '');
  return out;
}

const readOrNull = (p: string) => fsp.readFile(p).catch(() => null);
const same = (a: Buffer | null, b: Buffer | null) => (a === null || b === null ? a === b : a.equals(b));

/**
 * A working copy of a problem where an AI agent makes its edits. Changes stay here —
 * and can be compiled and judged here — until the user accepts them into the real
 * problem folder ("AI never overwrites files directly", DESIGN §4.4).
 */
export class Sandbox {
  constructor(
    readonly realDir: string,
    readonly dir: string,
    /** Paths the agent has written or deleted (candidates for the change set). */
    readonly touched: Set<string>,
  ) {}

  /** Create the copy on first use; afterwards bring files the agent has not touched up to date. */
  async sync(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    const real = await walk(this.realDir);
    const mine = await walk(this.dir);
    for (const [rel, abs] of real) {
      if (this.touched.has(rel)) continue;
      const target = path.join(this.dir, rel);
      const [a, b] = await Promise.all([fsp.readFile(abs), readOrNull(target)]);
      if (!same(a, b)) {
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, a);
      }
    }
    for (const [rel, abs] of mine) if (!real.has(rel) && !this.touched.has(rel)) await fsp.rm(abs, { force: true });
  }

  /** Resolve a model-supplied path inside the sandbox; the cache folders are off limits. */
  resolve(rel: string): { abs: string; rel: string } {
    const clean = rel.replace(/\\/g, '/').replace(/^\.?\//, '');
    if (!clean || clean.split('/').some((seg) => HIDDEN_DIRS.has(seg))) throw new HttpError(400, 'bad_path', `Path not allowed: ${rel}`);
    const abs = safeJoin(this.dir, clean);
    return { abs, rel: toPosix(path.relative(this.dir, abs)) };
  }

  async read(rel: string): Promise<Buffer> {
    const { abs } = this.resolve(rel);
    const b = await readOrNull(abs);
    if (!b) throw new HttpError(404, 'file_not_found', `File not found: ${rel}`);
    return b;
  }

  async write(rel: string, content: string | Buffer): Promise<string> {
    const r = this.resolve(rel);
    await fsp.mkdir(path.dirname(r.abs), { recursive: true });
    await fsp.writeFile(r.abs, content);
    this.touched.add(r.rel);
    return r.rel;
  }

  async remove(rel: string): Promise<string> {
    const r = this.resolve(rel);
    if (!(await exists(r.abs))) throw new HttpError(404, 'file_not_found', `File not found: ${rel}`);
    await fsp.rm(r.abs, { recursive: true, force: true });
    this.touched.add(r.rel);
    return r.rel;
  }

  async files(): Promise<Map<string, string>> {
    return walk(this.dir);
  }

  /** Differences between the sandbox and the real problem, for touched paths. */
  async changes(): Promise<AiChange[]> {
    const out: AiChange[] = [];
    for (const rel of [...this.touched].sort()) {
      const [mine, real] = await Promise.all([readOrNull(path.join(this.dir, rel)), readOrNull(path.join(this.realDir, rel))]);
      if (same(mine, real)) {
        // Reverted to the original: nothing to review.
        this.touched.delete(rel);
        continue;
      }
      const binary = [mine, real].some((b) => b && looksBinary(b)) || undefined;
      out.push({ path: rel, status: !real ? 'added' : !mine ? 'deleted' : 'modified', binary });
    }
    return out;
  }

  async content(rel: string): Promise<AiChangeContent> {
    const { rel: clean } = this.resolve(rel);
    const [mine, real] = await Promise.all([readOrNull(path.join(this.dir, clean)), readOrNull(path.join(this.realDir, clean))]);
    const binary = [mine, real].some((b) => b && looksBinary(b));
    const text = (b: Buffer | null) => (b === null ? null : binary ? `<binary, ${b.length} bytes, sha1 ${sha1(b).slice(0, 12)}>` : b.toString('utf8'));
    return { path: clean, original: text(real), modified: text(mine), binary: binary || undefined };
  }

  /** Copy accepted changes into the real problem (the file watcher then updates open editors). */
  async accept(paths: string[]): Promise<string[]> {
    const done: string[] = [];
    for (const p of paths) {
      const { rel } = this.resolve(p);
      if (!this.touched.has(rel)) continue;
      const mine = await readOrNull(path.join(this.dir, rel));
      const target = safeJoin(this.realDir, rel);
      if (mine) await atomicWrite(target, mine);
      else await fsp.rm(target, { force: true });
      this.touched.delete(rel);
      done.push(rel);
    }
    return done;
  }

  /** Throw away changes: restore the sandbox copy from the real problem. */
  async reject(paths: string[]): Promise<string[]> {
    const done: string[] = [];
    for (const p of paths) {
      const { rel, abs } = this.resolve(p);
      if (!this.touched.has(rel)) continue;
      const real = await readOrNull(path.join(this.realDir, rel));
      if (real) {
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, real);
      } else await fsp.rm(abs, { force: true });
      this.touched.delete(rel);
      done.push(rel);
    }
    return done;
  }
}
