import { promises as fs } from 'node:fs';
import path from 'node:path';
import { stringify as yaml } from 'yaml';
import { groupTotal, parseIndexList, testsetOf } from '@polyforge/shared';
import type { JobCtx } from '../jobs.js';
import { ZipWriter } from '../util/zip.js';
import type { Judge, ProblemCtx } from './index.js';
import { exportedTests } from './lemonlime.js';
import { answerPath, inputPath, planTests } from './tests.js';

/** in/out is the published dataset convention; polyforge.yaml is our optional companion. */
export async function joiPackage(judge: Judge, ctx: ProblemCtx, job: JobCtx, testsets: string[]) {
  const sets = await exportedTests(judge, ctx, testsets, ctx.config.problem.name, job);
  const zip = new ZipWriter({ async: true }), used = new Set<string>();
  const cases: Record<string, unknown>[] = [], subtasks: Record<string, unknown>[] = [];
  for (const set of sets) {
    const ts = testsetOf(ctx.config, set.name)!;
    const planned = new Map((await planTests(ctx, [], set.name)).map(test => [test.index, test]));
    const caseId = (index: number) => `${set.name}:${index}`;
    const groupId = (name: string) => sets.length === 1 ? name : `${set.name}/${name}`;
    for (const index of set.tests) {
      job.signal.throwIfAborted();
      const original = ts.cases?.[index];
      const source = planned.get(index);
      const basename = path.posix.basename((original?.original_input || (source?.origin === 'manual' ? source.source : `${index}`)).replace(/\\/g, '/'));
      const stem = basename.replace(/\.(in|out|ans|txt)(?:\.txt)?$/i, '').replace(/[^\p{L}\p{N}._-]/gu, '_') || `${index}`;
      let name = `${stem}.txt`;
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${stem}-${n}.txt`;
      used.add(name.toLowerCase());
      zip.add(`in/${name}`, await fs.readFile(inputPath(ctx, index, set.name)));
      zip.add(`out/${name}`, await fs.readFile(answerPath(ctx, index, set.name)));
      cases.push({ id: caseId(index), input: `in/${name}`, output: `out/${name}`, original_input: original?.original_input ?? (source?.origin === 'manual' ? source.source : undefined),
        original_output: original?.original_output, score: original?.points, time_ms: original?.time_limit, memory_mib: original?.memory_limit,
        sample: parseIndexList(ts.samples ?? '').includes(index) || undefined });
    }
    if (ts.groups) for (const group of ts.group) subtasks.push({ id: groupId(group.name), aggregation: group.policy === 'EACH_TEST' ? 'sum' : 'min',
      points: groupTotal(group), test_points: group.test_points, time_ms: group.time_limit, memory_mib: group.memory_limit,
      cases: parseIndexList(group.tests ?? '').map(caseId), dependencies: group.dependencies?.map(groupId),
      overrides: group.cases && Object.fromEntries(Object.entries(group.cases).map(([index, value]) => [caseId(Number(index)), value])) });
  }
  zip.add('polyforge.yaml', yaml({ format: 'polyforge-inout', version: 1, problem: { name: ctx.config.problem.name, title: ctx.config.problem.title,
    time_ms: ctx.config.problem.time_limit, memory_mib: ctx.config.problem.memory_limit, input: ctx.config.problem.input, output: ctx.config.problem.output },
    points_enabled: !!ctx.config.tests.points, cases, subtasks }));
  return { data: await zip.finishAsync(), tests: cases.length, warnings: ['JOI / AtCoder in/out ZIPs have no universal scoring configuration. polyforge.yaml preserves Taskweave settings for re-import.'] };
}
