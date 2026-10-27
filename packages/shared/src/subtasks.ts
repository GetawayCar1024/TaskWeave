import type { ProblemToml, TestGroup, TestsetConfig } from './problem.js';
import { parseIndexList, compressRanges, groupLayout, type TestInfo } from './judge.js';

/** Locale-independent dictionary order, also used by the dependency editor. */
export const compareGroupNames = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** A bundle has one maximum; a uniform sum group has one maximum per member. */
export function groupTotal(group: TestGroup): number | undefined {
  return group.policy === 'EACH_TEST' && group.test_points !== undefined
    ? group.test_points * new Set(parseIndexList(group.tests ?? '')).size : group.points;
}

export function testLimitLookup(config: ProblemToml, ts: TestsetConfig) {
  const groups = new Map<number, TestGroup[]>();
  if (ts.groups) for (const group of ts.group) for (const index of new Set(parseIndexList(group.tests ?? ''))) {
    const list = groups.get(index) ?? []; list.push(group); groups.set(index, list);
  }
  const resolve = (index: number, group?: TestGroup) => ({
    timeLimit: group?.cases?.[index]?.time_limit ?? group?.time_limit ?? ts.cases?.[index]?.time_limit ?? config.problem.time_limit,
    memoryLimit: group?.cases?.[index]?.memory_limit ?? group?.memory_limit ?? ts.cases?.[index]?.memory_limit ?? config.problem.memory_limit,
  });
  return (index: number, group?: TestGroup) => {
    if (group || !groups.has(index)) return resolve(index, group);
    // The manifest's summary uses the widest limits; invocations run distinct group contexts.
    const limits = groups.get(index)!.map(g => resolve(index, g));
    return { timeLimit: Math.max(...limits.map(l => l.timeLimit)), memoryLimit: Math.max(...limits.map(l => l.memoryLimit)) };
  };
}

export function testMetadata(config: ProblemToml, ts: TestsetConfig) {
  const layout = groupLayout(ts, !!config.tests.points), limits = testLimitLookup(config, ts);
  const groups = new Map(ts.group.map(g => [g.name, g]));
  return (index: number): Pick<TestInfo, 'group' | 'groups' | 'points' | 'timeLimit' | 'memoryLimit' | 'originalInput' | 'originalOutput'> => ({
    ...limits(index), group: layout.mapping[index], points: layout.points[index],
    groups: (layout.memberships[index] ?? []).map(name => ({ name, points: layout.byGroup[name]?.[index], ...limits(index, groups.get(name)) })),
    originalInput: ts.cases?.[index]?.original_input, originalOutput: ts.cases?.[index]?.original_output,
  });
}

export function originalTestName(test: { originalInput?: string; source: string }): string {
  return (test.originalInput || test.source).replace(/\\/g, '/').split('/').pop()!;
}

export function inferFilenameGroups(tests: { index: number; source: string; originalInput?: string }[]) {
  const groups = new Map<string, number[]>(), unmatched: string[] = [];
  for (const test of tests) {
    const name = originalTestName(test);
    const stem = name.replace(/\.(?:in|out|ans|txt)(?:\.txt)?$/i, '');
    const match = /^(.+)[_-](\d+)$/.exec(stem);
    if (!match || !match[1].trim()) { unmatched.push(name); continue; }
    const indices = groups.get(match[1]) ?? []; indices.push(test.index); groups.set(match[1], indices);
  }
  return { groups: [...groups].map(([name, indices]): TestGroup => ({ name, tests: compressRanges(indices), policy: 'COMPLETE_GROUP' })), unmatched };
}
