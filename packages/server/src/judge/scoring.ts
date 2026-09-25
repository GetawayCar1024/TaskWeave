import { groupLayout, parseIndexList, type GroupScore, type InvocationCell, type ScoringInput, type SolutionScore, type TestsetConfig } from '@polyforge/shared';
import type { ProblemCtx } from './index.js';

/** Scores apply when points are enabled. */
export const scoringEnabled = (ctx: ProblemCtx) => !!ctx.config.tests.points;

export function scoringInput(ctx: ProblemCtx, ts: TestsetConfig, tests: number[], cells: (InvocationCell | null)[]): ScoringInput {
  const layout = groupLayout(ts, !!ctx.config.tests.points);
  return {
    tests: tests.map((index, k) => {
      const c = cells[k];
      return { index, group: layout.mapping[index], points: layout.points[index], verdict: c?.verdict ?? 'SKIP', checkerPoints: c?.points };
    }),
    groups: ts.groups
      ? ts.group.map((g) => ({ name: g.name, points: g.points, policy: g.policy ?? 'COMPLETE_GROUP', dependencies: g.dependencies ?? [], tests: parseIndexList(g.tests ?? '') }))
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
  const testScore = (t: ScoringInput['tests'][number]) => t.checkerPoints ?? (t.verdict === 'OK' ? t.points ?? 0 : 0);
  const passed = new Map<string, boolean>();
  const groups: GroupScore[] = [];
  for (const g of input.groups) {
    const run = g.tests.map((i) => byIndex.get(i)).filter((t): t is NonNullable<typeof t> => !!t);
    const allOk = run.length === g.tests.length && run.every((t) => t.verdict === 'OK' && (t.checkerPoints === undefined || t.checkerPoints >= (t.points ?? 0)));
    passed.set(g.name, allOk);
    if (!run.length) continue;
    const max = g.points ?? run.reduce((a, t) => a + (t.points ?? 0), 0);
    let score = g.policy === 'EACH_TEST' ? run.reduce((a, t) => a + testScore(t), 0) : allOk ? max : 0;
    const blockedBy = g.dependencies.filter((d) => passed.get(d) === false || (!passed.has(d) && input.groups.some((x) => x.name === d)));
    if (blockedBy.length) score = 0;
    groups.push({ name: g.name, score, max, passed: allOk, ...(blockedBy.length ? { blockedBy } : {}) });
  }
  const loose = input.tests.filter((t) => !t.group);
  return {
    total: groups.reduce((a, g) => a + g.score, 0) + loose.reduce((a, t) => a + testScore(t), 0),
    max: groups.reduce((a, g) => a + g.max, 0) + loose.reduce((a, t) => a + (t.points ?? 0), 0),
    groups,
  };
}
