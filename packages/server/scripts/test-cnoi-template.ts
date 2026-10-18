import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { cnoiFootnotes, cnoiTemplate } from '../../web/src/lib/cnoiTemplate.js';

// Upstream targets a bundler (xxhashjs has CommonJS named imports). Exercise its
// actual compiler through a bundle, as in Vite, instead of changing vendored code.
const bundled = buildSync({ stdin: { contents: 'import getProcessor from "./compiler/getProcessor"; import plugins from "./cnoi/unifiedPlugins"; module.exports = getProcessor(plugins);', resolveDir: fileURLToPath(new URL('../../web/src/vendor/cnoi/', import.meta.url)) }, bundle: true, platform: 'node', format: 'cjs', write: false });
const loaded = { exports: {} as { processSync: (text: string) => { toString(): string } } };
new Function('module', 'exports', 'require', bundled.outputFiles[0].text)(loaded, loaded.exports, createRequire(import.meta.url));

const main = readFileSync(new URL('../../web/src/vendor/cnoi/cnoi/typst/main.typ', import.meta.url), 'utf8');
test('OI English adaptation translates visible template labels and preserves Chinese template', () => {
  assert.equal(cnoiTemplate(main, 'zh'), main);
  const en = cnoiTemplate(main, 'en');
  assert.ok(en.includes('[【] + it.body + [】]'), 'English section headings retain the upstream brackets');
  for (const text of ['Time: ', 'Problem type', 'Input file', 'Output file', 'Time limit per test', 'Memory limit', 'Test cases', 'Equal points per test', 'Source file names', 'Compiler options', 'Page #(now) of', '#p.title (#p.name)', 'lang: "en"']) assert.ok(en.includes(text), text);
  for (const text of ['题目名称', '编译选项', '提交源程序文件名', '年{}月', '[第 #(now)', '（#p.name）']) assert.ok(!en.includes(text), text);
  assert.throws(() => cnoiTemplate(main.replace('[题目名称]', '[Changed upstream]'), 'en'), /localization patch/);
});
test('upstream footnote paragraphs have no leading empty line; body and extra paragraphs survive', () => {
  const compiled = loaded.exports.processSync('Body[^a] and another[^b].\n\n[^a]: First paragraph.\n\n    Second paragraph with $x$.\n\n[^b]: Another note.').toString();
  assert.match(compiled, /#footnote\[\n#par\[/);
  const fixed = cnoiFootnotes(compiled);
  assert.equal((fixed.match(/#footnote\[#par\[/g) ?? []).length, 2);
  assert.ok(fixed.includes('Second paragraph with') && fixed.includes('Another note.'));
  assert.equal(cnoiFootnotes(fixed), fixed);
  assert.equal(cnoiFootnotes('#raw("#footnote[\\n")'), '#raw("#footnote[\\n")');
});
