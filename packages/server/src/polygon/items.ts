import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  polygonFeatureWarnings,
  LANG_FROM_POLYGON,
  LANG_TO_POLYGON,
  STATEMENT_SECTIONS,
  STD_PREFIX,
  TAG_FROM_POLYGON,
  TAG_TO_POLYGON,
  compressRanges,
  convertStatement,
  statementSyntaxWarnings,
  groupLayout as sharedGroupLayout,
  parseIndexList,
  testsetOf,
  testsetsOf,
  OI_SECTIONS,
  TESTSET_NAME_RE,
  type TestsetConfig,
  type ProblemToml,
  type SolutionTag,
  type SyncItem,
  type SyncItemKind,
} from '@polyforge/shared';
import { pickLanguage } from '../judge/compiler.js';
import type { Judge, ProblemCtx } from '../judge/index.js';
import { planTests, scriptStatementPaths, statementPaths } from '../judge/tests.js';
import { defsForProblem, readSharedDefs } from '../defs.js';
import { exists, HttpError, isDir, looksBinary, safeJoin, sha1, validateFileName } from '../util/fs.js';
import { HIDDEN_DIRS } from '../workspace/files.js';
import { PolygonError, type PolygonClient } from './client.js';

export const TESTSET = 'tests';

/** Resource files every Polygon problem has; never synced. */
const DEFAULT_RESOURCES = new Set(['olymp.sty', 'problem.tex', 'statements.ftl', 'testlib.h', 'tutorial.tex']);
/** Statement macro definitions (Codeforces defs), shared by default. */
const DEFS_FILE = 'defs.toml';

const POLY_SECTIONS = ['name', ...STATEMENT_SECTIONS] as const;
type PolySection = (typeof POLY_SECTIONS)[number];

/** A unit of synchronisation. `text`/`bytes` + `meta` are what gets hashed. */
export interface Item extends SyncItem {
  text?: string;
  bytes?: Buffer;
  meta?: Record<string, unknown>;
  /** Push/apply details that are not part of the content (not hashed). */
  extra?: Record<string, any>;
}

const normalize = (s: string) => s.replace(/\r\n/g, '\n').replace(/\s+$/, '');

export function itemHash(it: Item): string {
  const body = it.bytes ?? Buffer.from(normalize(it.text ?? ''), 'utf8');
  const meta = it.kind === 'source' || it.kind === 'solution' ? { ...it.meta, sourceType: it.extra?.sourceType ?? '' } : it.meta ?? {};
  return sha1(Buffer.concat([Buffer.from(JSON.stringify(sortKeys(meta)) + '\0'), body]));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)]));
  return v;
}

/** Text shown in the diff view. */
export function itemDisplay(it: Item): string {
  const meta = it.meta && Object.keys(it.meta).length ? `# ${JSON.stringify(sortKeys(it.meta))}\n` : '';
  if (it.bytes) return meta + (looksText(it.bytes) ? it.bytes.toString('utf8') : `<binary, ${it.bytes.length} bytes, sha1 ${sha1(it.bytes).slice(0, 12)}>`);
  return meta + (it.text ?? '');
}

function looksText(b: Buffer) {
  return !b.subarray(0, 8000).includes(0);
}

export const PUSH_ORDER: SyncItemKind[] = [
  'toml',
  'info',
  'resource',
  'source',
  'config',
  'solution',
  'statementResource',
  'statement',
  // Manual tests before the script: "> $" in the script takes the next index that no
  // manual test has (as in the local test plan), and Polygon numbers when it is saved.
  'test',
  'script',
  'sample',
  'groups',
  'validatorTest',
  'checkerTest',
  'testset',
  'file',
];

// ---------------------------------------------------------------------------
// Shared helpers

export { compressRanges };

const polyCheckerName = (src: string) => (src.startsWith(STD_PREFIX) ? `std::${src.slice(STD_PREFIX.length)}.cpp` : path.posix.basename(src));

const CHECKER_VERDICT_TO_POLY: Record<string, string> = { OK: 'OK', WA: 'WRONG_ANSWER', PE: 'PRESENTATION_ERROR', FAIL: 'CRASHED' };
const CHECKER_VERDICT_FROM_POLY: Record<string, string> = { OK: 'ok', WRONG_ANSWER: 'wa', PRESENTATION_ERROR: 'pe', CRASHED: 'fail' };

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, base: string) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith('.')) continue;
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(d, e.name), rel);
      else out.push(rel);
    }
  };
  await walk(dir, '');
  return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

const hasToken = (s: string, t: string) => new RegExp(`(^|[/._-])${t}([/._-]|$)`, 'i').test(s);

/**
 * Polygon indices of validator / checker self-test files: their number prefix ("03.valid.in",
 * as a pull writes them) when every file has a distinct one, since Polygon keeps the indices
 * of the other tests when one is deleted; else their position.
 */
function selfTestIndices(files: string[]): number[] {
  const nums = files.map((f) => Number(f.match(/^(\d+)(?=[._-]|$)/)?.[1] ?? NaN));
  const ok = nums.every((n) => Number.isInteger(n) && n >= 1) && new Set(nums).size === nums.length;
  return ok ? nums : files.map((_, i) => i + 1);
}

/** Everything of a testset other than "tests", synced as one item. */
export interface TestsetContent {
  script: string;
  /** Manual tests by index. */
  tests: Record<string, string>;
  groupsEnabled: boolean;
  groups: { name: string; pointsPolicy: string; dependencies: string[]; points?: number; tests: string }[];
  /** Per-test points (points enabled). */
  points?: Record<string, number>;
  /** Tests used in the statements ("1-2"). */
  samples?: string;
  /** Statement input / output of manual tests, by index. */
  statements?: Record<string, { input?: string; output?: string }>;
  /** Statement input / output of samples made by the script, by index. */
  scriptStatements?: Record<string, { input?: string; output?: string }>;
}

/** Statement input / output metadata as a testset content entry (undefined when there is none). */
function statementEntry(sm: Record<string, string>): { input?: string; output?: string } | undefined {
  if (sm.statementInput === undefined && sm.statementOutput === undefined) return undefined;
  return { ...(sm.statementInput !== undefined ? { input: sm.statementInput } : {}), ...(sm.statementOutput !== undefined ? { output: sm.statementOutput } : {}) };
}

/** Points as Polygon takes them: at most 2 decimals (also hides float noise of split scores). */
export const roundPoints = (n: number) => Math.round(Number(n) * 100) / 100;

/** Non-zero per-test points, rounded: the form compared on both sides. */
function pointsKey(points: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(points).map(([i, p]) => [i, roundPoints(p)]).filter(([, p]) => p !== 0));
}

function testsetGroups(ts: TestsetConfig, pointsEnabled: boolean): Pick<TestsetContent, 'groupsEnabled' | 'groups' | 'points'> {
  const layout = sharedGroupLayout(ts, pointsEnabled);
  const points = pointsKey(layout.points);
  return {
    groupsEnabled: ts.groups,
    groups: ts.groups
      ? ts.group.map((g) => ({
          name: g.name,
          pointsPolicy: g.policy ?? 'COMPLETE_GROUP',
          dependencies: [...(g.dependencies ?? [])].sort(),
          ...(pointsEnabled ? { points: roundPoints(g.points ?? 0) } : {}),
          tests: compressRanges(parseIndexList(g.tests ?? '')),
        }))
      : [],
    ...(Object.keys(points).length ? { points } : {}),
  };
}

/** A name from Polygon that becomes a local file or folder name: one plain path segment. */
export class UnsafeNameError extends HttpError {
  constructor(what: string, name: string) {
    super(400, 'unsafe_name', `Unsafe ${what} name from Polygon: "${name}"; skipped`);
  }
}
function safeName(what: string, name: unknown): string {
  const s = String(name ?? '');
  try {
    if (/[\\/]/.test(s)) throw new Error();
    validateFileName(s);
  } catch {
    throw new UnsafeNameError(what, s);
  }
  return s;
}
function safeIndex(i: unknown): number {
  const n = Number(i);
  if (!Number.isInteger(n) || n < 1 || n > 1e6) throw new UnsafeNameError('test index', String(i));
  return n;
}

/**
 * OI-only statement files (`statement/<lang>/constraints.tex`, `statement/<lang>/samples/*.tex`):
 * Polygon statements have nothing like them, so they are never synced nor deleted by a pull.
 */
export function isOiOnlyFile(rel: string): boolean {
  const m = rel.match(/^statement\/[^/]+\/(.+)$/);
  if (!m) return false;
  return m[1].startsWith('samples/') || (OI_SECTIONS as readonly string[]).some((s) => m[1] === `${s}.tex`);
}

/** The OI-only statement files a problem has (with content), for the push warning. */
export async function oiOnlyFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const rel of await listFiles(path.join(dir, 'statement'))) {
    const full = `statement/${rel}`;
    if (!isOiOnlyFile(full)) continue;
    const text = await fsp.readFile(path.join(dir, full), 'utf8').catch(() => '');
    if (text.trim()) out.push(full);
  }
  return out;
}

/** Stable, readable text for hashing and the diff view. */
export function testsetText(c: TestsetContent): string {
  // Line endings and trailing blanks do not count, as for single-file items.
  const tests = Object.fromEntries(Object.entries(c.tests).map(([i, t]) => [i, normalize(t)]));
  return JSON.stringify(sortKeys({ ...c, script: normalize(c.script), tests }), null, 2);
}

/** Group of each test index, and per-test points derived from group totals (testset "tests"). */
export function groupLayout(config: ProblemToml) {
  return sharedGroupLayout(testsetOf(config)!, !!config.tests.points);
}

// ---------------------------------------------------------------------------
// Local side

export interface LocalItems {
  items: Item[];
  warnings: string[];
}

export async function localItems(judge: Judge, ctx: ProblemCtx): Promise<LocalItems> {
  const { config, ref } = ctx;
  const dir = ref.dir;
  const warnings: string[] = polygonFeatureWarnings(config);
  const items: Item[] = [];
  const languages = (await judge.global.readLanguages()).languages;
  const readText = async (rel: string) => (await fsp.readFile(path.join(dir, rel), 'utf8')).replace(/\r\n/g, '\n');
  const sourceType = (rel: string) => {
    if (config.polygon_source_types[rel]) return config.polygon_source_types[rel];
    try {
      return pickLanguage(languages, rel, judge.langOf(config, rel))?.lang.polygon;
    } catch {
      return undefined;
    }
  };

  items.push({
    key: 'info',
    kind: 'info',
    label: 'problem info',
    path: 'problem.toml',
    meta: {
      inputFile: config.problem.input || 'stdin',
      outputFile: config.problem.output || 'stdout',
      interactive: config.problem.interactive,
      timeLimit: config.problem.time_limit,
      memoryLimit: config.problem.memory_limit,
    },
  });

  // ---- sources: validator / checker / interactor / generators ----
  const names = new Map<string, string>();
  const addSource = async (rel: string, role: string) => {
    if (rel.startsWith(STD_PREFIX) || !(await exists(path.join(dir, rel)))) return;
    const name = path.posix.basename(rel);
    const prev = names.get(name);
    if (prev && prev !== rel) return warnings.push(`Polygon file names are flat: ${rel} and ${prev} would both be "${name}"; skipping ${rel}`);
    if (prev) return;
    names.set(name, rel);
    items.push({ key: `source:${name}`, kind: 'source', label: `${role}: ${name}`, path: rel, text: await readText(rel), extra: { name, sourceType: sourceType(rel) } });
  };
  if (config.validator) await addSource(config.validator.source, 'validator');
  if (config.checker) await addSource(config.checker.source, 'checker');
  if (config.problem.interactive && config.interactor) await addSource(config.interactor.source, 'interactor');
  for (const [, src] of await judge.generators(ctx)) await addSource(src, 'generator');

  const hasLocal = (src?: string) => !!src && (src.startsWith(STD_PREFIX) || names.has(path.posix.basename(src)));
  const { mapping, points } = groupLayout(config);
  items.push({
    key: 'config',
    kind: 'config',
    label: 'validator / checker / interactor / groups',
    path: 'problem.toml',
    meta: {
      validator: hasLocal(config.validator?.source) ? path.posix.basename(config.validator!.source) : null,
      checker: hasLocal(config.checker?.source) ? polyCheckerName(config.checker!.source) : null,
      interactor: config.problem.interactive && hasLocal(config.interactor?.source) ? path.posix.basename(config.interactor!.source) : null,
      groups: config.tests.groups
        ? (config.tests.group ?? []).map((g) => ({
            name: g.name,
            pointsPolicy: g.policy ?? 'COMPLETE_GROUP',
            dependencies: [...(g.dependencies ?? [])].sort(),
            ...(config.tests.points ? { points: roundPoints(g.points ?? 0) } : {}),
          }))
        : [],
    },
    extra: { groupsEnabled: !!config.tests.groups, pointsEnabled: !!config.tests.points },
  });
  if (Object.keys(mapping).length) {
    // Per-test points are part of the content: a change of points alone must be pushed too.
    const pk = pointsKey(points);
    items.push({ key: 'groups', kind: 'groups', label: 'test groups', path: 'problem.toml', meta: { mapping, ...(Object.keys(pk).length ? { points: pk } : {}) }, extra: { points, pointsEnabled: !!config.tests.points } });
  }

  // ---- resources ----
  for (const rel of await listFiles(path.join(dir, 'files'))) {
    if (rel.includes('/')) {
      warnings.push(`files/${rel}: Polygon resource files cannot be in folders; skipped`);
      continue;
    }
    if (DEFAULT_RESOURCES.has(rel) || rel === '.gitkeep') continue;
    items.push({ key: `resource:${rel}`, kind: 'resource', label: `resource: ${rel}`, path: `files/${rel}`, bytes: await fsp.readFile(path.join(dir, 'files', rel)), binary: true, extra: { name: rel } });
  }
  // Polygon gives every problem testlib.h but not defs.toml, which the statements' \Def…
  // macros need: send the shared one unless the problem has its own files/defs.toml.
  // With a Chinese statement the version with the Chinese macros, else the original one.
  if (!(await exists(path.join(dir, 'files', DEFS_FILE)))) {
    const text = await readSharedDefs(judge.global.sharedDir).catch(() => null);
    const zh = !!config.problem.title.zh?.trim() || (await isDir(path.join(dir, 'statement', 'zh')));
    if (text !== null) {
      const bytes = Buffer.from(defsForProblem(text, zh), 'utf8');
      items.push({ key: `resource:${DEFS_FILE}`, kind: 'resource', label: `resource: ${DEFS_FILE} (shared)`, bytes, binary: true, extra: { name: DEFS_FILE } });
    }
  }

  // ---- solutions ----
  const solNames = new Map<string, string>();
  for (const s of config.solutions) {
    if (!(await exists(path.join(dir, s.source)))) {
      warnings.push(`Solution ${s.source} is listed in problem.toml but missing`);
      continue;
    }
    const name = path.posix.basename(s.source);
    if (solNames.has(name)) {
      warnings.push(`Solutions ${s.source} and ${solNames.get(name)} share the Polygon name "${name}"; skipping ${s.source}`);
      continue;
    }
    solNames.set(name, s.source);
    if (s.tag === 'FL') warnings.push(`${name}: Polygon has no FL tag; it is sent as RJ`);
    items.push({
      key: `solution:${name}`,
      kind: 'solution',
      label: `solution: ${name} (${s.tag})`,
      path: s.source,
      text: await readText(s.source),
      meta: { tag: TAG_TO_POLYGON[s.tag] },
      extra: { name, sourceType: sourceType(s.source) },
    });
  }

  // ---- statements ----
  const stmtDir = path.join(dir, 'statement');
  // Statement folders, plus titles set in problem.toml for a language without one yet
  // (Polygon keeps the title with the statement of that language).
  const folders: string[] = [];
  for (const lang of await fsp.readdir(stmtDir).catch(() => [] as string[])) if (lang !== 'images' && (await isDir(path.join(stmtDir, lang)))) folders.push(lang);
  const titled = Object.entries(config.problem.title).filter(([, v]) => typeof v === 'string' && v.trim()).map(([l]) => l);
  for (const lang of [...new Set([...folders, ...titled])].sort()) {
    const plang = LANG_TO_POLYGON[lang] ?? lang;
    const title = config.problem.title[lang];
    if (title) items.push({ key: `statement:${plang}:name`, kind: 'statement', label: `statement (${plang}): name`, path: 'problem.toml', text: title, extra: { lang: plang, section: 'name' } });
    for (const sec of STATEMENT_SECTIONS) {
      const rel = `statement/${lang}/${sec}.tex`;
      if (!(await exists(path.join(dir, rel)))) continue;
      const text = await readText(rel);
      if (!text.trim()) continue;
      const label = sec === 'tutorial' ? `tutorial (${plang})` : `statement (${plang}): ${sec}`;
      const converted = convertStatement(text, 'polygon');
      warnings.push(...statementSyntaxWarnings(rel, converted.warnings));
      items.push({ key: `statement:${plang}:${sec}`, kind: 'statement', label, path: rel, text: converted.tex, extra: { lang: plang, section: sec } });
    }
  }
  for (const rel of await listFiles(path.join(stmtDir, 'images'))) {
    if (rel.includes('/') || rel === '.gitkeep') continue;
    items.push({
      key: `statementResource:${rel}`,
      kind: 'statementResource',
      label: `statement resource: ${rel}`,
      path: `statement/images/${rel}`,
      bytes: await fsp.readFile(path.join(stmtDir, 'images', rel)),
      binary: true,
      extra: { name: rel },
    });
  }

  // ---- tests ----
  if (config.tests.script && (await exists(path.join(dir, config.tests.script)))) {
    const text = await readText(config.tests.script);
    // An empty script is no script (Polygon: clearScript), as on the remote side.
    if (text.trim()) items.push({ key: 'script', kind: 'script', label: 'test script', path: config.tests.script, text });
  }
  const samples = new Set(parseIndexList(config.tests.samples ?? ''));
  const planErrors: string[] = [];
  const planned = await planTests(ctx, planErrors);
  warnings.push(...planErrors);
  for (const p of planned) {
    if (p.origin === 'manual' && p.manualPath) {
      const rel = path.relative(dir, p.manualPath).split(path.sep).join('/');
      items.push({
        key: `test:${p.index}`,
        kind: 'test',
        label: `manual test ${p.index} (${rel.replace(/^tests\/manual\//, '')})`,
        path: rel,
        text: await readText(rel),
        meta: { sample: samples.has(p.index), ...(await statementMeta(dir, statementPaths(rel))) },
        extra: { index: p.index },
      });
    } else if (samples.has(p.index)) {
      const meta = { sample: true, ...(await statementMeta(dir, scriptStatementPaths(p.index))) };
      items.push({ key: `sample:${p.index}`, kind: 'sample', label: `test ${p.index} is a sample`, path: 'problem.toml', meta, extra: { index: p.index } });
    }
  }

  // ---- further testsets: one item each (script, manual tests, groups) ----
  for (const ts of testsetsOf(config).filter((t) => t.name !== TESTSET)) {
    const errs: string[] = [];
    const tests: Record<string, string> = {};
    const paths: Record<string, string> = {};
    const statements: NonNullable<TestsetContent['statements']> = {};
    const scriptStatements: NonNullable<TestsetContent['scriptStatements']> = {};
    // Statement files of the generated samples (present or not), so they count as tracked.
    const statementFiles: string[] = [];
    const tsSampleSet = new Set(parseIndexList(ts.samples ?? ''));
    for (const p of await planTests(ctx, errs, ts.name)) {
      if (p.origin !== 'manual' || !p.manualPath) {
        if (!tsSampleSet.has(p.index)) continue;
        const sp = scriptStatementPaths(p.index, ts.name);
        statementFiles.push(sp.input, sp.output);
        const st = statementEntry(await statementMeta(dir, sp));
        if (st) scriptStatements[p.index] = st;
        continue;
      }
      const rel = path.relative(dir, p.manualPath).split(path.sep).join('/');
      tests[p.index] = await readText(rel);
      paths[p.index] = rel;
      const st = statementEntry(await statementMeta(dir, statementPaths(rel)));
      if (st) statements[p.index] = st;
    }
    warnings.push(...errs.map((e) => `${ts.name}: ${e}`));
    const tsSamples = compressRanges(parseIndexList(ts.samples ?? ''));
    const content: TestsetContent = {
      script: ts.script ? await readText(ts.script).catch(() => '') : '',
      tests,
      ...testsetGroups(ts, !!config.tests.points),
      ...(tsSamples ? { samples: tsSamples } : {}),
      ...(Object.keys(statements).length ? { statements } : {}),
      ...(Object.keys(scriptStatements).length ? { scriptStatements } : {}),
    };
    items.push({ key: `testset:${ts.name}`, kind: 'testset', label: `testset ${ts.name}`, path: 'problem.toml', text: testsetText(content), extra: { testset: ts.name, content, paths, statementFiles } });
  }

  // ---- validator / checker self-tests ----
  const vt = (await listFiles(path.join(dir, 'validator-tests'))).filter((f) => hasToken(f, 'valid') || hasToken(f, 'invalid'));
  const vtIndex = selfTestIndices(vt);
  for (const [k, f] of vt.entries()) {
    const i = vtIndex[k] - 1;
    const verdict = hasToken(f, 'invalid') ? 'INVALID' : 'VALID';
    items.push({ key: `validatorTest:${i + 1}`, kind: 'validatorTest', label: `validator test ${i + 1} (${f})`, path: `validator-tests/${f}`, text: await readText(`validator-tests/${f}`), meta: { verdict }, extra: { index: i + 1 } });
  }
  const ctNames = (await listFiles(path.join(dir, 'checker-tests'))).filter((f) => f.endsWith('.in')).map((f) => f.slice(0, -3));
  const ctIndex = selfTestIndices(ctNames);
  for (const [k, name] of ctNames.entries()) {
    const i = ctIndex[k] - 1;
    const read = async (ext: string) => ((await exists(path.join(dir, 'checker-tests', `${name}.${ext}`))) ? readText(`checker-tests/${name}.${ext}`) : '');
    let v = (await read('verdict')).trim().split(/\s+/)[0]?.toLowerCase();
    if (!v) v = ['ok', 'wa', 'pe', 'fail'].find((w) => hasToken(name, w)) ?? '';
    const verdict = CHECKER_VERDICT_TO_POLY[{ ok: 'OK', wa: 'WA', pe: 'PE', fail: 'FAIL', fl: 'FAIL' }[v] ?? ''];
    if (!verdict) {
      warnings.push(`checker-tests/${name}: no expected verdict; skipped`);
      continue;
    }
    const [input, output, answer] = [await read('in'), await read('out'), await read('ans')];
    items.push({
      key: `checkerTest:${i + 1}`,
      kind: 'checkerTest',
      label: `checker test ${i + 1} (${name})`,
      path: `checker-tests/${name}.in`,
      text: checkerTestText(input, output, answer),
      meta: { verdict },
      extra: { index: i + 1, name, input, output, answer },
    });
  }

  return { items, warnings };
}

function checkerTestText(input: string, output: string, answer: string) {
  return `=== input ===\n${normalize(input)}\n=== output ===\n${normalize(output)}\n=== answer ===\n${normalize(answer)}`;
}

function splitCheckerTestText(t: string) {
  const m = t.match(/^=== input ===\n([\s\S]*?)\n=== output ===\n([\s\S]*?)\n=== answer ===\n([\s\S]*)$/);
  return m ? { input: m[1], output: m[2], answer: m[3] } : { input: t, output: '', answer: '' };
}

// ---------------------------------------------------------------------------
// Remote side

/**
 * Polygon has no call that lists testsets: the extra ones known locally are fetched by
 * name, and `probe` names (e.g. "pretests") are fetched when Polygon has them.
 */
export async function remoteItems(client: PolygonClient, problemId: number, extraTestsets: string[] = [], probe: string[] = []): Promise<Item[]> {
  const pid = { problemId };
  const items: Item[] = [];
  const info = await client.call('problem.info', pid);
  items.push({
    key: 'info',
    kind: 'info',
    label: 'problem info',
    path: 'problem.toml',
    meta: { inputFile: info.inputFile, outputFile: info.outputFile, interactive: !!info.interactive, timeLimit: info.timeLimit, memoryLimit: info.memoryLimit },
  });

  const opt = async <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
  const [validator, checker, interactor, files, solutions, statements, resources, script, tests, groupDefs, vtests, ctests] = await Promise.all([
    opt(client.call<string>('problem.validator', pid), ''),
    opt(client.call<string>('problem.checker', pid), ''),
    info.interactive ? opt(client.call<string>('problem.interactor', pid), '') : Promise.resolve(''),
    client.call('problem.files', pid),
    client.call<any[]>('problem.solutions', pid),
    client.call<Record<string, Record<string, string>>>('problem.statements', pid),
    opt(client.call<any[]>('problem.statementResources', pid), []),
    opt(client.text('problem.script', { ...pid, testset: TESTSET }), ''),
    opt(client.call<any[]>('problem.tests', { ...pid, testset: TESTSET, noInputs: false }), []),
    opt(client.call<any[]>('problem.viewTestGroup', { ...pid, testset: TESTSET }), []),
    opt(client.call<any[]>('problem.validatorTests', pid), []),
    opt(client.call<any[]>('problem.checkerTests', pid), []),
  ]);

  const pointsByGroup = new Map<string, number>();
  for (const t of tests) if (t.group) pointsByGroup.set(t.group, roundPoints((pointsByGroup.get(t.group) ?? 0) + Number(t.points ?? 0)));
  const anyPoints = tests.some((t) => Number(t.points ?? 0) > 0);
  items.push({
    key: 'config',
    kind: 'config',
    label: 'validator / checker / interactor / groups',
    path: 'problem.toml',
    meta: {
      validator: validator || null,
      checker: checker || null,
      interactor: info.interactive ? interactor || null : null,
      groups: groupDefs.map((g) => ({
        name: String(g.name),
        pointsPolicy: g.pointsPolicy ?? 'COMPLETE_GROUP',
        dependencies: [...(g.dependencies ?? [])].map(String).sort(),
        ...(anyPoints ? { points: pointsByGroup.get(String(g.name)) ?? 0 } : {}),
      })),
    },
    extra: { anyPoints, testPoints: Object.fromEntries(tests.map((t) => [t.index, Number(t.points ?? 0)])) },
  });
  const mapping: Record<string, string> = {};
  for (const t of tests) if (t.group) mapping[t.index] = String(t.group);
  const pk = anyPoints ? pointsKey(Object.fromEntries(tests.filter((t) => t.group).map((t) => [t.index, Number(t.points ?? 0)]))) : {};
  if (Object.keys(mapping).length) items.push({ key: 'groups', kind: 'groups', label: 'test groups', path: 'problem.toml', meta: { mapping, ...(Object.keys(pk).length ? { points: pk } : {}) } });

  for (const f of files.sourceFiles ?? []) {
    const text = await client.text('problem.viewFile', { ...pid, type: 'source', name: f.name });
    items.push({ key: `source:${f.name}`, kind: 'source', label: `source: ${f.name}`, text, extra: { name: f.name, sourceType: f.sourceType } });
  }
  for (const f of files.resourceFiles ?? []) {
    if (DEFAULT_RESOURCES.has(f.name)) continue;
    const bytes = await client.raw('problem.viewFile', { ...pid, type: 'resource', name: f.name });
    items.push({ key: `resource:${f.name}`, kind: 'resource', label: `resource: ${f.name}`, bytes, binary: true, extra: { name: f.name } });
  }
  for (const s of solutions) {
    const text = await client.text('problem.viewSolution', { ...pid, name: s.name });
    items.push({ key: `solution:${s.name}`, kind: 'solution', label: `solution: ${s.name} (${s.tag})`, text, meta: { tag: s.tag }, extra: { name: s.name, sourceType: s.sourceType } });
  }
  for (const [plang, st] of Object.entries(statements ?? {})) {
    for (const sec of POLY_SECTIONS) {
      const text = st?.[sec];
      if (typeof text !== 'string' || !text.trim()) continue;
      items.push({ key: `statement:${plang}:${sec}`, kind: 'statement', label: sec === 'tutorial' ? `tutorial (${plang})` : `statement (${plang}): ${sec}`, text: text.replace(/\r\n/g, '\n'), extra: { lang: plang, section: sec } });
    }
  }
  for (const r of resources) {
    const bytes = await client.raw('problem.viewStatementResource', { ...pid, name: r.name });
    items.push({ key: `statementResource:${r.name}`, kind: 'statementResource', label: `statement resource: ${r.name}`, bytes, binary: true, extra: { name: r.name } });
  }
  if (script.trim()) items.push({ key: 'script', kind: 'script', label: 'test script', text: script.replace(/\r\n/g, '\n') });
  for (const t of tests) {
    if (t.manual) {
      const input = await remoteInput(client, problemId, TESTSET, t);
      items.push({ key: `test:${t.index}`, kind: 'test', label: `manual test ${t.index}`, text: input.replace(/\r\n/g, '\n'), meta: { sample: isSample(t), ...remoteStatementMeta(t) }, extra: { index: t.index } });
    } else if (isSample(t)) {
      items.push({ key: `sample:${t.index}`, kind: 'sample', label: `test ${t.index} is a sample`, path: 'problem.toml', meta: { sample: true, ...remoteStatementMeta(t) }, extra: { index: t.index } });
    }
  }
  for (const v of vtests) {
    items.push({ key: `validatorTest:${v.index}`, kind: 'validatorTest', label: `validator test ${v.index}`, text: String(v.input ?? '').replace(/\r\n/g, '\n'), meta: { verdict: v.expectedVerdict }, extra: { index: v.index } });
  }
  for (const c of ctests) {
    items.push({
      key: `checkerTest:${c.index}`,
      kind: 'checkerTest',
      label: `checker test ${c.index}`,
      text: checkerTestText(String(c.input ?? ''), String(c.output ?? ''), String(c.answer ?? '')),
      meta: { verdict: c.expectedVerdict },
      extra: { index: c.index },
    });
  }
  // Testsets cannot be listed: ask for each name; Polygon answers FAILED for a testset it does not have.
  const probeOnly = new Set(probe.filter((n) => !extraTestsets.includes(n)));
  for (const name of [...new Set([...extraTestsets, ...probe])]) {
    if (name === TESTSET || !TESTSET_NAME_RE.test(name)) continue;
    let tests: any[];
    try {
      tests = (await client.call<any[]>('problem.tests', { ...pid, testset: name, noInputs: false })) ?? [];
    } catch (e) {
      if (e instanceof PolygonError) continue;
      throw e;
    }
    const [script, groupDefs] = await Promise.all([
      opt(client.text('problem.script', { ...pid, testset: name }), ''),
      opt(client.call<any[]>('problem.viewTestGroup', { ...pid, testset: name }), []),
    ]);
    // A probed name (not a local testset) that exists but is empty is not worth a local testset.
    if (probeOnly.has(name) && !script.trim() && !tests.length && !groupDefs.length) continue;
    const manual: Record<string, string> = {};
    const statements: NonNullable<TestsetContent['statements']> = {};
    const scriptStatements: NonNullable<TestsetContent['scriptStatements']> = {};
    for (const t of tests) {
      if (!t.manual) {
        // Only samples have statement files locally (as for the "tests" testset).
        const st = isSample(t) ? statementEntry(remoteStatementMeta(t)) : undefined;
        if (st) scriptStatements[t.index] = st;
        continue;
      }
      manual[t.index] = (await remoteInput(client, problemId, name, t)).replace(/\r\n/g, '\n');
      const st = statementEntry(remoteStatementMeta(t));
      if (st) statements[t.index] = st;
    }
    const byGroup = new Map<string, number[]>();
    for (const t of tests) if (t.group) byGroup.set(String(t.group), [...(byGroup.get(String(t.group)) ?? []), t.index]);
    const anyPoints = tests.some((t) => Number(t.points ?? 0) > 0);
    const points = anyPoints ? pointsKey(Object.fromEntries(tests.filter((t) => t.group).map((t) => [t.index, Number(t.points ?? 0)]))) : {};
    const samples = compressRanges(tests.filter(isSample).map((t) => Number(t.index)));
    const content: TestsetContent = {
      script: script.replace(/\r\n/g, '\n'),
      tests: manual,
      groupsEnabled: groupDefs.length > 0,
      groups: groupDefs.map((g) => {
        const idx = byGroup.get(String(g.name)) ?? [];
        return {
          name: String(g.name),
          pointsPolicy: g.pointsPolicy ?? 'COMPLETE_GROUP',
          dependencies: [...(g.dependencies ?? [])].map(String).sort(),
          ...(anyPoints ? { points: roundPoints(idx.reduce((a, i) => a + Number(tests.find((t) => t.index === i)?.points ?? 0), 0)) } : {}),
          tests: compressRanges(idx),
        };
      }),
      ...(Object.keys(points).length ? { points } : {}),
      ...(samples ? { samples } : {}),
      ...(Object.keys(statements).length ? { statements } : {}),
      ...(Object.keys(scriptStatements).length ? { scriptStatements } : {}),
    };
    items.push({ key: 'testset:' + name, kind: 'testset', label: 'testset ' + name, text: testsetText(content), extra: { testset: name, content } });
  }
  return items;
}

const isSample = (t: any) => t.useInStatements === true || t.useInStatements === 'true';

/** Exact input of a manual test: Base64 when given (`input` is a lossy UTF-8 view). */
async function remoteInput(client: PolygonClient, problemId: number, testset: string, t: any): Promise<string> {
  if (typeof t.inputBase64 === 'string') return Buffer.from(t.inputBase64, 'base64').toString('utf8');
  if (typeof t.input === 'string') return t.input;
  return client.text('problem.testInput', { problemId, testset, testIndex: t.index });
}

/** Statement input / output of a Polygon test, as sync metadata (absent when empty). */
function remoteStatementMeta(t: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, v] of [
    ['statementInput', t.inputForStatement ?? t.inputForStatements],
    ['statementOutput', t.outputForStatement ?? t.outputForStatements],
  ] as const) {
    if (typeof v === 'string' && v.trim()) out[key] = normStmt(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Push: send one local item to Polygon

export interface PushContext {
  client: PolygonClient;
  problemId: number;
  warn: (msg: string) => void;
}

const fileBuf = (it: Item) => it.bytes ?? Buffer.from(it.text ?? '', 'utf8');

/** Points of the given tests (missing = 0); a failure fails the item, so it is sent again. */
async function savePoints(pc: PushContext, testset: string, indices: string[], points: Record<string, number>) {
  const failed: string[] = [];
  for (const i of [...indices].sort((a, b) => Number(a) - Number(b))) {
    await pc.client.call('problem.saveTest', { problemId: pc.problemId, testset, testIndex: Number(i), testPoints: roundPoints(points[i] ?? 0) }).catch((err: Error) => failed.push(`${i}: ${err.message}`));
  }
  if (failed.length) throw new Error(`${testset === TESTSET ? '' : `${testset}: `}points of tests ${failed.join('; ')}`);
}

/** Push an item; `deleted` pushes clear the remote value where Polygon allows it. */
export async function pushItem(pc: PushContext, it: Item, deleted = false): Promise<void> {
  const { client, problemId } = pc;
  const pid = { problemId };
  const e = it.extra ?? {};
  switch (it.kind) {
    case 'info': {
      const m = it.meta as any;
      await client.call('problem.updateInfo', { ...pid, inputFile: m.inputFile, outputFile: m.outputFile, interactive: m.interactive, timeLimit: m.timeLimit, memoryLimit: m.memoryLimit });
      return;
    }
    case 'source':
      await client.call('problem.saveFile', { ...pid, type: 'source', name: e.name, file: fileBuf(it), sourceType: e.sourceType });
      return;
    case 'resource':
      await client.call('problem.saveFile', { ...pid, type: 'resource', name: e.name, file: fileBuf(it) });
      return;
    case 'config': {
      const m = it.meta as any;
      if (m.validator) await client.call('problem.setValidator', { ...pid, validator: m.validator });
      if (m.checker) await client.call('problem.setChecker', { ...pid, checker: m.checker });
      if (m.interactor) await client.call('problem.setInteractor', { ...pid, interactor: m.interactor });
      await client.call('problem.enableGroups', { ...pid, testset: TESTSET, enable: !!e.groupsEnabled });
      await client.call('problem.enablePoints', { ...pid, enable: !!e.pointsEnabled });
      for (const g of m.groups ?? []) {
        await client.call('problem.saveTestGroup', { ...pid, testset: TESTSET, group: g.name, pointsPolicy: g.pointsPolicy, dependencies: g.dependencies.join(',') || undefined });
      }
      return;
    }
    case 'groups': {
      const mapping = ((it.meta as any)?.mapping ?? {}) as Record<string, string>;
      const byGroup = new Map<string, number[]>();
      for (const [i, g] of Object.entries(mapping)) byGroup.set(g, [...(byGroup.get(g) ?? []), Number(i)]);
      for (const [g, idx] of byGroup) await client.call('problem.setTestGroup', { ...pid, testset: TESTSET, testGroup: g, testIndices: idx.sort((a, b) => a - b).join(',') });
      const points = (e.points ?? (it.meta as any)?.points ?? {}) as Record<string, number>;
      // Every grouped test, so a test whose points went to 0 is reset too; ≤ 2 decimals as Polygon wants.
      if (e.pointsEnabled ?? Object.keys(points).length > 0) await savePoints(pc, TESTSET, Object.keys(mapping), points);
      return;
    }
    case 'solution':
      await client.call('problem.saveSolution', { ...pid, name: e.name, file: fileBuf(it), tag: (it.meta as any).tag, sourceType: e.sourceType });
      return;
    case 'statementResource':
      await client.call('problem.saveStatementResource', { ...pid, name: e.name, file: fileBuf(it) });
      return;
    case 'statement':
      await client.call('problem.saveStatement', { ...pid, lang: e.lang, encoding: 'UTF-8', [e.section]: deleted ? '' : it.text ?? '' });
      return;
    case 'script':
      if ((it.text ?? '').trim()) await client.call('problem.saveScript', { ...pid, testset: TESTSET, source: it.text ?? '' });
      else await client.call('problem.clearScript', { ...pid, testset: TESTSET });
      return;
    case 'test':
      {
        const m = (it.meta ?? {}) as { sample?: boolean; statementInput?: string; statementOutput?: string };
        await client.call('problem.saveTest', {
          ...pid,
          testset: TESTSET,
          testIndex: e.index,
          testInput: it.text ?? '',
          testUseInStatements: !!m.sample,
          // Statement input / output shown instead of the test (any problem); not verified by Polygon.
          testInputForStatements: m.statementInput ?? '', testOutputForStatements: m.statementOutput ?? '', verifyInputOutputForStatements: false,
        });
      }
      return;
    case 'sample': {
      // A generated test: only the statement flags change (saveTest edits an existing test).
      const m = (it.meta ?? {}) as { statementInput?: string; statementOutput?: string };
      const custom = !deleted && (m.statementInput !== undefined || m.statementOutput !== undefined);
      await client.call('problem.saveTest', {
        ...pid,
        testset: TESTSET,
        testIndex: e.index,
        testUseInStatements: !deleted,
        testInputForStatements: custom ? m.statementInput ?? '' : '', testOutputForStatements: custom ? m.statementOutput ?? '' : '', verifyInputOutputForStatements: false,
      });
      return;
    }
    case 'validatorTest':
      await client.call('problem.saveValidatorTest', { ...pid, testIndex: e.index, testInput: it.text ?? '', testVerdict: (it.meta as any).verdict });
      return;
    case 'checkerTest': {
      const parts = splitCheckerTestText(it.text ?? '');
      await client.call('problem.saveCheckerTest', { ...pid, testIndex: e.index, testInput: parts.input, testOutput: parts.output, testAnswer: parts.answer, testVerdict: (it.meta as any).verdict });
      return;
    }
    case 'testset': {
      // The testset itself has to exist on Polygon (Tests → testset list); the API cannot create it.
      const testset: string = e.testset;
      const c = e.content as TestsetContent;
      const missing = (err: Error) => {
        throw new Error(`${err.message} — create the testset "${testset}" on Polygon first (Tests page → testsets), then push again`);
      };
      const listTests = async () => {
        const r = await client.call<any[]>('problem.tests', { ...pid, testset, noInputs: true });
        return Array.isArray(r) ? r : [];
      };
      const before = await listTests().catch(missing);
      // Manual tests that are gone locally go on Polygon too (before the script renumbers "> $").
      const stale = before.filter((t) => t.manual && c.tests[t.index] === undefined).map((t) => Number(t.index));
      if (stale.length) await client.call('problem.deleteTest', { ...pid, testset, testIndices: stale.join(',') });
      // A manual test cannot take the index of a generated one: drop those first.
      if (before.some((t) => !t.manual && c.tests[t.index] !== undefined)) await client.call('problem.clearScript', { ...pid, testset });
      const samples = new Set(parseIndexList(c.samples ?? ''));
      for (const [i, text] of Object.entries(c.tests)) {
        const st = c.statements?.[i];
        await client.call('problem.saveTest', {
          ...pid, testset, testIndex: Number(i), testInput: text, testUseInStatements: samples.has(Number(i)),
          testInputForStatements: st?.input ?? '', testOutputForStatements: st?.output ?? '', verifyInputOutputForStatements: false,
        });
      }
      if (c.script.trim()) await client.call('problem.saveScript', { ...pid, testset, source: c.script }).catch(missing);
      else await client.call('problem.clearScript', { ...pid, testset }).catch(missing);
      // Generated tests exist only now: set their sample flags and statement input / output.
      for (const t of await listTests()) {
        if (t.manual) continue;
        const sample = samples.has(Number(t.index));
        const want = sample ? c.scriptStatements?.[t.index] : undefined;
        const have = statementEntry(remoteStatementMeta(t));
        if (isSample(t) === sample && (want?.input ?? '') === (have?.input ?? '') && (want?.output ?? '') === (have?.output ?? '')) continue;
        await client.call('problem.saveTest', {
          ...pid, testset, testIndex: Number(t.index), testUseInStatements: sample,
          testInputForStatements: want?.input ?? '', testOutputForStatements: want?.output ?? '', verifyInputOutputForStatements: false,
        });
      }
      await client.call('problem.enableGroups', { ...pid, testset, enable: c.groupsEnabled });
      const grouped: string[] = [];
      for (const g of c.groups) {
        await client.call('problem.saveTestGroup', { ...pid, testset, group: g.name, pointsPolicy: g.pointsPolicy, dependencies: g.dependencies.join(',') || undefined });
        const idx = parseIndexList(g.tests);
        grouped.push(...idx.map(String));
        if (idx.length) await client.call('problem.setTestGroup', { ...pid, testset, testGroup: g.name, testIndices: idx.join(',') });
      }
      if (c.groups.some((g) => g.points !== undefined) || Object.keys(c.points ?? {}).length) await savePoints(pc, testset, [...new Set([...grouped, ...Object.keys(c.points ?? {})])], c.points ?? {});
      return;
    }
  }
}

/** Kinds whose local deletion can be expressed on Polygon (deleting or clearing it there). */
export const DELETABLE_KINDS = new Set<SyncItemKind>(['statement', 'sample', 'solution', 'source', 'resource', 'statementResource', 'validatorTest', 'checkerTest', 'test', 'script', 'groups']);

/** Resource files Polygon refuses to delete. */
const UNDELETABLE_RESOURCES = new Set(['olymp.sty', 'problem.tex', 'statements.ftl']);

/** Parts of a sync key: `kind:name` (names may contain ":"), `statement:lang:section`. */
export function splitKey(key: string): { kind: SyncItemKind; name: string } {
  const at = key.indexOf(':');
  return at < 0 ? { kind: key as SyncItemKind, name: '' } : { kind: key.slice(0, at) as SyncItemKind, name: key.slice(at + 1) };
}

/**
 * Remove on Polygon an item deleted locally since the last sync. A statement section is
 * cleared (the whole language goes with `problem.deleteStatement`, see sync); groups go
 * with the config item (enableGroups).
 */
export async function deleteItem(pc: PushContext, key: string): Promise<void> {
  const { client, problemId } = pc;
  const pid = { problemId };
  const { kind, name } = splitKey(key);
  switch (kind) {
    case 'statement': {
      const [lang, section] = [name.slice(0, name.lastIndexOf(':')), name.slice(name.lastIndexOf(':') + 1)];
      return pushItem(pc, { key, kind, label: key, extra: { lang, section } }, true);
    }
    case 'sample':
      return pushItem(pc, { key, kind, label: key, extra: { index: Number(name) } }, true);
    case 'solution':
      await client.call('problem.deleteSolution', { ...pid, name });
      return;
    case 'source':
      await client.call('problem.deleteFile', { ...pid, type: 'source', name });
      return;
    case 'resource':
      if (UNDELETABLE_RESOURCES.has(name)) return;
      await client.call('problem.deleteFile', { ...pid, type: 'resource', name });
      return;
    case 'statementResource':
      await client.call('problem.deleteStatementResource', { ...pid, name });
      return;
    case 'validatorTest':
      await client.call('problem.deleteValidatorTest', { ...pid, testIndex: Number(name) });
      return;
    case 'checkerTest':
      await client.call('problem.deleteCheckerTest', { ...pid, testIndex: Number(name) });
      return;
    case 'test':
      await client.call('problem.deleteTest', { ...pid, testset: TESTSET, testIndex: Number(name) });
      return;
    case 'script':
      await client.call('problem.clearScript', { ...pid, testset: TESTSET });
      return;
    case 'groups':
      return;
    default:
      throw new Error(`${key}: cannot be deleted on Polygon`);
  }
}

/** Polygon's answer when the object to delete is not there (any more): nothing left to do. */
export const alreadyGone = (e: unknown) => {
  if (!(e instanceof PolygonError)) return false;
  // problem.deleteTest: "Some tests can not be deleted." with a reason per test.
  const failures = (e.result as { failures?: { reason?: string }[] } | undefined)?.failures;
  if (Array.isArray(failures) && failures.length) return failures.every((f) => f?.reason === 'NOT_FOUND');
  return /not found|no such|does not exist|doesn't exist|there is no|not exist/i.test(e.message);
};

// ---------------------------------------------------------------------------
// Apply: write a remote item into the local problem

export interface ApplyContext {
  dir: string;
  /** Raw problem.toml document, mutated in place and saved by the caller. */
  doc: Record<string, any>;
  /** Local item with the same key (to reuse its path), if any. */
  local?: Item;
  /** Remote config (for placing role sources). */
  remoteConfig?: Record<string, any>;
  sourceLanguages?: Record<string, string>;
  written: Set<string>;
}

async function writeRel(ac: ApplyContext, rel: string, data: string | Buffer) {
  const abs = safeJoin(ac.dir, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, typeof data === 'string' && data && !data.endsWith('\n') ? `${data}\n` : data);
  ac.written.add(rel);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Remove a problem file (never outside the problem folder). */
async function rmRel(ac: Pick<ApplyContext, 'dir'>, rel: string) {
  await fsp.rm(safeJoin(ac.dir, rel), { force: true });
}

function samplesSet(doc: Record<string, any>): Set<number> {
  return new Set(parseIndexList(doc.tests?.samples ?? ''));
}
function saveSamples(doc: Record<string, any>, s: Set<number>) {
  doc.tests ??= {};
  if (s.size) doc.tests.samples = compressRanges([...s]);
  else delete doc.tests.samples;
}

/** Where a Polygon source file lives locally. */
export function sourcePlacement(name: string, remoteConfig?: Record<string, any>): string {
  if (remoteConfig && [remoteConfig.validator, remoteConfig.checker, remoteConfig.interactor].includes(name)) return name;
  return `generators/${name}`;
}

export async function applyItem(ac: ApplyContext, it: Item): Promise<void> {
  const { doc } = ac;
  const e = it.extra ?? {};
  doc.problem ??= {};
  doc.tests ??= {};
  switch (it.kind) {
    case 'info': {
      const m = it.meta as any;
      Object.assign(doc.problem, { input: m.inputFile || 'stdin', output: m.outputFile || 'stdout', interactive: !!m.interactive, judge_mode: m.interactive ? 'io' : 'batch', time_limit: m.timeLimit, memory_limit: m.memoryLimit });
      return;
    }
    case 'config': {
      const m = it.meta as any;
      const toLocal = (name: string | null, keep?: string) => {
        if (!name) return null;
        if (name.startsWith('std::')) return `${STD_PREFIX}${safeName('checker', name.slice(5)).replace(/\.cpp$/, '')}`;
        if (keep && path.posix.basename(keep) === name) return keep;
        return sourcePlacement(safeName('source', name), m);
      };
      for (const role of ['validator', 'checker', 'interactor'] as const) {
        const v = toLocal(m[role], doc[role]?.source);
        if (v) doc[role] = { ...(doc[role] ?? {}), source: v };
        else delete doc[role];
      }
      const existing: any[] = Array.isArray(doc.tests.group) ? doc.tests.group : [];
      const groups = (m.groups ?? []) as any[];
      doc.tests.groups = groups.length > 0;
      doc.tests.points = groups.some((g) => (g.points ?? 0) > 0);
      doc.tests.group = groups.map((g) => ({
        ...(existing.find((x) => x.name === g.name) ?? {}),
        name: g.name,
        policy: g.pointsPolicy,
        dependencies: g.dependencies,
        ...(g.points !== undefined ? { points: g.points } : {}),
      }));
      if (!doc.tests.group.length) delete doc.tests.group;
      return;
    }
    case 'groups': {
      const mapping = ((it.meta as any)?.mapping ?? {}) as Record<string, string>;
      const byGroup = new Map<string, number[]>();
      for (const [i, g] of Object.entries(mapping)) byGroup.set(g, [...(byGroup.get(g) ?? []), Number(i)]);
      const list: any[] = Array.isArray(doc.tests.group) ? doc.tests.group : [];
      for (const [g, idx] of byGroup) {
        let entry = list.find((x) => x.name === g);
        if (!entry) list.push((entry = { name: g }));
        entry.tests = compressRanges(idx);
      }
      doc.tests.group = list;
      doc.tests.groups = true;
      return;
    }
    case 'source': {
      const rel = ac.local?.path ?? sourcePlacement(safeName('source', e.name), ac.remoteConfig);
      await writeRel(ac, rel, it.text ?? '');
      applySourceType(ac, rel, e.sourceType);
      if (rel.startsWith('generators/')) {
        const gens: any[] = Array.isArray(doc.generators) ? doc.generators : [];
        if (!gens.some((g) => g.source === rel)) gens.push({ source: rel });
        doc.generators = gens;
      }
      return;
    }
    case 'resource':
      await writeRel(ac, ac.local?.path ?? `files/${safeName('resource', e.name)}`, it.bytes ?? Buffer.alloc(0));
      return;
    case 'solution': {
      const rel = ac.local?.path ?? `solutions/${safeName('solution', e.name)}`;
      await writeRel(ac, rel, it.text ?? '');
      applySourceType(ac, rel, e.sourceType);
      const tag: SolutionTag = TAG_FROM_POLYGON[String((it.meta as any)?.tag)] ?? 'RJ';
      const sols: any[] = Array.isArray(doc.solutions) ? doc.solutions : [];
      if (tag === 'MA') for (const entry of sols) if (entry.source !== rel && entry.tag === 'MA') entry.tag = 'OK';
      const s = sols.find((x) => x.source === rel);
      if (s) s.tag = tag;
      else sols.push({ source: rel, tag });
      doc.solutions = sols;
      return;
    }
    case 'statement': {
      const lang = LANG_FROM_POLYGON[e.lang] ?? e.lang;
      if (!/^[A-Za-z][\w-]{0,31}$/.test(lang) || lang === 'images') throw new UnsafeNameError('statement language', String(e.lang));
      if (e.section === 'name') {
        doc.problem.title = { ...(doc.problem.title ?? {}), [lang]: it.text ?? '' };
        return;
      }
      if (!(STATEMENT_SECTIONS as readonly string[]).includes(e.section)) throw new UnsafeNameError('statement section', String(e.section));
      await writeRel(ac, `statement/${lang}/${e.section}.tex`, it.text ?? '');
      return;
    }
    case 'statementResource':
      await writeRel(ac, `statement/images/${safeName('statement resource', e.name)}`, it.bytes ?? Buffer.alloc(0));
      return;
    case 'script': {
      const rel = doc.tests.script || 'tests/script.txt';
      doc.tests.script = rel;
      await writeRel(ac, rel, it.text ?? '');
      return;
    }
    case 'test': {
      const index = safeIndex(e.index);
      const rel = ac.local?.path ?? `tests/manual/${pad(index)}.in`;
      await writeRel(ac, rel, it.text ?? '');
      await writeStatementIo(ac, statementPaths(rel), it.meta);
      const s = samplesSet(doc);
      if ((it.meta as any)?.sample) s.add(index);
      else s.delete(index);
      saveSamples(doc, s);
      return;
    }
    case 'sample': {
      const index = safeIndex(e.index);
      const s = samplesSet(doc);
      s.add(index);
      saveSamples(doc, s);
      await writeStatementIo(ac, scriptStatementPaths(index), it.meta);
      return;
    }
    case 'validatorTest': {
      const verdict = String((it.meta as any)?.verdict ?? 'VALID').toLowerCase() === 'invalid' ? 'invalid' : 'valid';
      const want = `validator-tests/${pad(safeIndex(e.index))}.${verdict}.in`;
      const old = ac.local?.path;
      const keep = old && hasToken(old, verdict) && (verdict === 'invalid' || !hasToken(old, 'invalid'));
      if (old && !keep) await rmRel(ac, old);
      await writeRel(ac, keep ? old! : want, it.text ?? '');
      return;
    }
    case 'checkerTest': {
      const parts = splitCheckerTestText(it.text ?? '');
      const word = CHECKER_VERDICT_FROM_POLY[String((it.meta as any)?.verdict)] ?? 'ok';
      const oldName: string | undefined = ac.local?.extra?.name;
      if (oldName) for (const ext of ['in', 'out', 'ans', 'verdict']) await rmRel(ac, `checker-tests/${oldName}.${ext}`);
      const base = `checker-tests/${pad(safeIndex(e.index))}.${word}`;
      await writeRel(ac, `${base}.in`, parts.input);
      await writeRel(ac, `${base}.out`, parts.output);
      await writeRel(ac, `${base}.ans`, parts.answer);
      return;
    }
    case 'testset': {
      const name: string = e.testset;
      if (!TESTSET_NAME_RE.test(String(name)) || name === TESTSET) throw new UnsafeNameError('testset', String(name));
      const c = e.content as TestsetContent;
      doc.testsets ??= {};
      const t: Record<string, any> = (doc.testsets[name] ??= {});
      // Manual tests live in tests/<name>/ by default, so the script goes next to it.
      const manual: string = String(t.manual ?? `tests/${name}`).replace(/\/+$/, '');
      if (c.script.trim()) {
        t.script ??= `tests/script-${name}.txt`;
        await writeRel(ac, t.script, c.script);
      } else if (t.script) {
        await rmRel(ac, t.script);
        delete t.script;
      }
      const paths = (ac.local?.extra?.paths ?? {}) as Record<string, string>;
      // Manual tests Polygon does not have any more go, with their statement input / output.
      for (const [i, rel] of Object.entries(paths)) {
        if (c.tests[i] !== undefined) continue;
        for (const f of [rel, ...Object.values(statementPaths(rel))]) await rmRel(ac, f);
      }
      for (const [i, text] of Object.entries(c.tests)) {
        const rel = paths[i] ?? `${manual}/${pad(safeIndex(i))}.in`;
        await writeRel(ac, rel, text);
        const st = c.statements?.[i];
        await writeStatementIo(ac, statementPaths(rel), { statementInput: st?.input, statementOutput: st?.output });
      }
      // Statement input / output of generated samples: the old files go, the new ones are written.
      for (const rel of (ac.local?.extra?.statementFiles ?? []) as string[]) await rmRel(ac, rel);
      for (const i of parseIndexList(c.samples ?? '')) {
        if (c.tests[i] !== undefined) continue;
        const st = c.scriptStatements?.[i];
        await writeStatementIo(ac, scriptStatementPaths(safeIndex(i), name), { statementInput: st?.input, statementOutput: st?.output });
      }
      if (c.samples) t.samples = c.samples;
      else delete t.samples;
      if (c.groupsEnabled) t.groups = true;
      else delete t.groups;
      const existing: any[] = Array.isArray(t.group) ? t.group : [];
      t.group = c.groups.map((g) => ({
        ...(existing.find((x) => x.name === g.name) ?? {}),
        name: g.name,
        policy: g.pointsPolicy,
        ...(g.dependencies.length ? { dependencies: g.dependencies } : {}),
        ...(g.points !== undefined ? { points: g.points } : {}),
        ...(g.tests ? { tests: g.tests } : {}),
      }));
      if (!t.group.length) delete t.group;
      return;
    }
  }
}

function applySourceType(ac: ApplyContext, rel: string, sourceType?: string) {
  if (!sourceType) return;
  (ac.doc.polygon_source_types ??= {})[rel] = sourceType;
  const lang = ac.sourceLanguages?.[sourceType];
  if (lang) (ac.doc.source_languages ??= {})[rel] = lang;
}

/** Remove the local counterpart of an item that no longer exists on Polygon. */
/** Files that belong to the repository, not the problem: never offered for deletion. */
const NOT_PROBLEM_FILES = /^(problem\.toml|\.gitignore|\.gitattributes|readme(\.[a-z]+)?)$/i;

/**
 * Local files that no sync item accounts for (an unregistered solution, a stray file in
 * a problem folder, …), as items the pull can delete: Polygon has nothing like them.
 */
export async function untrackedItems(dir: string, config: ProblemToml, items: Item[]): Promise<Item[]> {
  const covered = new Set<string>();
  const coveredDirs: string[] = [];
  for (const it of items) {
    if (it.path) covered.add(it.path);
    if (it.kind === 'test' && it.path) for (const rel of Object.values(statementPaths(it.path))) covered.add(rel);
    if (it.kind === 'sample') for (const rel of Object.values(scriptStatementPaths(it.extra?.index))) covered.add(rel);
    if (it.kind === 'testset') for (const rel of (it.extra?.statementFiles ?? []) as string[]) covered.add(rel);
    if (it.kind === 'checkerTest') for (const ext of ['in', 'out', 'ans', 'verdict']) covered.add(`checker-tests/${it.extra?.name}.${ext}`);
  }
  // Further testsets are one item each: their script and manual tests.
  for (const ts of testsetsOf(config).filter((t) => t.name !== TESTSET)) {
    if (ts.script) covered.add(ts.script);
    coveredDirs.push(`${ts.manual.replace(/\/+$/, '')}/`);
  }
  // An empty script is no item, but it is still the problem's script.
  if (config.tests.script) covered.add(config.tests.script);
  const out: Item[] = [];
  for (const rel of await listFiles(dir)) {
    if (rel.split('/').some((seg) => HIDDEN_DIRS.has(seg)) || NOT_PROBLEM_FILES.test(rel) || covered.has(rel) || coveredDirs.some((d) => rel.startsWith(d))) continue;
    // OI-only statement parts are local by design, not something Polygon lacks.
    if (isOiOnlyFile(rel)) continue;
    // Statement sections are synced when they have text; empty ones are placeholders.
    const sec = rel.match(/^statement\/[^/]+\/([a-z]+)\.tex$/)?.[1];
    if (sec && (STATEMENT_SECTIONS as readonly string[]).includes(sec)) continue;
    const bytes = await fsp.readFile(path.join(dir, rel));
    const binary = looksBinary(bytes);
    out.push({ key: `file:${rel}`, kind: 'file', label: `local file: ${rel}`, path: rel, ...(binary ? { bytes, binary: true } : { text: bytes.toString('utf8') }) });
  }
  return out;
}

export async function removeLocal(ac: ApplyContext, it: Item): Promise<void> {
  const { doc } = ac;
  switch (it.kind) {
    case 'file':
      // Never a file this pull has just written (e.g. a sample's statement input), nor an OI-only one.
      if (it.path && !ac.written.has(it.path) && !isOiOnlyFile(it.path)) await rmRel(ac, it.path);
      return;
    case 'sample':
    case 'test': {
      const s = samplesSet(doc);
      s.delete(it.extra?.index);
      saveSamples(doc, s);
      if (it.kind === 'test' && it.path) for (const rel of [it.path, ...Object.values(statementPaths(it.path))]) await rmRel(ac, rel);
      if (it.kind === 'sample') for (const rel of Object.values(scriptStatementPaths(it.extra?.index))) await rmRel(ac, rel);
      return;
    }
    case 'solution':
      if (it.path) await rmRel(ac, it.path);
      doc.solutions = (doc.solutions ?? []).filter((s: any) => s.source !== it.path);
      return;
    case 'statement':
      if (it.extra?.section === 'name') {
        const lang = LANG_FROM_POLYGON[it.extra.lang] ?? it.extra.lang;
        if (doc.problem?.title) delete doc.problem.title[lang];
      } else if (it.path) await rmRel(ac, it.path);
      return;
    case 'checkerTest':
      for (const ext of ['in', 'out', 'ans', 'verdict']) await rmRel(ac, `checker-tests/${it.extra?.name}.${ext}`);
      return;
    case 'testset': {
      const name = String(it.extra?.testset ?? '');
      const t = doc.testsets?.[name];
      if (!t) return;
      for (const rel of Object.values((it.extra?.paths ?? {}) as Record<string, string>)) for (const f of [rel, ...Object.values(statementPaths(rel))]) await rmRel(ac, f);
      for (const rel of (it.extra?.statementFiles ?? []) as string[]) await rmRel(ac, rel);
      if (t.script) await rmRel(ac, t.script);
      delete doc.testsets[name];
      return;
    }
    case 'source':
      if (it.path) {
        await rmRel(ac, it.path);
        // Unregister it too, so problem.toml does not point to a missing file.
        if (Array.isArray(doc.generators)) doc.generators = doc.generators.filter((g: any) => g?.source !== it.path);
        for (const role of ['validator', 'checker', 'interactor']) if (doc[role]?.source === it.path) delete doc[role];
      }
      return;
    case 'resource':
    case 'statementResource':
    case 'script':
    case 'validatorTest':
      if (it.path) await rmRel(ac, it.path);
      if (it.kind === 'script' && doc.tests?.script === it.path) delete doc.tests.script;
      return;
  }
}


/** Write (or remove, when absent) a sample's statement input / output files. */
async function writeStatementIo(ac: ApplyContext, sp: { input: string; output: string }, meta: unknown) {
  const m = (meta ?? {}) as { statementInput?: string; statementOutput?: string };
  for (const [text, file] of [
    [m.statementInput, sp.input],
    [m.statementOutput, sp.output],
  ] as const) {
    if (text !== undefined && text !== '') await writeRel(ac, file, text);
    else await rmRel(ac, file);
  }
}

/** Statement input / output text as compared and stored: LF, one trailing newline. */
function normStmt(v: string): string {
  const t = v.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  return t ? `${t}\n` : '';
}

/** A sample's statement input / output files as sync metadata. */
async function statementMeta(dir: string, sp: { input: string; output: string }): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, file] of [
    ['statementInput', sp.input],
    ['statementOutput', sp.output],
  ] as const) {
    const text = await fsp.readFile(path.join(dir, file), 'utf8').catch(() => null);
    if (text !== null && text.trim()) out[key] = normStmt(text);
  }
  return out;
}
