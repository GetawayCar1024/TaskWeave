import path from 'node:path';
import { PROBLEM_NAME_RE, TESTSET_NAME_RE, type PackageSelection } from '@taskweave/shared';
import type { ProblemRegistry } from '../workspace/problems.js';
import { libraryParent } from '../workspace/library.js';
import { pathKey } from '../global.js';
import { exists } from '../util/fs.js';
import { LEMON_CONTEST_ONLY } from './lemon.js';

const FORMATS = new Set(['polygon-package', 'hydro-problem', 'lemonlime', 'fps', 'data', 'joi', 'luogu-data', 'hydro-data']);

/**
 * Settings and conflicts of a whole batch, checked before anything is written. Package contents
 * were validated when they were staged; one error rejects the batch. Short names only conflict
 * within the target folder: with existing problems there and with other items going there.
 */
export async function validatePackageSelections(registry: ProblemRegistry, items: PackageSelection[], problemId?: string): Promise<(string | undefined)[]> {
  const folders = problemId ? new Map<string, Map<string, string[]>>() : await registry.namesByFolder();
  const nameOf = (item: PackageSelection) => typeof item.name === 'string' ? item.name.trim() : '';
  const parents = await Promise.all(items.map(async item => {
    if (problemId) return undefined;
    try { return await libraryParent(registry.requireRoot(item.root), item.folder); } catch (e) { return e as Error; }
  }));
  const slot = (i: number) => typeof parents[i] === 'string' ? `${pathKey(parents[i] as string)}\n${nameOf(items[i])}` : '';
  const counts = new Map<string, number>();
  items.forEach((_, i) => { if (slot(i)) counts.set(slot(i), (counts.get(slot(i)) ?? 0) + 1); });
  return Promise.all(items.map(async (item, i) => {
    try {
      if (!FORMATS.has(item.format)) return 'Unknown import format.';
      if (item.format === 'lemonlime') return LEMON_CONTEST_ONLY;
      if (problemId) {
        if (item.format === 'polygon-package') return 'Polygon packages create new problems.';
        return TESTSET_NAME_RE.test(item.testset ?? 'tests') ? undefined : 'Invalid target testset name.';
      }
      const name = nameOf(item), parent = parents[i];
      if (!PROBLEM_NAME_RE.test(name)) return 'Name must be lowercase letters, digits and dashes (up to 64 characters).';
      if (item.title !== undefined && (!item.title || typeof item.title !== 'object' || Object.values(item.title).some(value => typeof value !== 'string'))) return 'Invalid problem title.';
      if (item.timeLimit !== undefined && (!Number.isSafeInteger(item.timeLimit) || item.timeLimit <= 0)) return 'Time limit must be a positive whole number of milliseconds.';
      if (item.memoryLimit !== undefined && (typeof item.memoryLimit !== 'number' || !Number.isFinite(item.memoryLimit) || item.memoryLimit <= 0)) return 'Memory limit must be a positive number of MiB.';
      if (typeof parent !== 'string') return parent?.message ?? 'Choose a library folder.';
      if (counts.get(slot(i))! > 1) return `Duplicate problem name in the same folder: ${name}`;
      if (folders.get(pathKey(parent))?.has(name)) return `Problem name already exists in this folder: ${name}`;
      const dir = path.join(parent, name);
      if (await exists(dir)) return `Folder already exists: ${dir}`;
      return undefined;
    } catch (e) { return (e as Error).message; }
  }));
}
