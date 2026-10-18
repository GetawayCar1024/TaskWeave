import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertStatement, lintStatement } from '@polyforge/shared';
import { renderLatex } from '../../web/src/lib/latex.js';
import { GlobalStore } from '../src/global.js';
import { ProblemRegistry } from '../src/workspace/problems.js';
import { ContestRegistry } from '../src/workspace/contests.js';
import { Judge } from '../src/judge/index.js';
import { WsHub } from '../src/ws.js';
import { localItems, pushItem, itemHash } from '../src/polygon/items.js';
import { PolygonSync } from '../src/polygon/sync.js';
import { contestSyncStatus } from '../src/polygon/contestSync.js';
import { contestTex } from '../src/judge/statementTex.js';

const options = { macros: new Map(), imageUrl: (name: string) => '/images/' + name };
test('mixed Markdown and Polygon TeX keep math and native syntax intact', () => {
  const source = '# 标题\n\n**粗体 $a_i$** 与 \\textit{原有格式}。\n\n- 第一项\n- $b_1$\n\n\\begin{center}**居中**\\end{center}';
  const result = convertStatement(source);
  assert.match(result.tex, /\\textbf\{粗体 \$a_i\$\}/);
  assert.match(result.tex, /\\textit\{原有格式\}/);
  assert.match(result.tex, /\\begin\{itemize\}/);
  assert.match(result.tex, /\\begin\{center\}\\textbf\{居中\}\\end\{center\}/);
  const rendered = renderLatex(source, options);
  assert.deepEqual(rendered.unknown, []);
  assert.match(rendered.html, /<h1>标题<\/h1>/);
  assert.match(rendered.html, /<b>粗体 <span class="katex"/);
  assert.match(rendered.html, /<li>/);
});

test('native TeX, comments, formulas and verbatim are not rewritten', () => {
  const source = String.raw`\textbf{原文 $a_b$} \DefLimit[n][10^5]
% **not markdown**
\begin{verbatim}
**literal** $x$ #include <x>
\end{verbatim}
\[a_i * b_i\]
\begin{tabular}{|l|r|}A & B\\ 1 & 2\end{tabular}`;
  assert.equal(convertStatement(source).tex, source);
  assert.equal(convertStatement(source).changed, false);
});

test('fenced and inline code preserve TeX-looking content and blank lines', () => {
  const source = 'Text `a_b $x$ \\textbf{literal}`\n\n```cpp\n  a_b = 1;\n\n\n  // $x$ **not bold**\n```';
  const converted = convertStatement(source);
  assert.ok(converted.tex.includes('  a_b = 1;\n\n\n  // $x$ **not bold**'));
  const rendered = renderLatex(source, options);
  assert.match(rendered.html, /<code>a_b \$x\$ \\textbf\{literal\}<\/code>/);
  assert.deepEqual(rendered.unknown, []);
});

test('quote, strike and rule extensions warn and preserve text in Polygon fallback', () => {
  const source = '**Before**\n\n> quoted **bold** $x$\n>\n> second paragraph\n\n~~old~~\n\n---';
  const preview = convertStatement(source);
  assert.deepEqual(preview.warnings.map(x => x.syntax), ['blockquote', 'strikethrough', 'horizontal-rule']);
  assert.equal(preview.warnings[0].line, 3);
  assert.match(renderLatex(source, options).html, /blockquote class="markdown-quote"/);
  const polygon = convertStatement(source, 'polygon').tex;
  assert.ok(!/pfmd|\\sout|^>/m.test(polygon));
  assert.match(polygon, /quoted \\textbf\{bold\} \$x\$/);
  assert.ok(polygon.includes('second paragraph') && polygon.includes('old'));
  const latex = convertStatement(source, 'latex').tex;
  assert.ok(latex.includes('\\begin{pfmdquote}') && latex.includes('\\sout{old}'));
});

test('tables, links and local images convert to native TeX', () => {
  const source = '| Key | Value |\n| :--- | ---: |\n| **A** | $x_i$ |\n\n[link](https://example.com/a?b=1&c=2#part)\n\n![plot](statement/images/plot.png)';
  const converted = convertStatement(source, 'polygon');
  assert.match(converted.tex, /\\begin\{tabular\}\{\|l\|r\|\}/);
  assert.match(converted.tex, /\\includegraphics\{plot.png\}/);
  const rendered = renderLatex(source, options);
  assert.deepEqual(rendered.unknown, []);
  assert.match(rendered.html, /href="https:\/\/example.com\/a\?b=1&amp;c=2#part"/);
  assert.match(rendered.html, /src="\/images\/plot.png"/);
  for (const markup of ['[link](https://example.com/a%20b?q=x%2Fy)', '<https://example.com/a%20b?q=x%2Fy>', '[link][ref]\n\n[ref]: https://example.com/a%20b?q=x%2Fy']) {
    assert.match(renderLatex(markup, options).html, /href="https:\/\/example.com\/a%20b\?q=x%2Fy"/);
  }
  assert.match(renderLatex('\\textbf{bold} [link](https://example.com)', options).html, /<b>bold<\/b> <a href="https:\/\/example.com"/);
});

test('accepted Markdown is not an automatic source-file rewrite', () => {
  const source = '# Header\n\n**Bold** and `a_b $x$`.\n\n- First\n- Second\n\n```cpp\n  x <= 3;\n\n\n```';
  const result = lintStatement(source, { lang: 'en', allowMarkdown: true });
  assert.ok(!result.issues.some(x => x.rule.startsWith('md-')));
  assert.equal(result.fixed, source);
});

test('ordered lists, Markdown escapes and protected multiline TeX remain stable', () => {
  const source = '3. **three**\n4. four\n\n\\*literal\\*\n\n\\[x_1 +\nx_2\\]\n\n> quoted';
  assert.match(renderLatex(source, options).html, /<ol start="3">/);
  const polygon = convertStatement(source, 'polygon');
  assert.ok(polygon.tex.includes('\\item[3.]') && polygon.tex.includes('\\item[4.]'));
  assert.equal(convertStatement(polygon.tex, 'polygon').tex, polygon.tex);
  assert.equal(polygon.warnings.find(x => x.syntax === 'blockquote')?.line, 9);
  assert.deepEqual(renderLatex(source, options).unknown, []);
});

test('lint preserves TeX examples inside backtick and tilde code fences', () => {
  for (const fence of ['```', '~~~~']) {
    const source = `${fence}tex\n\\begin{itemize}\n\\item **literal**\n\n\n\\end{itemize}\n${fence}`;
    assert.equal(lintStatement(source, { lang: 'en', allowMarkdown: true }).fixed, source);
    const quoted = source.split('\n').map(line => '> ' + line).join('\n');
    assert.equal(lintStatement(quoted, { lang: 'en', allowMarkdown: true }).fixed, quoted);
    assert.ok(convertStatement(quoted).tex.includes('\\item **literal**'));
  }
});

test('sync preview, payload, sync hashes and standalone export share conversion without source writes', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-markup-'));
  try {
    const global = new GlobalStore(home); await global.init();
    global.config.problems.roots = [path.join(home, 'problems')];
    const registry = new ProblemRegistry(global), contests = new ContestRegistry(registry, global);
    const judge = new Judge(global, registry, new WsHub());
    const problem = await registry.create({ name: 'hybrid' });
    const file = path.join(problem.dir, 'statement/zh/legend.tex');
    const source = '**Bold $x$**\n\n> 引用内容\n\n[link](https://example.com)';
    await fs.writeFile(file, source);
    const ctx = await judge.ctx(problem.id);
    const items = await localItems(judge, ctx);
    const item = items.items.find(x => x.path === 'statement/zh/legend.tex')!;
    assert.equal(item.text, convertStatement(source, 'polygon').tex);
    assert.ok(items.warnings.some(x => /unsupported syntax.*blockquote.*legend.tex:3/.test(x)));
    assert.equal(itemHash(item), itemHash({ ...item, text: convertStatement(item.text!, 'polygon').tex }));
    const calls: { method: string; args: any }[] = [];
    await pushItem({ client: { call: async (method: string, args: any) => calls.push({ method, args }) } as any, problemId: 1, warn() {} }, item);
    assert.equal(calls[0].method, 'problem.saveStatement');
    assert.equal(calls[0].args.legend, item.text);
    const sync = new PolygonSync(judge);
    assert.ok((await sync.pushPreview(ctx)).warnings.some(x => x.includes('unsupported syntax')));
    assert.ok((await sync.localStatus(ctx)).warnings.some(x => x.includes('unsupported syntax')));
    const contest = await contests.create({ name: 'hybrid-round', problems: [{ index: 'A', problem: problem.id }] });
    await registry.patch(problem.id, { polygonId: 1 });
    const boundCtx = await judge.ctx(problem.id);
    sync.client = async () => ({ call: async (method: string, args: any) => {
      if (method === 'problems.list') return [{ id: 1, name: 'hybrid', revision: 1 }];
      calls.push({ method, args }); return undefined;
    } }) as any;
    const pushed = await sync.push(boundCtx, { keys: [item.key], commit: false, buildPackage: false }, { signal: new AbortController().signal, progress() {} });
    assert.ok(pushed.warnings.some(w => w.includes('unsupported syntax')));
    assert.equal((await sync.pushPreview(boundCtx)).items.find(x => x.key === item.key)?.status, 'unchanged');
    assert.ok((await contestSyncStatus({ judge, contests, sync }, contest.id)).warnings.some(w => w.startsWith('A · Polygon unsupported syntax')));
    const exported = await contestTex(judge, contests, contest.id, 'zh', 'statements', false, false);
    const tex = exported.data.toString('utf8');
    assert.ok(tex.includes('\\usepackage{hyperref}') && tex.includes('\\newenvironment{pfmdquote}'));
    assert.ok(tex.includes('\\begin{pfmdquote}') && tex.includes('\\textbf{Bold $x$}'));
    assert.equal(await fs.readFile(file, 'utf8'), source);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
