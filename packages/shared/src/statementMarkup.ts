import MarkdownIt from 'markdown-it';

export type StatementTarget = 'preview' | 'polygon' | 'latex';
export interface StatementSyntaxWarning { line: number; syntax: string }
export interface StatementConversion { tex: string; changed: boolean; warnings: StatementSyntaxWarning[] }

// HTML is deliberately text, not executable markup. TeX and math are protected
// before CommonMark parsing so underscores, braces and backslashes keep meaning.
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
type Token = ReturnType<typeof markdown.parse>[number];
const literalEnvironments = new Set(['verbatim', 'lstlisting', 'equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'displaymath', 'eqnarray', 'eqnarray*']);
const textCommands = new Set(['textbf', 'textit', 'emph', 'textsl', 'underline', 'textsc', 'textsf', 'textrm', 'textup', 'textnormal', 'mbox', 'footnote']);
const escapeText = (s: string) => s.replace(/[\\{}&%$#_^~`']/g, c => ({ '\\': '\\textbackslash{}', '^': '\\textasciicircum{}', '~': '\\textasciitilde{}', '`': '\\textasciigrave{}', "'": '\\textquotesingle{}' })[c] ?? `\\${c}`);

function groupEnd(src: string, start: number, open = '{', close = '}'): number {
  if (src[start] !== open) return start;
  let depth = 1;
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === '\\') i++;
    else if (src[i] === open) depth++;
    else if (src[i] === close && --depth === 0) return i + 1;
  }
  return start;
}

/** In-memory conversion shared by preview, sync hashes/payloads and TeX exports. */
export function convertStatement(source: string, target: StatementTarget = 'preview'): StatementConversion {
  const warnings: StatementSyntaxWarning[] = [];
  let changed = false;
  function convert(src: string, baseLine: number, inline = false, depth = 0): string {
    if (depth > 32) return src;
    let localChanged = false;
    let prefix = '\uE100PF';
    while (src.includes(prefix)) prefix += 'P';
    const values: string[] = [];
    const lineOrigins = [baseLine];
    let line = baseLine, shielded = '';
    const append = (text: string, original = text) => {
      const originalLines = original.split('\n').length - 1;
      let n = 0;
      for (const c of text) if (c === '\n') lineOrigins.push(line + Math.min(++n, originalLines));
      line += originalLines;
      shielded += text;
    };
    const protect = (raw: string, value = raw) => {
      append(`${prefix}${values.push(value) - 1}\uE101`, raw);
      if (raw !== value) localChanged = true;
    };
    const restore = (text: string) => text.replace(new RegExp(`${prefix}(\\d+)\uE101`, 'g'), (_, n: string) => values[Number(n)]);

    for (let i = 0; i < src.length;) {
      const rest = src.slice(i);
      // Protect Markdown code from the TeX scanner; let CommonMark parse fences.
      const opening = (i === 0 || src[i - 1] === '\n') && rest.match(/^[ \t>]*(?:[-+*] |\d+[.)] )?(`{3,}|~{3,})[^\n]*(?:\n|$)/);
      if (opening) {
        const end = new RegExp(`^[ \\t>]*${opening[1][0]}{${opening[1].length},}[ \\t]*(?:\\n|$)`, 'gm');
        end.lastIndex = i + opening[0].length;
        const closing = end.exec(src);
        const stop = closing ? closing.index + closing[0].length : src.length;
        append(src.slice(i, stop)); i = stop; continue;
      }
      if (src[i] === '`') {
        const ticks = rest.match(/^`+/)![0];
        const closing = src.indexOf(ticks, i + ticks.length);
        if (closing >= 0) { append(src.slice(i, closing + ticks.length)); i = closing + ticks.length; continue; }
      }
      // URL percent escapes are not TeX comments. Keep destinations untouched;
      // labels still go through the TeX/math protection above and below.
      if (rest.startsWith('](')) {
        const end = groupEnd(src, i + 1, '(', ')');
        if (end > i + 1) { append(src.slice(i, end)); i = end; continue; }
      }
      const autolink = rest.match(/^<(?:https?:\/\/|mailto:)[^<>\n]+>/i);
      if (autolink) { append(autolink[0]); i += autolink[0].length; continue; }
      const reference = (i === 0 || src[i - 1] === '\n') && rest.match(/^ {0,3}\[[^\]\n]+\]:[^\n]*/);
      if (reference) { append(reference[0]); i += reference[0].length; continue; }
      if (src[i] === '%') {
        const end = src.indexOf('\n', i);
        const stop = end < 0 ? src.length : end;
        protect(src.slice(i, stop)); i = stop; continue;
      }
      const delimiter = rest.startsWith('$$') ? '$$' : src[i] === '$' ? '$' : rest.startsWith('\\(') ? '\\)' : rest.startsWith('\\[') ? '\\]' : '';
      if (delimiter) {
        const size = delimiter.length;
        let j = i + size;
        while (j < src.length && !src.startsWith(delimiter, j)) {
          if (src[j] === '\\') j += 2; else j++;
        }
        if (j < src.length) { protect(src.slice(i, j + size)); i = j + size; continue; }
      }
      const env = rest.match(/^\\begin\{([a-zA-Z*]+)\}/);
      if (env) {
        const end = new RegExp(`\\\\(begin|end)\\{${env[1].replace('*', '\\*')}\\}`, 'g');
        end.lastIndex = i + env[0].length;
        let nesting = 1, match: RegExpExecArray | null;
        while ((match = end.exec(src))) {
          nesting += match[1] === 'begin' ? 1 : -1;
          if (!nesting) break;
        }
        if (match) {
          const raw = src.slice(i, end.lastIndex), body = src.slice(i + env[0].length, match.index);
          protect(raw, literalEnvironments.has(env[1]) ? raw : env[0] + convert(body, line, false, depth + 1) + match[0]);
          i = end.lastIndex; continue;
        }
      }
      const command = rest.match(/^\\(?:[a-zA-Z]+\*?|[^\r\n])/);
      if (command) {
        if (/^\\[*!|>`]$/.test(command[0])) {
          const literal: Record<string, string> = { '*': '\\mbox{*}', '!': '\\mbox{!}', '|': '\\textbar{}', '>': '\\textgreater{}', '`': '\\textasciigrave{}' };
          protect(command[0], literal[command[0][1]]); i += 2; continue;
        }
        let end = i + command[0].length;
        const name = command[0].slice(1);
        // \verb uses a delimiter, not braces.
        if (/^verb\*?$/.test(name) && src[end]) {
          const close = src.indexOf(src[end], end + 1);
          if (close >= 0) end = close + 1;
        }
        let first = -1, required = 0;
        const arity = textCommands.has(name) || ['t', 'texttt', 'url', 'includegraphics'].includes(name) ? 1 : ['href', 'epigraph', 'exmp', 'exmpfile'].includes(name) ? 2 : Infinity;
        for (;;) {
          if (required >= arity) break;
          const start = end + (src.slice(end).match(/^[ \t]*/)?.[0].length ?? 0);
          const stop = groupEnd(src, start, src[start] === '[' ? '[' : '{', src[start] === '[' ? ']' : '}');
          if (stop === start) break;
          if (first < 0 && src[start] === '{') first = start;
          if (src[start] === '{') required++;
          end = stop;
        }
        const raw = src.slice(i, end);
        if (first >= 0 && textCommands.has(name)) {
          const stop = groupEnd(src, first);
          protect(raw, src.slice(i, first + 1) + convert(src.slice(first + 1, stop - 1), line, true, depth + 1) + src.slice(stop - 1, end));
        } else protect(raw);
        i = end; continue;
      }
      append(src[i]); i++;
    }

    const warn = (syntax: string, at: number) => {
      const originalLine = lineOrigins[at] ?? baseLine;
      if (!warnings.some(w => w.line === originalLine && w.syntax === syntax)) warnings.push({ line: originalLine, syntax });
    };
    const mark = () => { localChanged = true; };
    const tokens = inline ? markdown.parseInline(shielded, {}) : markdown.parse(shielded, {});
    function render(list: Token[], at = 0): string {
      let out = '';
      const lists: { name: string; next: number; explicit: boolean }[] = [];
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        if (t.map) at = t.map[0];
        const children = () => render(t.children ?? [], at);
        switch (t.type) {
          case 'inline': out += children(); break;
          case 'text': out += t.content.replace(/[&#_]/g, c => `\\${c}`); break;
          case 'softbreak': out += '\n'; break;
          case 'hardbreak': mark(); out += '\\newline\n'; break;
          case 'paragraph_open': break;
          case 'paragraph_close': out += '\n\n'; break;
          case 'strong_open': mark(); out += '\\textbf{'; break;
          case 'em_open': mark(); out += '\\emph{'; break;
          case 'strong_close': case 'em_close': out += '}'; break;
          case 's_open': mark(); warn('strikethrough', at); out += target === 'polygon' ? '' : '\\sout{'; break;
          case 's_close': out += target === 'polygon' ? '' : '}'; break;
          case 'heading_open': {
            mark(); const level = Number(t.tag[1]);
            const body = render(list[++i].children ?? [], at); i++;
            out += target === 'preview' ? `\\pfmdheading{${level}}{${body}}\n\n` : target === 'latex' ? `\\${['section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph', 'subparagraph'][level - 1]}*{${body}}\n\n` : `\\textbf{${body}}\\par\n\n`;
            break;
          }
          case 'code_inline': mark(); out += `\\texttt{${escapeText(t.content)}}`; break;
          case 'fence': case 'code_block': {
            mark();
            const body = t.content;
            out += body.includes('\\end{verbatim}') ? `\\texttt{${escapeText(body).replace(/\n/g, '\\newline\n')}}\n\n` : `\\begin{verbatim}\n${body}${body.endsWith('\n') ? '' : '\n'}\\end{verbatim}\n\n`;
            break;
          }
          case 'bullet_list_open': case 'ordered_list_open': {
            mark(); const start = Number(t.attrGet('start') ?? 1);
            const ordered = t.type === 'ordered_list_open';
            const name = !ordered ? 'itemize' : start !== 1 && target === 'preview' ? 'pfmdenumerate' : 'enumerate';
            lists.push({ name, next: start, explicit: ordered && start !== 1 && target !== 'preview' });
            out += `\\begin{${name}}${name === 'pfmdenumerate' ? `{${start}}` : ''}\n`; break;
          }
          case 'bullet_list_close': case 'ordered_list_close': out += `\\end{${lists.pop()!.name}}\n\n`; break;
          case 'list_item_open': {
            const parent = lists.at(-1);
            out += parent?.explicit ? `\\item[${parent.next++}.] ` : '\\item '; break;
          }
          case 'list_item_close': out = out.trimEnd() + '\n'; break;
          case 'blockquote_open': mark(); warn('blockquote', at); out += target === 'polygon' ? '\n\n' : '\\begin{pfmdquote}\n'; break;
          case 'blockquote_close': out += target === 'polygon' ? '\n\n' : '\\end{pfmdquote}\n\n'; break;
          case 'hr': mark(); warn('horizontal-rule', at); out += target === 'polygon' ? '\\par\n\n' : '\\pfmdrule{}\n\n'; break;
          case 'link_open': mark(); out += `\\href{${restore(String(t.attrGet('href') ?? '')).replace(/[{}%#]/g, c => `\\${c}`)}}{`; break;
          case 'link_close': out += '}'; break;
          case 'image': {
            mark(); const file = restore(String(t.attrGet('src') ?? ''));
            if (/^(?:https?:|data:|\/)/i.test(file) || /[{}\\]/.test(file)) { warn('external-image', at); out += escapeText(t.content) + ` (${escapeText(file)})`; }
            else out += `\\includegraphics{${file.replace(/^statement\/images\//, '')}}`;
            break;
          }
          case 'table_open': {
            mark(); const cells: Token[] = [];
            for (let j = i + 1; j < list.length && list[j].type !== 'tr_close'; j++) if (list[j].type === 'th_open') cells.push(list[j]);
            const align = cells.map(c => String(c.attrGet('style')).includes('center') ? 'c' : String(c.attrGet('style')).includes('right') ? 'r' : 'l');
            out += `\\begin{tabular}{|${align.join('|')}|}\n\\hline\n`; break;
          }
          case 'table_close': out += '\\end{tabular}\n\n'; break;
          case 'thead_open': case 'thead_close': case 'tbody_open': case 'tbody_close': case 'tr_open': break;
          case 'tr_close': out += ' \\\\\n\\hline\n'; break;
          case 'th_open': out += '\\textbf{'; break;
          case 'th_close': out += '}' + (list[i + 1]?.type === 'th_open' ? ' & ' : ''); break;
          case 'td_open': break;
          case 'td_close': if (list[i + 1]?.type === 'td_open') out += ' & '; break;
          default: out += children() || escapeText(t.content);
        }
      }
      return out;
    }
    const rendered = restore(render(tokens));
    changed ||= localChanged;
    return localChanged ? rendered.trimEnd() : src;
  }
  const tex = convert(source.replace(/\r\n/g, '\n'), 1);
  return { tex, changed, warnings };
}

/** Standalone LaTeX only; these extensions are never sent to Polygon. */
export const STATEMENT_LATEX_PREAMBLE = [
  '\\usepackage{hyperref}',
  '\\usepackage[normalem]{ulem}',
  '\\usepackage{framed,xcolor}',
  '\\newenvironment{pfmdquote}{\\begin{leftbar}}{\\end{leftbar}}',
  '\\newcommand{\\pfmdrule}{\\par\\noindent\\rule{\\linewidth}{0.4pt}\\par}',
];

export function statementSyntaxWarnings(path: string, warnings: StatementSyntaxWarning[]): string[] {
  return warnings.map(w => `Polygon unsupported syntax: ${w.syntax} (${path}:${w.line}); exported as plain content where necessary`);
}
