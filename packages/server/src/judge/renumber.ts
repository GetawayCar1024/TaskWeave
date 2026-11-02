import { compressRanges, groupLayout, parseIndexList, type TestGroup, type TestsetConfig } from '@taskweave/shared';

/** Test-indexed values after renumbering; `map` returns undefined for removed tests. */
export const remapKeys = <T>(values: Record<string, T>, map: (index: number) => number | undefined): Record<string, T> =>
  Object.fromEntries(Object.entries(values).flatMap(([index, value]) => { const next = map(Number(index)); return next === undefined ? [] : [[String(next), value] as const]; }));

/** Remove groups; a group that depended on a removed one depends on that group's prerequisites instead. */
export function dropGroups(groups: TestGroup[], dropped: Set<string>): TestGroup[] {
  const prerequisites = new Map(groups.map(g => [g.name, g.dependencies ?? []]));
  const resolve = (name: string, seen: Set<string>): string[] => !dropped.has(name) ? [name]
    : seen.has(name) ? [] : (seen.add(name), (prerequisites.get(name) ?? []).flatMap(d => resolve(d, seen)));
  return groups.filter(g => !dropped.has(g.name)).map(g => {
    if (!g.dependencies?.length) return g;
    const { dependencies, ...rest } = g, next = [...new Set(dependencies.flatMap(d => resolve(d, new Set())))];
    return next.length ? { ...rest, dependencies: next } : rest;
  });
}

/**
 * Renumber the tests of groups: `map` gives each kept test its new index (undefined: removed).
 * Sum groups lose the points of their removed tests; a group left without tests is dropped.
 */
export function withoutTests(groups: TestGroup[], cases: NonNullable<TestsetConfig['cases']>, map: (index: number) => number | undefined) {
  const layout = groupLayout({ name: 'tests', manual: '', groups: true, group: groups, cases }, true), dropped = new Set<string>();
  const kept = groups.map((g): TestGroup => {
    const before = [...new Set(parseIndexList(g.tests ?? ''))], after = before.flatMap(i => map(i) ?? []), lost = before.filter(i => map(i) === undefined);
    if (before.length && !after.length) dropped.add(g.name);
    const next: TestGroup = { ...g, tests: compressRanges(after), ...g.cases ? { cases: remapKeys(g.cases, map) } : {} };
    if (lost.length && g.policy === 'EACH_TEST' && g.points !== undefined) next.points = g.test_points !== undefined ? g.test_points * after.length
      : Math.max(0, Math.round((g.points - lost.reduce((sum, i) => sum + (layout.byGroup[g.name]?.[i] ?? 0), 0)) * 1e6) / 1e6);
    return next;
  });
  return { groups: dropGroups(kept, dropped), dropped: [...dropped] };
}
