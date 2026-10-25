import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { ENDNOTE, cnoiFootnotes, cnoiTemplate } from '../../web/src/lib/cnoiTemplate.js';

// Upstream targets a bundler (xxhashjs has CommonJS named imports). Exercise its
// actual compiler through a bundle, as in Vite, instead of changing vendored code.
const bundled = buildSync({ stdin: { contents: 'import getProcessor from "./compiler/getProcessor"; import plugins from "./cnoi/unifiedPlugins"; module.exports = getProcessor(plugins);', resolveDir: fileURLToPath(new URL('../../web/src/vendor/cnoi/', import.meta.url)) }, bundle: true, platform: 'node', format: 'cjs', write: false });
const loaded = { exports: {} as { processSync: (text: string) => { toString(): string } } };
new Function('module', 'exports', 'require', bundled.outputFiles[0].text)(loaded, loaded.exports, createRequire(import.meta.url));

const main = readFileSync(new URL('../../web/src/vendor/cnoi/cnoi/typst/main.typ', import.meta.url), 'utf8');
test('OI English adaptation translates visible template labels and preserves Chinese template', () => {
  const zh = cnoiTemplate(main, 'zh');
  for (const text of ['[题目名称]', '提交源程序文件名', '[第 #(now) 页', 'spacing: 0.7em, leading: 0.7em']) assert.ok(zh.includes(text), text);
  assert.ok(zh.includes('#if data.at("pf_toc", default: true) [\n#align(center)['), 'contents page is optional');
  assert.ok(zh.includes('if data.at("pf_toc", default: true) or i > 0 { pagebreak() }'), 'no blank first page without contents');
  assert.ok(zh.indexOf('#figure(table(') > zh.indexOf('#if data.at("pf_toc"') && zh.indexOf(']\n\n#set table(\n  stroke: (x, y)') > zh.lastIndexOf('编译选项'));
  for (const from of ['#include "extra-precaution.typ"', '#set table(\n  stroke: (x, y)', '  pagebreak()\n']) {
    assert.throws(() => cnoiTemplate(main.replace(/\r\n/g, '\n').replace(from, ''), 'zh'), /CNOI template no longer matches/, 'upstream change is reported');
  }
  assert.throws(() => cnoiTemplate(main.replace('"时间："', '"Time"'), 'en'), /CNOI template no longer matches/);
  const en = cnoiTemplate(main, 'en');
  assert.ok(en.includes('spacing: 0.6em, leading: 0.65em'), 'tighter Latin paragraphs');
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
test('section endnotes: marks become superscripts and the notes a block at the end of the section', () => {
  const markdown = `Body${ENDNOTE.ref('∗')} and **bold**${ENDNOTE.ref('†')}.\n\n${ENDNOTE.start}\n\n${ENDNOTE.entry('∗')}\n\nFirst note.\n\nSecond paragraph with $x$.\n\n${ENDNOTE.entry('†')}\n\nAnother note.\n\n${ENDNOTE.end}\n\n## Next section`;
  const fixed = cnoiFootnotes(loaded.exports.processSync(markdown).toString());
  assert.ok(!/[\uE010-\uE015]/.test(fixed), 'no private-use tokens left');
  assert.ok(!fixed.includes('#footnote'));
  assert.ok(fixed.includes('#"Body"#super("∗")#" and "') && fixed.includes('#super("†")'));
  const block = fixed.indexOf('#block(width: 100%');
  assert.ok(block > fixed.indexOf('#super("†")') && block < fixed.indexOf('Next section'), 'notes stay before the next section');
  assert.ok(fixed.includes('super("∗"), [#par[#"First note."]') && fixed.includes('Second paragraph with') && fixed.includes('super("†"), [#par[#"Another note."]]'));
});
