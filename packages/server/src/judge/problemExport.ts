import { luoguExportOptions, type LuoguExportOptions } from '@polyforge/shared';
import type { JobCtx } from '../jobs.js';
import { HttpError } from '../util/fs.js';
import type { Judge, ProblemCtx } from './index.js';
import { exportTestsets } from './lemonlime.js';
import { luoguData } from './luogu.js';
import { hydroPackage } from './hydro.js';

export function requireLuoguOptions(value: unknown): LuoguExportOptions {
  const options = value as LuoguExportOptions | undefined;
  if (!options || !['sum', 'min', 'max'].includes(options.time) || !['sum', 'min', 'max'].includes(options.memory)) throw new HttpError(400, 'bad_request', 'Unknown time / memory aggregation');
  return { time: options.time, memory: options.memory };
}

/** Both single and contest export use exactly this single-problem package boundary. */
export async function buildProblemDataPackage(judge: Judge, ctx: ProblemCtx, format: 'luogu' | 'hydro', job: JobCtx, options: { testsets?: string[]; luogu?: LuoguExportOptions } = {}) {
  const sets = exportTestsets(ctx, ctx.config.problem.name, options.testsets);
  if (format === 'hydro') return { ...await hydroPackage(judge, ctx, job, sets), filename: `${ctx.config.problem.name}-hydro.zip`, readme: undefined };
  const aggregation = requireLuoguOptions(options.luogu ?? luoguExportOptions(ctx.config));
  if (options.luogu) await judge.registry.patch(ctx.ref.id, { luogu: aggregation });
  return { ...await luoguData(judge, ctx, ctx.config.problem.name, job, sets, aggregation), filename: 'data.zip' };
}
