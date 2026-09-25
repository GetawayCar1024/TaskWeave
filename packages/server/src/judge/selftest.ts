import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { CheckerTestResult, SelfTestReport, ValidatorTestResult, Verdict } from '@polyforge/shared';
import type { JobCtx } from '../jobs.js';
import { exists } from '../util/fs.js';
import { describeRun, readHead, runChecker, runHelper, withTmp } from './execute.js';
import { CompileFailure, type Judge, type ProblemCtx } from './index.js';

async function listFiles(dir: string, base = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith('.')) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(path.join(dir, e.name), rel)));
    else out.push(rel);
  }
  return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

const hasToken = (s: string, t: string) => new RegExp(`(^|[/._-])${t}([/._-]|$)`, 'i').test(s);

/**
 * validator-tests/: the expected result comes from the path — `invalid` or `valid` as
 * a folder or a dot/dash-separated part of the name, e.g. `03.invalid.in`, `valid/big.txt`.
 */
export async function runValidatorTests(judge: Judge, ctx: ProblemCtx, job: JobCtx): Promise<SelfTestReport<ValidatorTestResult>> {
  const src = ctx.config.validator?.source;
  if (!src) return { results: [], error: 'No validator configured' };
  const out = await judge.compile(ctx, src);
  if (!out.program) return { compile: out.result, results: [], error: 'Validator failed to compile' };
  const validator = out.program;
  const dir = path.join(ctx.ref.dir, 'validator-tests');
  const files = await listFiles(dir);
  let done = 0;
  const results = await Promise.all(
    files.map(async (f): Promise<ValidatorTestResult | null> => {
      const expected = hasToken(f, 'invalid') ? 'INVALID' : hasToken(f, 'valid') ? 'VALID' : null;
      if (!expected) return null;
      const r = await withTmp(ctx.ref.dir, async (tmp) => {
        const err = path.join(tmp, 'err.txt');
        const run = await runHelper(judge.runner, validator, [], { cwd: tmp, stdin: path.join(dir, f), stderr: err }, job.signal);
        return { run, msg: (await readHead(err, 2000)).trim() };
      });
      job.progress(++done, files.length);
      const actual = r.run.status === 'OK' ? 'VALID' : r.run.status === 'RE' ? 'INVALID' : 'ERROR';
      return {
        file: `validator-tests/${f}`,
        expected,
        actual,
        ok: actual === expected,
        message: actual === 'ERROR' ? describeRun(r.run) : r.msg,
      };
    }),
  );
  const list = results.filter((r): r is ValidatorTestResult => !!r);
  const skipped = files.length - list.length;
  return {
    compile: out.result,
    results: list,
    error: skipped ? `${skipped} file(s) skipped: name them with "valid"/"invalid", e.g. 01.valid.in` : undefined,
  };
}

const VERDICT_WORDS: Record<string, Verdict> = { ok: 'OK', wa: 'WA', pe: 'PE', fail: 'FAIL', fl: 'FAIL' };

/**
 * checker-tests/: a test is NAME.in + NAME.out (+ NAME.ans, defaults to empty). The
 * expected verdict is in NAME.verdict, or an ok/wa/pe/fail part of NAME (e.g. `02.wa`).
 */
export async function runCheckerTests(judge: Judge, ctx: ProblemCtx, job: JobCtx): Promise<SelfTestReport<CheckerTestResult>> {
  const src = ctx.config.checker?.source;
  if (!src) return { results: [], error: 'No checker configured' };
  let checker;
  try {
    checker = await judge.require(ctx, src, 'Checker');
  } catch (e) {
    if (e instanceof CompileFailure) return { compile: e.result, results: [], error: 'Checker failed to compile' };
    throw e;
  }
  const dir = path.join(ctx.ref.dir, 'checker-tests');
  const names = (await listFiles(dir)).filter((f) => f.endsWith('.in')).map((f) => f.slice(0, -3));
  let done = 0;
  const results = await Promise.all(
    names.map(async (name): Promise<CheckerTestResult> => {
      const file = (ext: string) => path.join(dir, `${name}.${ext}`);
      let expected: Verdict | undefined;
      if (await exists(file('verdict'))) expected = VERDICT_WORDS[(await readHead(file('verdict'), 100)).trim().split(/\s+/)[0].toLowerCase()];
      expected ??= Object.entries(VERDICT_WORDS).find(([w]) => hasToken(name, w))?.[1];
      if (!(await exists(file('out')))) {
        job.progress(++done, names.length);
        return { name, expected: expected ?? 'OK', actual: 'IE', ok: false, message: `missing ${name}.out` };
      }
      const outcome = await withTmp(ctx.ref.dir, async (tmp) => {
        let ans = file('ans');
        if (!(await exists(ans))) {
          ans = path.join(tmp, 'empty.ans');
          await fsp.writeFile(ans, '');
        }
        return runChecker(judge.runner, checker, { input: file('in'), output: file('out'), answer: ans }, tmp, job.signal);
      });
      job.progress(++done, names.length);
      if (!expected) return { name, expected: 'OK', actual: outcome.verdict, ok: false, message: `no expected verdict (add ${name}.verdict). ${outcome.message}` };
      return { name, expected, actual: outcome.verdict, ok: outcome.verdict === expected, message: outcome.message };
    }),
  );
  return { compile: undefined, results };
}
