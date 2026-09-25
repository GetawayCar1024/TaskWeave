import { diff3Merge } from 'node-diff3';

export interface MergeOutcome {
  text: string;
  /** Number of regions both sides changed differently (left as conflict markers). */
  conflicts: number;
}

const lines = (s: string) => s.replace(/\r\n/g, '\n').split('\n');

/**
 * Line-based three-way merge. Clean regions are combined; overlapping edits are kept
 * with git-style markers so the file can be finished by hand in the editor.
 */
export function merge3(local: string, base: string, remote: string, labels = { local: 'local', remote: 'Polygon' }): MergeOutcome {
  const out: string[] = [];
  let conflicts = 0;
  for (const region of diff3Merge(lines(local), lines(base), lines(remote), { excludeFalseConflicts: true })) {
    if (region.ok) out.push(...region.ok);
    else if (region.conflict) {
      conflicts++;
      out.push(`<<<<<<< ${labels.local}`, ...region.conflict.a, '=======', ...region.conflict.b, `>>>>>>> ${labels.remote}`);
    }
  }
  return { text: out.join('\n'), conflicts };
}

/** Merge metadata key by key: take whichever side changed; local wins if both did. */
export function mergeMeta(local: Record<string, unknown> = {}, base: Record<string, unknown> = {}, remote: Record<string, unknown> = {}) {
  const out: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    out[k] = same(local[k], base[k]) ? remote[k] : local[k];
  }
  return out;
}
