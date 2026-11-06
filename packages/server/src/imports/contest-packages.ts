import type { ContestPackageImportRequest, ContestPackageValidation, LemonContestCandidate } from '@taskweave/shared';
import type { Judge } from '../judge/index.js';
import type { ContestRegistry } from '../workspace/contests.js';
import { HttpError } from '../util/fs.js';
import { importLemonContest, lemonContests, validateLemonContest } from './lemon.js';
import { importPolygonContest, polygonContests } from './polygon-contest.js';

export function contestPackages(files: Map<string, Buffer>): LemonContestCandidate[] {
  const names = [...files.keys()];
  const lemon = names.some(file => /\.cdf$/i.test(file)) ? lemonContests(files).map(contest => ({ ...contest, format: 'lemonlime' as const })) : [];
  const explicitPolygon = names.some(file => /(?:^|\/)contest\.xml$/i.test(file));
  const polygon = explicitPolygon || names.some(file => /(?:^|\/)problem\.xml(?:\.polygon)?$/i.test(file)) ? polygonContests(files) : [];
  // A preserved CDF inside a Polygon contest must not hide its actual manifest.
  if (lemon.length || polygon.length) return explicitPolygon ? [...polygon, ...lemon] : [...lemon, ...polygon];
  return polygonContests(files);
}

export async function validateContestPackage(judge: Judge, contests: ContestRegistry, request: ContestPackageImportRequest): Promise<ContestPackageValidation> {
  const result = await validateLemonContest(judge, contests, request);
  if (request?.format !== undefined && request.format !== 'lemonlime' && request.format !== 'polygon-package') result.errors.push('Unsupported contest package format.');
  return result;
}

export async function importContestPackage(judge: Judge, contests: ContestRegistry, files: Map<string, Buffer>, request: ContestPackageImportRequest) {
  if (!request || typeof request.entry !== 'string') throw new HttpError(400, 'invalid_package', 'Select a contest from the package.');
  if (request?.format !== undefined && request.format !== 'lemonlime' && request.format !== 'polygon-package') throw new HttpError(400, 'invalid_package', 'Unsupported contest package format.');
  const polygon = request?.format === 'polygon-package' || request?.format === undefined && !/\.cdf$/i.test(request?.entry || '');
  return polygon ? importPolygonContest(judge, contests, files, request) : importLemonContest(judge, contests, files, request);
}
