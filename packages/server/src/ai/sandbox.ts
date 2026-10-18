import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { AiChange, AiChangeContent } from '@polyforge/shared';
import { atomicWrite, exists, HttpError, looksBinary, safeJoin, sha1, toPosix } from '../util/fs.js';
import { HIDDEN_DIRS } from '../workspace/files.js';
import { contestFile } from '../workspace/contestFiles.js';

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
    private contestFiles = false,
  ) {}

  /** Create the copy on first use; afterwards bring files the agent has not touched up to date. */
  async sync(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    const real = await walk(this.realDir);
    const mine = await walk(this.dir);
    for (const [rel, abs] of real) {
      if (rel.startsWith('scratch/')) continue;
      if (this.touched.has(rel)) continue;
      const target = path.join(this.dir, rel);
      const [a, b] = await Promise.all([fsp.readFile(abs), readOrNull(target)]);
      if (!same(a, b)) {
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, a);
      }
    }
    for (const [rel, abs] of mine) if (!rel.startsWith('scratch/') && !real.has(rel) && !this.touched.has(rel)) await fsp.rm(abs, { force: true });
  }

  /** Resolve a model-supplied path inside the sandbox; the cache folders are off limits. */
  resolve(rel: string): { abs: string; rel: string } {
    const clean = rel.replace(/\\/g, '/').replace(/^\.?\//, '');
    if (!clean || clean.split('/').some((seg) => HIDDEN_DIRS.has(seg))) throw new HttpError(400, 'bad_path', `Path not allowed: ${rel}`);
    const abs = safeJoin(this.dir, clean);
    if (path.resolve(abs) === path.resolve(this.dir)) throw new HttpError(400, 'bad_path', 'The problem root cannot be modified');
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
    if (!r.rel.startsWith('scratch/')) this.touched.add(r.rel);
    return r.rel;
  }

  async remove(rel: string): Promise<string> {
    const r = this.resolve(rel);
    if (!(await exists(r.abs))) throw new HttpError(404, 'file_not_found', `File not found: ${rel}`);
    const children = (await fsp.stat(r.abs)).isDirectory() ? [...(await this.files()).keys()].filter(p => p.startsWith(r.rel + '/')) : [r.rel];
    await fsp.rm(r.abs, { recursive: true, force: true });
    for (const child of children) if (!child.startsWith('scratch/')) this.touched.add(child);
    return r.rel;
  }

  async files(): Promise<Map<string, string>> {
    return walk(this.dir);
  }

  async clearScratch(): Promise<void> {
    await fsp.rm(safeJoin(this.dir, 'scratch'), { recursive: true, force: true });
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
      if (this.contestFiles) await contestFile(path.dirname(this.realDir), rel);
      if (mine) await atomicWrite(target, mine);
      else {
        await fsp.rm(target, { force: true });
        // Only prune empty parents inside the statement tree, never other user folders.
        if (/^statement\/[a-z]{2,8}\//.test(rel)) {
          let parent = path.dirname(target);
          const boundary = path.join(this.realDir, 'statement');
          while (parent !== boundary && parent.startsWith(boundary + path.sep)) {
            try { await fsp.rmdir(parent); } catch { break; }
            parent = path.dirname(parent);
          }
        }
      }
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

/** What the agent service needs from a working copy (one problem, or a whole contest). */
export interface SandboxLike {
  clearScratch(): Promise<void>;
  readonly touched: ReadonlySet<string>;
  sync(): Promise<void>;
  changes(): Promise<AiChange[]>;
  content(rel: string): Promise<AiChangeContent>;
  accept(paths: string[]): Promise<string[]>;
  reject(paths: string[]): Promise<string[]>;
}

/** A problem of a contest session: its id (the path prefix), letter and real folder. */
export interface ContestPart {
  kind?: 'files';
  id: string;
  index: string;
  realDir: string;
  /** In the contest now. Others only keep changes made earlier (to accept or reject). */
  listed: boolean;
}

/**
 * The working copy of a contest: one problem sandbox per problem, under
 * <work>/<problem id>/. Paths are "<problem id>/<path in the problem>".
 */
export class ContestSandbox implements SandboxLike {
  async clearScratch(): Promise<void> {
    await this.ready();
    for (const { sandbox } of this.parts.values()) await sandbox.clearScratch();
  }
  private parts = new Map<string, { part: ContestPart; sandbox: Sandbox }>();
  /** Touched paths of problems not loaded yet (split by prefix on first use). */
  private pending: string[];

  constructor(
    readonly dir: string,
    touched: Iterable<string>,
    /** The contest's problems now, plus any with pending changes. */
    private resolveParts: (withIds: string[]) => Promise<ContestPart[]>,
  ) {
    this.pending = [...touched];
  }

  get touched(): ReadonlySet<string> {
    const all = new Set(this.pending);
    for (const [id, { sandbox }] of this.parts) for (const rel of sandbox.touched) all.add(`${id}/${rel}`);
    return all;
  }

  /** (Re)build the problem list; sandboxes of problems that stay keep their state. */
  async refresh(): Promise<void> {
    // Besides the contest's problems (resolveParts adds them): only those with changes to review.
    const withChanges = [...this.parts].filter(([, x]) => x.sandbox.touched.size).map(([id]) => id);
    const ids = [...new Set([...withChanges, ...this.pending.map((p) => p.split('/')[0])])];
    const next = new Map<string, { part: ContestPart; sandbox: Sandbox }>();
    for (const part of await this.resolveParts(ids)) {
      const old = this.parts.get(part.id);
      if (old) {
        next.set(part.id, { part, sandbox: old.sandbox });
        continue;
      }
      const mine = this.pending.filter((p) => p.startsWith(`${part.id}/`)).map((p) => p.slice(part.id.length + 1));
      this.pending = this.pending.filter((p) => !p.startsWith(`${part.id}/`));
      next.set(part.id, { part, sandbox: new Sandbox(part.realDir, path.join(this.dir, part.id), new Set(mine), part.kind === 'files') });
    }
    // A problem that has pending changes but no longer resolves keeps them in `pending`.
    this.parts = next;
  }

  private async ready() {
    if (!this.parts.size) await this.refresh();
  }

  /** The contest's problems, in contest order: all that the agent's tools can reach. */
  async list(): Promise<{ part: ContestPart; sandbox: Sandbox }[]> {
    await this.ready();
    return [...this.parts.values()].filter((x) => x.part.listed);
  }

  private lookup(name: string, any: boolean) {
    const all = [...this.parts.values()].filter((x) => any || x.part.listed);
    if (name === 'files') return all.find(x => x.part.kind === 'files');
    return all.find((x) => x.part.id === name) ?? all.find((x) => x.part.index.toLowerCase() === name.toLowerCase());
  }

  private async names() {
    return (await this.list()).map((x) => `${x.part.id} (${x.part.index})`).join(', ');
  }

  /**
   * Find the problem of a path by its first segment (problem id, or the contest letter).
   * Only problems of the contest, unless `any` (reviewing changes made earlier).
   */
  async route(p: string, any = false): Promise<{ part: ContestPart; sandbox: Sandbox; rest: string }> {
    await this.ready();
    const clean = p.replace(/\\/g, '/').replace(/^\.?\//, '');
    const [head, ...tail] = clean.split('/');
    const hit = this.lookup(head, any);
    if (!hit || !tail.length) throw new HttpError(400, 'bad_path', `Path must start with a problem folder of this contest (${await this.names()}): ${p}`);
    return { ...hit, rest: tail.join('/') };
  }

  async problem(name: string): Promise<{ part: ContestPart; sandbox: Sandbox }> {
    await this.ready();
    const hit = this.lookup(name, false);
    if (!hit) throw new HttpError(400, 'bad_problem', `Unknown problem "${name}"; this contest has: ${await this.names()}`);
    return hit;
  }

  async sync(): Promise<void> {
    await this.refresh();
    for (const { part, sandbox } of this.parts.values()) if (part.listed) await sandbox.sync();
  }

  async changes(): Promise<AiChange[]> {
    const out: AiChange[] = [];
    for (const [id, { sandbox }] of (await this.ready(), this.parts)) for (const c of await sandbox.changes()) out.push({ ...c, path: `${id}/${c.path}` });
    return out;
  }

  async content(rel: string): Promise<AiChangeContent> {
    const r = await this.route(rel, true);
    const c = await r.sandbox.content(r.rest);
    return { ...c, path: `${r.part.id}/${c.path}` };
  }

  private async each(paths: string[], fn: (s: Sandbox, rels: string[]) => Promise<string[]>): Promise<string[]> {
    const by = new Map<string, { part: ContestPart; sandbox: Sandbox; rels: string[] }>();
    for (const p of paths) {
      const r = await this.route(p, true);
      const e = by.get(r.part.id) ?? { ...r, rels: [] };
      e.rels.push(r.rest);
      by.set(r.part.id, e);
    }
    const done: string[] = [];
    for (const e of by.values()) for (const rel of await fn(e.sandbox, e.rels)) done.push(`${e.part.id}/${rel}`);
    return done;
  }

  accept(paths: string[]): Promise<string[]> {
    return this.each(paths, (s, rels) => s.accept(rels));
  }

  reject(paths: string[]): Promise<string[]> {
    return this.each(paths, (s, rels) => s.reject(rels));
  }
}
