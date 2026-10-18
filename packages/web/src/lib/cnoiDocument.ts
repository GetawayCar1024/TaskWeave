import type { ContestStatement } from '@polyforge/shared';
import { rawUrl } from './api';
import { renderLatex, type MacroTable } from './latex';
let sectionId = 0;

/** Content adapter only. All page, heading, table, code and formula layout is upstream. */
export function cnoiMarkdown(source: string, macros: MacroTable, imageUrl: (name: string) => string, lang = 'zh'): string {
  const root = document.createElement('div');
  root.innerHTML = renderLatex(source, { macros, imageUrl }).html;
  return cnoiHtmlMarkdown(root, lang);
}

function cnoiHtmlMarkdown(root: HTMLElement, lang: string): string {
  if (root.querySelector('.tex-unknown,.tex-error,.katex-error')) throw new Error(lang === 'zh' ? '题面含未支持或错误的 TeX，请先在普通预览中修复后再生成 OI PDF。' : 'Unsupported or invalid TeX. Fix the errors in the regular preview before exporting OI.');
  const block = (s: string) => `\n\n${s.trim()}\n\n`;
  const footnotePrefix = `pf-${++sectionId}-`;
  let footnote = 0;
  let definition = 0;
  const escape = (s: string) => s.replace(/([\\`*_{}\[\]<>!|#$~])/g, '\\$1');
  const children = (n: Node): string => [...n.childNodes].map(walk).join('');
  function walk(n: Node): string {
    if (n.nodeType === Node.TEXT_NODE) return escape((n.textContent ?? '').replace(/[\t\r\n ]+/g, ' '));
    if (!(n instanceof HTMLElement)) return '';
    if (n.matches('.footnote-ref')) return `[^${footnotePrefix}${++footnote}]`;
    if (n.matches('.footnotes')) return block([...n.children].map(entry => {
      const copy = entry.cloneNode(true) as HTMLElement;
      copy.querySelector('sup')?.remove();
      return `[^${footnotePrefix}${++definition}]: ${children(copy).trim().replace(/\n/g, '\n    ')}`;
    }).join('\n\n'));
    if (n.matches('.math-display,.katex-display,.katex')) {
      const tex = n.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
      if (tex) return n.matches('.math-display,.katex-display') ? block(`$$\n${tex}\n$$`) : `$${tex}$`;
    }
    if (n.tagName === 'PRE') {
      const code = n.textContent ?? '';
      const fence = '`'.repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map(m => m[0].length + 1)));
      return block(`${fence}\n${code.replace(/\n$/, '')}\n${fence}`);
    }
    if (n.tagName === 'CODE') {
      const value = n.textContent ?? '';
      const fence = '`'.repeat(Math.max(1, ...[...value.matchAll(/`+/g)].map(m => m[0].length + 1)));
      return `${fence} ${value} ${fence}`;
    }
    if (n.tagName === 'IMG') {
      const attrs: string[] = [];
      for (const dimension of ['width', 'height'] as const) {
        const size = n.style[dimension];
        if (/^[\d.]+px$/.test(size)) attrs.push(`${dimension}=${Number.parseFloat(size) * 0.75}pt`);
        else if (/^[\d.]+(?:%|pt|cm|mm|in|em)$/.test(size)) attrs.push(`${dimension}=${size}`);
      }
      return `![${escape(n.getAttribute('alt') ?? '')}](<${(n as HTMLImageElement).src}>)${attrs.length ? '{' + attrs.join(',') + '}' : ''}`;
    }
    if (n.tagName === 'TABLE') {
      const rows = [...(n as HTMLTableElement).rows];
      if (rows.some(row => [...row.cells].some(c => c.colSpan !== 1 || c.rowSpan !== 1))) throw new Error(lang === 'zh' ? 'OI 导出暂不支持 TeX 合并单元格，请将此表改为普通表格。' : 'OI export does not support merged TeX table cells yet. Use a table without merged cells.');
      const lines = rows.map(row => '| ' + [...row.cells].map(c => children(c).trim().replace(/\n+/g, ' ')).join(' | ') + ' |');
      if (rows.length) lines.splice(1, 0, '| ' + [...rows[0].cells].map(() => '---').join(' | ') + ' |');
      return block(lines.join('\n'));
    }
    if (n.matches('ul,ol')) {
      const start = Number(n.getAttribute('start') ?? 1);
      return block([...n.children].map((li, i) => {
        const marker = n.tagName === 'OL' ? `${start + i}. ` : '- ';
        return marker + children(li).trim().replace(/\n/g, '\n' + ' '.repeat(marker.length));
      }).join('\n'));
    }
    const c = children(n);
    if (/^H[1-6]$/.test(n.tagName)) return block(`${'#'.repeat(Math.max(2, Number(n.tagName[1])))} ${c.trim()}`);
    if (n.matches('strong,b')) return `**${c.trim()}**`;
    if (n.matches('em,i')) return `*${c.trim()}*`;
    if (n.matches('del,s')) return `~~${c.trim()}~~`;
    if (n.tagName === 'BLOCKQUOTE') return block(c.trim().split('\n').map(s => `> ${s}`).join('\n'));
    if (n.tagName === 'HR') return block('---');
    if (n.tagName === 'BR') return '  \n';
    if (n.matches('a[href]')) return `[${c}](<${n.getAttribute('href')}>)`;
    return n.matches('p,div,section') ? block(c) : c;
  }
  return children(root).trim() + '\n';
}

export function cnoiProblemMarkdown(s: ContestStatement, doc: 'statements' | 'tutorials', lang: string, macros: MacroTable) {
  return cnoiHtmlMarkdown(cnoiProblemElement(s, doc, lang, macros), lang);
}

/** Semantic content for both the upstream adapter and the shared Markdown exporter. */
export function cnoiProblemElement(s: ContestStatement, doc: 'statements' | 'tutorials', lang: string, macros: MacroTable): HTMLElement {
  const root = document.createElement('div');
  const section = (label: string, source: string) => {
    if (!source.trim()) return;
    if (label) { const h = document.createElement('h2'); h.textContent = label; root.append(h); }
    const div = document.createElement('div');
    div.innerHTML = renderLatex(source, { macros, imageUrl: n => rawUrl(s.problem, `statement/images/${n}`) }).html;
    // Keep multi-paragraph footnotes in one text column in Markdown HTML too.
    for (const footnote of div.querySelectorAll<HTMLElement>('.footnote')) {
      const body = document.createElement('div');
      for (const child of [...footnote.childNodes].slice(1)) body.append(child);
      for (const paragraph of body.querySelectorAll<HTMLElement>('.p')) paragraph.style.margin = '0 0 0.5em';
      footnote.style.alignItems = 'baseline';
      footnote.append(body);
    }
    root.append(div);
  };
  if (doc === 'tutorials') { section('', s.sections.tutorial ?? ''); return root; }
  if (s.body) { section('', s.body); return root; }
  const labels = lang === 'zh' ? ['题目描述', '输入格式', '输出格式', '交互', '数据范围与约定', '样例解释'] : ['Description', 'Input', 'Output', 'Interaction', 'Constraints', 'Notes'];
  ['legend', 'input', 'output', 'interaction'].forEach((key, i) => section(labels[i], s.sections[key] ?? ''));
  s.samples.forEach((sample, i) => {
    const number = sample.number ?? i + 1;
    if (sample.large) {
      const h = document.createElement('h2'); h.textContent = `${lang === 'zh' ? '样例' : 'Sample'} ${number}`;
      const p = document.createElement('p');
      p.append(lang === 'zh' ? `样例 ${number} 见选手目录下的 ` : `Sample ${number}: see `);
      const input = document.createElement('em'); input.textContent = sample.inputFile ?? '';
      const output = document.createElement('em'); output.textContent = sample.outputFile ?? '';
      p.append(input, lang === 'zh' ? ' 与 ' : ' and ', output, lang === 'zh' ? '。' : ' in the contestant directory.');
      root.append(h, p); return;
    }
    for (const [label, value] of [[lang === 'zh' ? '样例输入' : 'Sample input', sample.input], [lang === 'zh' ? '样例输出' : 'Sample output', sample.output]]) {
      const h = document.createElement('h2'); h.textContent = `${label} ${number}`;
      const pre = document.createElement('pre'); pre.textContent = value;
      root.append(h, pre);
    }
  });
  for (const [key, label] of [['notes', labels[5]], ['scoring', labels[4]]]) section(label, s.sections[key] ?? '');
  return root;
}
