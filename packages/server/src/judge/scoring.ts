import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  groupLayout,
  parseIndexList,
  type GroupScore,
  type InvocationCell,
  type ScoringInput,
  type SolutionScore,
  type TestsetConfig,
} from '@polyforge/shared';
import { describeRun, readHead, runHelper, withTmp } from './execute.js';
import type { Judge, ProblemCtx } from './index.js';

/** Scores apply when points are enabled or a local scoring program is configured. */
export const scoringEnabled = (ctx: ProblemCtx) => !!ctx.config.tests.points || !!ctx.config.scoring?.source;

/** Score of one test: checker points (quitp) when given, else the test's points if OK. */
function testScore(cell: InvocationCell | null, max: number): number {
  if (!cell) return 0;
  if (cell.points !== undefined) return cell.points;
  return cell.verdict === 'OK' ? max : 0;
}

export function scoringInput(ctx: ProblemCtx, ts: TestsetConfig, tests: number[], cells: (InvocationCell | null)[]): ScoringInput {
  const layout = groupLayout(ts, !!ctx.config.tests.points);
  return {
    testset: ts.name,
    tests: tests.map((index, k) => {
      const c = cells[k];
      return {
        index,
        group: layout.mapping[index],
        points: layout.points[index],
        verdict: c?.verdict ?? 'SKIP',
        checkerPoints: c?.points,
        timeMs: c?.timeMs ?? 0,
        memoryKb: c?.memoryKb ?? 0,
      };
    }),
    groups: ts.groups
      ? ts.group.map((g) => ({ name: g.name, points: g.points, policy: g.policy ?? 'COMPLETE_GROUP', dependencies: g.dependencies ?? [], tests: parseIndexList(g.tests ?? '') }))
      : [],
  };
}

/**
 * Polygon rules: COMPLETE_GROUP scores the group's points only if every test passes;
 * EACH_TEST sums the test scores; a group whose dependencies did not all pass scores 0.
 * Tests outside groups add their own points. Groups not run at all are left out.
 */
export function groupScore(input: ScoringInput): SolutionScore {
  const byIndex = new Map(input.tests.map((t) => [t.index, t]));
  const passed = new Map<string, boolean>();
  const groups: GroupScore[] = [];
  for (const g of input.groups) {
    const run = g.tests.map((i) => byIndex.get(i)).filter((t): t is NonNullable<typeof t> => !!t);
    const allOk = run.length === g.tests.length && run.every((t) => t.verdict === 'OK' && (t.checkerPoints === undefined || t.checkerPoints >= (t.points ?? 0)));
    passed.set(g.name, allOk);
    if (!run.length) continue;
    const max = g.points ?? run.reduce((a, t) => a + (t.points ?? 0), 0);
    let score = g.policy === 'EACH_TEST' ? run.reduce((a, t) => a + (t.checkerPoints ?? (t.verdict === 'OK' ? t.points ?? 0 : 0)), 0) : allOk ? max : 0;
    const blockedBy = g.dependencies.filter((d) => passed.get(d) === false || (!passed.has(d) && input.groups.some((x) => x.name === d)));
    if (blockedBy.length) score = 0;
    groups.push({ name: g.name, score, max, passed: allOk, ...(blockedBy.length ? { blockedBy } : {}) });
  }
  const loose = input.tests.filter((t) => !t.group);
  const looseScore = loose.reduce((a, t) => a + (t.checkerPoints ?? (t.verdict === 'OK' ? t.points ?? 0 : 0)), 0);
  const looseMax = loose.reduce((a, t) => a + (t.points ?? 0), 0);
  return {
    total: groups.reduce((a, g) => a + g.score, 0) + looseScore,
    max: groups.reduce((a, g) => a + g.max, 0) + looseMax,
    groups,
    source: 'groups',
  };
}

/**
 * Score one solution's results. With a scoring program, its first output line is the
 * score (optionally "score max"); the rest is shown as a message. The group breakdown
 * is kept for display either way.
 */
export async function scoreSolution(judge: Judge, ctx: ProblemCtx, input: ScoringInput, signal?: AbortSignal): Promise<SolutionScore> {
  const base = groupScore(input);
  const source = ctx.config.scoring?.source;
  if (!source) return base;
  try {
    const prog = await judge.require(ctx, source, 'Scoring program');
    return await withTmp(ctx.ref.dir, async (tmp) => {
      const inFile = path.join(tmp, 'results.json');
      const out = path.join(tmp, 'out.txt');
      const err = path.join(tmp, 'err.txt');
      await fsp.writeFile(inFile, JSON.stringify(input));
      const r = await runHelper(judge.runner, prog, [], { cwd: tmp, stdin: inFile, stdout: out, stderr: err }, signal);
      const text = (await readHead(out, 4000)).trim();
      if (r.status !== 'OK') return { ...base, source: 'script' as const, error: `${describeRun(r)} ${(await readHead(err, 1000)).trim()}`.trim() };
      const [first, ...rest] = text.split('\n');
      const m = first?.trim().match(/^(-?[\d.]+)(?:\s+(-?[\d.]+))?/);
      if (!m) return { ...base, source: 'script' as const, error: `Expected a score on the first line, got: ${first ?? '(nothing)'}` };
      return { ...base, total: Number(m[1]), max: m[2] !== undefined ? Number(m[2]) : base.max, source: 'script' as const, message: rest.join('\n').trim() || undefined };
    });
  } catch (e) {
    return { ...base, source: 'script', error: (e as Error).message };
  }
}
