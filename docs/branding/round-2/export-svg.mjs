/** Regenerate standalone SVG drafts from the same paths used in the comparison page. */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
const root = path.dirname(fileURLToPath(import.meta.url));
const context = { window: {} };
vm.runInNewContext(await readFile(path.join(root, 'marks.js'), 'utf8'), context);
const { marks, palettes } = context.window.brandRoundTwo;
await mkdir(path.join(root, 'icons'), { recursive: true });
for (const mark of marks) {
  const color = palettes.indigo;
  const paths = mark.paths.replaceAll('var(--mark)', color.mark).replaceAll('var(--accent)', color.accent);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-labelledby="title">
  <title id="title">CaseWeave / ${mark.id} — ${mark.title}</title>
  <defs><linearGradient id="tile" x1="0" y1="0" x2=".3" y2="1"><stop stop-color="${color.top}"/><stop offset="1" stop-color="${color.bottom}"/></linearGradient></defs>
  <rect x="8" y="8" width="240" height="240" rx="55" fill="url(#tile)"/>
  <rect x="8.5" y="8.5" width="239" height="239" rx="54.5" fill="none" stroke="${color.outline}" stroke-opacity=".55"/>
  ${paths}
</svg>
`;
  await writeFile(path.join(root, 'icons', `${mark.id.toLowerCase()}-${mark.key}.svg`), svg);
}
console.log(`Exported ${marks.length} SVG icon studies.`);
