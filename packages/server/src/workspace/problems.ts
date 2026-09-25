import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import {
  PROBLEM_NAME_RE,
  STD_PREFIX,
  problemTomlSchema,
  type CreateProblemRequest,
  type PatchProblemRequest,
  type ProblemDetail,
  type ProblemSummary,
  type ProblemToml,
} from '@polyforge/shared';
import type { GlobalStore } from '../global.js';
import { samePath } from '../global.js';
import { atomicWrite, exists, HttpError, isDir, safeJoin, toPosix } from '../util/fs.js';
import { buildTree } from './files.js';

export interface ProblemRef {
  id: string;
  dir: string;
  root: string;
}

export const PROBLEM_FILE = 'problem.toml';

export class ProblemRegistry {
  private byId = new Map<string, ProblemRef>();

  constructor(private global: GlobalStore) {}

  get roots(): string[] {
    return this.global.config.problems.roots;
  }

  /** Rescan all roots. Each direct subfolder containing problem.toml is a problem. */
  async scan(): Promise<ProblemRef[]> {
    const next = new Map<string, ProblemRef>();
    for (const root of this.roots) {
      let entries;
      try {
        entries = await fsp.readdir(root, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const ent of entries) {
        if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
        const dir = path.join(root, ent.name);
        if (!(await exists(path.join(dir, PROBLEM_FILE)))) continue;
        let id = ent.name;
        for (let i = 2; next.has(id); i++) id = `${ent.name}~${i}`;
        next.set(id, { id, dir, root });
      }
    }
    this.byId = next;
    return [...next.values()];
  }

  async get(id: string): Promise<ProblemRef> {
    let ref = this.byId.get(id);
    if (!ref) {
      await this.scan();
      ref = this.byId.get(id);
    }
    if (!ref) throw new HttpError(404, 'problem_not_found', `Problem not found: ${id}`);
    return ref;
  }

  /** Find the problem containing an absolute path (used by the watcher). */
  locate(absPath: string): { ref: ProblemRef; rel: string } | null {
    for (const ref of this.byId.values()) {
      const rel = path.relative(ref.dir, absPath);
      if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) continue;
      return { ref, rel: toPosix(rel) };
    }
    return null;
  }

  async list(): Promise<ProblemSummary[]> {
    const refs = await this.scan();
    return Promise.all(refs.map((r) => this.summary(r)));
  }

  async readConfig(ref: ProblemRef): Promise<{ config: ProblemToml | null; raw: Record<string, unknown>; error?: string }> {
    let raw: Record<string, unknown>;
    try {
      raw = parse(await fsp.readFile(path.join(ref.dir, PROBLEM_FILE), 'utf8')) as Record<string, unknown>;
    } catch (e) {
      return { config: null, raw: {}, error: `problem.toml: ${(e as Error).message}` };
    }
    const r = problemTomlSchema.safeParse(raw);
    if (!r.success) {
      const msg = r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      return { config: null, raw, error: `problem.toml: ${msg}` };
    }
    return { config: r.data, raw };
  }

  async summary(ref: ProblemRef): Promise<ProblemSummary> {
    const { config, error } = await this.readConfig(ref);
    const has = (rel?: string) => (rel ? this.sourceExists(ref, rel) : Promise.resolve(false));
    const std = config?.solutions.find((s) => s.tag === 'MA');
    const [statement, validator, checker, stdOk, manualTests, hasScript] = await Promise.all([
      this.hasStatement(ref),
      has(config?.validator?.source),
      has(config?.checker?.source),
      has(std?.source),
      countFiles(path.join(ref.dir, 'tests', 'manual')),
      has(config?.tests.script),
    ]);
    return {
      id: ref.id,
      name: config?.problem.name ?? path.basename(ref.dir),
      title: config?.problem.title ?? {},
      dir: ref.dir,
      root: ref.root,
      timeLimit: config?.problem.time_limit ?? 0,
      memoryLimit: config?.problem.memory_limit ?? 0,
      interactive: config?.problem.interactive ?? false,
      status: {
        statement,
        validator,
        checker,
        std: stdOk,
        manualTests,
        hasScript,
        polygonId: config?.polygon.id,
      },
      error,
    };
  }

  async detail(id: string): Promise<ProblemDetail> {
    const ref = await this.get(id);
    const [summary, { config }, tree] = await Promise.all([this.summary(ref), this.readConfig(ref), buildTree(ref.dir)]);
    return { summary, config, tree };
  }

  /** `std:xxx` resolves to the global shared checkers, anything else to a file in the problem. */
  private async sourceExists(ref: ProblemRef, source: string): Promise<boolean> {
    if (source.startsWith(STD_PREFIX)) {
      return exists(path.join(this.global.sharedDir, 'checkers', `${source.slice(STD_PREFIX.length)}.cpp`));
    }
    try {
      return await exists(safeJoin(ref.dir, source));
    } catch {
      return false;
    }
  }

  private async hasStatement(ref: ProblemRef): Promise<boolean> {
    const dir = path.join(ref.dir, 'statement');
    let langs: string[];
    try {
      langs = await fsp.readdir(dir);
    } catch {
      return false;
    }
    for (const lang of langs) {
      try {
        const legend = await fsp.readFile(path.join(dir, lang, 'legend.tex'), 'utf8');
        if (legend.trim()) return true;
      } catch {
        /* no legend for this language */
      }
    }
    return false;
  }

  async create(req: CreateProblemRequest): Promise<ProblemSummary> {
    const name = req.name?.trim() ?? '';
    if (!PROBLEM_NAME_RE.test(name)) {
      throw new HttpError(400, 'invalid_name', 'Name must be lowercase letters, digits and dashes');
    }
    const root = req.root ?? this.roots[0];
    if (!root) throw new HttpError(400, 'no_root', 'No problem root directory configured');
    if (!this.roots.some((r) => samePath(r, root))) throw new HttpError(400, 'invalid_root', 'Unknown problem root');
    await fsp.mkdir(root, { recursive: true });
    const dir = path.join(root, name);
    if (await exists(dir)) throw new HttpError(409, 'exists', `Folder already exists: ${dir}`);

    const tl = req.timeLimit ?? 1000;
    const ml = req.memoryLimit ?? 256;
    const interactive = !!req.interactive;
    const vars: Record<string, string> = {
      '"{{name}}"': JSON.stringify(name),
      '"{{title_zh}}"': JSON.stringify(req.title?.zh ?? ''),
      '"{{title_en}}"': JSON.stringify(req.title?.en ?? ''),
      '{{time_limit}}': String(Math.trunc(tl)),
      '{{memory_limit}}': String(Math.trunc(ml)),
      '{{interactive}}': String(interactive),
    };

    const tpl = path.join(this.global.templatesDir, 'problem');
    const stmtTpl = path.join(this.global.templatesDir, 'statement');
    try {
      await copyTemplate(tpl, dir, vars);
      if (await isDir(stmtTpl)) {
        for (const lang of await fsp.readdir(stmtTpl)) {
          if (await isDir(path.join(stmtTpl, lang))) {
            await copyTemplate(path.join(stmtTpl, lang), path.join(dir, 'statement', lang), vars);
          }
        }
      }
      if (!interactive) {
        for (const lang of await fsp.readdir(path.join(dir, 'statement')).catch(() => [])) {
          await fsp.rm(path.join(dir, 'statement', lang, 'interaction.tex'), { force: true });
        }
      }
      if (!(await exists(path.join(dir, PROBLEM_FILE)))) {
        await atomicWrite(path.join(dir, PROBLEM_FILE), stringify({ problem: { name, time_limit: tl, memory_limit: ml, interactive } }));
      }
    } catch (e) {
      await fsp.rm(dir, { recursive: true, force: true });
      throw e;
    }
    await this.scan();
    const ref = [...this.byId.values()].find((r) => samePath(r.dir, dir));
    if (!ref) throw new HttpError(500, 'create_failed', 'Problem created but not found on rescan');
    return this.summary(ref);
  }

  /**
   * Apply a partial update to problem.toml. Note: re-serialising drops comments; the
   * file stays hand-editable and is usually edited directly in the editor anyway.
   */
  async patch(id: string, req: PatchProblemRequest): Promise<ProblemDetail> {
    const ref = await this.get(id);
    const { raw, error } = await this.readConfig(ref);
    if (error && Object.keys(raw).length === 0) throw new HttpError(400, 'invalid_problem_toml', error);
    const doc = structuredClone(raw) as Record<string, any>;
    doc.problem ??= {};
    const p = doc.problem;
    if (req.title) p.title = req.title;
    if (req.timeLimit !== undefined) p.time_limit = req.timeLimit;
    if (req.memoryLimit !== undefined) p.memory_limit = req.memoryLimit;
    if (req.interactive !== undefined) p.interactive = req.interactive;
    if (req.input !== undefined) p.input = req.input;
    if (req.output !== undefined) p.output = req.output;
    for (const key of ['checker', 'validator', 'interactor'] as const) {
      const v = req[key];
      if (v === null) delete doc[key];
      else if (v !== undefined) doc[key] = { ...(doc[key] ?? {}), source: v };
    }
    if (req.solution) {
      const list: any[] = Array.isArray(doc.solutions) ? doc.solutions : [];
      const i = list.findIndex((s) => s?.source === req.solution!.source);
      if (req.solution.tag === null) {
        if (i >= 0) list.splice(i, 1);
      } else if (i >= 0) list[i].tag = req.solution.tag;
      else list.push({ source: req.solution.source, tag: req.solution.tag });
      doc.solutions = list;
    }
    if (req.samples !== undefined) {
      doc.tests ??= {};
      if (req.samples.trim()) doc.tests.samples = req.samples.trim();
      else delete doc.tests.samples;
    }
    if (req.generator) {
      const list: any[] = Array.isArray(doc.generators) ? doc.generators : [];
      const i = list.findIndex((g) => g?.source === req.generator!.source);
      if (req.generator.enabled && i < 0) list.push({ source: req.generator.source });
      if (!req.generator.enabled && i >= 0) list.splice(i, 1);
      doc.generators = list;
    }
    const check = problemTomlSchema.safeParse(doc);
    if (!check.success) throw new HttpError(400, 'invalid_patch', check.error.message);
    await atomicWrite(path.join(ref.dir, PROBLEM_FILE), stringify(doc) + '\n');
    return this.detail(id);
  }
}

async function copyTemplate(src: string, dest: string, vars: Record<string, string>): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });
  for (const ent of await fsp.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) {
      await copyTemplate(s, d, vars);
    } else if (ent.name === '.gitkeep') {
      /* keeps empty template dirs in git; not needed in the problem */
    } else if (/\.(toml|txt|tex|cpp|py|md)$/.test(ent.name)) {
      let text = await fsp.readFile(s, 'utf8');
      for (const [k, v] of Object.entries(vars)) text = text.split(k).join(v);
      await fsp.writeFile(d, text);
    } else {
      await fsp.copyFile(s, d);
    }
  }
}

async function countFiles(dir: string): Promise<number> {
  try {
    return (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).length;
  } catch {
    return 0;
  }
}
