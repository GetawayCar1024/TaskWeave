import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
const root = path.dirname(fileURLToPath(import.meta.url));
const context = { window: {} };
vm.runInNewContext(await readFile(path.join(root, 'marks.js'), 'utf8'), context);
const { svg } = context.window.foldRefinement;
await mkdir(path.join(root, 'icons'), { recursive: true });
for (const kind of ['original', 'refined']) {
  await writeFile(path.join(root, 'icons', `taskweave-d-${kind}-porcelain.svg`), svg(kind, { id: 'taskweave' }) + '\n');
  await writeFile(path.join(root, 'icons', `taskweave-d-${kind}-mark.svg`), svg(kind, { id: 'taskweave', tile: false }) + '\n');
}
console.log('Exported original D and edge-refined D, in Porcelain and transparent SVG.');
