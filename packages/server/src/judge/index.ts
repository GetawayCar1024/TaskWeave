import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { CompileResult, ProblemToml } from '@polyforge/shared';
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
  /** .polyforge directory of the problem. */
  work: string;
  /** Build cache override (AI sandboxes share the real problem's build cache). */
  buildRoot?: string;
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
      work: path.join(ref.dir, '.polyforge'),
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
    const entries = [config.checker, config.validator, config.interactor, ...config.solutions, ...config.generators];
    return entries.find((e) => e?.source === source)?.lang;
  }

  async compile(ctx: ProblemCtx, source: string): Promise<CompileOutcome> {
    const out = await this.compiler.compile(ctx.ref.dir, source, this.langOf(ctx.config, source), ctx.buildRoot);
    this.hub.broadcast({ type: 'build:done', problemId: ctx.ref.id, result: out.result });
    return out;
  }

  /** Compile or throw with the compiler log, for programs a job cannot do without. */
  async require(ctx: ProblemCtx, source: string, role: string): Promise<Program> {
    const out = await this.compile(ctx, source);
    if (!out.program) throw new CompileFailure(role, out.result);
    return out.program;
  }

  mainSolution(config: ProblemToml): string | undefined {
    return config.solutions.find((s) => s.tag === 'MA')?.source;
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
