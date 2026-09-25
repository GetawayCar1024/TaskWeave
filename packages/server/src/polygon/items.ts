import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  LANG_FROM_POLYGON,
  LANG_TO_POLYGON,
  STATEMENT_SECTIONS,
  STD_PREFIX,
  TAG_FROM_POLYGON,
  TAG_TO_POLYGON,
  groupLayout as sharedGroupLayout,
  parseIndexList,
  testsetOf,
  testsetsOf,
  type TestsetConfig,
  type ProblemToml,
  type SolutionTag,
  type SyncItem,
  type SyncItemKind,
} from '@polyforge/shared';
import { pickLanguage } from '../judge/compiler.js';
import type { Judge, ProblemCtx } from '../judge/index.js';
import { planTests } from '../judge/tests.js';
import { exists, isDir, sha1 } from '../util/fs.js';
import type { PolygonClient } from './client.js';

export const TESTSET = 'tests';

/** Resource files every Polygon problem has; never synced. */
const DEFAULT_RESOURCES = new Set(['olymp.sty', 'problem.tex', 'statements.ftl', 'testlib.h', 'tutorial.tex']);

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
  return sha1(Buffer.concat([Buffer.from(JSON.stringify(sortKeys(it.meta ?? {})) + '\0'), body]));
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
  'info',
  'resource',
  'source',
  'config',
  'solution',
  'statementResource',
  'statement',
  'script',
  'test',
  'sample',
  'groups',
  'validatorTest',
  'checkerTest',
  'testset',
];

// ---------------------------------------------------------------------------
// Shared helpers

export function compressRanges(nums: number[]): string {
  const s = [...new Set(nums)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(i === j ? `${s[i]}` : `${s[i]}-${s[j]}`);
    i = j + 1;
  }
  return out.join(',');
}

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

/** Everything of a testset other than "tests", synced as one item. */
export interface TestsetContent {
  script: string;
  /** Manual tests by index. */
  tests: Record<string, string>;
  groupsEnabled: boolean;
  groups: { name: string; pointsPolicy: string; dependencies: string[]; points?: number; tests: string }[];
  /** Per-test points (points enabled). */
  points?: Record<string, number>;
}

function testsetGroups(ts: TestsetConfig, pointsEnabled: boolean): Pick<TestsetContent, 'groupsEnabled' | 'groups' | 'points'> {
  const layout = sharedGroupLayout(ts, pointsEnabled);
  return {
    groupsEnabled: ts.groups,
    groups: ts.groups
      ? ts.group.map((g) => ({
          name: g.name,
          pointsPolicy: g.policy ?? 'COMPLETE_GROUP',
          dependencies: [...(g.dependencies ?? [])].sort(),
          ...(pointsEnabled ? { points: g.points ?? 0 } : {}),
          tests: compressRanges(parseIndexList(g.tests ?? '')),
        }))
      : [],
    ...(Object.keys(layout.points).length ? { points: layout.points } : {}),
  };
}

/** Stable, readable text for hashing and the diff view. */
export function testsetText(c: TestsetContent): string {
  return JSON.stringify(sortKeys(c), null, 2);
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
  const warnings: string[] = [];
  const items: Item[] = [];
  const languages = (await judge.global.readLanguages()).languages;
  const readText = async (rel: string) => (await fsp.readFile(path.join(dir, rel), 'utf8')).replace(/\r\n/g, '\n');
  const sourceType = (rel: string) => {
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
            ...(config.tests.points ? { points: g.points ?? 0 } : {}),
          }))
        : [],
    },
    extra: { groupsEnabled: !!config.tests.groups, pointsEnabled: !!config.tests.points },
  });
  if (Object.keys(mapping).length) {
    items.push({ key: 'groups', kind: 'groups', label: 'test groups', path: 'problem.toml', meta: { mapping }, extra: { points } });
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
  for (const lang of (await fsp.readdir(stmtDir).catch(() => [] as string[])).sort()) {
    if (lang === 'images' || !(await isDir(path.join(stmtDir, lang)))) continue;
    const plang = LANG_TO_POLYGON[lang] ?? lang;
    const title = config.problem.title[lang];
    if (title) items.push({ key: `statement:${plang}:name`, kind: 'statement', label: `statement (${plang}): name`, path: 'problem.toml', text: title, extra: { lang: plang, section: 'name' } });
    for (const sec of STATEMENT_SECTIONS) {
      const rel = `statement/${lang}/${sec}.tex`;
      if (!(await exists(path.join(dir, rel)))) continue;
      const text = await readText(rel);
      if (!text.trim()) continue;
      const label = sec === 'tutorial' ? `tutorial (${plang})` : `statement (${plang}): ${sec}`;
      items.push({ key: `statement:${plang}:${sec}`, kind: 'statement', label, path: rel, text, extra: { lang: plang, section: sec } });
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
    items.push({ key: 'script', kind: 'script', label: 'test script', path: config.tests.script, text: await readText(config.tests.script) });
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
        meta: { sample: samples.has(p.index) },
        extra: { index: p.index },
      });
    } else if (samples.has(p.index)) {
      items.push({ key: `sample:${p.index}`, kind: 'sample', label: `test ${p.index} is a sample`, path: 'problem.toml', meta: { sample: true }, extra: { index: p.index } });
    }
  }

  // ---- further testsets: one item each (script, manual tests, groups) ----
  for (const ts of testsetsOf(config).filter((t) => t.name !== TESTSET)) {
    const errs: string[] = [];
    const tests: Record<string, string> = {};
    for (const p of await planTests(ctx, errs, ts.name)) {
      if (p.origin === 'manual' && p.manualPath) tests[p.index] = await readText(path.relative(dir, p.manualPath).split(path.sep).join('/'));
    }
    warnings.push(...errs.map((e) => `${ts.name}: ${e}`));
    const content: TestsetContent = {
      script: ts.script ? await readText(ts.script).catch(() => '') : '',
      tests,
      ...testsetGroups(ts, !!config.tests.points),
    };
    items.push({ key: `testset:${ts.name}`, kind: 'testset', label: `testset ${ts.name}`, path: 'problem.toml', text: testsetText(content), extra: { testset: ts.name, content } });
  }

  // ---- validator / checker self-tests ----
  const vt = (await listFiles(path.join(dir, 'validator-tests'))).filter((f) => hasToken(f, 'valid') || hasToken(f, 'invalid'));
  for (const [i, f] of vt.entries()) {
    const verdict = hasToken(f, 'invalid') ? 'INVALID' : 'VALID';
    items.push({ key: `validatorTest:${i + 1}`, kind: 'validatorTest', label: `validator test ${i + 1} (${f})`, path: `validator-tests/${f}`, text: await readText(`validator-tests/${f}`), meta: { verdict }, extra: { index: i + 1 } });
  }
  const ctNames = (await listFiles(path.join(dir, 'checker-tests'))).filter((f) => f.endsWith('.in')).map((f) => f.slice(0, -3));
  for (const [i, name] of ctNames.entries()) {
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

/** Polygon has no call that lists testsets: the extra ones known locally are fetched by name. */
export async function remoteItems(client: PolygonClient, problemId: number, extraTestsets: string[] = []): Promise<Item[]> {
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
  for (const t of tests) if (t.group) pointsByGroup.set(t.group, (pointsByGroup.get(t.group) ?? 0) + Number(t.points ?? 0));
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
  if (Object.keys(mapping).length) items.push({ key: 'groups', kind: 'groups', label: 'test groups', path: 'problem.toml', meta: { mapping } });

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
      const input = typeof t.input === 'string' ? t.input : t.inputBase64 ? Buffer.from(t.inputBase64, 'base64').toString('utf8') : await client.text('problem.testInput', { ...pid, testset: TESTSET, testIndex: t.index });
      items.push({ key: `test:${t.index}`, kind: 'test', label: `manual test ${t.index}`, text: input.replace(/\r\n/g, '\n'), meta: { sample: !!t.useInStatements }, extra: { index: t.index } });
    } else if (t.useInStatements) {
      items.push({ key: `sample:${t.index}`, kind: 'sample', label: `test ${t.index} is a sample`, path: 'problem.toml', meta: { sample: true }, extra: { index: t.index } });
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
  for (const name of extraTestsets) {
    const [script, tests, groupDefs] = await Promise.all([
      opt(client.text('problem.script', { ...pid, testset: name }), ''),
      opt(client.call<any[]>('problem.tests', { ...pid, testset: name, noInputs: false }), []),
      opt(client.call<any[]>('problem.viewTestGroup', { ...pid, testset: name }), []),
    ]);
    if (!script.trim() && !tests.length && !groupDefs.length) continue;
    const manual: Record<string, string> = {};
    for (const t of tests) {
      if (!t.manual) continue;
      const input = typeof t.input === 'string' ? t.input : await client.text('problem.testInput', { ...pid, testset: name, testIndex: t.index });
      manual[t.index] = input.replace(/\r\n/g, '\n');
    }
    const byGroup = new Map<string, number[]>();
    for (const t of tests) if (t.group) byGroup.set(String(t.group), [...(byGroup.get(String(t.group)) ?? []), t.index]);
    const anyPoints = tests.some((t) => Number(t.points ?? 0) > 0);
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
          ...(anyPoints ? { points: idx.reduce((a, i) => a + Number(tests.find((t) => t.index === i)?.points ?? 0), 0) } : {}),
          tests: compressRanges(idx),
        };
      }),
      ...(anyPoints ? { points: Object.fromEntries(tests.filter((t) => t.group).map((t) => [t.index, Number(t.points ?? 0)])) } : {}),
    };
    items.push({ key: 'testset:' + name, kind: 'testset', label: 'testset ' + name, text: testsetText(content), extra: { testset: name, content } });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Push: send one local item to Polygon

export interface PushContext {
  client: PolygonClient;
  problemId: number;
  warn: (msg: string) => void;
}

const fileBuf = (it: Item) => it.bytes ?? Buffer.from(it.text ?? '', 'utf8');

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
      for (const [i, pts] of Object.entries((e.points ?? {}) as Record<string, number>)) {
        await client.call('problem.saveTest', { ...pid, testset: TESTSET, testIndex: Number(i), testPoints: pts }).catch((err: Error) => pc.warn(`points of test ${i}: ${err.message}`));
      }
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
      await client.call('problem.saveScript', { ...pid, testset: TESTSET, source: it.text ?? '' });
      return;
    case 'test':
      await client.call('problem.saveTest', { ...pid, testset: TESTSET, testIndex: e.index, testInput: it.text ?? '', testUseInStatements: !!(it.meta as any)?.sample });
      return;
    case 'sample':
      await client.call('problem.saveTest', { ...pid, testset: TESTSET, testIndex: e.index, testUseInStatements: !deleted });
      return;
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
      await client.call('problem.saveScript', { ...pid, testset, source: c.script }).catch((err: Error) => {
        throw new Error(`${err.message} — create the testset "${testset}" on Polygon first (Tests page → testsets), then push again`);
      });
      for (const [i, text] of Object.entries(c.tests)) await client.call('problem.saveTest', { ...pid, testset, testIndex: Number(i), testInput: text });
      await client.call('problem.enableGroups', { ...pid, testset, enable: c.groupsEnabled });
      for (const g of c.groups) {
        await client.call('problem.saveTestGroup', { ...pid, testset, group: g.name, pointsPolicy: g.pointsPolicy, dependencies: g.dependencies.join(',') || undefined });
        const idx = parseIndexList(g.tests);
        if (idx.length) await client.call('problem.setTestGroup', { ...pid, testset, testGroup: g.name, testIndices: idx.join(',') });
      }
      for (const [i, pts] of Object.entries(c.points ?? {})) {
        await client.call('problem.saveTest', { ...pid, testset, testIndex: Number(i), testPoints: pts }).catch((err: Error) => pc.warn(`${testset}: points of test ${i}: ${err.message}`));
      }
      return;
    }
  }
}

/** Kinds whose local deletion can be expressed on Polygon (by clearing the value). */
export const DELETABLE_KINDS = new Set<SyncItemKind>(['statement', 'sample']);

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
  written: Set<string>;
}

async function writeRel(ac: ApplyContext, rel: string, data: string | Buffer) {
  const abs = path.join(ac.dir, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, typeof data === 'string' && data && !data.endsWith('\n') ? `${data}\n` : data);
  ac.written.add(rel);
}

const pad = (n: number) => String(n).padStart(2, '0');

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
      Object.assign(doc.problem, { input: m.inputFile || 'stdin', output: m.outputFile || 'stdout', interactive: !!m.interactive, time_limit: m.timeLimit, memory_limit: m.memoryLimit });
      return;
    }
    case 'config': {
      const m = it.meta as any;
      const toLocal = (name: string | null, keep?: string) => {
        if (!name) return null;
        if (name.startsWith('std::')) return `${STD_PREFIX}${name.slice(5).replace(/\.cpp$/, '')}`;
        if (keep && path.posix.basename(keep) === name) return keep;
        return sourcePlacement(name, m);
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
      const rel = ac.local?.path ?? sourcePlacement(e.name, ac.remoteConfig);
      await writeRel(ac, rel, it.text ?? '');
      if (rel.startsWith('generators/')) {
        const gens: any[] = Array.isArray(doc.generators) ? doc.generators : [];
        if (!gens.some((g) => g.source === rel)) gens.push({ source: rel });
        doc.generators = gens;
      }
      return;
    }
    case 'resource':
      await writeRel(ac, ac.local?.path ?? `files/${e.name}`, it.bytes ?? Buffer.alloc(0));
      return;
    case 'solution': {
      const rel = ac.local?.path ?? `solutions/${e.name}`;
      await writeRel(ac, rel, it.text ?? '');
      const tag: SolutionTag = TAG_FROM_POLYGON[String((it.meta as any)?.tag)] ?? 'RJ';
      const sols: any[] = Array.isArray(doc.solutions) ? doc.solutions : [];
      const s = sols.find((x) => x.source === rel);
      if (s) s.tag = tag;
      else sols.push({ source: rel, tag });
      doc.solutions = sols;
      return;
    }
    case 'statement': {
      const lang = LANG_FROM_POLYGON[e.lang] ?? e.lang;
      if (e.section === 'name') {
        doc.problem.title = { ...(doc.problem.title ?? {}), [lang]: it.text ?? '' };
        return;
      }
      await writeRel(ac, `statement/${lang}/${e.section}.tex`, it.text ?? '');
      return;
    }
    case 'statementResource':
      await writeRel(ac, `statement/images/${e.name}`, it.bytes ?? Buffer.alloc(0));
      return;
    case 'script': {
      const rel = doc.tests.script || 'tests/script.txt';
      doc.tests.script = rel;
      await writeRel(ac, rel, it.text ?? '');
      return;
    }
    case 'test': {
      await writeRel(ac, ac.local?.path ?? `tests/manual/${pad(e.index)}.in`, it.text ?? '');
      const s = samplesSet(doc);
      if ((it.meta as any)?.sample) s.add(e.index);
      else s.delete(e.index);
      saveSamples(doc, s);
      return;
    }
    case 'sample': {
      const s = samplesSet(doc);
      s.add(e.index);
      saveSamples(doc, s);
      return;
    }
    case 'validatorTest': {
      const verdict = String((it.meta as any)?.verdict ?? 'VALID').toLowerCase();
      const want = `validator-tests/${pad(e.index)}.${verdict}.in`;
      const old = ac.local?.path;
      const keep = old && hasToken(old, verdict) && (verdict === 'invalid' || !hasToken(old, 'invalid'));
      if (old && !keep) await fsp.rm(path.join(ac.dir, old), { force: true });
      await writeRel(ac, keep ? old! : want, it.text ?? '');
      return;
    }
    case 'checkerTest': {
      const parts = splitCheckerTestText(it.text ?? '');
      const word = CHECKER_VERDICT_FROM_POLY[String((it.meta as any)?.verdict)] ?? 'ok';
      const oldName: string | undefined = ac.local?.extra?.name;
      if (oldName) for (const ext of ['in', 'out', 'ans', 'verdict']) await fsp.rm(path.join(ac.dir, 'checker-tests', `${oldName}.${ext}`), { force: true });
      const base = `checker-tests/${pad(e.index)}.${word}`;
      await writeRel(ac, `${base}.in`, parts.input);
      await writeRel(ac, `${base}.out`, parts.output);
      await writeRel(ac, `${base}.ans`, parts.answer);
      return;
    }
    case 'testset': {
      const name: string = e.testset;
      const c = e.content as TestsetContent;
      doc.testsets ??= {};
      const t: Record<string, any> = (doc.testsets[name] ??= {});
      // Manual tests live in tests/<name>/ by default, so the script goes next to it.
      const manual: string = t.manual ?? `tests/${name}`;
      if (c.script.trim()) {
        t.script ??= `tests/script-${name}.txt`;
        await writeRel(ac, t.script, c.script);
      }
      for (const [i, text] of Object.entries(c.tests)) await writeRel(ac, `${manual}/${pad(Number(i))}.in`, text);
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

/** Remove the local counterpart of an item that no longer exists on Polygon. */
export async function removeLocal(ac: ApplyContext, it: Item): Promise<void> {
  const { doc } = ac;
  switch (it.kind) {
    case 'sample':
    case 'test': {
      const s = samplesSet(doc);
      s.delete(it.extra?.index);
      saveSamples(doc, s);
      if (it.kind === 'test' && it.path) await fsp.rm(path.join(ac.dir, it.path), { force: true });
      return;
    }
    case 'solution':
      if (it.path) await fsp.rm(path.join(ac.dir, it.path), { force: true });
      doc.solutions = (doc.solutions ?? []).filter((s: any) => s.source !== it.path);
      return;
    case 'statement':
      if (it.extra?.section === 'name') {
        const lang = LANG_FROM_POLYGON[it.extra.lang] ?? it.extra.lang;
        if (doc.problem?.title) delete doc.problem.title[lang];
      } else if (it.path) await fsp.rm(path.join(ac.dir, it.path), { force: true });
      return;
    case 'checkerTest':
      for (const ext of ['in', 'out', 'ans', 'verdict']) await fsp.rm(path.join(ac.dir, 'checker-tests', `${it.extra?.name}.${ext}`), { force: true });
      return;
    case 'source':
    case 'resource':
    case 'statementResource':
    case 'script':
    case 'validatorTest':
      if (it.path) await fsp.rm(path.join(ac.dir, it.path), { force: true });
      return;
  }
}

