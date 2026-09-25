import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import {
  CONTEST_FILE,
  CONTEST_INDEX_RE,
  PROBLEM_NAME_RE,
  contestTomlSchema,
  type ContestDetail,
  type ContestProblemRef,
  type ContestSummary,
  type ContestToml,
  type CreateContestRequest,
  type UpdateContestRequest,
} from '@polyforge/shared';
import { samePath } from '../global.js';
import { atomicWrite, exists, HttpError } from '../util/fs.js';
import type { ProblemRegistry } from './problems.js';

export interface ContestRef {
  id: string;
  dir: string;
  root: string;
}

/** Contests: subfolders of the problem roots containing contest.toml. */
export class ContestRegistry {
  private byId = new Map<string, ContestRef>();

  constructor(private problems: ProblemRegistry) {}

  async scan(): Promise<ContestRef[]> {
    const next = new Map<string, ContestRef>();
    for (const root of this.problems.roots) {
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
        if (!(await exists(path.join(dir, CONTEST_FILE)))) continue;
        let id = ent.name;
        for (let i = 2; next.has(id); i++) id = `${ent.name}~${i}`;
        next.set(id, { id, dir, root });
      }
    }
    this.byId = next;
    return [...next.values()];
  }

  async get(id: string): Promise<ContestRef> {
    let ref = this.byId.get(id);
    if (!ref) {
      await this.scan();
      ref = this.byId.get(id);
    }
    if (!ref) throw new HttpError(404, 'contest_not_found', `Contest not found: ${id}`);
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
      name: config?.contest.name ?? path.basename(ref.dir),
      title: config?.contest.title ?? {},
      dir: ref.dir,
      root: ref.root,
      polygonId: config?.polygon.id,
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

  /** Validate a new contest name / root; returns the folder to create. */
  async checkNew(name: string, rootArg?: string): Promise<string> {
    if (!PROBLEM_NAME_RE.test(name)) throw new HttpError(400, 'invalid_name', 'Name must be lowercase letters, digits and dashes');
    const roots = this.problems.roots;
    const root = rootArg ?? roots[0];
    if (!root) throw new HttpError(400, 'no_root', 'No problem root directory configured');
    if (!roots.some((r) => samePath(r, root))) throw new HttpError(400, 'invalid_root', 'Unknown problem root');
    const dir = path.join(root, name);
    if (await exists(dir)) throw new HttpError(409, 'exists', `Folder already exists: ${dir}`);
    return dir;
  }

  async create(req: CreateContestRequest): Promise<ContestSummary> {
    const name = req.name?.trim() ?? '';
    const dir = await this.checkNew(name, req.root);
    const problems = checkProblems(req.problems ?? []);
    await fsp.mkdir(dir, { recursive: true });
    await this.write(dir, { contest: { name, title: req.title ?? {} }, problems });
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
    if (req.title) doc.contest.title = req.title;
    if (req.problems) doc.problems = checkProblems(req.problems);
    if (req.polygonId !== undefined) {
      doc.polygon ??= {};
      if (req.polygonId === null) delete doc.polygon.id;
      else doc.polygon.id = req.polygonId;
      if (!Object.keys(doc.polygon).length) delete doc.polygon;
    }
    const check = contestTomlSchema.safeParse(doc);
    if (!check.success) throw new HttpError(400, 'invalid_patch', check.error.message);
    await this.write(ref.dir, doc);
    return this.detail(id);
  }

  /** Remove contest.toml (the problems are untouched); the folder goes too if nothing else is left. */
  async remove(id: string): Promise<void> {
    const ref = await this.get(id);
    await fsp.rm(path.join(ref.dir, CONTEST_FILE), { force: true });
    await fsp.rm(path.join(ref.dir, '.polyforge'), { recursive: true, force: true });
    const left = await fsp.readdir(ref.dir).catch(() => ['?']);
    if (!left.length) await fsp.rmdir(ref.dir).catch(() => {});
    await this.scan();
  }

  private write(dir: string, doc: Record<string, unknown>) {
    return atomicWrite(path.join(dir, CONTEST_FILE), stringify(doc) + '\n');
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
