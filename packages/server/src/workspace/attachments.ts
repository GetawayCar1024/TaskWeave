import { promises as fsp } from 'node:fs';
import { flattenFiles } from '@polyforge/shared';
import { HttpError, safeJoin } from '../util/fs.js';
import { ZipWriter } from '../util/zip.js';
import { buildTree } from './files.js';

/** Only this dedicated, public folder is included. Tests and solutions stay private. */
export async function addAttachments(zip: Pick<ZipWriter, 'add'>, dir: string, prefix = '') {
  const root = safeJoin(dir, 'attachments');
  if ((await fsp.lstat(root).catch(() => null))?.isSymbolicLink()) throw new HttpError(400, 'bad_path', 'Attachments directory must not be a symbolic link');
  for (const f of flattenFiles(await buildTree(root))) {
    if (f.path.split('/').some(p => p.startsWith('.'))) continue;
    zip.add(prefix + f.path, await fsp.readFile(safeJoin(root, f.path)));
  }
}
