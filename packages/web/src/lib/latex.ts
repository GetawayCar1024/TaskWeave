import { codeHtml } from './codeHighlight';
import katex from 'katex';
import { convertStatement } from '@polyforge/shared';

/**
 * Renderer for the LaTeX subset used by Polygon statements (DESIGN §4.6). Produces
 * HTML; math goes to KaTeX, `\DefXxx` macros from defs.toml are expanded textually,
 * and unknown commands are highlighted instead of silently dropped (a light lint).
 */

export interface Macro {
  name: string;
  /** One entry per argument; the value is its default ('' = required). */
  args: string[];
  body: string;
}

export type MacroTable = Map<string, Macro>;

interface DefsCommand {
  name: string;
  args?: string[];
  body?: string;
}
export type DefsToml = Record<string, { command?: DefsCommand[] }>;

/** Tables used for a statement language: its own, then English, then common. */
const DEFS_TABLES: Record<string, string[]> = {
  en: ['english', 'common'],
  zh: ['chinese', 'english', 'common'],
  ru: ['russian', 'english', 'common'],
};

export function buildMacros(defs: DefsToml | null, lang: string): MacroTable {
  const map: MacroTable = new Map();
  if (!defs) return map;
  for (const table of DEFS_TABLES[lang] ?? ['english', 'common']) {
    for (const c of defs[table]?.command ?? []) {
      if (c.name && !map.has(c.name)) map.set(c.name, { name: c.name, args: c.args ?? [], body: (c.body ?? '').replace(/^\n|\n$/g, '') });
    }
  }
  return map;
}

export interface RenderOptions {
  macros: MacroTable;
  /** Resolve `\includegraphics{name}` to a URL. */
  imageUrl: (name: string) => string;
}

export interface RenderResult {
  html: string;
  /** Commands the renderer did not recognise. */
  unknown: string[];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Markers used while rendering; replaced when paragraphs/lists/tables are assembled.
const PAR = '\u0000P\u0000';
const ITEM = '\u0000I\u0000';
const CELL = '\u0000C\u0000';
const ROW = '\u0000R\u0000';
const HLINE = '\u0000H\u0000';

const ONE_ARG: Record<string, [string, string]> = {
  textbf: ['<b>', '</b>'],
  textit: ['<i>', '</i>'],
  emph: ['<em>', '</em>'],
  textsl: ['<i>', '</i>'],
  underline: ['<u>', '</u>'],
  t: ['<code>', '</code>'],
  texttt: ['<code>', '</code>'],
  textsc: ['<span class="sc">', '</span>'],
  textsf: ['<span class="sf">', '</span>'],
  textrm: ['<span>', '</span>'],
  textup: ['<span>', '</span>'],
  textnormal: ['<span>', '</span>'],
  textsuperscript: ['<sup>', '</sup>'],
  textsubscript: ['<sub>', '</sub>'],
  sout: ['<s>', '</s>'],
  mbox: ['<span>', '</span>'],
};

const SWITCH: Record<string, [string, string]> = {
  bf: ['<b>', '</b>'],
  bfseries: ['<b>', '</b>'],
  it: ['<i>', '</i>'],
  itshape: ['<i>', '</i>'],
  em: ['<em>', '</em>'],
  tt: ['<code>', '</code>'],
  ttfamily: ['<code>', '</code>'],
  sc: ['<span class="sc">', '</span>'],
  tiny: ['<span style="font-size:.6em">', '</span>'],
  scriptsize: ['<span style="font-size:.7em">', '</span>'],
  footnotesize: ['<span style="font-size:.8em">', '</span>'],
  small: ['<span style="font-size:.9em">', '</span>'],
  normalsize: ['<span>', '</span>'],
  large: ['<span style="font-size:1.2em">', '</span>'],
  Large: ['<span style="font-size:1.44em">', '</span>'],
  LARGE: ['<span style="font-size:1.73em">', '</span>'],
  huge: ['<span style="font-size:2.07em">', '</span>'],
  Huge: ['<span style="font-size:2.49em">', '</span>'],
};

const SYMBOLS: Record<string, string> = {
  ldots: '…',
  dots: '…',
  le: '≤',
  leq: '≤',
  ge: '≥',
  geq: '≥',
  ne: '≠',
  times: '×',
  cdot: '·',
  textbackslash: '\\',
  textasciitilde: '~',
  textasciicircum: '^',
  textbar: '|',
  textasciigrave: '`',
  textquotesingle: "'",
  textless: '&lt;',
  textgreater: '&gt;',
  textendash: '–',
  textemdash: '—',
  textquotedblleft: '“',
  textquotedblright: '”',
  copyright: '©',
  S: '§',
  LaTeX: 'L<sup style="font-size:.75em;margin-left:-.3em">A</sup>T<sub style="margin-left:-.15em">E</sub>X',
  TeX: 'T<sub style="margin-left:-.15em">E</sub>X',
  quad: '&emsp;',
  qquad: '&emsp;&emsp;',
  enspace: '&ensp;',
  newline: '<br>',
  linebreak: '<br>',
  hfill: '<span style="flex:1"></span>',
};

/** Commands that are accepted and ignored, with the number of `{}` arguments to skip. */
const IGNORED: Record<string, number> = {
  noindent: 0,
  indent: 0,
  bigskip: 0,
  medskip: 0,
  smallskip: 0,
  centering: 0,
  raggedright: 0,
  raggedleft: 0,
  clearpage: 0,
  newpage: 0,
  vspace: 1,
  'vspace*': 1,
  hspace: 1,
  'hspace*': 1,
  label: 1,
  vfill: 0,
  protect: 0,
  InputFile: 0,
  OutputFile: 0,
  Examples: 0,
  Note: 0,
  Interaction: 0,
};

const ESCAPABLE = '%$&#_{}~^ ';

class Parser {
  private pos = 0;
  private expansions = 0;
  footnotes: string[] = [];
  unknown = new Set<string>();

  constructor(
    private src: string,
    private opts: RenderOptions,
  ) {}

  private peek(o = 0) {
    return this.src[this.pos + o];
  }
  private eof() {
    return this.pos >= this.src.length;
  }

  private skipSpaces() {
    while (!this.eof() && /[ \t]/.test(this.peek())) this.pos++;
  }

  /** Read `{...}` raw (balanced), or null if the next token is not a group. */
  private readGroupRaw(allowNewline = true): string | null {
    const save = this.pos;
    while (!this.eof() && (this.peek() === ' ' || this.peek() === '\t' || (allowNewline && this.peek() === '\n' && this.peek(1) !== '\n'))) this.pos++;
    if (this.peek() !== '{') {
      this.pos = save;
      return null;
    }
    let depth = 0;
    const start = this.pos + 1;
    for (; !this.eof(); this.pos++) {
      const c = this.peek();
      if (c === '\\') {
        this.pos++;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        const s = this.src.slice(start, this.pos);
        this.pos++;
        return s;
      }
    }
    return this.src.slice(start);
  }

  private readOptRaw(): string | null {
    const save = this.pos;
    this.skipSpaces();
    if (this.peek() !== '[') {
      this.pos = save;
      return null;
    }
    const end = this.src.indexOf(']', this.pos);
    if (end < 0) return null;
    const s = this.src.slice(this.pos + 1, end);
    this.pos = end + 1;
    return s;
  }

  /** `[...]` with nested brackets and braces (e.g. `[a[i] + \{x\}]`), or null. */
  private readBracketRaw(): string | null {
    const save = this.pos;
    this.skipSpaces();
    if (this.peek() !== '[') {
      this.pos = save;
      return null;
    }
    const start = this.pos + 1;
    let depth = 0;
    let braces = 0;
    for (; !this.eof(); this.pos++) {
      const c = this.peek();
      if (c === '\\') {
        this.pos++;
        continue;
      }
      if (c === '{') braces++;
      else if (c === '}') braces--;
      else if (braces === 0 && c === '[') depth++;
      else if (braces === 0 && c === ']' && --depth === 0) {
        const s = this.src.slice(start, this.pos);
        this.pos++;
        return s;
      }
    }
    this.pos = save;
    return null;
  }

  private readCommandName(): string {
    const m = this.src.slice(this.pos).match(/^([A-Za-z@]+\*?|.)/s);
    const name = m ? m[1] : '';
    this.pos += name.length;
    return name;
  }

  /** Render a nested piece of source with the same macros and footnote list. */
  private sub(s: string): string {
    const p = new Parser(s, this.opts);
    p.footnotes = this.footnotes;
    p.unknown = this.unknown;
    p.expansions = this.expansions;
    const html = p.parse(() => false);
    this.expansions = p.expansions;
    return html;
  }

  private math(tex: string, display: boolean): string {
    try {
      return katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: 'ignore', output: 'htmlAndMathml' });
    } catch (e) {
      return `<span class="tex-error" title="${esc((e as Error).message)}">${esc(tex)}</span>`;
    }
  }

  private readUntil(close: string): string {
    const end = this.src.indexOf(close, this.pos);
    const s = end < 0 ? this.src.slice(this.pos) : this.src.slice(this.pos, end);
    this.pos = end < 0 ? this.src.length : end + close.length;
    return s;
  }

  /** Inline math `$...$`, honouring `\$`. */
  private readInlineMath(): string {
    let s = '';
    while (!this.eof()) {
      const c = this.peek();
      if (c === '\\' && this.peek(1) !== undefined) {
        s += c + this.peek(1);
        this.pos += 2;
      } else if (c === '$') {
        this.pos++;
        return s;
      } else {
        s += c;
        this.pos++;
      }
    }
    return s;
  }

  parse(stop: () => boolean): string {
    let out = '';
    while (!this.eof() && !stop()) {
      const c = this.peek();
      if (c === '}') {
        // Groups stop via `stop()` before their brace; anything reaching here is stray.
        this.pos++;
        continue;
      }
      if (c === '%') {
        this.readUntil('\n');
        while (/[ \t]/.test(this.peek() ?? '')) this.pos++;
      } else if (c === '\\') {
        out += this.command(stop);
      } else if (c === '$') {
        if (this.peek(1) === '$') {
          this.pos += 2;
          out += `<div class="math-display">${this.math(this.readUntil('$$'), true)}</div>`;
        } else {
          this.pos++;
          out += this.math(this.readInlineMath(), false);
        }
      } else if (c === '{') {
        this.pos++;
        out += this.parse(() => this.peek() === '}');
        if (this.peek() === '}') this.pos++;
      } else if (c === '~') {
        this.pos++;
        out += '&nbsp;';
      } else if (c === '-') {
        if (this.src.startsWith('---', this.pos)) (out += '—'), (this.pos += 3);
        else if (this.src.startsWith('--', this.pos)) (out += '–'), (this.pos += 2);
        else (out += '-'), this.pos++;
      } else if (c === '`') {
        if (this.peek(1) === '`') (out += '“'), (this.pos += 2);
        else (out += '‘'), this.pos++;
      } else if (c === "'" && this.peek(1) === "'") {
        out += '”';
        this.pos += 2;
      } else if (c === '<' && this.peek(1) === '<') {
        out += '«';
        this.pos += 2;
      } else if (c === '>' && this.peek(1) === '>') {
        out += '»';
        this.pos += 2;
      } else if (c === '\n') {
        let j = this.pos + 1;
        while (j < this.src.length && /[ \t\r]/.test(this.src[j])) j++;
        if (this.src[j] === '\n') {
          while (j < this.src.length && /\s/.test(this.src[j])) j++;
          out += PAR;
          this.pos = j;
        } else {
          out += ' ';
          this.pos++;
        }
      } else if (c === '&') {
        out += CELL;
        this.pos++;
      } else if (c === '\r') {
        this.pos++;
      } else {
        out += esc(c);
        this.pos++;
      }
    }
    return out;
  }

  private command(stop: () => boolean): string {
    this.pos++; // backslash
    const name = this.readCommandName();
    if (name === '\\') {
      this.readOptRaw();
      return ROW;
    }
    if (name.length === 1 && ESCAPABLE.includes(name)) return name === ' ' ? ' ' : esc(name);
    if (name === ',' || name === ';' || name === ':') return '&thinsp;';
    if (name === '-' || name === '/') return '';
    if (name === '(') return this.math(this.readUntil('\\)'), false);
    if (name === '[') return `<div class="math-display">${this.math(this.readUntil('\\]'), true)}</div>`;
    if (name === 'item') {
      const label = this.readOptRaw();
      return ITEM + (label !== null ? `<span class="item-label">${this.sub(label)}</span> ` : '');
    }
    if (name === 'hline') return HLINE;
    if (name === 'par') return PAR;

    const macro = this.opts.macros.get(name);
    if (macro) return this.expand(macro);

    if (ONE_ARG[name]) {
      const arg = this.readGroupRaw();
      const [a, b] = ONE_ARG[name];
      return arg === null ? '' : a + this.sub(arg) + b;
    }
    if (SWITCH[name]) {
      const [a, b] = SWITCH[name];
      // Applies to the rest of the enclosing group.
      return a + this.parse(() => stop() || this.peek() === '}') + b;
    }
    if (SYMBOLS[name] !== undefined) {
      if (/^[A-Za-z]/.test(name) && this.peek() === ' ') this.pos++;
      if (this.src.startsWith('{}', this.pos)) this.pos += 2;
      return SYMBOLS[name];
    }
    if (IGNORED[name] !== undefined) {
      for (let i = 0; i < IGNORED[name]; i++) this.readGroupRaw();
      return '';
    }
    switch (name) {
      case 'section': case 'section*':
      case 'subsection': case 'subsection*':
      case 'subsubsection': case 'subsubsection*': {
        const level = name.startsWith('subsub') ? 3 : name.startsWith('sub') ? 2 : 1;
        this.readOptRaw();
        const body = this.readGroupRaw() ?? '';
        return `${PAR}<h${level}>${this.sub(body)}</h${level}>${PAR}`;
      }
      case 'pfmdheading': {
        const level = Math.max(1, Math.min(6, Number(this.readGroupRaw()) || 1));
        const body = this.readGroupRaw() ?? '';
        return `${PAR}<h${level}>${this.sub(body)}</h${level}>${PAR}`;
      }
      case 'pfmdrule':
        this.readGroupRaw();
        return `${PAR}<hr>${PAR}`;
      case 'footnote': {
        const arg = this.readGroupRaw() ?? '';
        this.footnotes.push(this.sub(arg));
        const n = this.footnotes.length;
        return `<sup class="footnote-ref">${fnSymbol(n)}</sup>`;
      }
      case 'url': {
        const u = this.readGroupRaw() ?? '';
        return `<a href="${esc(safeUrl(u))}" target="_blank" rel="noreferrer">${esc(u)}</a>`;
      }
      case 'href': {
        const u = (this.readGroupRaw() ?? '').replace(/\\([%#&_{}])/g, '$1');
        const text = this.readGroupRaw() ?? u;
        return `<a href="${esc(u.startsWith('file://') ? this.opts.imageUrl(u.slice(7)) : safeUrl(u))}" target="_blank" rel="noreferrer">${this.sub(text)}</a>`;
      }
      case 'includegraphics': {
        const opt = this.readOptRaw() ?? '';
        const file = (this.readGroupRaw() ?? '').trim();
        return `<img class="stmt-img" src="${esc(this.opts.imageUrl(file))}" alt="${esc(file)}" style="${esc(imageStyle(opt))}">`;
      }
      case 'epigraph': {
        const text = this.readGroupRaw() ?? '';
        const who = this.readGroupRaw() ?? '';
        // As Polygon renders it: text, then the source under a rule, in the right third.
        return `<div class="epigraph"><div class="epigraph-text">${this.sub(text)}</div><div class="epigraph-source">${this.sub(who)}</div></div>`;
      }
      case 'exmp':
      case 'exmpfile': {
        const a = this.readGroupRaw() ?? '';
        const b = this.readGroupRaw() ?? '';
        return sampleHtml(a, b, 'Input', 'Output');
      }
      case 'begin':
        return this.environment((this.readGroupRaw() ?? '').trim());
      case 'end':
        this.readGroupRaw();
        return '';
    }
    this.unknown.add(name);
    return `<span class="tex-unknown" title="Unknown command">\\${esc(name)}</span>`;
  }

  private expand(m: Macro): string {
    if (++this.expansions > 500) return `<span class="tex-error">macro expansion limit</span>`;
    // Codeforces-style defs: arguments with defaults are optional `[...]` arguments,
    // e.g. \DefLimitSum[r - l + 1][10^6]; `{...}` is accepted as well.
    const vals = m.args.map((def) => this.readBracketRaw() ?? this.readGroupRaw() ?? def);
    const body = m.body.replace(/#(\d)/g, (_, d: string) => vals[Number(d) - 1] ?? '');
    // Textual substitution, as TeX does: the expansion is parsed in place.
    this.src = this.src.slice(0, this.pos) + body + this.src.slice(this.pos);
    return '';
  }

  /** Content up to the matching \end{name}, raw. */
  private envBodyRaw(name: string): string {
    const re = new RegExp(`\\\\(begin|end)\\s*\\{${name.replace(/[*]/g, '\\*')}\\}`, 'g');
    re.lastIndex = this.pos;
    let depth = 1;
    for (let m; (m = re.exec(this.src)); ) {
      depth += m[1] === 'begin' ? 1 : -1;
      if (depth === 0) {
        const body = this.src.slice(this.pos, m.index);
        this.pos = m.index + m[0].length;
        return body;
      }
    }
    const body = this.src.slice(this.pos);
    this.pos = this.src.length;
    return body;
  }

  private environment(name: string): string {
    switch (name) {
      case 'itemize':
      case 'enumerate':
      case 'pfmdenumerate': {
        const start = name === 'pfmdenumerate' ? Number(this.readGroupRaw()) || 1 : 1;
        const html = this.sub(this.envBodyRaw(name));
        const items = html.split(ITEM).slice(1).map((s) => `<li>${paragraphs(s)}</li>`);
        const tag = name === 'itemize' ? 'ul' : 'ol';
        return `${PAR}<${tag}${start !== 1 ? ` start="${start}"` : ''}>${items.join('')}</${tag}>${PAR}`;
      }
      case 'center':
      case 'flushleft':
      case 'flushright': {
        const align = name === 'center' ? 'center' : name === 'flushleft' ? 'left' : 'right';
        return `${PAR}<div style="text-align:${align}">${paragraphs(this.sub(this.envBodyRaw(name)))}</div>${PAR}`;
      }
      case 'quote':
      case 'quotation':
        return `${PAR}<blockquote>${paragraphs(this.sub(this.envBodyRaw(name)))}</blockquote>${PAR}`;
      case 'pfmdquote':
        return `${PAR}<blockquote class="markdown-quote">${paragraphs(this.sub(this.envBodyRaw(name)))}</blockquote>${PAR}`;
      case 'verbatim':
      case 'lstlisting': {
        let body = this.envBodyRaw(name);
        if (name === 'lstlisting') body = body.replace(/^\[[^\]]*\]/, '');
        return `${PAR}<pre class="verbatim">${codeHtml(body.replace(/^\n/, ''))}</pre>${PAR}`;
      }
      case 'tabular': {
        const spec = this.readGroupRaw() ?? '';
        return `${PAR}${tableHtml(this.sub(this.envBodyRaw(name)), spec)}${PAR}`;
      }
      case 'equation':
      case 'equation*':
      case 'displaymath':
        return `<div class="math-display">${this.math(this.envBodyRaw(name), true)}</div>`;
      case 'align':
      case 'align*':
      case 'gather':
      case 'gather*':
      case 'eqnarray':
      case 'eqnarray*': {
        const inner = name.startsWith('eqnarray') ? 'align*' : name.endsWith('*') ? name : `${name}*`;
        return `<div class="math-display">${this.math(`\\begin{${inner}}${this.envBodyRaw(name)}\\end{${inner}}`, true)}</div>`;
      }
      case 'example':
        return `${PAR}<div class="examples">${this.sub(this.envBodyRaw(name))}</div>${PAR}`;
      default:
        this.unknown.add(`begin{${name}}`);
        return `<span class="tex-unknown">\\begin{${esc(name)}}</span>${this.sub(this.envBodyRaw(name))}<span class="tex-unknown">\\end{${esc(name)}}</span>`;
    }
  }
}

function safeUrl(u: string): string {
  return /^(https?:|mailto:)/i.test(u.trim()) ? u.trim() : '#';
}

function imageStyle(opt: string): string {
  const w = opt.match(/width\s*=\s*([\d.]+)\s*(\\textwidth|\\linewidth|cm|mm|pt|px|in|em)?/);
  if (w) {
    const v = Number(w[1]);
    const unit = w[2] ?? 'px';
    if (unit.startsWith('\\')) return `width:${v * 100}%`;
    const px = { cm: 37.8, mm: 3.78, pt: 1.333, px: 1, in: 96, em: 16 }[unit] ?? 1;
    return `width:${Math.round(v * px)}px`;
  }
  const s = opt.match(/scale\s*=\s*([\d.]+)/);
  return s ? `zoom:${Number(s[1])}` : '';
}

function tableHtml(body: string, spec: string): string {
  const bordered = spec.includes('|');
  const aligns = [...spec.replace(/\{[^}]*\}/g, '').replace(/[|@\s]/g, '')].map((c) => (c === 'c' ? 'center' : c === 'r' ? 'right' : 'left'));
  const rows = body
    .split(ROW)
    .map((r) => r.replace(new RegExp(HLINE, 'g'), '').trim())
    .filter((r) => r !== '' && r !== PAR);
  const tr = rows.map(
    (r) => `<tr>${r.split(CELL).map((cell, i) => `<td style="text-align:${aligns[i] ?? 'left'}">${cell.replace(new RegExp(PAR, 'g'), ' ').trim()}</td>`).join('')}</tr>`,
  );
  return `<table class="tabular${bordered ? ' bordered' : ''}"><tbody>${tr.join('')}</tbody></table>`;
}

/** Split on paragraph markers; drop leftover structural markers. */
function paragraphs(html: string): string {
  const cleaned = html.replace(new RegExp(`${ROW}`, 'g'), '<br>').replace(new RegExp(`${CELL}|${HLINE}|${ITEM}`, 'g'), '');
  return cleaned
    .split(PAR)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (/^<(ul|ol|div|pre|table|blockquote|h[1-6]|hr)/.test(p) ? p : `<div class="p">${p}</div>`))
    .join('');
}

/**
 * A sample as input / output boxes. With `inputCases` (test case of each input line,
 * from the validator's test markup) lines are tagged per test case as on Codeforces:
 * alternating shades, and hovering a case highlights it in both boxes. Output lines
 * are matched when their count is a multiple of the number of cases.
 */
export function sampleHtml(input: string, output: string, inLabel: string, outLabel: string, inputCases?: number[]): string {
  const split = (s: string) => s.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const inLines = split(input);
  const cases = inputCases?.length ? Math.max(...inputCases) : 0;
  const outLines = split(output);
  const outCases =
    cases > 0 && outLines.length % cases === 0 && outLines.length >= cases ? outLines.map((_, i) => Math.floor(i / (outLines.length / cases)) + 1) : undefined;
  const lines = (ls: string[], of?: number[]) =>
    of
      ? ls
          .map((l, i) => {
            const c = of[i] ?? 0;
            const text = esc(l) || ' ';
            // Cases 1, 3, 5, … are shaded (Codeforces class name), so the line with t and
            // the first case differ.
            return c > 0 ? `<div class="test-example-line${c % 2 ? ' test-example-line-even' : ''}" data-case="${c}">${text}</div>` : `<div class="test-example-line">${text}</div>`;
          })
          .join('')
      : esc(ls.join('\n'));
  // Only multi-test inputs with a line for t (a line before the first case) are marked.
  const marked = cases > 0 && inLines.length === inputCases!.length && inputCases![0] === 0;
  return (
    `<div class="sample"><div class="sample-part"><div class="sample-title">${esc(inLabel)}</div><pre>${lines(inLines, marked ? inputCases : undefined)}</pre></div>` +
    `<div class="sample-part"><div class="sample-title">${esc(outLabel)}</div><pre>${lines(outLines, marked ? outCases : undefined)}</pre></div></div>`
  );
}

/** Footnote marks as LaTeX \fnsymbol and Codeforces statements: ∗ † ‡ § ¶ ‖, then doubled. */
const FN_SYMBOLS = ['∗', '†', '‡', '§', '¶', '‖'];
function fnSymbol(n: number): string {
  const s = FN_SYMBOLS[(n - 1) % FN_SYMBOLS.length];
  return s.repeat(Math.floor((n - 1) / FN_SYMBOLS.length) + 1);
}

export function renderLatex(src: string, opts: RenderOptions): RenderResult {
  const p = new Parser(convertStatement(src).tex, opts);
  let html = paragraphs(p.parse(() => false));
  if (p.footnotes.length) {
    html += `<div class="footnotes">${p.footnotes.map((f, i) => `<div class="footnote"><sup>${fnSymbol(i + 1)}</sup>${paragraphs(f)}</div>`).join('')}</div>`;
  }
  return { html, unknown: [...p.unknown] };
}

/** Plain-text preview of a macro with default arguments, for editor hovers. */
export function macroPreview(m: Macro): string {
  return m.body.replace(/#(\d)/g, (_, d: string) => m.args[Number(d) - 1] || `#${d}`);
}
