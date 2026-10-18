import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { DEFAULT_TESTSET, TESTSET_NAME_RE, compressRanges, groupLayout, parseIndexList, testsetOf, type TestInfo, type TestsManifest, type TestsetConfig } from '@polyforge/shared';
import { HttpError } from '../util/fs.js';
import type { JobCtx } from '../jobs.js';
import { atomicWrite, exists, safeJoin, sha1 } from '../util/fs.js';
import type { Program } from './compiler.js';
import { copyNormalized, describeRun, readHead, runHelper, runSolution, withTmp } from './execute.js';
import { CompileFailure, type Judge, type ProblemCtx } from './index.js';
import { parseScript, ScriptError, type ScriptCommand } from './script.js';

/** Internal manifest entry: TestInfo plus cache keys of each stage. */
interface Entry extends TestInfo {
  inputKey?: string;
  inputHash?: string;
  validKey?: string;
  answerKey?: string;
}

interface Manifest extends TestsManifest {
  tests: Entry[];
}

export interface Planned {
  index: number;
  origin: 'manual' | 'script';
  source: string;
  line?: number;
  manualPath?: string;
  cmd?: ScriptCommand;
  /** Position within a multi-test command's target list. */
  multiPos?: number;
}

/** Generated files of a testset: "tests" keeps its historic folder, others go to testsets/<name>. */
export const testsDir = (ctx: ProblemCtx, ts = DEFAULT_TESTSET) => {
  if (ts === DEFAULT_TESTSET) return path.join(ctx.work, 'tests');
  // The name becomes a folder: never let it point elsewhere.
  if (!TESTSET_NAME_RE.test(ts)) throw new HttpError(400, 'bad_testset', `Invalid testset name: ${ts}`);
  return path.join(ctx.work, 'testsets', ts);
};
export const inputPath = (ctx: ProblemCtx, i: number, ts?: string) => path.join(testsDir(ctx, ts), `${i}.in`);
export const answerPath = (ctx: ProblemCtx, i: number, ts?: string) => path.join(testsDir(ctx, ts), `${i}.ans`);
export const overviewPath = (ctx: ProblemCtx, i: number, ts?: string) => path.join(testsDir(ctx, ts), `${i}.overview.txt`);
const manifestPath = (ctx: ProblemCtx, ts?: string) => path.join(testsDir(ctx, ts), 'manifest.json');

/** The testset config, or 404 for an unknown name. */
export function requireTestset(ctx: ProblemCtx, name = DEFAULT_TESTSET): TestsetConfig {
  const ts = testsetOf(ctx.config, name);
  if (!ts) throw new HttpError(404, 'testset_not_found', `Unknown testset: ${name}`);
  return ts;
}

export async function readManifest(ctx: ProblemCtx, ts?: string): Promise<Manifest | null> {
  try {
    return JSON.parse(await fsp.readFile(manifestPath(ctx, ts), 'utf8')) as Manifest;
  } catch {
    return null;
  }
}

/** Strip cache keys before sending to the client. */
export function publicManifest(m: Manifest): TestsManifest {
  return {
    ...m,
    tests: m.tests.map(({ inputKey: _a, inputHash: _b, validKey: _c, answerKey: _d, ...t }) => t),
  };
}

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

async function hashFile(file: string): Promise<string> {
  return sha1(await fsp.readFile(file));
}

/** Test index assignment, shared with Polygon sync (manual test indices). */
export const planTests = (ctx: ProblemCtx, errors: string[], ts = DEFAULT_TESTSET) => plan(ctx, errors, requireTestset(ctx, ts));

/** Decide which test gets which index (DESIGN §4.2, Polygon semantics for `$`). */
async function plan(ctx: ProblemCtx, errors: string[], ts: TestsetConfig): Promise<Planned[]> {
  const slots = new Map<number, Planned>();
  const auto: Planned[] = [];
  const put = (p: Planned) => {
    const prev = slots.get(p.index);
    if (prev) errors.push(`Test ${p.index} is defined twice: ${prev.source} and ${p.source}`);
    else slots.set(p.index, p);
  };

  const manualRel = ts.manual.replace(/\/+$/, '');
  const manualDir = safeJoin(ctx.ref.dir, manualRel);
  const manual = (await fsp.readdir(manualDir, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isFile() && !e.name.startsWith('.') && !/\.(ans|out)$/i.test(e.name) && !/\.statement\.in$/i.test(e.name))
    .map((e) => e.name)
    .sort(natural);
  for (const name of manual) {
    const base = name.replace(/\.[^.]*$/, '');
    const p: Planned = { index: 0, origin: 'manual', source: `${manualRel}/${name}`, manualPath: path.join(manualDir, name) };
    if (/^\d+$/.test(base) && Number(base) > 0) put({ ...p, index: Number(base) });
    else auto.push(p);
  }

  let cmds: ScriptCommand[] = [];
  const script = ts.script;
  if (script) {
    try {
      const text = await fsp.readFile(safeJoin(ctx.ref.dir, script), 'utf8');
      cmds = parseScript(text);
    } catch (e) {
      if (e instanceof ScriptError) errors.push(e.message);
      else if ((e as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(`${script}: ${(e as Error).message}`);
    }
  }
  for (const cmd of cmds) {
    const base = { origin: 'script' as const, source: cmd.text, line: cmd.line, cmd };
    if (cmd.target.kind === 'index') put({ ...base, index: cmd.target.index });
    else if (cmd.target.kind === 'multi') cmd.target.indices.forEach((index, multiPos) => put({ ...base, index, multiPos }));
  }
  // `$` takes the smallest free index, in order of appearance.
  for (const cmd of cmds) if (cmd.target.kind === 'auto') auto.push({ index: 0, origin: 'script', source: cmd.text, line: cmd.line, cmd });
  let next = 1;
  for (const p of auto) {
    while (slots.has(next)) next++;
    slots.set(next, { ...p, index: next });
  }

  const planned = [...slots.values()].sort((a, b) => a.index - b.index);
  const missing = planned.length ? [...Array(planned[planned.length - 1].index).keys()].map((i) => i + 1).filter((i) => !slots.has(i)) : [];
  if (missing.length) errors.push(`Test indices must be contiguous; missing: ${missing.slice(0, 20).join(', ')}`);
  return planned;
}


/**
 * Generate all tests: inputs (manual files / generators), validation, and answers from
 * the main solution. Every stage is cached by the hashes it depends on, so re-running
 * after a small change only redoes what changed.
 */
export async function generateTests(judge: Judge, ctx: ProblemCtx, job: JobCtx, testset = DEFAULT_TESTSET): Promise<TestsManifest> {
  const errors: string[] = [];
  const ts = requireTestset(ctx, testset);
  const dir = testsDir(ctx, ts.name);
  await fsp.mkdir(dir, { recursive: true });
  const prev = new Map((await readManifest(ctx, ts.name))?.tests.map((t) => [t.index, t]) ?? []);
  const planned = await plan(ctx, errors, ts);
  const layout = groupLayout(ts, !!ctx.config.tests.points);
  const group = (i: number) => layout.mapping[i];
  // Statements use the samples of "tests" only (as on Polygon).
  const samples = new Set(ts.name === DEFAULT_TESTSET ? parseIndexList(ts.samples ?? '') : []);
  const inputPath = (c: ProblemCtx, i: number) => inputPathOf(c, i, ts.name);
  const answerPath = (c: ProblemCtx, i: number) => answerPathOf(c, i, ts.name);
  const overviewPath = (c: ProblemCtx, i: number) => overviewPathOf(c, i, ts.name);

  // ---- compile everything up front ----
  job.progress(0, planned.length * 3, 'compiling');
  const genSources = await judge.generators(ctx);
  const usedGens = new Set(planned.filter((p) => p.cmd).map((p) => p.cmd!.generator));
  const gens = new Map<string, Program>();
  const compileErr = (e: unknown) => {
    if (e instanceof CompileFailure) errors.push(e.message);
    else throw e;
  };
  const mainSrc = judge.mainSolution(ctx.config);
  if (!mainSrc) errors.push('No main solution: tag one solution as MA to generate answers');
  const [validator, main, interactor] = await Promise.all([
    ctx.config.validator ? judge.require(ctx, ctx.config.validator.source, 'Validator').catch(compileErr) : undefined,
    mainSrc ? judge.require(ctx, mainSrc, 'Main solution').catch(compileErr) : undefined,
    ctx.config.problem.interactive
      ? ctx.config.interactor
        ? judge.require(ctx, ctx.config.interactor.source, 'Interactor').catch(compileErr)
        : (errors.push('Interactive problem without an interactor'), undefined)
      : undefined,
    ...[...usedGens].map(async (name) => {
      const src = genSources.get(name);
      if (!src) return errors.push(`Unknown generator "${name}" (expected generators/${name}.cpp or a registered generator)`);
      const p = await judge.require(ctx, src, 'Generator').catch(compileErr);
      if (p) gens.set(name, p);
    }),
  ]);
  job.signal.throwIfAborted();

  const entries = new Map<number, Entry>();
  for (const p of planned) {
    const sp = samples.has(p.index) ? sampleStatementPaths(p) : undefined;
    const has = async (rel?: string) => (rel && (await exists(safeJoin(ctx.ref.dir, rel))) ? rel : undefined);
    entries.set(p.index, {
      statementInput: await has(sp?.input),
      statementOutput: await has(sp?.output),
      index: p.index,
      origin: p.origin,
      source: p.source,
      line: p.line,
      group: group(p.index),
      points: layout.points[p.index],
      sample: samples.has(p.index) || undefined,
      largeSample: samples.has(p.index) && parseIndexList(ctx.config.tests.large_samples ?? '').includes(p.index) || undefined,
    });
  }
  let done = 0;
  const total = planned.length * 3;
  const tick = (msg: string) => job.progress(++done, total, msg);

  // ---- inputs ----
  const byCmd = new Map<ScriptCommand, Planned[]>();
  for (const p of planned) if (p.cmd?.target.kind === 'multi') byCmd.set(p.cmd, [...(byCmd.get(p.cmd) ?? []), p]);

  const setInput = async (p: Planned, key: string, produce: () => Promise<string | null>) => {
    const e = entries.get(p.index)!;
    const old = prev.get(p.index);
    const file = inputPath(ctx, p.index);
    if (old?.inputKey === key && old.inputHash && (await exists(file))) {
      e.inputKey = key;
      e.inputHash = old.inputHash;
    } else {
      const err = await produce();
      if (err) {
        e.error = err;
        await fsp.rm(file, { force: true });
        return;
      }
      e.inputKey = key;
      e.inputHash = await hashFile(file);
    }
    e.inputSize = (await fsp.stat(file)).size;
  };

  const inputTasks: Promise<void>[] = [];
  for (const p of planned) {
    if (p.manualPath) {
      inputTasks.push(
        (async () => {
          const content = await fsp.readFile(p.manualPath!);
          await setInput(p, `manual:${sha1(content)}`, async () => {
            await copyNormalized(p.manualPath!, inputPath(ctx, p.index));
            return null;
          });
          tick(`input ${p.index}`);
        })(),
      );
    } else if (p.cmd && p.cmd.target.kind !== 'multi') {
      const cmd = p.cmd;
      inputTasks.push(
        (async () => {
          const gen = gens.get(cmd.generator);
          if (!gen) {
            entries.get(p.index)!.error = `generator "${cmd.generator}" unavailable`;
          } else {
            await setInput(p, sha1(JSON.stringify([gen.hash, cmd.args])), () =>
              withTmp(ctx.ref.dir, async (tmp) => {
                const out = path.join(tmp, 'out.txt');
                const r = await runHelper(judge.runner, gen, cmd.args, { cwd: tmp, stdout: out, stderr: path.join(tmp, 'err.txt') }, job.signal);
                if (r.status !== 'OK') return `generator failed: ${describeRun(r)} ${(await readHead(path.join(tmp, 'err.txt'), 1000)).trim()}`.trim();
                await copyNormalized(out, inputPath(ctx, p.index));
                return null;
              }),
            );
          }
          tick(`input ${p.index}`);
        })(),
      );
    }
  }
  for (const [cmd, ps] of byCmd) {
    inputTasks.push(
      (async () => {
        const gen = gens.get(cmd.generator);
        const key = gen ? sha1(JSON.stringify([gen.hash, cmd.args, 'multi'])) : '';
        const allCached =
          gen &&
          (await Promise.all(ps.map(async (p) => prev.get(p.index)?.inputKey === `${key}:${p.multiPos}` && (await exists(inputPath(ctx, p.index)))))).every(
            Boolean,
          );
        let failure: string | null = gen ? null : `generator "${cmd.generator}" unavailable`;
        if (gen && !allCached) {
          failure = await withTmp(ctx.ref.dir, async (tmp) => {
            const r = await runHelper(judge.runner, gen, cmd.args, { cwd: tmp, stdout: path.join(tmp, 'stdout.txt'), stderr: path.join(tmp, 'err.txt') }, job.signal);
            if (r.status !== 'OK') return `generator failed: ${describeRun(r)} ${(await readHead(path.join(tmp, 'err.txt'), 1000)).trim()}`.trim();
            // testlib's startTest(k) writes a file named k: accept the target indices or 1..n.
            for (const p of ps) {
              const candidates = [String(p.index), String(p.multiPos! + 1)];
              let found: string | null = null;
              for (const c of candidates) if (await exists(path.join(tmp, c))) (found ??= c);
              if (!found) return `generator did not create a file for test ${p.index} (expected "${candidates.join('" or "')}")`;
              await copyNormalized(path.join(tmp, found), inputPath(ctx, p.index));
            }
            return null;
          });
        }
        for (const p of ps) {
          await setInput(p, `${key}:${p.multiPos}`, async () => failure);
          tick(`input ${p.index}`);
        }
      })(),
    );
  }
  await Promise.all(inputTasks);
  job.signal.throwIfAborted();

  // ---- validation and answers ----
  const perTest = planned.map(async (p) => {
    const e = entries.get(p.index)!;
    const old = prev.get(p.index);
    if (e.error) {
      done += 2;
      return;
    }
    const inFile = inputPath(ctx, p.index);

    if (validator) {
      // Samples also get the validator's test markup (which lines belong to which test
      // case, from setTestCase), for the per-test-case highlighting of the statement.
      const markup = true;
      const key = sha1(JSON.stringify([e.inputHash, validator.hash, e.group ?? '', ts.name, markup]));
      const ov = overviewPath(ctx, p.index);
      if (old?.validKey === key && old.valid !== undefined) {
        Object.assign(e, { validKey: key, valid: old.valid, validatorMessage: old.validatorMessage, hasOverview: old.hasOverview, inputCases: old.inputCases });
      } else {
        await withTmp(ctx.ref.dir, async (tmp) => {
          const err = path.join(tmp, 'err.txt');
          const mu = path.join(tmp, 'markup.txt');
          const args = ['--testOverviewLogFileName', ov, '--testset', ts.name, ...(e.group ? ['--group', e.group] : []), ...(markup ? ['--testMarkupFileName', mu] : [])];
          await fsp.rm(ov, { force: true });
          const r = await runHelper(judge.runner, validator, args, { cwd: tmp, stdin: inFile, stderr: err }, job.signal);
          e.validKey = key;
          e.valid = r.status === 'OK';
          const msg = (await readHead(err, 2000)).trim();
          e.validatorMessage = e.valid ? undefined : msg || describeRun(r);
          e.hasOverview = await exists(ov);
          e.inputCases = markup && e.valid ? parseTestMarkup(await fsp.readFile(mu).catch(() => null)) : undefined;
        });
      }
    } else {
      e.valid = null;
    }
    tick(`validate ${p.index}`);

    if (main && e.valid !== false && !(ctx.config.problem.interactive && !interactor)) {
      const lim = ctx.limits;
      const key = sha1(JSON.stringify([e.inputHash, main.hash, interactor?.hash ?? '', lim]));
      const ans = answerPath(ctx, p.index);
      if (old?.answerKey === key && (await exists(ans))) {
        e.answerKey = key;
      } else {
        await fsp.rm(ans, { force: true });
        await withTmp(ctx.ref.dir, async (tmp) => {
          const r = await runSolution(judge.runner, main, inFile, lim, tmp, { interactor: interactor ?? undefined, signal: job.signal });
          if (r.verdict !== 'OK') {
            e.error = `main solution: ${r.verdict}${r.message ? ` — ${r.message}` : ''}`;
            return;
          }
          await copyNormalized(r.outputFile, ans);
          e.answerKey = key;
        });
      }
      if (await exists(ans)) e.answerSize = (await fsp.stat(ans)).size;
    }
    tick(`answer ${p.index}`);
  });
  await Promise.all(perTest);
  job.signal.throwIfAborted();

  // Remove files of tests that no longer exist.
  const keep = new Set(planned.map((p) => p.index));
  for (const f of await fsp.readdir(dir)) {
    const m = f.match(/^(\d+)\.(in|ans|overview\.txt)$/);
    if (m && !keep.has(Number(m[1]))) await fsp.rm(path.join(dir, f), { force: true });
  }

  const tests = [...entries.values()].sort((a, b) => a.index - b.index);
  for (const i of samples) if (!entries.has(i)) errors.push(`Sample test ${i} does not exist (tests.samples)`);
  for (const t of tests) {
    if (t.valid === false) errors.push(`Test ${t.index} is invalid: ${t.validatorMessage ?? ''}`.trim());
    if (t.error) errors.push(`Test ${t.index}: ${t.error}`);
  }
  const manifest: Manifest = {
    testset: ts.name,
    generatedAt: new Date().toISOString(),
    ok: errors.length === 0,
    tests,
    errors,
    hasOverview: tests.some((t) => t.hasOverview),
  };
  await atomicWrite(manifestPath(ctx, ts.name), JSON.stringify(manifest, null, 1));
  return publicManifest(manifest);
}

const inputPathOf = inputPath;
const answerPathOf = answerPath;
const overviewPathOf = overviewPath;

/**
 * Add a manual test (e.g. a new sample) with the next suitable index: after the
 * current samples, skipping indices that manual files or script lines claim
 * explicitly ("> 3"); tests from "> $" lines move up, as on Polygon.
 */
/** Statement input / output of a manual sample: tests/manual/NN.in → NN.statement.in / NN.statement.out. */
export function statementPaths(manualSource: string): { input: string; output: string } {
  const stem = manualSource.replace(/\.[^./]*$/, '');
  return { input: `${stem}.statement.in`, output: `${stem}.statement.out` };
}

/**
 * Statement input / output of a sample made by the script: keyed by the test index,
 * tests/_statement/NN.in / NN.out ("_" keeps the folder apart from testset folders).
 */
export function scriptStatementPaths(index: number): { input: string; output: string } {
  const nn = String(index).padStart(2, '0');
  return { input: `tests/_statement/${nn}.in`, output: `tests/_statement/${nn}.out` };
}

/** Where a sample's statement input / output live, for either kind of test. */
export function sampleStatementPaths(t: { origin: string; source: string; index: number }): { input: string; output: string } {
  return t.origin === 'manual' ? statementPaths(t.source) : scriptStatementPaths(t.index);
}

export async function addManualTest(
  ctx: ProblemCtx,
  input: string,
  opts: { sample?: boolean; testset?: string; statementInput?: string; statementOutput?: string },
): Promise<{ index: number; path: string; samples?: string }> {
  const ts = requireTestset(ctx, opts.testset);
  const planned = await plan(ctx, [], ts);
  const explicit = new Set<number>();
  for (const p of planned) {
    const manualNumbered = p.origin === 'manual' && /^\d+$/.test(path.basename(p.source).replace(/\.[^.]*$/, ''));
    const scriptExplicit = p.origin === 'script' && p.cmd && p.cmd.target.kind !== 'auto';
    if (manualNumbered || scriptExplicit) explicit.add(p.index);
  }
  // Only samples that exist count: a stale entry in tests.samples must not leave a gap.
  const existing = new Set(planned.map((p) => p.index));
  const samples = ts.name === DEFAULT_TESTSET ? parseIndexList(ts.samples ?? '').filter((i) => existing.has(i)) : [];
  let index = samples.length ? Math.max(...samples) + 1 : 1;
  const manualDir = ts.manual.replace(/\/+$/, '');
  const fileOf = (i: number) => `${manualDir}/${String(i).padStart(2, '0')}.in`;
  while (explicit.has(index) || (await exists(safeJoin(ctx.ref.dir, fileOf(index))))) index++;
  const rel = fileOf(index);
  const text = input.replace(/\r\n/g, '\n');
  await fsp.mkdir(path.dirname(safeJoin(ctx.ref.dir, rel)), { recursive: true });
  await atomicWrite(safeJoin(ctx.ref.dir, rel), text.endsWith('\n') || !text ? text : `${text}\n`);
  if (opts.sample && ts.name === DEFAULT_TESTSET) {
    const sp = statementPaths(rel);
    for (const [text, file] of [
      [opts.statementInput, sp.input],
      [opts.statementOutput, sp.output],
    ] as const) {
      if (!text?.trim()) continue;
      const t = text.replace(/\r\n/g, '\n');
      await atomicWrite(safeJoin(ctx.ref.dir, file), t.endsWith('\n') ? t : `${t}\n`);
    }
  }
  if (opts.sample && ts.name === DEFAULT_TESTSET) {
    const next = [...new Set([...samples, index])].sort((a, b) => a - b);
    return { index, path: rel, samples: compressRanges(next) };
  }
  return { index, path: rel };
}

/**
 * testlib's test markup (validator --testMarkupFileName): the input with "!c<n>;"
 * where test case n starts; \ and ! are escaped with a backslash. Returns the test case
 * of every input line (0 = before the first case, e.g. the line with t), or undefined
 * when the validator does not mark test cases.
 */
export function parseTestMarkup(buf: Buffer | null): number[] | undefined {
  if (!buf) return undefined;
  const s = buf.toString('latin1');
  const HEADER = 'MU\xF3\x01';
  if (!s.startsWith(HEADER)) return undefined;
  const lines: number[] = [];
  let cur = 0;
  let lineCase: number | null = null;
  let seen = false;
  for (let i = HEADER.length; i < s.length; i++) {
    let c = s[i];
    if (c === '!' && s[i + 1] === 'c') {
      const end = s.indexOf(';', i);
      if (end > i) {
        // setTestCase(i) starts case i; count the markers instead of trusting the
        // number: testlib 0.9.44 built with GCC 15 prints 0 for every case (vtos bug,
        // fixed in 0.9.45).
        cur++;
        seen = true;
        i = end;
        continue;
      }
    }
    if (c === '\\' && i + 1 < s.length) c = s[++i];
    if (c === '\n') {
      lines.push(lineCase ?? cur);
      lineCase = null;
    } else if (lineCase === null && c !== '\r') lineCase = cur;
  }
  if (lineCase !== null) lines.push(lineCase);
  return seen ? lines : undefined;
}

/**
 * Remove one test. A manual test's files (input and statement input / output) are
 * deleted. A script test loses its line in the script;
 * a line that makes several tests ({a-b}) removes all of them. Lines produced by a
 * FreeMarker loop cannot be removed one by one. The index leaves tests.samples.
 */
export async function removeTest(
  ctx: ProblemCtx,
  index: number,
  opts: { testset?: string; source?: string },
): Promise<{ kind: 'manual' | 'script'; removed: number[]; samples?: string }> {
  const ts = requireTestset(ctx, opts.testset);
  const planned = await plan(ctx, [], ts);
  const p = planned.find((x) => x.index === index);
  if (!p) throw new HttpError(404, 'test_not_found', `Test ${index} does not exist`);
  // The caller saw the test in a manifest that may be out of date: never remove another one.
  if (opts.source !== undefined && opts.source !== p.source) {
    throw new HttpError(409, 'test_changed', `Test ${index} is now ${p.source}, not ${opts.source}; regenerate the tests and try again`);
  }
  let result: { kind: 'manual' | 'script'; removed: number[] };
  if (p.origin === 'manual' && p.manualPath) {
    const sp = statementPaths(p.source);
    for (const rel of [p.source, sp.input, sp.output]) await fsp.rm(safeJoin(ctx.ref.dir, rel), { force: true });
    result = { kind: 'manual', removed: [index] };
  } else {
    if (!ts.script || !p.cmd) throw new HttpError(400, 'not_removable', `Test ${index} has no source to remove`);
    const file = safeJoin(ctx.ref.dir, ts.script);
    const text = (await fsp.readFile(file, 'utf8')).replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    const templated = /<#|\$\{/.test(text);
    let at = -1;
    if (!templated && lines[p.cmd.line - 1]?.trim() === p.cmd.text) at = p.cmd.line - 1;
    else {
      const same = lines.map((l, i) => (l.trim() === p.cmd!.text ? i : -1)).filter((i) => i >= 0);
      if (same.length === 1) at = same[0];
    }
    if (at < 0) throw new HttpError(400, 'templated_script', `Test ${index} comes from a template loop in ${ts.script}; edit the script instead`);
    lines.splice(at, 1);
    await atomicWrite(file, lines.join('\n'));
    const removed = planned.filter((x) => x.cmd === p.cmd).map((x) => x.index);
    // Their statement input / output (keyed by index) go with them.
    if (ts.name === DEFAULT_TESTSET) {
      for (const i of removed) for (const rel of Object.values(scriptStatementPaths(i))) await fsp.rm(safeJoin(ctx.ref.dir, rel), { force: true });
    }
    result = { kind: 'script', removed };
  }
  if (ts.name === DEFAULT_TESTSET) {
    const samples = parseIndexList(ts.samples ?? '');
    if (samples.some((i) => result.removed.includes(i))) return { ...result, samples: compressRanges(samples.filter((i) => !result.removed.includes(i))) };
  }
  return result;
}
