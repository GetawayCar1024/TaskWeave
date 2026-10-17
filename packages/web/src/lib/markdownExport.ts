import { api } from './api';

const htmlEscape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const textSpace = (text: string) => text.replace(/[\t\r\n\f \u00a0]+/g, ' ');
const markdownEscape = (text: string) => text.replace(/&/g, '&amp;').replace(/([\\`*_~\[\]<>!|#$])/g, '\\$1').replace(/^([-+])(?= )/, '\\$1').replace(/^(\d+)([.)])(?= )/, '$1\\$2');
// Blank lines terminate raw HTML blocks in CommonMark, even inside <pre>.
const htmlCode = (text: string) => htmlEscape(text).replace(/\r/g, '&#13;').replace(/\n/g, '&#10;');
const block = (text: string) => text.trim() ? `\n\n${text.trim()}\n\n` : '';
const clean = (text: string) => text.split('\n').map(line => line.replace(/[ \t]+/g, ' ').trim())
  .join('\n').replace(/\n{3,}/g, '\n\n').trim();

interface MarkdownExportOptions {
  contestTitle?: string;
  contentsTable?: HTMLElement;
}

/** Export the preview's document, without UI styles or application-only attributes. */
export function serializeMarkdown(element: HTMLElement, options: MarkdownExportOptions = {}) {
  const headingOffset = options.contestTitle === undefined ? 0 : 1;
  const images: { problem: string; path: string; name: string }[] = [];
  let warnings = 0;
  // Protect literal contents before normalising prose. In particular, blank lines
  // and indentation inside code, samples, TeX and HTML must not be collapsed.
  let prefix = '\uE000PF';
  while ((element.outerHTML + (options.contentsTable?.outerHTML ?? '')).includes(prefix)) prefix += 'P';
  let headingCount = 0;
  const literals: string[] = [];
  const keep = (text: string) => `${prefix}${literals.push(text) - 1}\uE001`;
  const restore = (text: string): string => text.replace(new RegExp(`${prefix}(\\d+)\uE001`, 'g'), (_, i: string) => literals[Number(i)]);
  const children = (node: Node) => [...node.childNodes].map(walk).join('');
  const inlineCode = (text: string) => {
    if (!text || /[\r\n]/.test(text)) return `<code>${htmlCode(text)}</code>`;
    const fence = '`'.repeat(Math.max(1, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1)));
    const pad = /^[` ]|[` ]$/.test(text) && !/^ +$/.test(text) ? ' ' : '';
    return fence + pad + text + pad + fence;
  };
  const codeText = (node: HTMLElement) => {
    const lines = [...node.querySelectorAll('.test-example-line')];
    return lines.length ? lines.map(line => line.textContent ?? '').join('\n') : node.textContent ?? '';
  };
  const mathTex = (node: HTMLElement) => node.dataset.originalTex ?? node.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
  const isMath = (node: HTMLElement) => node.matches('.math-display, .katex-display, .katex');
  const headingId = (node: HTMLElement) => htmlEscape(node.id || `pf-heading-${++headingCount}`);

  function imagePath(node: HTMLImageElement): string | undefined {
    const url = new URL(node.src, location.href);
    const match = url.pathname.match(/^\/api\/problems\/([^/]+)\/raw\/(.+)$/);
    if (!match) { warnings++; return; }
    const problem = decodeURIComponent(match[1]), path = decodeURIComponent(match[2]);
    let asset = images.find(image => image.problem === problem && image.path === path);
    if (!asset) {
      asset = { problem, path, name: `image-${images.length + 1}.${path.split('.').pop()}` };
      images.push(asset);
    }
    return `images/${asset.name}`;
  }

  // Translate semantic preview classes into portable inline styles. Exported
  // HTML should work without loading PolyForge's stylesheet.
  function styles(node: HTMLElement): string {
    const declarations: Record<string, string> = {};
    if (node.matches('.sc')) declarations['text-transform'] = 'uppercase';
    if (node.matches('.sf')) declarations['font-family'] = 'Arial, sans-serif';
    if (node.matches('.epigraph')) Object.assign(declarations, { 'margin-left': '67%', width: '33%' });
    if (node.matches('.epigraph-source')) Object.assign(declarations, { 'text-align': 'right', 'border-top': '1px solid currentColor' });
    if (node.matches('.footnotes')) Object.assign(declarations, { 'font-size': '85%', 'border-top': '1px solid currentColor' });
    if (node.matches('.footnote')) Object.assign(declarations, { display: 'flex', gap: '0.5em' });
    if (node.matches('table.tabular')) declarations['border-collapse'] = 'collapse';
    if (node.matches('td,th') && node.closest('table.tabular')) declarations.padding = '0.15em 0.7em';
    if (node.matches('td,th') && node.closest('table.bordered')) declarations.border = '1px solid currentColor';
    if (node.matches('.stmt-img')) declarations['max-width'] = '95%';
    for (const key of ['text-align', 'font-size', 'font-family', 'font-weight', 'font-style', 'font-variant', 'text-transform', 'text-decoration', 'vertical-align', 'margin-left', 'margin-right', 'width', 'height', 'max-width', 'zoom', 'flex']) {
      const value = node.style.getPropertyValue(key);
      if (value && !/url\s*\(|expression\s*\(|[<>\\]/i.test(value)) declarations[key] = value;
    }
    return Object.entries(declarations).map(([key, value]) => `${key}:${value}`).join(';');
  }

  /** HTML blocks require HTML children: Markdown emphasis inside them is literal. */
  function html(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return htmlEscape(textSpace(node.textContent ?? ''));
    if (!(node instanceof HTMLElement) || node.matches('script,style,iframe,object,button,input')) return '';
    if (isMath(node)) {
      // Native MathML stays renderable even in Markdown engines that do not
      // parse $...$ inside raw HTML tables or aligned paragraphs.
      const math = node.querySelector('math')?.cloneNode(true) as Element | undefined;
      if (math) { math.querySelectorAll('annotation').forEach(n => n.remove()); return math.outerHTML; }
      return htmlEscape(mathTex(node) ?? node.textContent ?? '');
    }
    if (node.matches('.tex-unknown, .tex-error, .katex-error')) warnings++;
    if (node.tagName === 'PRE') return `<pre><code>${htmlCode(codeText(node))}</code></pre>`;
    if (node.tagName === 'CODE') return `<code>${htmlCode(node.textContent ?? '')}</code>`;
    if (node.tagName === 'IMG') {
      const src = imagePath(node as HTMLImageElement);
      const style = styles(node);
      return src ? `<img src="${htmlEscape(src)}" alt="${htmlEscape((node as HTMLImageElement).alt)}"${style ? ` style="${htmlEscape(style)}"` : ''}>` : htmlEscape((node as HTMLImageElement).alt);
    }
    const tag = node.matches('.p') ? 'p' : node.tagName.toLowerCase();
    const supported = /^(div|span|p|b|strong|i|em|u|s|del|sub|sup|small|mark|a|br|hr|blockquote|ul|ol|li|table|thead|tbody|tfoot|tr|th|td|caption|h[1-6])$/.test(tag);
    let content = [...node.childNodes].map(html).join('');
    if (!supported) return content;
    const style = styles(node);
    const attributes: string[] = style ? [`style="${htmlEscape(style)}"`] : [];
    for (const key of ['colspan', 'rowspan', 'start', 'value', 'width', 'height']) {
      const value = node.getAttribute(key);
      if (value && /^\d+$/.test(value)) attributes.push(`${key}="${value}"`);
    }
    if (tag === 'a') {
      const href = node.getAttribute('href') ?? '';
      if (/^(https?:|mailto:|#)/i.test(href)) attributes.push(`href="${htmlEscape(href)}"`);
    }
    if (/^(div|p|blockquote|li|t[dh]|h[1-6])$/.test(tag)) content = content.trim();
    const open = `<${tag}${attributes.length ? ' ' + attributes.join(' ') : ''}>`;
    return /^(br|hr)$/.test(tag) ? open : open + content + `</${tag}>`;
  }

  function walk(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return markdownEscape(textSpace(node.textContent ?? ''));
    if (!(node instanceof HTMLElement) || node.matches('script,style,iframe,object,button,input')) return '';
    if (node.matches('.title')) {
      const level = 1 + headingOffset;
      const id = headingId(node);
      const title = [...node.childNodes].map(html).join('').trim();
      return block(keep(`<h${level} id="${id}" align="center">${title}</h${level}>`));
    }
    if (node.matches('.limits')) {
      const lines = [''];
      for (const child of node.childNodes) {
        if (child instanceof HTMLElement && child.tagName === 'BR') lines.push('');
        else lines[lines.length - 1] += html(child);
      }
      const rows = lines.map(line => line.trim()).filter(Boolean).map(line => `<div>${line}</div>`);
      return rows.length ? block(keep(`<div align="center">\n${rows.join('\n')}\n</div>`)) : '';
    }
    if (isMath(node)) {
      const tex = mathTex(node);
      if (tex) {
        if (node.matches('.math-display, .katex-display')) return block(keep(`$$\n${tex.trim()}\n$$`));
        // Dollar delimiters next to digits or another formula are ambiguous.
        const adjacentMath = [node.previousSibling, node.nextSibling].some(n => n instanceof HTMLElement && isMath(n));
        const digitBoundary = /[\d\\]$/.test(node.previousSibling?.textContent ?? '') || /^\d/.test(node.nextSibling?.textContent ?? '');
        return keep(adjacentMath || digitBoundary ? html(node) : `$${tex.trim()}$`);
      }
    }
    if (node.matches('.tex-unknown, .tex-error, .katex-error')) { warnings++; return keep(inlineCode(node.textContent ?? '')); }
    if (node.tagName === 'PRE') {
      const code = codeText(node);
      const fence = '`'.repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map(m => m[0].length + 1)));
      return block(keep(`${fence}\n${code}${code.endsWith('\n') ? '' : '\n'}${fence}`));
    }
    if (node.tagName === 'CODE') return keep(inlineCode(node.textContent ?? ''));
    if (node.matches('table')) {
      const rows = [...(node as HTMLTableElement).rows];
      const simple = rows.length && rows[0].cells.length
        && rows.every(row => row.cells.length === rows[0].cells.length)
        && [...rows[0].cells].every(c => c.tagName === 'TH')
        && [...node.querySelectorAll('*')].every(child => child.matches('thead,tbody,tfoot,tr,th,td,a,br') && !child.matches('[colspan],[rowspan],[style]'))
        && !styles(node);
      if (!simple) return block(keep(html(node)));
      const cells = rows.map(row => [...row.cells].map(cell => clean(children(cell)).replace(/\n/g, '<br>')));
      return block([cells[0], cells[0].map(() => '---'), ...cells.slice(1)].map(row => '| ' + row.join(' | ') + ' |').join('\n'));
    }
    if (node.matches('u,s,del,sub,sup,small,mark') || styles(node)) {
      const rendered = keep(html(node));
      return node.matches('div,p,blockquote') ? block(rendered) : rendered;
    }
    if (node.tagName === 'IMG') {
      const src = imagePath(node as HTMLImageElement);
      return src ? `![${markdownEscape((node as HTMLImageElement).alt)}](${src})` : markdownEscape((node as HTMLImageElement).alt);
    }
    if (node.matches('ul,ol')) {
      const items = [...node.children].filter(child => child.tagName === 'LI');
      if (node.querySelector('[value],.item-label')) return block(keep(html(node)));
      const start = Number(node.getAttribute('start') ?? 1);
      const list = items.map((item, i) => {
        const marker = node.tagName === 'OL' ? `${start + i}. ` : '- ';
        const content = restore(clean(children(item)));
        return marker + content.replace(/\n/g, '\n' + ' '.repeat(marker.length));
      }).join('\n');
      return block(keep(list));
    }
    if (node.matches('b,strong,i,em')) {
      const text = node.textContent?.trim() ?? '';
      // CommonMark delimiter rules lose adjacent/nested emphasis and emphasis
      // starting with punctuation in Chinese prose. HTML preserves these cases.
      const adjacent = [node.previousSibling, node.nextSibling].some(n => n instanceof HTMLElement && n.matches('b,strong,i,em'));
      if (adjacent || node.children.length || /^[\p{P}\p{S}]|[\p{P}\p{S}]$/u.test(text)) return keep(html(node));
    }
    const content = children(node);
    const level = node.matches('.section-title') ? 2 + headingOffset : node.matches('.sample-title') ? 3 + headingOffset : /^H[1-6]$/.test(node.tagName) ? Math.min(6, Number(node.tagName[1]) + headingOffset) : 0;
    if (level) return block(`<a id="${headingId(node)}"></a>\n\n${'#'.repeat(level)} ${content.trim()}`);
    if (node.tagName === 'BR') return '<br>\n';
    if (node.tagName === 'HR') return block('---');
    if (node.matches('b,strong,i,em')) {
      const marker = node.matches('b,strong') ? '**' : '*';
      return content.trim() ? content.replace(/^(\s*)([\s\S]*?)(\s*)$/, (_, a: string, b: string, c: string) => `${a}${marker}${b}${marker}${c}`) : content;
    }
    if (node.tagName === 'BLOCKQUOTE') return block(keep(restore(clean(content)).split('\n').map(line => '> ' + line).join('\n')));
    if (node.matches('a[href]')) {
      const href = node.getAttribute('href') ?? '';
      return /^(https?:|mailto:|#)/i.test(href) ? `[${content}](<${href.replace(/[\s<>|\\]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()).replace(/&/g, '&amp;')}>)` : content;
    }
    return node.matches('div,article,section,p,header,footer') ? block(content) : content;
  }
  const contestHeading = options.contestTitle === undefined ? '' : `<h1 align="center">${htmlEscape(textSpace(options.contestTitle).trim())}</h1>\n\n`;
  const toc = options.contentsTable ? block(walk(options.contentsTable)) : '';
  const body = restore(clean(toc + walk(element)));
  return { markdown: contestHeading + body + '\n', images, warnings };
}

export async function exportMarkdown(element: HTMLElement, name: string, options: MarkdownExportOptions = {}) {
  const result = serializeMarkdown(element, options);
  await api.exportMarkdown(name, result.markdown, result.images);
  return result.warnings;
}
