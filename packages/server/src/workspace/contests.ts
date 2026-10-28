import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import {
  CONTEST_FILE,
  CONTEST_INDEX_RE,
  PROBLEM_NAME_RE,
  contestTomlSchema,
  problemTypeSchema,
  type ProblemType,
  type ContestDetail,
  type ContestProblemRef,
  type ContestSummary,
  type ContestToml,
  type CreateContestRequest,
  type UpdateContestRequest,
} from '@polyforge/shared';
import { samePath } from '../global.js';
import { ensureContestFiles } from './contestFiles.js';
import { atomicWrite, exists, HttpError } from '../util/fs.js';
import type { GlobalStore } from '../global.js';
import type { ProblemRegistry } from './problems.js';
import { libraryParent, parentFolder, workspaceDirectories } from './library.js';

export interface ContestRef {
  id: string;
  dir: string;
  root: string;
}

/**
 * Contests: subfolders of the contests folder (config contests.dir, default
 * <global dir>/contests) containing contest.toml. They are kept apart from the
 * problems, which they reference by id.
 */
export class ContestRegistry {
  private byId = new Map<string, ContestRef>();

  constructor(
    private problems: ProblemRegistry,
    private global: GlobalStore,
  ) {}

  get dir() {
    return this.global.contestsDir;
  }

  async scan(): Promise<ContestRef[]> {
    const next = new Map<string, ContestRef>();
    const root = this.dir;
    const found = await Promise.all((await workspaceDirectories(root, CONTEST_FILE)).map(async ref => ({ ...ref,
      identity: (await fsp.readFile(path.join(ref.dir, '.polyforge/identity'), 'utf8').catch(() => '')).trim(),
    })));
    const reserved = new Set(found.map(ref => ref.identity).filter(Boolean));
    for (const ref of found) {
      let id = /^[a-zA-Z0-9_-]+(?:~\d+)?$/.test(ref.identity) ? ref.identity : '';
      if (!id || next.has(id)) { id = ref.name; for (let i = 2; next.has(id) || reserved.has(id); i++) id = `${ref.name}~${i}`; }
      if (id !== ref.identity) await atomicWrite(path.join(ref.dir, '.polyforge/identity'), id);
      next.set(id, { id, dir: ref.dir, root });
    }
    this.byId = next;
    return [...next.values()];
  }

  /**
   * Contests used to live in the problem roots: move such folders (contest.toml and
   * no problem.toml) into the contests folder. Returns what was moved.
   */
  async migrateFromProblemRoots(): Promise<{ from: string; to: string }[]> {
    const moved: { from: string; to: string }[] = [];
    for (const root of this.problems.roots) {
      const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
      for (const ent of entries) {
        if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
        const from = path.join(root, ent.name);
        if (!(await exists(path.join(from, CONTEST_FILE))) || (await exists(path.join(from, 'problem.toml')))) continue;
        let to = path.join(this.dir, ent.name);
        for (let i = 2; await exists(to); i++) to = path.join(this.dir, `${ent.name}-${i}`);
        await fsp.mkdir(this.dir, { recursive: true });
        try {
          await fsp.rename(from, to).catch(async (e: NodeJS.ErrnoException) => {
            if (e.code !== 'EXDEV') throw e;
            await fsp.cp(from, to, { recursive: true });
            await fsp.rm(from, { recursive: true, force: true });
          });
          moved.push({ from, to });
        } catch (e) {
          console.warn(`[taskweave] could not move contest ${from}: ${(e as Error).message}`);
        }
      }
    }
    return moved;
  }

  async get(id: string): Promise<ContestRef> {
    let ref = this.byId.get(id);
    if (!ref) {
      await this.scan();
      ref = this.byId.get(id);
    }
    if (!ref) throw new HttpError(404, 'contest_not_found', `Contest not found: ${id}`);
    await ensureContestFiles(ref.dir);
    return ref;
  }

  async read(ref: ContestRef): Promise<{ config: ContestToml | null; raw: Record<string, unknown>; error?: string }> {
    let raw: Record<string, unknown>;
    try {
      raw = parse(await fsp.readFile(path.join(ref.dir, CONTEST_FILE), 'utf8')) as Record<string, unknown>;
    } catch (e) {
      return { config: null, raw: {}, error: `contest.toml: ${(e as Error).message}` };
    }
    const r = contestTomlSchema.safeParse(raw);
    if (!r.success) {
      const msg = r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      return { config: null, raw, error: `contest.toml: ${msg}` };
    }
    return { config: r.data, raw };
  }

  /** Contest config, or 400 when contest.toml is invalid. */
  async config(id: string): Promise<{ ref: ContestRef; config: ContestToml }> {
    const ref = await this.get(id);
    const { config, error } = await this.read(ref);
    if (!config) throw new HttpError(400, 'invalid_contest_toml', error ?? 'invalid contest.toml');
    return { ref, config };
  }

  private async summaryOf(ref: ContestRef, problemIds: Set<string>): Promise<ContestSummary> {
    const { config, error } = await this.read(ref);
    return {
      id: ref.id,
      type: config?.contest.type ?? 'cf',
      name: config?.contest.name ?? path.basename(ref.dir),
      title: config?.contest.title ?? {},
      dir: ref.dir,
      root: ref.root,
      folder: parentFolder(ref.root, ref.dir),
      polygonId: config?.polygon.id,
      statement: config?.statement,
      problems: (config?.problems ?? []).map((p) => ({ index: p.index, problem: p.problem, found: problemIds.has(p.problem) })),
      error,
    };
  }

  async list(): Promise<ContestSummary[]> {
    const [refs, problems] = await Promise.all([this.scan(), this.problems.scan()]);
    const ids = new Set(problems.map((p) => p.id));
    return Promise.all(refs.map((r) => this.summaryOf(r, ids)));
  }

  async detail(id: string): Promise<ContestDetail> {
    const ref = await this.get(id);
    const all = await this.problems.list();
    const byId = new Map(all.map((p) => [p.id, p]));
    const summary = await this.summaryOf(ref, new Set(byId.keys()));
    return { summary, problems: summary.problems.map((p) => ({ index: p.index, problem: p.problem, summary: byId.get(p.problem) ?? null })) };
  }

  /** Validate a new contest name; returns the folder to create. */
  async checkNew(name: string, folder = ''): Promise<string> {
    if (!PROBLEM_NAME_RE.test(name)) throw new HttpError(400, 'invalid_name', 'Name must be lowercase letters, digits and dashes');
    const dir = path.join(await libraryParent(this.dir, folder), name);
    if (await exists(dir)) throw new HttpError(409, 'exists', `Folder already exists: ${dir}`);
    if ((await this.list()).some(c => c.name === name)) throw new HttpError(409, 'exists', `Contest name already exists: ${name}`);
    return dir;
  }

  async create(req: CreateContestRequest): Promise<ContestSummary> {
    const parsedType = problemTypeSchema.safeParse(req.type ?? 'cf');
    if (!parsedType.success) throw new HttpError(400, 'invalid_type', 'Contest type must be cf or oi');
    const type = parsedType.data;
    const name = req.name?.trim() ?? '';
    const dir = await this.checkNew(name, req.folder);
    const problems = await this.prepareProblems(req.problems ?? []);
    await fsp.mkdir(dir, { recursive: true });
    await ensureContestFiles(dir);
    await this.write(dir, { contest: { name, type, title: req.title ?? {} }, problems });
    await this.scan();
    const ref = [...this.byId.values()].find((r) => samePath(r.dir, dir));
    if (!ref) throw new HttpError(500, 'create_failed', 'Contest created but not found on rescan');
    return (await this.list()).find((c) => c.id === ref.id)!;
  }

  /** Update title / problem list / Polygon id; keeps unknown keys of contest.toml. */
  async update(id: string, req: UpdateContestRequest): Promise<ContestDetail> {
    const ref = await this.get(id);
    const { raw, error } = await this.read(ref);
    if (error && Object.keys(raw).length === 0) throw new HttpError(400, 'invalid_contest_toml', error);
    const doc = structuredClone(raw) as Record<string, any>;
    doc.contest ??= { name: path.basename(ref.dir) };
    if (req.name !== undefined) {
      const name = typeof req.name === 'string' ? req.name.trim() : '';
      if (!PROBLEM_NAME_RE.test(name)) throw new HttpError(400, 'invalid_name', 'Name must be lowercase letters, digits and dashes');
      if ((await this.list()).some(c => c.id !== id && c.name === name)) throw new HttpError(409, 'exists', `Contest name already exists: ${name}`);
      // The folder is the stable contest id (AI sessions and batch jobs refer to it).
      // Rename the display/export short name without changing that identity.
      doc.contest.name = name;
    }
    if (req.title) doc.contest.title = req.title;
    if (req.type !== undefined) doc.contest.type = req.type;
    if (req.statement) doc.statement = req.statement;
    if (req.problems) doc.problems = checkProblems(req.problems);
    if (req.polygonId !== undefined) {
      doc.polygon ??= {};
      if (req.polygonId === null) delete doc.polygon.id;
      else doc.polygon.id = req.polygonId;
      if (!Object.keys(doc.polygon).length) delete doc.polygon;
    }
    const check = contestTomlSchema.safeParse(doc);
    if (!check.success) throw new HttpError(400, 'invalid_patch', check.error.message);
    if (req.problems) doc.problems = await this.prepareProblems(check.data.problems);
    await this.write(ref.dir, doc);
    return this.detail(id);
  }

  /**
   * Delete the contest's own folder (contest.toml, files/, .polyforge/) so the name can
   * be used again. Referenced problems live elsewhere and are never touched; a folder
   * that is (or contains) a problem only loses the contest's own entries.
   */
  async remove(id: string): Promise<void> {
    const ref = await this.get(id);
    const inside = (dir: string) => {
      const rel = path.relative(ref.dir, dir);
      return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
    };
    const problems = await this.problems.scan();
    const sharesProblem = await exists(path.join(ref.dir, 'problem.toml')) || problems.some(p => inside(p.dir))
      || this.problems.roots.some(r => inside(r));
    if ((await fsp.lstat(ref.dir)).isSymbolicLink()) {
      await fsp.unlink(ref.dir);
    } else if (sharesProblem || !samePath(path.dirname(ref.dir), this.dir)) {
      for (const entry of [CONTEST_FILE, 'files', '.polyforge']) await fsp.rm(path.join(ref.dir, entry), { recursive: true, force: true });
      const left = await fsp.readdir(ref.dir).catch(() => ['?']);
      if (!left.length) await fsp.rmdir(ref.dir).catch(() => {});
    } else {
      await fsp.rm(ref.dir, { recursive: true, force: true, maxRetries: 3 });
    }
    await this.scan();
  }

  private write(dir: string, doc: Record<string, unknown>) {
    return atomicWrite(path.join(dir, CONTEST_FILE), stringify(doc) + '\n');
  }

  async move(id: string, folder = ''): Promise<ContestDetail> {
    const ref = await this.get(id), parent = await libraryParent(this.dir, folder);
    const destination = path.join(parent, path.basename(ref.dir));
    if (samePath(destination, ref.dir)) return this.detail(id);
    if (await fsp.lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) throw new HttpError(409, 'exists', 'Destination folder already exists');
    await fsp.rename(ref.dir, destination);
    this.byId.set(id, { ...ref, dir: destination });
    await this.scan(); return this.detail(id);
  }

  private async prepareProblems(list: ContestProblemRef[]): Promise<ContestProblemRef[]> {
    const checked = checkProblems(list);
    await Promise.all(checked.map(async p => {
      const ref = await this.problems.get(p.problem);
      const { config, error } = await this.problems.readConfig(ref);
      if (!config) throw new HttpError(400, 'invalid_problem_toml', error ?? p.problem);
    }));
    return checked;
  }
}

function checkProblems(list: ContestProblemRef[]): ContestProblemRef[] {
  const seenIndex = new Set<string>();
  const seenProblem = new Set<string>();
  return list.map((p) => {
    const index = String(p.index ?? '').trim().toUpperCase();
    const problem = String(p.problem ?? '').trim();
    if (!CONTEST_INDEX_RE.test(index)) throw new HttpError(400, 'invalid_index', `Invalid problem index: ${p.index}`);
    if (!problem) throw new HttpError(400, 'invalid_problem', `Problem ${index} has no problem id`);
    if (seenIndex.has(index)) throw new HttpError(400, 'duplicate_index', `Duplicate index ${index}`);
    if (seenProblem.has(problem)) throw new HttpError(400, 'duplicate_problem', `Problem ${problem} is listed twice`);
    seenIndex.add(index);
    seenProblem.add(problem);
    return { index, problem };
  });
}
