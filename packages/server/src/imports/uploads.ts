import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { HttpError } from '../util/fs.js';
import { directoryPackage, readPackageArchive } from './input.js';

/** Short-lived compressed uploads: inspect once, then reuse for per-item settings and the import. */
export class PackageUploads {
  private entries = new Map<string, { file: string; size: number; expires: number }>();
  private directory: Promise<string>;
  constructor(home: string) {
    const parent = path.join(home, 'cache');
    this.directory = fs.mkdir(parent, { recursive: true }).then(() => fs.mkdtemp(path.join(parent, 'package-import-')));
  }
  /** Keep the bytes only after `inspect` accepted the archive. */
  async stage<T extends object>(bytes: Buffer, inspect: (archive: Map<string, Buffer>) => T): Promise<T & { id: string }> {
    if (!Buffer.isBuffer(bytes)) throw new HttpError(400, 'bad_request', 'Upload a ZIP or FPS XML file.');
    await this.expire();
    if (this.entries.size >= 64 || [...this.entries.values()].reduce((sum, item) => sum + item.size, bytes.length) > 1024 * 1024 * 1024) throw new HttpError(400, 'import_limit', 'Import or close existing selections before adding more archives (1 GiB per session).');
    const value = inspect(readPackageArchive(bytes));
    const directory = await this.directory;
    // Cache maintenance or a temporary-directory cleaner may remove an idle empty folder.
    await fs.mkdir(directory, { recursive: true });
    const id = randomBytes(16).toString('hex'), file = path.join(directory, `${id}.zip`);
    await fs.writeFile(file, bytes, { flag: 'wx' });
    this.entries.set(id, { file, size: bytes.length, expires: Date.now() + 60 * 60 * 1000 });
    return { ...value, id };
  }
  async stageDirectory<T extends object>(directory: string, inspect: (archive: Map<string, Buffer>) => T) { return this.stage(await directoryPackage(directory), inspect); }
  async read(id: unknown) {
    const item = typeof id === 'string' ? this.entries.get(id) : undefined;
    if (!item || item.expires < Date.now()) throw new HttpError(410, 'import_expired', 'The import selection expired. Select the ZIP again.');
    item.expires = Date.now() + 60 * 60 * 1000;
    const bytes = await fs.readFile(item.file).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      this.entries.delete(id as string);
      throw new HttpError(410, 'import_expired', 'The import selection expired. Select the ZIP again.');
    });
    return readPackageArchive(bytes);
  }
  async discard(id: string) {
    const entry = this.entries.get(id); if (!entry) return;
    this.entries.delete(id); await fs.rm(entry.file, { force: true });
  }
  private async expire() { await Promise.all([...this.entries].filter(([, item]) => item.expires < Date.now()).map(([id]) => this.discard(id))); }
  async dispose() { this.entries.clear(); await fs.rm(await this.directory, { recursive: true, force: true }); }
}
