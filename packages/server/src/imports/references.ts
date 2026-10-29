import path from 'node:path';
import { HttpError, validateFileName } from '../util/fs.js';

/** Resolve only unambiguous package-local references and report every repaired spelling. */
export class PackageReferences {
  private full = new Map<string, string[]>();
  private basenames = new Map<string, string[]>();
  private folders = new Set<string>();
  private notes: Set<string>;
  /** `scoped`: a reference into an existing top-level folder is only repaired inside that folder (one contest, many task folders). */
  constructor(private files: Map<string, Buffer>, private warnings: string[], private scoped = false) {
    this.notes = new Set(warnings);
    for (const name of files.keys()) {
      for (const [map, key] of [[this.full, name.toLowerCase()], [this.basenames, path.posix.basename(name).toLowerCase()]] as const) map.set(key, [...(map.get(key) ?? []), name]);
      if (name.includes('/')) this.folders.add(name.slice(0, name.indexOf('/') + 1).toLowerCase());
    }
  }
  private byBasename(reference: string, basenames: string[]) {
    const found = basenames.flatMap(name => this.basenames.get(name) ?? []);
    const folder = reference.includes('/') ? reference.slice(0, reference.indexOf('/') + 1).toLowerCase() : '';
    return this.scoped && folder && this.folders.has(folder) ? found.filter(name => name.toLowerCase().startsWith(folder)) : found;
  }
  find(value: string, answer = false): string | undefined {
    const normalized = value.replace(/\\/g, '/').split('/').filter(part => part !== '.').join('/');
    validateFileName(normalized);
    if (this.files.has(normalized)) {
      if (normalized !== value) this.note(value, normalized);
      return normalized;
    }
    const variants = new Set([normalized.toLowerCase()]);
    if (answer && /\.(ans|out)$/i.test(normalized)) {
      variants.add(normalized.replace(/\.(ans|out)$/i, '.ans').toLowerCase());
      variants.add(normalized.replace(/\.(ans|out)$/i, '.out').toLowerCase());
    }
    let candidates = this.full.get(normalized.toLowerCase()) ?? [];
    if (!candidates.length) candidates = [...variants].flatMap(name => this.full.get(name) ?? []);
    if (!candidates.length) candidates = this.byBasename(normalized, [path.posix.basename(normalized).toLowerCase()]);
    if (!candidates.length) candidates = this.byBasename(normalized, [...new Set([...variants].map(name => path.posix.basename(name)))]);
    if (candidates.length > 1) throw new HttpError(400, 'ambiguous_package_reference', `Ambiguous file reference ${value}: ${candidates.join(', ')}. Correct the package configuration.`);
    if (!candidates.length) return undefined;
    this.note(value, candidates[0]); return candidates[0];
  }
  require(value: string, answer = false): string {
    const found = this.find(value, answer);
    if (!found) throw new HttpError(400, 'missing_package_reference', `Missing file referenced by configuration: ${value}. Restore the file or correct the reference.`);
    return found;
  }
  private note(from: string, to: string) {
    const note = `Package reference corrected: ${from} -> ${to}`;
    if (!this.notes.has(note)) { this.notes.add(note); this.warnings.push(note); }
  }
}
