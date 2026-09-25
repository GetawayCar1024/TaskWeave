import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { STD_PREFIX, type CompileResult, type Diagnostic, type Language, type LanguagesConfig } from '@polyforge/shared';
import type { GlobalStore } from '../global.js';
import { stdRefToPath } from '../sharedFiles.js';
import { atomicWrite, exists, HttpError, safeJoin, sha1, toPosix } from '../util/fs.js';

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
  ok: boolean;
  log: string;
}

/**
 * Compiles sources with the templates from languages.toml. Builds are cached by
 * source content + language + templates + testlib.h, so unchanged files never rebuild.
 */
export class Compiler {
  private inflight = new Map<string, Promise<CompileOutcome>>();

  constructor(private global: GlobalStore) {}

  /** Resolve a problem.toml source reference to an absolute path. */
  resolveSource(problemDir: string, source: string): { srcPath: string; buildRoot: string } {
    if (source.startsWith(STD_PREFIX)) {
      const rel = stdRefToPath(source);
      if (!rel) throw new HttpError(400, 'bad_source', `Invalid std reference: ${source}`);
      return { srcPath: path.join(this.global.sharedDir, rel), buildRoot: path.join(this.global.cacheDir, 'bin') };
    }
    return { srcPath: safeJoin(problemDir, source), buildRoot: path.join(problemDir, '.polyforge', 'build') };
  }

  async compile(problemDir: string, source: string, langOverride?: string, buildRootOverride?: string): Promise<CompileOutcome> {
    const started = Date.now();
    const resolved = this.resolveSource(problemDir, source);
    const srcPath = resolved.srcPath;
    // Shared std checkers keep their global cache; problem sources may use an override.
    const buildRoot = source.startsWith(STD_PREFIX) || !buildRootOverride ? resolved.buildRoot : buildRootOverride;
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
    const usesShared = `${lang.compile ?? ''} ${lang.run}`.includes('{shared}');
    const testlib = usesShared ? await fsp.readFile(path.join(this.global.sharedDir, 'testlib.h')).catch(() => '') : '';
    const base = path.basename(srcPath, path.extname(srcPath));
    const hash = sha1(JSON.stringify([id, lang.compile ?? '', lang.run, base, sha1(content), sha1(testlib)]));

    const key = `${buildRoot}|${hash}`;
    let p = this.inflight.get(key);
    if (!p) {
      p = this.build({ source, srcPath, problemDir, buildRoot, hash, id, lang, base, started }).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private async build(a: {
    source: string;
    srcPath: string;
    problemDir: string;
    buildRoot: string;
    hash: string;
    id: string;
    lang: Language;
    base: string;
    started: number;
  }): Promise<CompileOutcome> {
    const dir = path.join(a.buildRoot, a.hash.slice(0, 16));
    const exe = path.join(dir, process.platform === 'win32' ? `${a.base}.exe` : a.base);
    const vars = { src: a.srcPath, exe, dir, class: a.base, shared: this.global.sharedDir };
    const program: Program = { source: a.source, srcPath: a.srcPath, lang: a.id, argv: substitute(splitCommand(a.lang.run), vars), hash: a.hash };
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
        if (!rec.ok || !needsExe || (await exists(exe))) return done(rec, true);
      } catch {
        /* corrupt record: rebuild */
      }
    }
    if (!a.lang.compile) return done({ ok: true, log: '' }, false);

    await fsp.mkdir(dir, { recursive: true });
    const [cmd, ...args] = substitute(splitCommand(a.lang.compile), vars);
    const rec = await new Promise<CacheRecord>((resolve) => {
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
    // A compiler missing from PATH is not a property of the source; don't cache it.
    if (!rec.log.startsWith('Compiler not found')) await atomicWrite(recordPath, JSON.stringify(rec));
    return done(rec, false);
  }
}
