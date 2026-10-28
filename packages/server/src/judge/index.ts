import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { judgeMode, LEMON_COMPARISON_MODES, type CompileResult, type ProblemToml } from '@taskweave/shared';
import type { GlobalStore } from '../global.js';
import { HttpError, isDir } from '../util/fs.js';
import type { ProblemRef, ProblemRegistry } from '../workspace/problems.js';
import type { WsHub } from '../ws.js';
import { Compiler, type CompileOutcome, type Program } from './compiler.js';
import type { ProblemLimits } from './execute.js';
import { Runner } from './runner.js';

export interface ProblemCtx {
  ref: ProblemRef;
  config: ProblemToml;
  limits: ProblemLimits;
  /** .taskweave directory of the problem. */
  work: string;
  /** Build cache override (AI sandboxes share the real problem's build cache). */
  buildRoot?: string;
}

export function requireFullProblem(ctx: ProblemCtx) {
  if (ctx.config.problem.unresolved_judge) throw new HttpError(400, 'unresolved_judge', ctx.config.problem.unresolved_judge);
  if (ctx.config.problem.data_only) throw new HttpError(400, 'data_only', 'This feature requires full authoring. Complete the statement, validator, checker and main solution, then leave compatibility mode.');
}

export class Judge {
  readonly compiler: Compiler;
  readonly runner: Runner;

  constructor(
    readonly global: GlobalStore,
    readonly registry: ProblemRegistry,
    readonly hub: WsHub,
  ) {
    this.runner = new Runner(path.join(global.cacheDir, 'bin'));
    this.runner.setParallel(global.config.judge?.parallel ?? 0);
    this.compiler = new Compiler(global, this.runner.compilePool);
  }

  async ctx(problemId: string): Promise<ProblemCtx> {
    return this.ctxFor(await this.registry.get(problemId));
  }

  /** Context for an arbitrary problem folder, e.g. an AI sandbox copy. */
  async ctxFor(ref: ProblemRef, buildRoot?: string): Promise<ProblemCtx> {
    const { config, error } = await this.registry.readConfig(ref);
    if (!config) throw new HttpError(400, 'invalid_problem_toml', error ?? 'problem.toml is invalid');
    return {
      ref,
      config,
      work: path.join(ref.dir, '.taskweave'),
      buildRoot,
      limits: {
        timeLimitMs: config.problem.time_limit,
        memoryLimitMb: config.problem.memory_limit,
        input: config.problem.input || 'stdin',
        output: config.problem.output || 'stdout',
      },
    };
  }

  /** The `lang` override for a source, if problem.toml lists one. */
  langOf(config: ProblemToml, source: string): string | undefined {
    if (config.source_languages?.[source]) return config.source_languages[source];
    const entries = [config.checker, config.lemon_checker, config.validator, config.interactor, ...config.solutions, ...config.generators];
    return entries.find((e) => e?.source === source)?.lang;
  }

  async compile(ctx: ProblemCtx, source: string, solution = ctx.config.solutions.some(s => s.source === source) || source.startsWith('solutions/')): Promise<CompileOutcome> {
    requireFullProblem(ctx);
    const grader = solution && judgeMode(ctx.config.problem) === 'grader' ? ctx.config.grader ?? { sources: [], headers: [] } : undefined;
    const out = await this.compiler.compile(ctx.ref.dir, source, this.langOf(ctx.config, source), ctx.buildRoot, grader);
    this.hub.broadcast({ type: 'build:done', problemId: ctx.ref.id, result: out.result });
    return out;
  }

  /** Compile or throw with the compiler log, for programs a job cannot do without. */
  async require(ctx: ProblemCtx, source: string, role: string): Promise<Program> {
    const out = await this.compile(ctx, source, /solution/i.test(role) ? true : undefined);
    if (!out.program) throw new CompileFailure(role, out.result);
    return out.program;
  }

  mainSolution(config: ProblemToml): string | undefined {
    return config.solutions.find((s) => s.tag === 'MA')?.source;
  }

  hasChecker(config: ProblemToml) { return !!config.checker || !!config.lemon_comparison; }
  async checker(ctx: ProblemCtx): Promise<Program> {
    requireFullProblem(ctx);
    const native = ctx.config.lemon_comparison;
    if (native) {
      const compiled = await this.compiler.compile(this.global.sharedDir, 'lemon-native/comparator.cpp', undefined, path.join(this.global.cacheDir, 'bin'));
      if (!compiled.program) throw new CompileFailure('Lemon native comparator', compiled.result);
      const mode = LEMON_COMPARISON_MODES[native.mode];
      return { ...compiled.program, argv: [...compiled.program.argv, String(mode), String(native.precision)], hash: `${compiled.program.hash}:${mode}:${native.precision}`, checkerProtocol: 'lemon-native' };
    }
    if (!ctx.config.checker) throw new HttpError(400, 'no_checker', 'No checker configured');
    return this.require(ctx, ctx.config.checker.source, 'Checker');
  }

  /**
   * Generator sources by script name (file name without extension): registered
   * generators first, then anything under generators/.
   */
  async generators(ctx: ProblemCtx): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const add = (src: string) => {
      const name = path.basename(src).replace(/\.[^.]+$/, '');
      if (!map.has(name)) map.set(name, src);
    };
    ctx.config.generators.forEach((g) => add(g.source));
    const dir = path.join(ctx.ref.dir, 'generators');
    if (await isDir(dir)) {
      for (const f of (await fsp.readdir(dir)).sort()) if (/\.(cpp|cc|cxx|c|py|java|kt|pas|rs|go)$/i.test(f)) add(`generators/${f}`);
    }
    return map;
  }
}

export class CompileFailure extends Error {
  constructor(
    public role: string,
    public result: CompileResult,
  ) {
    super(`${role} ${result.source} failed to compile:\n${result.log}`);
  }
}
