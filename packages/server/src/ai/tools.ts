import { promises as fsp } from 'node:fs';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { classifyFile, problemTomlSchema, type AiPlanStep } from '@polyforge/shared';
import type { JobCtx } from '../jobs.js';
import type { Judge, ProblemCtx } from '../judge/index.js';
import { readInvocation, runInvocation } from '../judge/invocation.js';
import { quickRun } from '../judge/quickrun.js';
import { runCheckerTests, runValidatorTests } from '../judge/selftest.js';
import { answerPath, generateTests, inputPath, overviewPath } from '../judge/tests.js';
import { listShared } from '../sharedFiles.js';
import { safeJoin } from '../util/fs.js';
import type { ToolDef } from './provider.js';
import type { Sandbox } from './sandbox.js';

export interface ToolEnv {
  sandbox: Sandbox;
  judge: Judge;
  /** Judge context for the sandbox copy (re-read after problem.toml edits). */
  ctx: () => Promise<ProblemCtx>;
  signal: AbortSignal;
  setPlan: (plan: AiPlanStep[]) => void;
  /** A file in the sandbox changed. */
  changed: () => void;
}

interface Tool<S extends z.ZodType> {
  name: string;
  description: string;
  schema: S;
  run: (input: z.infer<S>, env: ToolEnv) => Promise<string>;
}

const tool = <S extends z.ZodType>(t: Tool<S>) => t;

const MAX_RESULT = 30_000;
export const clip = (s: string, n = MAX_RESULT) => (s.length <= n ? s : `${s.slice(0, n)}\n… [truncated, ${s.length - n} more characters]`);

const job = (env: ToolEnv): JobCtx => ({ signal: env.signal, progress: () => {} });

/** Reject a problem.toml edit that would leave the file unparseable or invalid. */
function checkProblemToml(text: string): string | null {
  try {
    const r = problemTomlSchema.safeParse(parseToml(text));
    return r.success ? null : r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  } catch (e) {
    return (e as Error).message;
  }
}

async function guardedWrite(env: ToolEnv, rel: string, content: string): Promise<string> {
  const { rel: clean } = env.sandbox.resolve(rel);
  if (clean === 'problem.toml') {
    const err = checkProblemToml(content);
    if (err) throw new Error(`problem.toml would be invalid, not written: ${err}`);
  }
  await env.sandbox.write(clean, content);
  env.changed();
  return clean;
}

const TOOLS = [
  tool({
    name: 'list_files',
    description: 'List every file of the problem with its size and role (statement, validator, checker, generator, solution, test, …).',
    schema: z.object({}),
    async run(_i, env) {
      const ctx = await env.ctx();
      const lines: string[] = [];
      for (const [rel, abs] of await env.sandbox.files()) {
        const size = (await fsp.stat(abs)).size;
        lines.push(`${rel}  (${size} B, ${classifyFile(rel, ctx.config)})`);
      }
      return lines.join('\n') || '(no files)';
    },
  }),
  tool({
    name: 'read_file',
    description: 'Read a text file of the problem. Optionally a line range (1-based, inclusive).',
    schema: z.object({ path: z.string(), start_line: z.number().int().min(1).optional(), end_line: z.number().int().min(1).optional() }),
    async run(i, env) {
      const text = (await env.sandbox.read(i.path)).toString('utf8');
      const lines = text.split('\n');
      if (!i.start_line && !i.end_line) return clip(text, 100_000) || '(empty file)';
      const a = (i.start_line ?? 1) - 1;
      const b = Math.min(i.end_line ?? lines.length, lines.length);
      return `${i.path} lines ${a + 1}-${b} of ${lines.length}:\n${lines.slice(a, b).join('\n')}`;
    },
  }),
  tool({
    name: 'write_file',
    description: 'Create or overwrite a file with the full content. Use for new files or complete rewrites; prefer edit_file for small changes.',
    schema: z.object({ path: z.string(), content: z.string() }),
    async run(i, env) {
      const rel = await guardedWrite(env, i.path, i.content);
      return `Wrote ${rel} (${i.content.length} characters).`;
    },
  }),
  tool({
    name: 'edit_file',
    description: 'Replace an exact text fragment in a file. old_text must match exactly (including whitespace) and be unique unless replace_all is true.',
    schema: z.object({ path: z.string(), old_text: z.string().min(1), new_text: z.string(), replace_all: z.boolean().optional() }),
    async run(i, env) {
      const text = (await env.sandbox.read(i.path)).toString('utf8');
      const count = text.split(i.old_text).length - 1;
      if (count === 0) throw new Error('old_text not found; read the file again and copy the fragment exactly');
      if (count > 1 && !i.replace_all) throw new Error(`old_text appears ${count} times; add surrounding context or set replace_all`);
      const next = i.replace_all ? text.split(i.old_text).join(i.new_text) : text.replace(i.old_text, () => i.new_text);
      const rel = await guardedWrite(env, i.path, next);
      return `Edited ${rel} (${count} replacement${count > 1 ? 's' : ''}).`;
    },
  }),
  tool({
    name: 'delete_file',
    description: 'Delete a file of the problem.',
    schema: z.object({ path: z.string() }),
    async run(i, env) {
      if (env.sandbox.resolve(i.path).rel === 'problem.toml') throw new Error('problem.toml cannot be deleted');
      const rel = await env.sandbox.remove(i.path);
      env.changed();
      return `Deleted ${rel}.`;
    },
  }),
  tool({
    name: 'list_shared',
    description: 'List the shared library: standard checkers (usable as "std:<name>" in problem.toml) with descriptions, and validator/generator templates.',
    schema: z.object({}),
    async run(_i, env) {
      const s = await listShared(env.judge.global.sharedDir);
      const fmt = (xs: { path: string; ref?: string; description?: string }[]) => xs.map((x) => `  ${x.ref ?? x.path}${x.description ? ` — ${x.description}` : ''}`).join('\n');
      return `Checkers:\n${fmt(s.checkers)}\nValidator templates:\n${fmt(s.validators)}\nGenerator templates:\n${fmt(s.generators)}`;
    },
  }),
  tool({
    name: 'read_shared',
    description: 'Read a file of the shared library, e.g. "checkers/ncmp.cpp", "generators/gen-tree-graph.cpp" or "testlib.h".',
    schema: z.object({ path: z.string() }),
    async run(i, env) {
      return clip(await fsp.readFile(safeJoin(env.judge.global.sharedDir, i.path), 'utf8'));
    },
  }),
  tool({
    name: 'compile',
    description: 'Compile a source file of the problem (or a std checker such as "std:ncmp") and return the compiler output.',
    schema: z.object({ path: z.string() }),
    async run(i, env) {
      const out = await env.judge.compile(await env.ctx(), i.path);
      const r = out.result;
      return `${r.ok ? 'OK' : 'COMPILATION FAILED'} (${r.lang ?? 'unknown language'}, ${r.durationMs} ms${r.cached ? ', cached' : ''})${r.log ? `\n${clip(r.log, 8000)}` : ''}`;
    },
  }),
  tool({
    name: 'run',
    description: 'Compile and run a program under the problem limits, on custom stdin or on a generated test (then the checker judges the output).',
    schema: z.object({ path: z.string(), input: z.string().optional(), test: z.number().int().min(1).optional() }),
    async run(i, env) {
      const r = await quickRun(env.judge, await env.ctx(), { source: i.path, input: i.input, test: i.test });
      if (!r.compile.ok) return `COMPILATION FAILED\n${clip(r.compile.log, 8000)}`;
      const head = `verdict ${r.verdict ?? '?'}; ${r.run?.timeMs ?? '?'} ms; ${Math.round((r.run?.memoryKb ?? 0) / 1024)} MB; exit ${r.run?.exitCode ?? '?'}`;
      return [head, r.checker?.message ? `checker: ${r.checker.message}` : '', `stdout${r.stdoutTruncated ? ' (truncated)' : ''}:\n${clip(r.stdout, 6000)}`, r.stderr ? `stderr:\n${clip(r.stderr, 3000)}` : '']
        .filter(Boolean)
        .join('\n');
    },
  }),
  tool({
    name: 'generate_tests',
    description: 'Generate all tests: manual tests + tests/script.txt, run the validator on each, and produce answers with the main (MA) solution. Returns per-test status and errors.',
    schema: z.object({}),
    async run(_i, env) {
      const m = await generateTests(env.judge, await env.ctx(), job(env));
      const lines = m.tests.map(
        (t) =>
          `#${t.index} ${t.origin === 'manual' ? t.source : `[${t.source}]`} in=${t.inputSize ?? '-'}B ans=${t.answerSize ?? '-'}B ${t.valid === false ? `INVALID: ${t.validatorMessage}` : t.valid ? 'valid' : 'no validator'}${t.error ? ` ERROR: ${t.error}` : ''}`,
      );
      return clip(`${m.tests.length} tests, ${m.ok ? 'no errors' : `${m.errors.length} error(s)`}\n${m.errors.map((e) => `! ${e}`).join('\n')}\n${lines.join('\n')}`);
    },
  }),
  tool({
    name: 'view_test',
    description: 'Show the beginning of a generated test input, its answer, or the validator overview for it.',
    schema: z.object({ index: z.number().int().min(1), part: z.enum(['input', 'answer', 'overview']), max_chars: z.number().int().min(100).max(50_000).optional() }),
    async run(i, env) {
      const ctx = await env.ctx();
      const file = { input: inputPath, answer: answerPath, overview: overviewPath }[i.part](ctx, i.index);
      const text = await fsp.readFile(file, 'utf8').catch(() => null);
      if (text === null) throw new Error(`test ${i.index} ${i.part} not found (run generate_tests first)`);
      return clip(text, i.max_chars ?? 4000);
    },
  }),
  tool({
    name: 'run_invocation',
    description:
      'Run solutions on all generated tests (regenerating tests if needed) and check each against its tag (MA/OK must pass everything, WA must get WA somewhere, TL must TL somewhere, …). Returns a per-solution summary.',
    schema: z.object({ solutions: z.array(z.string()).optional(), tests: z.array(z.number().int()).optional() }),
    async run(i, env) {
      const ctx = await env.ctx();
      const sources = i.solutions?.length ? i.solutions : ctx.config.solutions.map((s) => s.source);
      if (!sources.length) throw new Error('no solutions listed in problem.toml');
      const id = await runInvocation(env.judge, ctx, sources, i.tests, job(env), () => {});
      const inv = await readInvocation(ctx, id);
      const out: string[] = [`${inv.tests.length} tests, TL ${inv.timeLimit} ms`];
      inv.solutions.forEach((s, si) => {
        const cells = inv.cells[si] ?? [];
        if (s.compile && !s.compile.ok) return out.push(`${s.source} [${s.tag}] COMPILATION FAILED\n${clip(s.compile.log, 1500)}`);
        const counts: Record<string, number> = {};
        cells.forEach((c) => c && (counts[c.verdict] = (counts[c.verdict] ?? 0) + 1));
        const e = s.expectation;
        out.push(
          `${s.source} [${s.tag ?? 'no tag'}] ${e?.ok ? 'matches tag' : 'DOES NOT MATCH TAG'}; ${Object.entries(counts).map(([v, n]) => `${v}×${n}`).join(' ')}; max ${s.maxTimeMs ?? '-'} ms / ${Math.round((s.maxMemoryKb ?? 0) / 1024)} MB`,
        );
        if (e?.missing) out.push(`  never got ${e.missing.join('/')} — the tests may be too weak to catch this solution`);
        for (const ti of (e?.unexpected ?? []).slice(0, 5)) {
          const c = cells[ti];
          out.push(`  test ${inv.tests[ti]}: ${c?.verdict} ${c?.timeMs} ms ${c?.message ? `— ${c.message.slice(0, 200)}` : ''}`);
        }
        if (e?.slow?.length) out.push(`  over half the TL on tests ${e.slow.map((ti) => inv.tests[ti]).join(', ')}`);
      });
      return clip(out.join('\n'));
    },
  }),
  tool({
    name: 'run_validator_tests',
    description: 'Run the validator on validator-tests/ (files named with "valid"/"invalid", e.g. 01.valid.in, 02.invalid.in) and report mismatches.',
    schema: z.object({}),
    async run(_i, env) {
      const r = await runValidatorTests(env.judge, await env.ctx(), job(env));
      if (r.compile && !r.compile.ok) return `VALIDATOR COMPILATION FAILED\n${clip(r.compile.log, 6000)}`;
      return [r.error ?? '', ...r.results.map((x) => `${x.ok ? 'ok ' : 'BAD'} ${x.file}: expected ${x.expected}, got ${x.actual}${x.message ? ` — ${x.message.slice(0, 200)}` : ''}`)].filter(Boolean).join('\n') || 'no validator tests';
    },
  }),
  tool({
    name: 'run_checker_tests',
    description: 'Run the checker on checker-tests/ (NAME.in + NAME.out + NAME.ans, expected verdict in NAME.verdict or the name: ok/wa/pe/fail).',
    schema: z.object({}),
    async run(_i, env) {
      const r = await runCheckerTests(env.judge, await env.ctx(), job(env));
      if (r.compile && !r.compile.ok) return `CHECKER COMPILATION FAILED\n${clip(r.compile.log, 6000)}`;
      return [r.error ?? '', ...r.results.map((x) => `${x.ok ? 'ok ' : 'BAD'} ${x.name}: expected ${x.expected}, got ${x.actual}${x.message ? ` — ${x.message.slice(0, 200)}` : ''}`)].filter(Boolean).join('\n') || 'no checker tests';
    },
  }),
  tool({
    name: 'update_plan',
    description: 'Show your plan to the user as a checklist. Call it at the start of multi-step work and whenever a step changes status.',
    schema: z.object({ steps: z.array(z.object({ title: z.string(), status: z.enum(['pending', 'in_progress', 'done', 'skipped']) })).min(1) }),
    async run(i, env) {
      env.setPlan(i.steps);
      return 'Plan updated.';
    },
  }),
];

export const TOOL_DEFS: ToolDef[] = TOOLS.map((t) => {
  const { $schema: _s, ...schema } = z.toJSONSchema(t.schema) as Record<string, unknown>;
  return { name: t.name, description: t.description, input_schema: schema };
});

/** Tools whose calls change files (shown with a distinct style in the UI). */
export const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file']);

/** Validate and run a tool call; errors become `is_error` results the model can react to. */
export async function runTool(name: string, input: unknown, env: ToolEnv): Promise<{ content: string; isError: boolean }> {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) return { content: `Unknown tool: ${name}`, isError: true };
  const parsed = t.schema.safeParse(input ?? {});
  if (!parsed.success) {
    return { content: `Invalid input for ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ')}`, isError: true };
  }
  try {
    return { content: await (t.run as (i: unknown, e: ToolEnv) => Promise<string>)(parsed.data, env), isError: false };
  } catch (e) {
    if (env.signal.aborted) throw e;
    return { content: (e as Error).message, isError: true };
  }
}
