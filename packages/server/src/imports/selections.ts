import path from 'node:path';
import { PROBLEM_NAME_RE, TESTSET_NAME_RE, type PackageSelection } from '@taskweave/shared';
import type { ProblemRegistry } from '../workspace/problems.js';
import { libraryParent } from '../workspace/library.js';
import { exists } from '../util/fs.js';
import { LEMON_CONTEST_ONLY } from './lemon.js';

const FORMATS = new Set(['polygon-package', 'hydro-problem', 'lemonlime', 'fps', 'data', 'joi', 'luogu-data', 'hydro-data']);

/**
 * Settings and conflicts of a whole batch, checked before anything is written. Package contents
 * were validated when they were staged; one error rejects the batch.
 */
export async function validatePackageSelections(registry: ProblemRegistry, items: PackageSelection[], problemId?: string): Promise<(string | undefined)[]> {
  const taken = problemId ? new Set<string>() : await registry.names(), counts = new Map<string, number>();
  const nameOf = (item: PackageSelection) => typeof item.name === 'string' ? item.name.trim() : '';
  for (const item of items) counts.set(nameOf(item), (counts.get(nameOf(item)) ?? 0) + 1);
  return Promise.all(items.map(async item => {
    try {
      if (!FORMATS.has(item.format)) return 'Unknown import format.';
      if (item.format === 'lemonlime') return LEMON_CONTEST_ONLY;
      if (problemId) {
        if (item.format === 'polygon-package') return 'Polygon packages create new problems.';
        return TESTSET_NAME_RE.test(item.testset ?? 'tests') ? undefined : 'Invalid target testset name.';
      }
      const name = nameOf(item);
      if (!PROBLEM_NAME_RE.test(name)) return 'Name must be lowercase letters, digits and dashes (up to 64 characters).';
      if (item.title !== undefined && (!item.title || typeof item.title !== 'object' || Object.values(item.title).some(value => typeof value !== 'string'))) return 'Invalid problem title.';
      if (item.timeLimit !== undefined && (!Number.isSafeInteger(item.timeLimit) || item.timeLimit <= 0)) return 'Time limit must be a positive whole number of milliseconds.';
      if (item.memoryLimit !== undefined && (typeof item.memoryLimit !== 'number' || !Number.isFinite(item.memoryLimit) || item.memoryLimit <= 0)) return 'Memory limit must be a positive number of MiB.';
      if (counts.get(name)! > 1) return `Duplicate problem name in this import: ${name}`;
      if (taken.has(name)) return `Problem name already exists: ${name}`;
      const dir = path.join(await libraryParent(registry.requireRoot(item.root), item.folder), name);
      if (await exists(dir)) return `Folder already exists: ${dir}`;
      return undefined;
    } catch (e) { return (e as Error).message; }
  }));
}
