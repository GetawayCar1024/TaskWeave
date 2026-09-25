import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { parseIndexList, type TestInfo, type TestsManifest } from '@polyforge/shared';
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

export const testsDir = (ctx: ProblemCtx) => path.join(ctx.work, 'tests');
export const inputPath = (ctx: ProblemCtx, i: number) => path.join(testsDir(ctx), `${i}.in`);
export const answerPath = (ctx: ProblemCtx, i: number) => path.join(testsDir(ctx), `${i}.ans`);
export const overviewPath = (ctx: ProblemCtx, i: number) => path.join(testsDir(ctx), `${i}.overview.txt`);
const manifestPath = (ctx: ProblemCtx) => path.join(testsDir(ctx), 'manifest.json');

export async function readManifest(ctx: ProblemCtx): Promise<Manifest | null> {
  try {
    return JSON.parse(await fsp.readFile(manifestPath(ctx), 'utf8')) as Manifest;
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
export const planTests = (ctx: ProblemCtx, errors: string[]) => plan(ctx, errors);

/** Decide which test gets which index (DESIGN §4.2, Polygon semantics for `$`). */
async function plan(ctx: ProblemCtx, errors: string[]): Promise<Planned[]> {
  const slots = new Map<number, Planned>();
  const auto: Planned[] = [];
  const put = (p: Planned) => {
    const prev = slots.get(p.index);
    if (prev) errors.push(`Test ${p.index} is defined twice: ${prev.source} and ${p.source}`);
    else slots.set(p.index, p);
  };

  const manualDir = path.join(ctx.ref.dir, 'tests', 'manual');
  const manual = (await fsp.readdir(manualDir, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isFile() && !e.name.startsWith('.') && !/\.(ans|out)$/i.test(e.name))
    .map((e) => e.name)
    .sort(natural);
  for (const name of manual) {
    const base = name.replace(/\.[^.]*$/, '');
    const p: Planned = { index: 0, origin: 'manual', source: `tests/manual/${name}`, manualPath: path.join(manualDir, name) };
    if (/^\d+$/.test(base) && Number(base) > 0) put({ ...p, index: Number(base) });
    else auto.push(p);
  }

  let cmds: ScriptCommand[] = [];
  const script = ctx.config.tests.script;
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

function groupOf(ctx: ProblemCtx): (i: number) => string | undefined {
  const map = new Map<number, string>();
  for (const g of ctx.config.tests.group ?? []) for (const i of parseIndexList(g.tests ?? '')) map.set(i, g.name);
  return (i) => map.get(i);
}

/**
 * Generate all tests: inputs (manual files / generators), validation, and answers from
 * the main solution. Every stage is cached by the hashes it depends on, so re-running
 * after a small change only redoes what changed.
 */
export async function generateTests(judge: Judge, ctx: ProblemCtx, job: JobCtx): Promise<TestsManifest> {
  const errors: string[] = [];
  const dir = testsDir(ctx);
  await fsp.mkdir(dir, { recursive: true });
  const prev = new Map((await readManifest(ctx))?.tests.map((t) => [t.index, t]) ?? []);
  const planned = await plan(ctx, errors);
  const group = groupOf(ctx);
  const samples = new Set(parseIndexList(ctx.config.tests.samples ?? ''));

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
    entries.set(p.index, {
      index: p.index,
      origin: p.origin,
      source: p.source,
      line: p.line,
      group: group(p.index),
      sample: samples.has(p.index) || undefined,
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
      const key = sha1(JSON.stringify([e.inputHash, validator.hash, e.group ?? '']));
      const ov = overviewPath(ctx, p.index);
      if (old?.validKey === key && old.valid !== undefined) {
        Object.assign(e, { validKey: key, valid: old.valid, validatorMessage: old.validatorMessage, hasOverview: old.hasOverview });
      } else {
        await withTmp(ctx.ref.dir, async (tmp) => {
          const err = path.join(tmp, 'err.txt');
          const args = ['--testOverviewLogFileName', ov, '--testset', 'tests', ...(e.group ? ['--group', e.group] : [])];
          await fsp.rm(ov, { force: true });
          const r = await runHelper(judge.runner, validator, args, { cwd: tmp, stdin: inFile, stderr: err }, job.signal);
          e.validKey = key;
          e.valid = r.status === 'OK';
          const msg = (await readHead(err, 2000)).trim();
          e.validatorMessage = e.valid ? undefined : msg || describeRun(r);
          e.hasOverview = await exists(ov);
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
  for (const t of tests) {
    if (t.valid === false) errors.push(`Test ${t.index} is invalid: ${t.validatorMessage ?? ''}`.trim());
    if (t.error) errors.push(`Test ${t.index}: ${t.error}`);
  }
  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    ok: errors.length === 0,
    tests,
    errors,
    hasOverview: tests.some((t) => t.hasOverview),
  };
  await atomicWrite(manifestPath(ctx), JSON.stringify(manifest, null, 1));
  return publicManifest(manifest);
}
