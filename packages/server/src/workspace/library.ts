import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CONTEST_FILE, type CreateLibraryFolderRequest, type LibraryDirectory, type LibraryLocation } from '@taskweave/shared';
import { HttpError, exists, safeJoin, toPosix, validateFileName } from '../util/fs.js';
import type { ProblemRegistry } from './problems.js';
import type { GlobalStore } from '../global.js';
import { samePath } from '../global.js';

const hidden = (name: string) => name.startsWith('.') || name === 'node_modules';
const workspace = async (dir: string) => await exists(path.join(dir, 'problem.toml')) || await exists(path.join(dir, CONTEST_FILE));
export const parentFolder = (root: string, dir: string) => toPosix(path.relative(root, path.dirname(dir)));

/** Containers are plain directories; traversal stops at a problem/contest boundary. */
export async function workspaceDirectories(root: string, marker: string): Promise<{ dir: string; root: string; name: string }[]> {
  const found: { dir: string; root: string; name: string }[] = [];
  async function scan(dir: string, depth: number) {
    if (depth > 64) return;
    for (const entry of (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || hidden(entry.name)) continue;
      const child = path.join(dir, entry.name);
      if (await exists(path.join(child, marker))) found.push({ dir: child, root, name: entry.name });
      else if (!await workspace(child)) await scan(child, depth + 1);
    }
  }
  await scan(root, 0); return found;
}

export async function libraryParent(root: string, folder = ''): Promise<string> {
  if (typeof folder !== 'string') throw new HttpError(400, 'bad_path', 'Invalid library folder.');
  if (folder) validateFileName(folder);
  let dir = root;
  for (const part of folder.replace(/\\/g, '/').split('/').filter(Boolean)) {
    if (hidden(part) || await workspace(dir)) throw new HttpError(400, 'bad_path', 'Choose a library folder outside problem and contest workspaces.');
    dir = safeJoin(dir, part);
    const stat = await fs.lstat(dir).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new HttpError(400, 'bad_path', 'Library folder does not exist or is linked.');
  }
  if (await workspace(dir)) throw new HttpError(400, 'bad_path', 'Choose a library folder outside problem and contest workspaces.');
  return dir;
}

export class LibraryFolders {
  constructor(private problems: ProblemRegistry, private global: GlobalStore) {}
  private root(location: LibraryLocation) {
    if (location.kind === 'problems') return this.problems.requireRoot(location.root);
    if (location.kind !== 'contests') throw new HttpError(400, 'bad_request', 'Choose problems or contests.');
    if (location.root && !samePath(location.root, this.global.contestsDir)) throw new HttpError(400, 'invalid_root', 'Unknown contest root.');
    return this.global.contestsDir;
  }
  async list(location: LibraryLocation): Promise<LibraryDirectory> {
    const root = this.root(location), folder = location.folder ?? '', dir = await libraryParent(root, folder);
    const folders: LibraryDirectory['folders'] = [];
    const scan = async (dir: string, folder: string, depth = 0) => {
      if (depth > 64) return;
      for (const entry of (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
        if (hidden(entry.name) || !entry.isDirectory() || entry.isSymbolicLink() || await workspace(path.join(dir, entry.name))) continue;
        const relative = folder ? `${folder}/${entry.name}` : entry.name;
        folders.push({ name: entry.name, path: relative });
        if (location.recursive) await scan(path.join(dir, entry.name), relative, depth + 1);
      }
    };
    await scan(dir, folder);
    return { kind: location.kind, root, folder, folders };
  }
  async create(request: CreateLibraryFolderRequest) {
    const name = request.name?.trim();
    if (!name || /[\\/]/.test(name) || hidden(name)) throw new HttpError(400, 'invalid_name', 'Enter one visible folder name.');
    validateFileName(name);
    const root = this.root(request); await fs.mkdir(root, { recursive: true });
    const parent = await libraryParent(root, request.folder);
    const dir = path.join(parent, name);
    try { await fs.mkdir(dir); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new HttpError(409, 'exists', `Folder already exists: ${dir}`); throw e; }
    return this.list(request);
  }
}
