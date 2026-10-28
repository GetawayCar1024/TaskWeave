import { execFile } from 'node:child_process';
import type { Semaphore } from './runner.js';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { STD_PREFIX, type CompileResult, type Diagnostic, type Language, type LanguagesConfig } from '@taskweave/shared';
import type { GlobalStore } from '../global.js';
import { stdRefToPath } from '../sharedFiles.js';
import { atomicWrite, exists, HttpError, safeJoin, sha1, toPosix } from '../util/fs.js';
import { withBuildLocks, type BuildIdentity } from './buildLock.js';

/** A compiled (or interpreted) program ready to be run. */
export interface Program {
  /** Reference as written in problem.toml, e.g. `solutions/std.cpp` or `std:ncmp`. */
  source: string;
  /** Absolute path of the source file. */
  srcPath: string;
  lang: string;
  /** argv to run it (before program arguments). */
  argv: string[];
  /** Identifies source + language + toolchain; used as a cache key for derived results. */
  hash: string;
  build?: BuildIdentity;
  checkerProtocol?: 'lemon-native';
}

export interface CompileOutcome {
  result: CompileResult;
  program?: Program;
}

/** Split a command template into argv, honouring double quotes. */
export function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let has = false;
  for (const ch of cmd) {
    if (ch === '"') {
      quoted = !quoted;
      has = true;
    } else if (/\s/.test(ch) && !quoted) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

function substitute(argv: string[], vars: Record<string, string>): string[] {
  return argv.map((a) => a.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m));
}

const C_COMPILERS = /^(g\+\+|gcc|c\+\+|cc|clang|clang\+\+)(-\d+)?(\.exe)?$/i;

/**
 * Tests are stored with LF (as on Polygon). testlib built on Windows without FOR_LINUX
 * expects CRLF in strict mode ("Expected EOLN"), so C/C++ builds always get -DFOR_LINUX,
 * also with a languages.toml written before the default template had it.
 */
export function withLfNewlines(lang: Language): Language {
  const cmd = lang.compile;
  if (!cmd || /-DFOR_(LINUX|WINDOWS)\b/.test(cmd)) return lang;
  const m = cmd.match(/^\s*("[^"]+"|\S+)/);
  if (!m || !C_COMPILERS.test(path.basename(m[1].replace(/"/g, '')))) return lang;
  return { ...lang, compile: `${m[0]} -DFOR_LINUX${cmd.slice(m[0].length)}` };
}

export function pickLanguage(languages: LanguagesConfig, file: string, override?: string): { id: string; lang: Language } | null {
  if (override) {
    const lang = languages[override];
    if (!lang) throw new HttpError(400, 'unknown_language', `Unknown language "${override}" for ${file}`);
    return { id: override, lang };
  }
  const ext = path.extname(file).toLowerCase();
  for (const [id, lang] of Object.entries(languages)) if (lang.extensions.includes(ext)) return { id, lang };
  return null;
}

const DIAG_RE = /^(.*?):(\d+):(\d+): (fatal error|error|warning|note): (.*)$/;

export function parseDiagnostics(log: string, problemDir: string | null): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const line of log.split(/\r?\n/)) {
    const m = line.match(DIAG_RE);
    if (!m) continue;
    let file = m[1];
    if (problemDir) {
      const rel = path.relative(problemDir, path.resolve(problemDir, file));
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) file = toPosix(rel);
    }
    const sev = m[4] === 'fatal error' ? 'error' : (m[4] as Diagnostic['severity']);
    out.push({ file, line: Number(m[2]), column: Number(m[3]), severity: sev, message: m[5] });
  }
  return out;
}

interface CacheRecord {
  hash?: string;
  source?: string;
  builtAt?: number;
  ok: boolean;
  log: string;
}

/**
 * One executable slot per canonical source path. Content, language, templates and
 * testlib.h invalidate the record without creating another executable directory.
 */
export class Compiler {
  canPrune = () => false;
  private maintenance: Promise<void> = Promise.resolve();
  private pruneTimer?: NodeJS.Timeout;
  private roots = new Set<string>();
  async waitForMaintenance() { await this.maintenance; }

  /** Prune only while all API requests, jobs and AI sessions are idle. */
  private schedulePrune(root: string) {
    this.roots.add(root);
    clearTimeout(this.pruneTimer);
    this.pruneTimer = setTimeout(() => {
      if (!this.canPrune() || this.inflight.size) return this.schedulePrune(root);
      this.maintenance = this.prune().catch(e => console.warn('[taskweave] cache cleanup:', e.message));
    }, 1000);
    this.pruneTimer.unref();
  }

  private async prune() {
    for (const root of this.roots) {
      const records: { dir: string; source: string; at: number }[] = [];
      for (const name of await fsp.readdir(root).catch(() => [] as string[])) {
        if (/^source-[a-f0-9]{16}$/.test(name)) {
          // Stable slots go once their source is gone (deleted or renamed).
          const dir = path.join(root, name);
          const r: CacheRecord | null = await fsp.readFile(path.join(dir, 'compile.json'), 'utf8').then(JSON.parse).catch(() => null);
          if (r?.source && !(await exists(r.source))) await fsp.rm(dir, { recursive: true, force: true });
          continue;
        }
        if (!/^[a-f0-9]{16}$/.test(name)) continue;
        const dir = path.join(root, name);
        const r: CacheRecord | null = await fsp.readFile(path.join(dir, 'compile.json'), 'utf8').then(JSON.parse).catch(() => null);
        // Old content-addressed slots are disposable once the source has a stable slot.
        if (!r?.source || await exists(path.join(root, `source-${sha1(this.sourceKey(r.source)).slice(0, 16)}`, 'compile.json'))) {
          await fsp.rm(dir, { recursive: true, force: true });
        } else records.push({ dir, source: this.sourceKey(r.source), at: r.builtAt ?? 0 });
      }
      const kept = new Set<string>();
      for (const r of records.sort((a,b) => b.at - a.at)) {
        if (!kept.has(r.source)) { kept.add(r.source); continue; }
        await fsp.rm(r.dir, { recursive: true, force: true });
      }
    }
  }
  private inflight = new Map<string, Promise<CompileOutcome>>();
  private sourceKey(file: string) {
    const resolved = path.resolve(file);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
  /** The plain variant keeps the historic slot name. */
  private slotKey(file: string, ...variant: string[]) {
    const v = variant.filter(Boolean);
    return v.length ? `${this.sourceKey(file)}|${v.join('|')}` : this.sourceKey(file);
  }

  constructor(
    private global: GlobalStore,
    /** Bounds concurrent compiler processes. */
    private pool?: Semaphore,
  ) {}

  /** Resolve a problem.toml source reference to an absolute path. */
  resolveSource(problemDir: string, source: string): { srcPath: string; buildRoot: string } {
    if (source.startsWith(STD_PREFIX) || source.startsWith('lemon:')) {
      const rel = stdRefToPath(source);
      if (!rel) throw new HttpError(400, 'bad_source', `Invalid std reference: ${source}`);
      return { srcPath: path.join(this.global.sharedDir, rel), buildRoot: path.join(this.global.cacheDir, 'bin') };
    }
    return { srcPath: safeJoin(problemDir, source), buildRoot: path.join(problemDir, '.taskweave', 'build') };
  }

  async compile(problemDir: string, source: string, langOverride?: string, buildRootOverride?: string, grader?: { sources: string[]; headers: string[] }): Promise<CompileOutcome> {
    await this.maintenance;
    const started = Date.now();
    const resolved = this.resolveSource(problemDir, source);
    const srcPath = await fsp.realpath(resolved.srcPath).catch(() => resolved.srcPath);
    // Shared std checkers keep their global cache; problem sources may use an override.
    const buildRoot = source.startsWith(STD_PREFIX) || source.startsWith('lemon:') || !buildRootOverride ? resolved.buildRoot : buildRootOverride;
    const fail = (log: string, lang?: string): CompileOutcome => ({
      result: { source, ok: false, cached: false, lang, log, diagnostics: [], durationMs: Date.now() - started },
    });
    let content: Buffer;
    try {
      content = await fsp.readFile(srcPath);
    } catch {
      return fail(`Source not found: ${source}`);
    }
    const languages = (await this.global.readLanguages()).languages;
    const picked = pickLanguage(languages, srcPath, langOverride);
    if (!picked) return fail(`No language in languages.toml matches ${path.extname(srcPath) || source}`);
    const id = picked.id;
    const lang = withLfNewlines(picked.lang);
    const extraArgs: string[] = [];
    const dependencies = new Map<string, string>();
    const dependencyFiles = [srcPath];
    const includeDirs: string[] = [];
    if (grader) {
      if (!grader.sources.length) return fail('Grader mode requires at least one C++ grader source.', id);
      const command = splitCommand(lang.compile ?? '');
      if (!/\.(cpp|cc|cxx)$/i.test(srcPath) || !C_COMPILERS.test(path.basename(command[0] ?? '')) || !command.includes('{src}')) return fail('Grader mode requires a C++ compiler command with a separate {src} argument.', id);
      const sources = grader.sources.map(s => safeJoin(problemDir, s));
      if (sources.some(s => this.sourceKey(s) === this.sourceKey(srcPath))) return fail('A submission cannot also be a grader source.', id);
      if (sources.some(s => !/\.(cpp|cc|cxx)$/i.test(s))) return fail('Grader sources must be C++ translation units.', id);
      const files = [...sources, ...grader.headers.map(s => safeJoin(problemDir, s))];
      includeDirs.push(...new Set(files.map(s => path.dirname(s))));
      extraArgs.push(...sources, ...includeDirs.flatMap(d => ['-I', d]));
      dependencyFiles.push(...files);
    }
    // Checker headers (including Testlib for Lemons) also invalidate the one executable slot.
    if (/\.(cpp|cc|cxx|c)$/i.test(srcPath)) {
      const collect = async (file: string): Promise<void> => {
        if (dependencies.has(file)) return;
        const bytes = await fsp.readFile(file);
        dependencies.set(file, sha1(bytes));
        for (const match of bytes.toString('utf8').matchAll(/^\s*#\s*include\s*(["<])([^">\r\n]+)[">]/gm)) {
          for (const dir of [...(match[1] === '"' ? [path.dirname(file)] : []), ...includeDirs, this.global.sharedDir]) {
            const candidate = path.resolve(dir, match[2]);
            if (await exists(candidate)) { await collect(candidate); break; }
          }
        }
      };
      try { for (const file of dependencyFiles) await collect(file); }
      catch (e) { return fail(`Cannot read source dependency: ${(e as Error).message}`, id); }
    }
    const usesShared = `${lang.compile ?? ''} ${lang.run}`.includes('{shared}');
    const testlib = usesShared ? await fsp.readFile(path.join(this.global.sharedDir, 'testlib.h')).catch(() => '') : '';
    const base = path.basename(srcPath, path.extname(srcPath));
    const hash = sha1(JSON.stringify([this.sourceKey(srcPath), id, lang.compile ?? '', lang.run, base, sha1(content), sha1(testlib), extraArgs, [...dependencies]]));
    // One slot per build variant: the grader-linked build must not overwrite the plain build
    // of the same source (and invalidate queued runs). A changed language reuses the slot:
    // every caller takes the language from problem.toml, so it cannot alternate.
    const dir = path.join(buildRoot, `source-${sha1(this.slotKey(srcPath, grader ? 'grader' : '')).slice(0, 16)}`);

    const key = `${buildRoot}|${hash}`;
    let p = this.inflight.get(key);
    if (!p) {
      p = withBuildLocks([dir], () => this.build({ source, srcPath, problemDir, buildRoot, dir, contentHash: sha1(content), hash, id, lang, base, started, extraArgs, dependencies })).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private async build(a: {
    source: string;
    srcPath: string;
    problemDir: string;
    buildRoot: string;
    dir: string;
    contentHash: string;
    hash: string;
    id: string;
    lang: Language;
    base: string;
    started: number;
    extraArgs: string[];
    dependencies: Map<string, string>;
  }): Promise<CompileOutcome> {
    const dir = a.dir;
    const exe = path.join(dir, process.platform === 'win32' ? `${a.base}.exe` : a.base);
    const vars = { src: a.srcPath, exe, dir, class: a.base, shared: this.global.sharedDir };
    const program: Program = { source: a.source, srcPath: a.srcPath, lang: a.id, argv: substitute(splitCommand(a.lang.run), vars), hash: a.hash, build: a.lang.compile ? { dir, hash: a.hash } : undefined };
    const recordPath = path.join(dir, 'compile.json');
    const problemDir = a.source.startsWith(STD_PREFIX) ? null : a.problemDir;
    const done = (rec: CacheRecord, cached: boolean): CompileOutcome => ({
      result: {
        source: a.source,
        ok: rec.ok,
        cached,
        lang: a.id,
        log: rec.log,
        diagnostics: parseDiagnostics(rec.log, problemDir),
        durationMs: Date.now() - a.started,
      },
      program: rec.ok ? program : undefined,
    });

    if (await exists(recordPath)) {
      try {
        const rec = JSON.parse(await fsp.readFile(recordPath, 'utf8')) as CacheRecord;
        // A successful record is only trusted if its executable is still there.
        const needsExe = !!a.lang.compile?.includes('{exe}');
        if (rec.hash === a.hash && (!rec.ok || !needsExe || (await exists(exe)))) {
          rec.source = a.srcPath;
          rec.builtAt = Date.now();
          await atomicWrite(recordPath, JSON.stringify(rec));
          this.schedulePrune(a.buildRoot);
          return done(rec, true);
        }
      } catch {
        /* corrupt record: rebuild */
      }
    }
    if (!a.lang.compile) return done({ ok: true, log: '' }, false);

    await fsp.mkdir(dir, { recursive: true });
    // Invalidate first; a failed compile must never leave a runnable old binary.
    await fsp.rm(recordPath, { force: true });
    await fsp.rm(exe, { force: true });
    const [cmd, ...args] = substitute(splitCommand(a.lang.compile), vars);
    args.push(...a.extraArgs);
    const compileOnce = () => new Promise<CacheRecord>((resolve) => {
      execFile(
        cmd,
        args,
        { cwd: path.dirname(a.srcPath), timeout: 120_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const log = `${stdout}${stderr}`.trim();
          if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') resolve({ ok: false, log: `Compiler not found: ${cmd}` });
          else if (err && (err as { killed?: boolean }).killed) resolve({ ok: false, log: `${log}\nCompilation timed out`.trim() });
          else resolve({ ok: !err, log });
        },
      );
    });
    const rec = this.pool ? await this.pool.use(compileOnce) : await compileOnce();
    const sourceChanged = sha1(await fsp.readFile(a.srcPath).catch(() => '')) !== a.contentHash || (await Promise.all([...a.dependencies].map(async ([file, hash]) => sha1(await fsp.readFile(file).catch(() => '')) !== hash))).some(Boolean);
    if (sourceChanged) {
      rec.ok = false;
      rec.log = 'Source changed during compilation; save or run again.';
    }
    if (!rec.ok) await fsp.rm(exe, { force: true });
    rec.hash = a.hash;
    rec.source = a.srcPath;
    rec.builtAt = Date.now();
    // A compiler missing from PATH is not a property of the source; don't cache it.
    if (!sourceChanged && !rec.log.startsWith('Compiler not found')) await atomicWrite(recordPath, JSON.stringify(rec));
    this.schedulePrune(a.buildRoot);
    return done(rec, false);
  }
}
