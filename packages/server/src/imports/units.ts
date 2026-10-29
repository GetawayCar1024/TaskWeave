import type { DetectedPackageFormat, ImportPackageFormat, PackageCandidate, PackageItem } from '@taskweave/shared';
import { HttpError } from '../util/fs.js';
import { detectPackageFormat, xmlRoot } from './input.js';
import { inspectPackage } from './packages.js';
import { LEMON_CONTEST_ONLY } from './lemon.js';

/** A problem directory, or one FPS file, inside an upload. `key` is stable for the same archive. */
export interface PackageUnit { key: string; scope: string; file?: string; format: DetectedPackageFormat }

const folderOf = (file: string) => file.slice(0, file.lastIndexOf('/') + 1);
const natural = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
/** Same-directory descriptors: the first format wins. */
const PRIORITY: DetectedPackageFormat[] = ['lemonlime', 'polygon-package', 'hydro-problem', 'joi'];

/**
 * Detect every package unit independently. An outer descriptor owns everything below it,
 * outermost data folders become data units, and files outside all units stay shared context
 * (for example a README that Polygon and Hydro imports preserve under other/<format>/archive).
 */
export function packageUnits(files: Map<string, Buffer>) {
  const names = [...files.keys()];
  const structured = new Map<string, DetectedPackageFormat>();
  const add = (scope: string, format: DetectedPackageFormat) => {
    const current = structured.get(scope);
    if (!current || PRIORITY.indexOf(format) < PRIORITY.indexOf(current)) structured.set(scope, format);
  };
  const outputs = new Set(names.flatMap(name => { const match = /^(.*\/)?out\/.+$/i.exec(name); return match ? [(match[1] ?? '').toLowerCase()] : []; }));
  for (const name of names) {
    const base = name.slice(name.lastIndexOf('/') + 1).toLowerCase(), scope = folderOf(name);
    if (base.endsWith('.cdf')) add(scope, 'lemonlime');
    else if (base === 'problem.xml.polygon' || base === 'problem.xml' && xmlRoot(files.get(name)!) === 'problem') add(scope, 'polygon-package');
    else if (/^problem\.ya?ml$/.test(base) && names.some(other => other.startsWith(scope + 'testdata/'))) add(scope, 'hydro-problem');
    const joi = /^(.*\/)?in\/.+$/i.exec(name);
    if (joi && outputs.has((joi[1] ?? '').toLowerCase())) add(joi[1] ?? '', 'joi');
  }
  const units: PackageUnit[] = [];
  for (const [scope, format] of [...structured].sort(([a], [b]) => a.length - b.length || natural(a, b))) {
    if (!units.some(unit => scope.startsWith(unit.scope))) units.push({ key: scope, scope, format });
  }
  const owner = new Map<string, PackageUnit>();
  for (const name of names) {
    const unit = units.find(unit => name.startsWith(unit.scope));
    if (unit) owner.set(name, unit);
  }
  for (const name of names) {
    if (owner.has(name) || !/\.xml$/i.test(name) || xmlRoot(files.get(name)!) !== 'fps') continue;
    const unit: PackageUnit = { key: name, scope: folderOf(name), file: name, format: 'fps' };
    units.push(unit); owner.set(name, unit);
  }
  const roots = [...new Set(names.filter(name => !owner.has(name) && /\.in$/i.test(name)).map(folderOf))];
  for (const scope of roots.filter(root => !roots.some(other => other !== root && root.startsWith(other)))) {
    const unit: PackageUnit = { key: scope, scope, format: 'data' };
    units.push(unit);
    for (const name of names) if (!owner.has(name) && name.startsWith(scope)) owner.set(name, unit);
  }
  units.sort((a, b) => natural(a.key, b.key));
  if (!units.length) units.push({ key: '', scope: '', format: detectPackageFormat(files) });
  return {
    list: units,
    find: (key: string) => units.find(unit => unit.key === key) ?? (key === '' ? { key: '', scope: '', format: detectPackageFormat(files) } : undefined),
    /** The unit's own files plus shared context; another unit's files are never visible. */
    files(key: string): Map<string, Buffer> {
      const unit = units.find(unit => unit.key === key);
      if (!unit) { if (key === '') return files; throw new HttpError(409, 'import_changed', 'The selected archive changed. Select it again.'); }
      return new Map([...files].filter(([name]) => { const current = owner.get(name); return !current || current === unit; }));
    },
  };
}

/** Validated problems of one unit, using its detected format unless another one is requested. */
export function unitItems(files: Map<string, Buffer>, unit: PackageUnit, requested: ImportPackageFormat = 'auto'): PackageItem[] {
  const format = requested === 'auto' ? unit.format : requested, entry = unit.file ?? unit.scope;
  const item = (candidate: PackageCandidate): PackageItem => ({ ...candidate, unit: unit.key, format });
  if (format === 'lemonlime') return [item({ entry, name: 'imported-problem', title: '', error: LEMON_CONTEST_ONLY })];
  let candidates: PackageCandidate[];
  try { candidates = inspectPackage(files, { format }).filter(candidate => candidate.entry.startsWith(entry)); }
  catch (e) { return [item({ entry, name: 'imported-problem', title: '', error: (e as Error).message })]; }
  return candidates.length ? candidates.map(item) : [item({ entry, name: 'imported-problem', title: '', error: 'No importable problem in this package directory.' })];
}

export function packageItems(files: Map<string, Buffer>, format: ImportPackageFormat = 'auto'): PackageItem[] {
  if (!files.size) return [{ unit: '', format: 'data', entry: '', name: 'imported-problem', title: '', error: 'The ZIP archive contains no files.' }];
  if (format !== 'auto') return unitItems(files, { key: '', scope: '', format }, format);
  const units = packageUnits(files);
  return units.list.flatMap(unit => unitItems(units.files(unit.key), unit));
}

export function inspectUnit(files: Map<string, Buffer>, key: unknown, format: unknown): PackageItem[] {
  if (typeof key !== 'string' || typeof format !== 'string') throw new HttpError(400, 'bad_request', 'Choose a package unit and format.');
  const units = packageUnits(files), unit = units.find(key);
  if (!unit) throw new HttpError(409, 'import_changed', 'The selected archive changed. Select it again.');
  return unitItems(units.files(key), unit, format as ImportPackageFormat);
}
