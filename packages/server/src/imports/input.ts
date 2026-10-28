import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DetectedPackageFormat, ImportPackageFormat } from '@taskweave/shared';
import { HttpError, validateFileName } from '../util/fs.js';
import { readZip, ZipWriter } from '../util/zip.js';
import { CDF_MAGIC } from './cdf.js';

export function xmlRoot(bytes: Buffer): string | undefined {
  return bytes.subarray(0, 32768).toString('utf8').replace(/^\uFEFF/, '')
    .replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE\s[^\[>]*(?:\[[\s\S]*?\]\s*)?>/gi, '').trimStart().match(/^<([\w:-]+)(?:\s|\/?>)/)?.[1]?.toLowerCase();
}
export function readPackageArchive(bytes: Buffer): Map<string, Buffer> {
  if (!Buffer.isBuffer(bytes)) throw new HttpError(400, 'invalid_package', 'Upload a ZIP, FPS XML or LemonLime CDF file.');
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === CDF_MAGIC) return new Map([['contest.cdf', bytes]]);
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50 || bytes.length >= 4 && bytes.readUInt32LE(0) === 0x06054b50) return readZip(bytes);
  if (xmlRoot(bytes) === 'fps') return new Map([['problem.xml', bytes]]);
  try { const value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '').trim()); if (value && Array.isArray(value.tasks)) return new Map([['contest.cdf', bytes]]); } catch { /* ZIP validation below reports invalid input */ }
  return readZip(bytes);
}
export function detectPackageFormat(files: Map<string, Buffer>, requested: ImportPackageFormat = 'auto'): DetectedPackageFormat {
  if (requested !== 'auto') return requested;
  if ([...files.keys()].some(name => /\.cdf$/i.test(name))) return 'lemonlime';
  if ([...files].some(([name, data]) => /\.xml$/i.test(name) && xmlRoot(data) === 'fps')) return 'fps';
  if ([...files].some(([name, data]) => /(?:^|\/)problem\.xml$/i.test(name) && xmlRoot(data) === 'problem')) return 'polygon-package';
  if ([...files.keys()].some(name => /(?:^|\/)problem\.ya?ml$/i.test(name) && [...files.keys()].some(file => file.startsWith(name.slice(0, name.lastIndexOf('/') + 1) + 'testdata/')))) return 'hydro-problem';
  const names = [...files.keys()].map(name => name.toLowerCase());
  if (names.some(name => /(?:^|\/)in\/.+/.test(name) && names.some(other => other.startsWith(name.slice(0, name.lastIndexOf('/in/') + 1) + 'out/')))) return 'joi';
  if (names.some(name => name.startsWith('in/')) && names.some(name => name.startsWith('out/'))) return 'joi';
  return 'data';
}

/** Snapshot an unpacked package so later inspection/import cannot read a moving target. */
export async function directoryPackage(directory: string): Promise<Buffer> {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new HttpError(400, 'bad_path', 'Choose an absolute package directory.');
  const root = await fs.lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new HttpError(400, 'bad_path', 'Choose a regular package directory.');
  const zip = new ZipWriter({ async: true });
  let count = 0, bytes = 0;
  const names = new Set<string>();
  async function walk(base: string, depth: number): Promise<void> {
    if (depth > 64) throw new HttpError(400, 'import_limit', 'Package directory nesting is too deep.');
    for (const entry of (await fs.readdir(path.join(directory, base), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = base ? `${base}/${entry.name}` : entry.name;
      validateFileName(relative);
      if (entry.isSymbolicLink()) throw new HttpError(400, 'bad_path', `Symbolic links are not supported: ${relative}`);
      const key = relative.toLowerCase();
      if (names.has(key)) throw new HttpError(400, 'invalid_package', `Duplicate package path: ${relative}`);
      names.add(key);
      if (++count > 20000) throw new HttpError(400, 'import_limit', 'Too many package entries (maximum 20000).');
      if (entry.isDirectory()) { await walk(relative, depth + 1); continue; }
      if (!entry.isFile()) throw new HttpError(400, 'bad_path', `Not a regular file: ${relative}`);
      const file = path.join(directory, relative), before = await fs.stat(file);
      bytes += before.size;
      if (bytes > 512 * 1024 * 1024) throw new HttpError(400, 'import_limit', 'Package directory exceeds 512 MiB.');
      const data = await fs.readFile(file), after = await fs.stat(file);
      if (data.length !== before.size || after.mtimeMs !== before.mtimeMs || after.size !== before.size) throw new HttpError(409, 'conflict', `File changed during import inspection: ${relative}`);
      zip.add(relative, data);
    }
  }
  await walk('', 0);
  return zip.finishAsync();
}
