import type { ContestStatement } from '@taskweave/shared';
import { rawUrl } from './api';
import { renderLatex, type MacroTable } from './latex';
import { ENDNOTE } from './cnoiTemplate';

/** Content adapter only. All page, heading, table, code and formula layout is upstream. */
export function cnoiMarkdown(source: string, macros: MacroTable, imageUrl: (name: string) => string, lang = 'zh'): string {
  const root = document.createElement('div');
  root.innerHTML = renderLatex(source, { macros, imageUrl }).html;
  return cnoiHtmlMarkdown(root, lang);
}

function cnoiHtmlMarkdown(root: HTMLElement, lang: string): string {
  if (root.querySelector('.tex-unknown,.tex-error,.katex-error')) throw new Error(lang === 'zh' ? '题面含未支持或错误的 TeX，请先在普通预览中修复后再生成 OI PDF。' : 'Unsupported or invalid TeX. Fix the errors in the regular preview before exporting OI.');
  const block = (s: string) => `\n\n${s.trim()}\n\n`;
  const escape = (s: string) => s.replace(/([\\`*_{}\[\]<>!|#$~])/g, '\\$1');
  const children = (n: Node): string => [...n.childNodes].map(walk).join('');
  const mark = (n: Element | null | undefined) => (n?.textContent ?? '').trim().replace(/[^\p{L}\p{N}\p{S}\p{P}]|["\\]/gu, '');
  function walk(n: Node): string {
    if (n.nodeType === Node.TEXT_NODE) return escape((n.textContent ?? '').replace(/[\t\r\n ]+/g, ' '));
    if (!(n instanceof HTMLElement)) return '';
    // Footnotes stay at the end of their section, as in the CF statements.
    if (n.matches('.footnote-ref')) return ENDNOTE.ref(mark(n));
    if (n.matches('.footnotes')) return block([ENDNOTE.start, ...[...n.children].map(entry => {
      const copy = entry.cloneNode(true) as HTMLElement;
      const sup = copy.querySelector(':scope > sup');
      const symbol = mark(sup);
      sup?.remove();
      return `${ENDNOTE.entry(symbol)}\n\n${children(copy).trim()}`;
    }), ENDNOTE.end].join('\n\n'));
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
  const zh = lang === 'zh';
  /** Empty sections (blank or only comments) are left out; the description is always shown. */
  const section = (label: string, source: string, always = false) => {
    const div = document.createElement('div');
    if (source.trim()) div.innerHTML = renderLatex(source, { macros, imageUrl: n => rawUrl(s.problem, `statement/images/${n}`) }).html;
    if (!always && !div.textContent?.trim() && !div.querySelector('img,table,pre,hr,.katex')) return;
    if (label) { const h = document.createElement('h2'); h.textContent = label; root.append(h); }
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
  const labels: Record<string, string> = zh
    ? { legend: '题目描述', input: '输入格式', output: '输出格式', interaction: '交互', scoring: '评分', constraints: '数据范围', notes: '说明' }
    : { legend: 'Description', input: 'Input', output: 'Output', interaction: 'Interaction', scoring: 'Scoring', constraints: 'Constraints', notes: 'Notes' };
  section(s.statementMode === 'whole' ? '' : labels.legend, s.sections.legend ?? '', true);
  for (const key of ['input', 'output', 'interaction']) section(labels[key], s.sections[key] ?? '');
  s.samples.forEach((sample, i) => {
    const number = sample.number ?? i + 1;
    if (sample.large) {
      const h = document.createElement('h2'); h.textContent = `${zh ? '样例' : 'Sample'} ${number}`;
      const p = document.createElement('p');
      p.append(zh ? `样例 ${number} 见选手目录下的 ` : `Sample ${number}: see `);
      const input = document.createElement('em'); input.textContent = sample.inputFile ?? '';
      const output = document.createElement('em'); output.textContent = sample.outputFile ?? '';
      p.append(input, zh ? ' 与 ' : ' and ', output, zh ? '。' : ' in the contestant directory.');
      root.append(h, p);
    } else {
      for (const [label, value] of [[zh ? '样例输入' : 'Sample input', sample.input], [zh ? '样例输出' : 'Sample output', sample.output]]) {
        const h = document.createElement('h2'); h.textContent = `${label} ${number}`;
        const pre = document.createElement('pre'); pre.textContent = value;
        root.append(h, pre);
      }
    }
    section(zh ? `样例 ${number} 解释` : `Explanation for sample ${number}`, sample.note ?? '');
  });
  // OI order: constraints right before the notes.
  for (const key of ['scoring', 'constraints', 'notes']) section(labels[key], s.sections[key] ?? '');
  return root;
}
