import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import {
  DEFAULT_TESTSET,
  PROBLEM_NAME_RE,
  TESTSET_NAME_RE,
  parseIndexList,
  type TestGroup,
  STD_PREFIX,
  statementLanguages,
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
    await this.fillStreams(ref, raw);
    const r = problemTomlSchema.safeParse(raw);
    if (!r.success) {
      const msg = r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      return { config: null, raw, error: `problem.toml: ${msg}` };
    }
    return { config: r.data, raw };
  }

  /**
   * Problems without `input` / `output` (older files, other tools) get stdin / stdout
   * written into [problem], as text so the rest of the file (comments) stays as it is.
   */
  private async fillStreams(ref: ProblemRef, raw: Record<string, unknown>) {
    const p = raw.problem as Record<string, unknown> | undefined;
    if (!p || typeof p !== 'object' || (p.input !== undefined && p.output !== undefined)) return;
    const file = path.join(ref.dir, PROBLEM_FILE);
    const text = await fsp.readFile(file, 'utf8');
    const m = /^[ \t]*\[problem\][ \t]*(#.*)?\r?\n/m.exec(text);
    if (!m) return;
    const nl = text.includes('\r\n') ? '\r\n' : '\n';
    const add = [p.input === undefined ? 'input = "stdin"' : '', p.output === undefined ? 'output = "stdout"' : ''].filter(Boolean);
    const at = m.index + m[0].length;
    await atomicWrite(file, text.slice(0, at) + add.map((l) => l + nl).join('') + text.slice(at)).catch(() => {});
    p.input ??= 'stdin';
    p.output ??= 'stdout';
  }

  async summary(ref: ProblemRef): Promise<ProblemSummary> {
    const { config, error } = await this.readConfig(ref);
    const has = (rel?: string) => (rel ? this.sourceExists(ref, rel) : Promise.resolve(false));
    const std = config?.solutions.find((s) => s.tag === 'MA');
    const [langs, validator, checker, stdOk, manualTests, hasScript] = await Promise.all([
      this.statementLangs(ref),
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
      input: config?.problem.input ?? 'stdin',
      output: config?.problem.output ?? 'stdout',
      interactive: config?.problem.interactive ?? false,
      status: {
        statement: langs.statement.length > 0,
        statementLangs: langs.statement,
        tutorialLangs: langs.tutorial,
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

  /** Languages with a non-empty statement / tutorial (whitespace-only files do not count). */
  private async statementLangs(ref: ProblemRef) {
    const dir = path.join(ref.dir, 'statement');
    const files: { path: string; size: number }[] = [];
    for (const lang of await fsp.readdir(dir).catch(() => [] as string[])) {
      for (const f of await fsp.readdir(path.join(dir, lang)).catch(() => [] as string[])) {
        if (!f.endsWith('.tex')) continue;
        const text = await fsp.readFile(path.join(dir, lang, f), 'utf8').catch(() => '');
        files.push({ path: `statement/${lang}/${f}`, size: text.trim().length });
      }
    }
    return statementLanguages(files);
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
        await atomicWrite(path.join(dir, PROBLEM_FILE), stringify({ problem: { name, time_limit: tl, memory_limit: ml, input: 'stdin', output: 'stdout', interactive } }));
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
    if (req.polygonId !== undefined) {
      doc.polygon ??= {};
      if (req.polygonId === null) delete doc.polygon.id;
      else doc.polygon.id = req.polygonId;
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
    if (req.points !== undefined) {
      doc.tests ??= {};
      if (req.points) doc.tests.points = true;
      else delete doc.tests.points;
    }
    for (const [name, p] of Object.entries(req.testsets ?? {})) {
      if (!TESTSET_NAME_RE.test(name)) throw new HttpError(400, 'invalid_testset', `Invalid testset name: ${name}`);
      const isDefault = name === DEFAULT_TESTSET;
      if (p === null) {
        if (isDefault) throw new HttpError(400, 'invalid_testset', 'The "tests" testset cannot be deleted');
        if (doc.testsets) delete doc.testsets[name];
        continue;
      }
      const target: Record<string, any> = isDefault ? (doc.tests ??= {}) : ((doc.testsets ??= {})[name] ??= {});
      if (p.script !== undefined) {
        if (p.script === null || !p.script.trim()) delete target.script;
        else target.script = p.script.trim();
      }
      if (p.groups !== undefined) {
        if (p.groups) target.groups = true;
        else delete target.groups;
      }
      if (p.group !== undefined) {
        const groups = checkGroups(name, p.group);
        if (groups.length) target.group = groups;
        else delete target.group;
      }
    }
    if (doc.testsets && !Object.keys(doc.testsets).length) delete doc.testsets;
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

/** Validate a testset's groups (subtasks) and drop empty fields before writing TOML. */
function checkGroups(testset: string, list: TestGroup[]): TestGroup[] {
  const names = new Set<string>();
  const covered = new Map<number, string>();
  const out = list.map((g) => {
    const name = String(g.name ?? '').trim();
    if (!name) throw new HttpError(400, 'invalid_group', `${testset}: a group has no name`);
    if (names.has(name)) throw new HttpError(400, 'invalid_group', `${testset}: duplicate group ${name}`);
    names.add(name);
    const tests = String(g.tests ?? '').trim();
    if (tests && !/^\s*\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*\s*$/.test(tests)) {
      throw new HttpError(400, 'invalid_group', `${testset}: group ${name}: tests must look like "1-5, 8"`);
    }
    for (const i of parseIndexList(tests)) {
      if (covered.has(i)) throw new HttpError(400, 'invalid_group', `${testset}: test ${i} is in groups ${covered.get(i)} and ${name}`);
      covered.set(i, name);
    }
    const r: TestGroup = { name };
    if (tests) r.tests = tests;
    if (g.points !== undefined && g.points !== null && !Number.isNaN(Number(g.points))) r.points = Number(g.points);
    if (g.policy) r.policy = g.policy;
    if (g.dependencies?.length) r.dependencies = g.dependencies.map(String);
    return r;
  });
  for (const g of out) {
    for (const d of g.dependencies ?? []) {
      if (d === g.name) throw new HttpError(400, 'invalid_group', `${testset}: group ${g.name} depends on itself`);
      if (!names.has(d)) throw new HttpError(400, 'invalid_group', `${testset}: group ${g.name} depends on unknown group ${d}`);
    }
  }
  // Dependencies must not form a cycle.
  const deps = new Map(out.map((g) => [g.name, g.dependencies ?? []]));
  const state = new Map<string, 1 | 2>();
  const visit = (n: string, stack: string[]) => {
    if (state.get(n) === 2) return;
    if (state.get(n) === 1) throw new HttpError(400, 'invalid_group', `${testset}: dependency cycle ${[...stack, n].join(' → ')}`);
    state.set(n, 1);
    for (const d of deps.get(n) ?? []) visit(d, [...stack, n]);
    state.set(n, 2);
  };
  for (const g of out) visit(g.name, []);
  return out;
}
