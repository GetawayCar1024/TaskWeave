import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import {
  DEFAULT_TESTSET,
  GROUP_POLICIES,
  judgeMode,
  judgeModeSchema,
  isSourceFile,
  STATEMENT_SECTIONS,
  PROBLEM_NAME_RE,
  TESTSET_NAME_RE,
  parseIndexList,
  compressRanges,
  type TestGroup,
  STD_PREFIX,
  statementLanguages,
  problemTomlSchema,
  problemTypeSchema,
  flattenFiles,
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
import { cfToOi, oiTemplate } from './oiStatement.js';
import { convertStatementMode } from './statements.js';

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

  requireRoot(root = this.roots[0]): string {
    if (!this.roots.length || !root) throw new HttpError(400, 'no_root', 'No problem root directory configured');
    if (!this.roots.some(r => samePath(r, root))) throw new HttpError(400, 'invalid_root', 'Unknown problem root');
    return root;
  }

  /** Rescan all roots. Each direct subfolder containing problem.toml is a problem. */
  private scanning?: Promise<ProblemRef[]>;
  async scan(): Promise<ProblemRef[]> {
    return this.scanning ??= this.scanRoots().finally(() => { this.scanning = undefined; });
  }
  private async scanRoots(): Promise<ProblemRef[]> {
    const found: { dir: string; root: string; name: string; identity?: string }[] = [];
    for (const root of this.roots) {
      const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
      for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
        const dir = path.join(root, ent.name);
        if (!(await exists(path.join(dir, PROBLEM_FILE)))) continue;
        const identity = await fsp.readFile(path.join(dir, '.polyforge', 'identity'), 'utf8').catch(() => '');
        found.push({ dir, root, name: ent.name, identity: /^[a-zA-Z0-9_-]+(?:~[0-9]+)?$/.test(identity.trim()) ? identity.trim() : undefined });
      }
    }
    const next = new Map<string, ProblemRef>();
    const reserved = new Set(found.map(p => p.identity).filter(Boolean));
    // A new problem must not steal the identity of a recoverable problem and silently
    // replace it in contests. Explicit identities of restored folders still win below.
    const trash = path.join(this.global.dir, 'trash');
    for (const entry of await fsp.readdir(trash, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const dir = path.join(trash, entry.name);
      const meta = await fsp.readFile(path.join(dir, '.polyforge-trash.json'), 'utf8').then(JSON.parse).catch(() => null);
      const identity = meta?.kind === 'problem' ? meta.originalId : (await fsp.readFile(path.join(dir, '.polyforge/identity'), 'utf8').catch(() => '')).trim();
      if (typeof identity === 'string' && /^[a-zA-Z0-9_-]+(?:~[0-9]+)?$/.test(identity)) reserved.add(identity);
    }
    for (const p of found) {
      let id = p.identity;
      if (!id || next.has(id)) {
        id = p.name;
        for (let i = 2; next.has(id) || reserved.has(id); i++) id = `${p.name}~${i}`;
      }
      if (id !== p.identity) await atomicWrite(path.join(p.dir, '.polyforge', 'identity'), id);
      next.set(id, { id, dir: p.dir, root: p.root });
    }
    this.byId = next;
    return [...next.values()];
  }

  async ensureRoot(root: string): Promise<string> {
    if (!path.isAbsolute(root)) throw new HttpError(400, 'invalid_root', 'Choose an absolute directory');
    root = path.resolve(root);
    await this.scan();
    if ([...this.byId.values()].some(p => samePath(p.dir, root) || root.toLowerCase().startsWith(p.dir.toLowerCase() + path.sep))) throw new HttpError(400, 'invalid_root', 'A problem folder cannot be a problem root');
    await fsp.mkdir(root, { recursive: true });
    root = await fsp.realpath(root);
    for (const p of this.byId.values()) {
      const dir = await fsp.realpath(p.dir);
      const rel = path.relative(dir, root);
      if (rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))) throw new HttpError(400, 'invalid_root', 'A problem folder cannot be a problem root');
    }
    if (!this.roots.some(r => samePath(r, root))) {
      await this.global.saveConfig({ ...this.global.config, problems: { ...this.global.config.problems, roots: [...this.roots, root] } });
    }
    return root;
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
    // External deletions must not leave phantom entries in run selectors.
    r.data.problem.interactive = judgeMode(r.data.problem) === 'io';
    try {
      checkGroups('tests', r.data.tests.group ?? []);
      if (r.data.tests.large_samples) {
        checkGroups('large samples', [{ name: 'large', tests: r.data.tests.large_samples }]);
        const samples = new Set(parseIndexList(r.data.tests.samples ?? ''));
        if (parseIndexList(r.data.tests.large_samples).some(i => !samples.has(i))) throw new Error('Large samples must be a subset of samples.');
      }
      for (const [name, ts] of Object.entries(r.data.testsets)) {
        checkGroups(name, ts.group ?? []);
        if (ts.large_samples && parseIndexList(ts.large_samples).some(i => !parseIndexList(ts.samples ?? '').includes(i))) throw new Error(`${name}: Large samples must be a subset of samples.`);
      }
    } catch (e) { return { config: null, raw, error: `problem.toml: ${(e as Error).message}` }; }
    r.data.solutions = (await Promise.all(r.data.solutions.map(async s => (await this.sourceExists(ref, s.source)) ? s : null))).filter(s => s !== null);
    if (r.data.solutions.length && !r.data.solutions.some(s => s.tag === 'MA')) r.data.solutions[0].tag = 'MA';
    return { config: r.data, raw };
  }

  /**
   * Problems without `input` / `output` (older files, other tools) get stdin / stdout
   * written into [problem], as text so the rest of the file (comments) stays as it is.
   */
  private filling = new Map<string, Promise<void>>();
  private async fillStreams(ref: ProblemRef, raw: Record<string, unknown>) {
    const p = raw.problem as Record<string, unknown> | undefined;
    if (!p || typeof p !== 'object' || (p.input !== undefined && p.output !== undefined)) return;
    const file = path.join(ref.dir, PROBLEM_FILE);
    // Concurrent reads (summary + detail) must not insert the keys twice.
    const run = (this.filling.get(file) ?? Promise.resolve()).then(async () => {
      const text = await fsp.readFile(file, 'utf8');
      let current: Record<string, unknown> | undefined;
      try { current = (parse(text) as Record<string, any>).problem; } catch { return; }
      if (!current || typeof current !== 'object' || (current.input !== undefined && current.output !== undefined)) return;
      const m = /^[ \t]*\[problem\][ \t]*(#.*)?\r?\n/m.exec(text);
      if (!m) return;
      const nl = text.includes('\r\n') ? '\r\n' : '\n';
      const add = [current.input === undefined ? 'input = "stdin"' : '', current.output === undefined ? 'output = "stdout"' : ''].filter(Boolean);
      const at = m.index + m[0].length;
      await atomicWrite(file, text.slice(0, at) + add.map((l) => l + nl).join('') + text.slice(at));
    }).catch(() => {});
    this.filling.set(file, run);
    await run;
    if (this.filling.get(file) === run) this.filling.delete(file);
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
      type: config?.problem.type ?? 'cf',
      dataOnly: config?.problem.data_only ?? false,
      name: config?.problem.name ?? path.basename(ref.dir),
      title: config?.problem.title ?? {},
      dir: ref.dir,
      root: ref.root,
      timeLimit: config?.problem.time_limit ?? 0,
      memoryLimit: config?.problem.memory_limit ?? 0,
      input: config?.problem.input ?? 'stdin',
      output: config?.problem.output ?? 'stdout',
      interactive: config ? judgeMode(config.problem) !== 'batch' : false,
      judgeMode: config ? judgeMode(config.problem) : 'batch',
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
    if (/^lemon:[\w-]+$/.test(source)) return exists(path.join(this.global.sharedDir, 'lemon/checkers', source.slice(6) + '.cpp'));
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
    const parsedType = problemTypeSchema.safeParse(req.type ?? 'cf');
    if (!parsedType.success) throw new HttpError(400, 'invalid_type', 'Problem type must be cf or oi');
    const type = parsedType.data;
    const name = req.name?.trim() ?? '';
    if (!PROBLEM_NAME_RE.test(name)) {
      throw new HttpError(400, 'invalid_name', 'Name must be lowercase letters, digits and dashes');
    }
    const root = this.requireRoot(req.root);
    await fsp.mkdir(root, { recursive: true });
    const dir = path.join(root, name);
    if (await exists(dir)) throw new HttpError(409, 'exists', `Folder already exists: ${dir}`);

    const tl = req.timeLimit ?? 1000;
    const ml = req.memoryLimit ?? 256;
    const mode = judgeModeSchema.parse(req.judgeMode ?? (req.interactive ? 'io' : 'batch'));
    if (req.dataOnly && mode !== 'batch') throw new HttpError(400, 'data_only', 'Compatibility mode supports batch input/answer pairs only.');
    const interactive = mode === 'io';
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
      if (req.dataOnly) {
        await fsp.mkdir(path.join(dir, 'tests/manual'), { recursive: true });
        await atomicWrite(path.join(dir, PROBLEM_FILE), stringify({
          problem: { name, type, data_only: true, title: req.title ?? {}, time_limit: tl, memory_limit: ml, input: 'stdin', output: 'stdout', judge_mode: 'batch' },
          tests: { answers: 'provided', points: true, groups: true, group: [{ name: 'all', points: 100, policy: 'EACH_TEST' }] },
        }));
      } else {
        await copyTemplate(tpl, dir, vars);
        if (type === 'cf' && await isDir(stmtTpl)) {
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
        const doc = parse(await fsp.readFile(path.join(dir, PROBLEM_FILE), 'utf8')) as Record<string, any>;
        doc.problem.type = type;
        doc.problem.judge_mode = mode;
        doc.problem.interactive = interactive;
        if (mode === 'grader') {
          doc.grader = { sources: ['grader/grader.cpp'], headers: ['grader/grader.h'] };
          doc.solutions = [{ source: 'solutions/std.cpp', tag: 'MA' }];
          await atomicWrite(path.join(dir, 'grader/grader.h'), '#pragma once\nlong long solve(long long a, long long b);\n');
          await atomicWrite(path.join(dir, 'grader/grader.cpp'), '#include "grader.h"\n#include <iostream>\nint main() { long long a, b; if (!(std::cin >> a >> b)) return 1; std::cout << solve(a, b) << "\\n"; }\n');
          await atomicWrite(path.join(dir, 'solutions/std.cpp'), '#include "grader.h"\nlong long solve(long long a, long long b) { return a + b; }\n');
        }
        await atomicWrite(path.join(dir, PROBLEM_FILE), stringify(doc));
        if (type === 'oi') {
          for (const lang of ['zh', 'en']) await atomicWrite(path.join(dir, 'statement', lang, 'statement.tex'), oiTemplate(lang));
          await fsp.mkdir(path.join(dir, 'attachments'), { recursive: true });
        }
        if (type === 'cf' && req.statementMode === 'whole') for (const lang of await fsp.readdir(path.join(dir, 'statement')).catch(() => [])) {
          if (/^[a-z]{2,8}$/.test(lang) && lang !== 'images') await convertStatementMode(dir, lang, 'whole');
        }
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
    if (req.name !== undefined) {
      const name = typeof req.name === 'string' ? req.name.trim() : '';
      if (!PROBLEM_NAME_RE.test(name)) throw new HttpError(400, 'invalid_name', 'Name must be lowercase letters, digits and dashes');
      if (name !== p.name && (await this.list()).some(problem => problem.id !== id && problem.name === name)) throw new HttpError(409, 'exists', `Problem name already exists: ${name}`);
      p.name = name;
    }
    if (req.luogu !== undefined) { doc.exports ??= {}; doc.exports.luogu = req.luogu; }
    if (req.language) {
      const { source, lang } = req.language;
      const languages = (await this.global.readLanguages()).languages;
      if (lang !== null && !languages[lang]) throw new HttpError(400, 'unknown_language', `Unknown language: ${lang}`);
      doc.source_languages ??= {};
      if (doc.polygon_source_types) delete doc.polygon_source_types[source];
      if (lang === null) delete doc.source_languages[source];
      else doc.source_languages[source] = lang;
      for (const entry of [doc.validator, doc.checker, doc.lemon_checker, doc.interactor, ...(doc.solutions ?? []), ...(doc.generators ?? [])]) {
        if (entry?.source !== source) continue;
        if (lang === null) delete entry.lang; else entry.lang = lang;
      }
    }
    if (req.title) p.title = req.title;
    if (req.timeLimit !== undefined) p.time_limit = req.timeLimit;
    if (req.memoryLimit !== undefined) p.memory_limit = req.memoryLimit;
    if (req.judgeMode !== undefined || req.interactive !== undefined) {
      const mode = judgeModeSchema.parse(req.judgeMode ?? (req.interactive ? 'io' : 'batch'));
      if (mode === 'grader' && doc.polygon?.id !== undefined) throw new HttpError(400, 'grader_polygon', 'Grader problems cannot connect to Polygon. Unbind the problem first.');
      p.judge_mode = mode;
      p.interactive = mode === 'io';
    }
    if (req.grader !== undefined) {
      if (req.grader === null) delete doc.grader;
      else {
        for (const file of [...req.grader.sources, ...req.grader.headers]) safeJoin(ref.dir, file);
        doc.grader = req.grader;
      }
    }
    if (req.input !== undefined) p.input = req.input;
    if (req.lemonChecker !== undefined) {
      if (req.lemonChecker === null) delete doc.lemon_checker;
      else {
        if (!/^lemon:[\w-]+$/.test(req.lemonChecker)) safeJoin(ref.dir, req.lemonChecker);
        doc.lemon_checker = { ...(doc.lemon_checker?.source === req.lemonChecker ? doc.lemon_checker : {}), source: req.lemonChecker,
          ...(doc.source_languages?.[req.lemonChecker] ? { lang: doc.source_languages[req.lemonChecker] } : {}) };
      }
    }
    if (req.output !== undefined) p.output = req.output;
    for (const key of ['checker', 'validator', 'interactor'] as const) {
      const v = req[key];
      if (v === null) delete doc[key];
      else if (v !== undefined) {
        safeJoinUnlessStd(ref.dir, v);
        // Options such as `lang` belong to the previous file; never carry them over.
        doc[key] = { ...(doc[key]?.source === v ? doc[key] : {}), source: v,
          ...(doc[key]?.source !== v && doc.source_languages?.[v] ? { lang: doc.source_languages[v] } : {}) };
      }
    }
    if (req.solution) {
      const list: any[] = Array.isArray(doc.solutions) ? doc.solutions : [];
      const i = list.findIndex((s) => s?.source === req.solution!.source);
      if (req.solution.tag === null) {
        if (i >= 0) list.splice(i, 1);
      } else if (i >= 0) list[i].tag = req.solution.tag;
      else list.push({ source: req.solution.source, tag: req.solution.tag });
      if (req.solution.tag === 'MA') for (const s of list) {
        if (s.source !== req.solution.source && s.tag === 'MA') s.tag = 'OK';
      }
      if (list.length && !list.some(s => s.tag === 'MA')) (list.find(s => s.source !== req.solution!.source) ?? list[0]).tag = 'MA';
      doc.solutions = list;
    }
    if (req.polygonId !== undefined) {
      if (judgeMode(p) === 'grader' && req.polygonId !== null) throw new HttpError(400, 'grader_polygon', 'Grader problems cannot connect to Polygon.');
      if (p.type === 'oi' && req.polygonId !== null) throw new HttpError(400, 'oi_polygon', 'OI problems cannot sync with Polygon');
      doc.polygon ??= {};
      if (req.polygonId === null) delete doc.polygon.id;
      else doc.polygon.id = req.polygonId;
    }
    if (req.samples !== undefined) {
      doc.tests ??= {};
      if (req.samples.trim()) doc.tests.samples = req.samples.trim();
      else delete doc.tests.samples;
      const remaining = new Set(parseIndexList(doc.tests.samples ?? ''));
      const large = parseIndexList(doc.tests.large_samples ?? '').filter(i => remaining.has(i));
      if (large.length) doc.tests.large_samples = compressRanges(large); else delete doc.tests.large_samples;
    }
    if (req.largeSamples !== undefined) {
      doc.tests ??= {};
      checkGroups('large samples', [{ name: 'large', tests: req.largeSamples }]);
      const samples = new Set(parseIndexList(doc.tests.samples ?? ''));
      const large = parseIndexList(req.largeSamples);
      if (large.some(i => !samples.has(i))) throw new HttpError(400, 'invalid_samples', 'Large samples must be a subset of samples.');
      if (large.length) doc.tests.large_samples = compressRanges(large); else delete doc.tests.large_samples;
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
      if (p.answers !== undefined) target.answers = p.answers;
      if (p.script !== undefined) {
        if (p.script === null || !p.script.trim()) delete target.script;
        else target.script = p.script.trim();
      }
      if (p.groups !== undefined) {
        if (p.groups) target.groups = true;
        else delete target.groups;
      }
      if (p.group !== undefined) {
        const groups = checkGroups(name, p.group, true);
        // An explicit edit of scoring replaces unsupported imported script semantics.
        delete target.unresolved_scoring;
        for (const group of groups) {
          const old = (target.group ?? []).find((g: TestGroup) => g.name === group.name);
          // Overrides belong to this membership, never erase another group's imported values.
          for (const i of parseIndexList(group.tests ?? '')) if (group.cases?.[i]) {
            if (old?.test_points !== group.test_points && group.test_points !== undefined) delete group.cases[i].points;
            for (const field of ['time_limit', 'memory_limit'] as const) if (old?.[field] !== group[field]) delete group.cases[i][field];
          }
        }
        if (groups.length) target.group = groups;
        else delete target.group;
      }
      if (p.samples !== undefined) {
        checkGroups(`${name} samples`, [{ name: 'samples', tests: p.samples }]);
        const samples = parseIndexList(p.samples);
        if (samples.length) target.samples = compressRanges(samples); else delete target.samples;
        const large = parseIndexList(target.large_samples ?? '').filter(i => samples.includes(i));
        if (large.length) target.large_samples = compressRanges(large); else delete target.large_samples;
      }
      if (p.largeSamples !== undefined) {
        checkGroups(`${name} large samples`, [{ name: 'large', tests: p.largeSamples }]);
        const samples = new Set(parseIndexList(target.samples ?? ''));
        const large = parseIndexList(p.largeSamples);
        if (large.some(i => !samples.has(i))) throw new HttpError(400, 'invalid_samples', 'Large samples must be a subset of samples.');
        if (large.length) target.large_samples = compressRanges(large); else delete target.large_samples;
      }
    }
    if (doc.testsets && !Object.keys(doc.testsets).length) delete doc.testsets;
    if (req.dataOnly !== undefined) p.data_only = req.dataOnly;
    const check = problemTomlSchema.safeParse(doc);
    if (!check.success) throw new HttpError(400, 'invalid_patch', check.error.message);
    if (req.dataOnly === false && raw.problem && (raw.problem as Record<string, unknown>).data_only) {
      const c = check.data;
      const requirements: [string, boolean][] = [
        ['statement', (await this.statementLangs(ref)).statement.length > 0],
        ['validator', !!c.validator && await this.sourceExists(ref, c.validator.source)],
        ['checker', !!c.checker && await this.sourceExists(ref, c.checker.source)],
        ['main solution (MA)', !!c.solutions.find(s => s.tag === 'MA') && await this.sourceExists(ref, c.solutions.find(s => s.tag === 'MA')!.source)],
      ];
      if (judgeMode(c.problem) === 'io') requirements.push(['interactor', !!c.interactor && await this.sourceExists(ref, c.interactor.source)]);
      if (judgeMode(c.problem) === 'grader') requirements.push(['grader', !!c.grader?.sources.length && (await Promise.all(c.grader.sources.map(s => this.sourceExists(ref, s)))).every(Boolean)]);
      const missing = requirements.filter(([, ok]) => !ok).map(([name]) => name);
      if (missing.length) throw new HttpError(400, 'incomplete_problem', `Complete these files before enabling full authoring: ${missing.join(', ')}`);
    }
    const configFile = path.join(ref.dir, PROBLEM_FILE);
    const destination = req.name !== undefined ? path.join(ref.root, p.name) : ref.dir;
    if (destination !== ref.dir) {
      if ((await fsp.lstat(ref.dir)).isSymbolicLink()) throw new HttpError(400, 'linked_problem', 'Cannot rename a linked problem folder.');
      if (!samePath(destination, ref.dir) && await fsp.lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) throw new HttpError(409, 'exists', `Destination folder already exists: ${destination}`);
      const previous = await fsp.readFile(configFile, 'utf8');
      await atomicWrite(configFile, stringify(doc) + '\n');
      try { await fsp.rename(ref.dir, destination); }
      catch (error) {
        // A locked/occupied destination must not leave a new short name on the old folder.
        await atomicWrite(configFile, previous);
        throw error;
      }
      // Finish any scan that began before the move, then publish the new location by identity.
      await this.scanning;
      this.byId.set(id, { ...ref, dir: destination });
    } else await atomicWrite(configFile, stringify(doc) + '\n');
    return this.detail(id);
  }

  /** Keep role registrations in step with file creation, deletion and rename. */
  async fileChanged(id: string, rel: string, to?: string, removed = false): Promise<void> {
    const ref = await this.get(id);
    const { raw } = await this.readConfig(ref);
    if (!raw.problem) return;
    const doc = structuredClone(raw) as Record<string, any>;
    const before = JSON.stringify(doc);
    const matches = (s: string) => s === rel || s.startsWith(rel + '/');
    for (const key of ['source_languages', 'polygon_source_types']) {
      for (const [source, value] of Object.entries(doc[key] ?? {})) {
        if (!matches(source)) continue;
        if (removed || to) delete doc[key][source];
        if (to) doc[key][to + source.slice(rel.length)] = value;
      }
    }
    for (const role of ['solutions', 'generators']) {
      if (!Array.isArray(doc[role])) continue;
      const list = doc[role] as { source: string; tag?: string }[];
      doc[role] = list.filter(e => !removed || !matches(e.source));
      if (to) for (const e of doc[role]) if (matches(e.source)) e.source = to + e.source.slice(rel.length);
    }
    for (const role of ['validator', 'checker', 'lemon_checker', 'interactor']) {
      if (!doc[role]?.source || !matches(doc[role].source)) continue;
      if (removed) delete doc[role];
      else if (to) doc[role].source = to + doc[role].source.slice(rel.length);
    }
    if (doc.grader) {
      for (const role of ['sources', 'headers']) {
        if (!Array.isArray(doc.grader[role])) continue;
        doc.grader[role] = (doc.grader[role] as string[])
          .filter(source => !removed || !matches(source))
          .map(source => to && matches(source) ? to + source.slice(rel.length) : source);
      }
      // A grader with no translation units is unconfigured, rather than invalid TOML.
      if (Array.isArray(doc.grader.sources) && !doc.grader.sources.length) delete doc.grader;
    }
    const target = to ?? rel;
    if (!removed && /^solutions?\//.test(target) && isSourceFile(target) && !(doc.solutions ?? []).some((s: any) => s.source === target)) {
      (doc.solutions ??= []).push({ source: target, tag: 'OK' });
    }
    if (doc.solutions?.length && !doc.solutions.some((s: any) => s.tag === 'MA')) doc.solutions[0].tag = 'MA';
    // Rewriting drops comments, so only write when a registration really changed.
    if (JSON.stringify(doc) !== before) await atomicWrite(path.join(ref.dir, PROBLEM_FILE), stringify(doc) + '\n');
  }

  async createStatementLanguage(id: string, rel: string): Promise<void> {
    const match = /^statement\/([a-z]{2,8})\/?$/.exec(rel);
    if (!match || match[1] === 'images') return;
    const ref = await this.get(id);
    const { config } = await this.readConfig(ref);
    if (config?.problem.type === 'oi') {
      const dest = safeJoin(ref.dir, `${rel}/statement.tex`);
      if (!(await exists(dest))) await atomicWrite(dest, oiTemplate(match[1]));
      return;
    }
    if (await exists(safeJoin(ref.dir, `${rel}/statement.tex`))) return;
    for (const section of STATEMENT_SECTIONS) {
      if (section === 'interaction' && !config?.problem.interactive) continue;
      const dest = safeJoin(ref.dir, `${rel}/${section}.tex`);
      if (await exists(dest)) continue;
      const template = await fsp.readFile(path.join(this.global.templatesDir, 'statement', match[1], `${section}.tex`), 'utf8').catch(() => '');
      await atomicWrite(dest, template);
    }
  }

  /** A separate, unbound OI copy. The source and its Polygon sync history stay intact. */
  async convertToOi(id: string): Promise<ProblemSummary> {
    const ref = await this.get(id);
    const { config, raw, error } = await this.readConfig(ref);
    if (!config) throw new HttpError(400, 'invalid_problem_toml', error ?? 'Invalid problem.toml');
    if (config.problem.type === 'oi') return this.summary(ref);
    if (!PROBLEM_NAME_RE.test(config.problem.name)) throw new HttpError(400, 'invalid_name', 'Name must be lowercase letters, digits and dashes');
    const langs = (await this.summary(ref)).status.statementLangs;
    const bodies = await Promise.all(langs.map(async lang => [lang, await cfToOi(ref.dir, config, lang)] as const));
    let name = `${config.problem.name.slice(0, 56)}-oi`;
    let dir = path.join(ref.root, name);
    // Exclusive mkdir reserves the destination even for concurrent conversions.
    for (let n = 2; ; n++) {
      try { await fsp.mkdir(dir); break; }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        name = `${config.problem.name.slice(0, 50)}-oi-${n}`;
        dir = path.join(ref.root, name);
      }
    }
    try {
      for (const file of flattenFiles(await buildTree(ref.dir))) {
        if (file.path === PROBLEM_FILE || /^statement\/[^/]+\/(legend|input|output|interaction|scoring|notes|statement)\.tex$/.test(file.path)) continue;
        await atomicWrite(safeJoin(dir, file.path), await fsp.readFile(safeJoin(ref.dir, file.path)));
      }
      for (const [lang, body] of bodies) await atomicWrite(path.join(dir, 'statement', lang, 'statement.tex'), body);
      await fsp.mkdir(path.join(dir, 'attachments'), { recursive: true });
      const doc = structuredClone(raw) as Record<string, any>;
      doc.problem = { ...doc.problem, type: 'oi', name };
      delete doc.polygon;
      delete doc.polygon_source_types;
      // Publish last: incomplete copies are never registered as problems.
      await atomicWrite(path.join(dir, PROBLEM_FILE), stringify(doc));
    } catch (e) {
      await fsp.rm(dir, { recursive: true, force: true });
      throw e;
    }
    await this.scan();
    return this.summary([...this.byId.values()].find(r => samePath(r.dir, dir))!);
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

function safeJoinUnlessStd(dir: string, source: string) {
  if (!source.startsWith(STD_PREFIX)) safeJoin(dir, source);
}

async function countFiles(dir: string): Promise<number> {
  try {
    return (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && !e.name.startsWith('.') && !/\.(ans|out)$/i.test(e.name) && !/\.statement\.in$/i.test(e.name)).length;
  } catch {
    return 0;
  }
}

/** Validate a testset's groups (subtasks) and drop empty fields before writing TOML. */
export function checkGroups(testset: string, list: TestGroup[], orderedDependencies = false): TestGroup[] {
  const names = new Set<string>();
  const out = list.map((g) => {
    const name = String(g.name ?? '').trim();
    if (!name) throw new HttpError(400, 'invalid_group', `${testset}: a group has no name`);
    if (names.has(name)) throw new HttpError(400, 'invalid_group', `${testset}: duplicate group ${name}`);
    names.add(name);
    const tests = String(g.tests ?? '').trim();
    if ((tests.match(/\d+/g) ?? []).some(n => !Number.isSafeInteger(Number(n)) || Number(n) > 100000)) throw new HttpError(400, 'invalid_group', `${testset}: test indices must not exceed 100000`);
    if (tests && !/^\s*\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*\s*$/.test(tests)) {
      throw new HttpError(400, 'invalid_group', `${testset}: group ${name}: tests must look like "1-5, 8"`);
    }
    for (const i of parseIndexList(tests)) {
      if (i < 1) throw new HttpError(400, 'invalid_group', `${testset}: test indices start at 1`);
    }
    const r: TestGroup = { name };
    if (tests) r.tests = compressRanges(parseIndexList(tests));
    if (g.points !== undefined && g.points !== null) {
      const points = Number(g.points);
      if (!Number.isFinite(points) || points < 0) throw new HttpError(400, 'invalid_group', `${testset}: group ${name}: points must be finite and nonnegative`);
      r.points = points;
    }
    for (const field of ['test_points', 'time_limit', 'memory_limit'] as const) if (g[field] !== undefined && g[field] !== null) {
      const value = Number(g[field]);
      if (!Number.isFinite(value) || (field === 'test_points' ? value < 0 : value <= 0) || field === 'time_limit' && !Number.isSafeInteger(value)) throw new HttpError(400, 'invalid_group', `${testset}: group ${name}: invalid ${field}`);
      r[field] = value;
    }
    if (g.policy) {
      if (!(GROUP_POLICIES as readonly string[]).includes(g.policy)) throw new HttpError(400, 'invalid_group', `${testset}: group ${name}: unknown points policy ${g.policy}`);
      r.policy = g.policy;
    }
    if (g.dependencies?.length) r.dependencies = [...new Set(g.dependencies.map((d) => String(d).trim()))];
    if (g.validator?.trim()) r.validator = g.validator.trim();
    if (g.cases) r.cases = structuredClone(g.cases);
    return r;
  });
  const positions = new Map(out.map((group, index) => [group.name, index]));
  for (const g of out) {
    for (const d of g.dependencies ?? []) {
      if (d === g.name) throw new HttpError(400, 'invalid_group', `${testset}: group ${g.name} depends on itself`);
      if (!names.has(d)) throw new HttpError(400, 'invalid_group', `${testset}: group ${g.name} depends on unknown group ${d}`);
      if (orderedDependencies && positions.get(d)! >= positions.get(g.name)!) throw new HttpError(400, 'invalid_group', `${testset}: subtask ${g.name} can only depend on earlier subtasks (${d}).`);
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
