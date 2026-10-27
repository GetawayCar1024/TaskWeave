/** Browser previews and standalone SVGs share the same path data and renderer. */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
const root = path.dirname(fileURLToPath(import.meta.url));
const context = { window: {} };
vm.runInNewContext(await readFile(path.join(root, 'marks.js'), 'utf8'), context);
const { marks, svg } = context.window.taskweaveStudies;
await mkdir(path.join(root, 'icons'), { recursive: true });
for (const mark of marks) {
  const name = `taskweave-${mark.id.toLowerCase()}-${mark.key}`;
  await writeFile(path.join(root, 'icons', `${name}-porcelain.svg`), svg(mark, { id: 'taskweave' }) + '\n');
  await writeFile(path.join(root, 'icons', `${name}-mark.svg`), svg(mark, { id: 'taskweave', tile: false }) + '\n');
}
console.log(`Exported ${marks.length} Porcelain studies and ${marks.length} transparent marks.`);
