import { groupLayout, groupTotal, parseIndexList, testLimitLookup, type GroupScore, type InvocationCell, type ScoringInput, type SolutionScore, type TestsetConfig } from '@polyforge/shared';
import type { ProblemCtx } from './index.js';

/** Scores apply when points are enabled. */
export const scoringEnabled = (ctx: ProblemCtx) => !!ctx.config.tests.points;

export function scoringInput(ctx: Pick<ProblemCtx, 'config'>, ts: TestsetConfig, tests: number[], cells: (InvocationCell | null)[]): ScoringInput {
  const layout = groupLayout(ts, !!ctx.config.tests.points);
  const limits = testLimitLookup(ctx.config, ts);
  return {
    tests: tests.map((index, k) => {
      const c = cells[k];
      return { index, group: layout.mapping[index], points: layout.points[index], verdict: c?.verdict ?? 'SKIP', checkerPoints: c?.points, timeMs: c?.timeMs, memoryKb: c?.memoryKb, wallMs: c?.wallMs };
    }),
    groups: ts.groups
      ? ts.group.map(g => ({ name: g.name, points: groupTotal(g), policy: g.policy ?? 'COMPLETE_GROUP', dependencies: [...new Set(g.dependencies ?? [])],
        tests: [...new Set(parseIndexList(g.tests ?? ''))], testPoints: layout.byGroup[g.name],
        limits: Object.fromEntries(parseIndexList(g.tests ?? '').map(i => [i, limits(i, g)])),
        results: Object.fromEntries(tests.flatMap((index, k) => cells[k]?.groupResults?.[g.name] ? [[index, cells[k]!.groupResults![g.name]]] : [])) }))
      : [],
  };
}

/**
 * Polygon rules: COMPLETE_GROUP scores the group's points only if every test passes;
 * EACH_TEST sums the test scores (checker points from quitp when given); a group whose
 * dependencies did not all pass scores 0. Tests outside groups add their own points.
 * Groups not run at all are left out.
 */
export function groupScore(input: ScoringInput): SolutionScore {
  const byIndex = new Map(input.tests.map((t) => [t.index, t]));
  const testScore = (t: ScoringInput['tests'][number]) => t.verdict === 'OK' ? Math.max(0, Math.min(t.points ?? 0, t.checkerPoints ?? t.points ?? 0)) : 0;
  const passed = new Map<string, boolean>();
  const definitions = new Map(input.groups.map(g => [g.name, g]));
  const groupedTest = (g: ScoringInput['groups'][number], t: ScoringInput['tests'][number]) => {
    const result = g.results?.[t.index];
    if (result) t = { ...t, ...result, checkerPoints: result.points };
    const limits = g.limits?.[t.index];
    return { ...t, points: g.testPoints?.[t.index] ?? (g.policy === 'COMPLETE_GROUP' ? g.points : undefined) ?? t.points,
      verdict: limits && ((t.timeMs ?? 0) > limits.timeLimit || (t.wallMs ?? 0) > limits.timeLimit * 3) ? 'TL' as const
        : limits && (t.memoryKb ?? 0) > limits.memoryLimit * 1024 ? 'ML' as const : t.verdict };
  };
  const visiting = new Set<string>();
  const passes = (name: string): boolean => {
    if (passed.has(name)) return passed.get(name)!;
    const g = definitions.get(name);
    if (!g || visiting.has(name)) return false;
    visiting.add(name);
    const ok = g.tests.length > 0 && g.tests.every(i => {
      const original = byIndex.get(i), t = original && groupedTest(g, original);
      return !!t && t.verdict === 'OK' && (t.checkerPoints === undefined || t.checkerPoints >= (t.points ?? 0));
    }) && g.dependencies.every(passes);
    visiting.delete(name);
    passed.set(name, ok);
    return ok;
  };
  const groups: GroupScore[] = [];
  for (const g of input.groups) {
    const run = g.tests.map(i => byIndex.get(i)).filter((t): t is NonNullable<typeof t> => !!t).map(t => groupedTest(g, t));
    const allOk = passes(g.name);
    if (!run.length) continue;
    const max = g.points ?? run.reduce((a, t) => a + (t.points ?? 0), 0);
    let score = g.policy === 'EACH_TEST' ? run.reduce((a, t) => a + testScore(t), 0)
      : run.length === g.tests.length ? Math.min(max, ...run.map(testScore)) : 0;
    const blockedBy = g.dependencies.filter(d => !passes(d));
    if (blockedBy.length) score = 0;
    groups.push({ name: g.name, score, max, passed: allOk, ...(blockedBy.length ? { blockedBy } : {}) });
  }
  const assigned = new Set(input.groups.flatMap(g => g.tests));
  const loose = input.tests.filter(t => !assigned.has(t.index));
  return {
    total: groups.reduce((a, g) => a + g.score, 0) + loose.reduce((a, t) => a + testScore(t), 0),
    max: groups.reduce((a, g) => a + g.max, 0) + loose.reduce((a, t) => a + (t.points ?? 0), 0),
    groups,
  };
}
