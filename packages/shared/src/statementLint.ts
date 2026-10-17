/**
 * Lint and auto-fix for Polygon LaTeX statements (DESIGN §4.6 "自动修改"): Markdown
 * that sneaked in, operators written as ASCII, exponents without braces, spacing
 * between Chinese text and formulas, straight quotes, … Math, verbatim blocks and
 * comments are recognised so that each rule only touches the right kind of text.
 */

export interface LintIssue {
  line: number;
  col: number;
  rule: string;
  message: string;
  /** The fix is part of `fixed`. */
  fixable: boolean;
}

export interface LintResult {
  issues: LintIssue[];
  fixed: string;
  changed: boolean;
}

type SegKind = 'text' | 'math' | 'verbatim' | 'comment';
interface Seg {
  kind: SegKind;
  start: number;
  text: string;
}

const MATH_ENVS = ['equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'displaymath', 'eqnarray', 'eqnarray*'];
const VERBATIM_ENVS = ['verbatim', 'lstlisting'];

/** Split a statement into text / math / verbatim / comment segments. */
function segment(src: string, issues: LintIssue[], pos: (o: number) => { line: number; col: number }): Seg[] {
  const segs: Seg[] = [];
  let i = 0;
  let textStart = 0;
  const flush = (end: number) => {
    if (end > textStart) segs.push({ kind: 'text', start: textStart, text: src.slice(textStart, end) });
  };
  const push = (kind: SegKind, start: number, end: number) => {
    flush(start);
    segs.push({ kind, start, text: src.slice(start, end) });
    i = end;
    textStart = end;
  };
  while (i < src.length) {
    const c = src[i];
    if ((i === 0 || src[i - 1] === '\n') && /^[ \t]*`{3,}/.test(src.slice(i))) {
      const opening = src.slice(i).match(/^[ \t]*(`{3,})[^\n]*\n/);
      if (opening) {
        const close = new RegExp('^[ \\t]*`{' + opening[1].length + ',}[ \\t]*(?:\\n|$)', 'gm');
        close.lastIndex = i + opening[0].length;
        const ending = close.exec(src);
        issues.push({ ...pos(i), rule: 'md-code-block', message: ending ? 'Markdown code fence → verbatim' : 'Code fence is not closed', fixable: !!ending });
        push('verbatim', i, ending ? ending.index + ending[0].length : src.length);
        continue;
      }
    }
    if (c === '\\') {
      const env = src.slice(i).match(/^\\begin\{([^}]+)\}/);
      if (env && (VERBATIM_ENVS.includes(env[1]) || MATH_ENVS.includes(env[1]))) {
        const endTag = `\\end{${env[1]}}`;
        const e = src.indexOf(endTag, i + env[0].length);
        const stop = e < 0 ? src.length : e + endTag.length;
        push(VERBATIM_ENVS.includes(env[1]) ? 'verbatim' : 'math', i, stop);
        continue;
      }
      if (src[i + 1] === '(' || src[i + 1] === '[') {
        const close = src[i + 1] === '(' ? '\\)' : '\\]';
        const e = src.indexOf(close, i + 2);
        push('math', i, e < 0 ? src.length : e + 2);
        continue;
      }
      i += 2; // escaped character or command start
      continue;
    }
    if (c === '%') {
      const e = src.indexOf('\n', i);
      push('comment', i, e < 0 ? src.length : e);
      continue;
    }
    if (c === '$') {
      const display = src[i + 1] === '$';
      let j = i + (display ? 2 : 1);
      while (j < src.length) {
        if (src[j] === '\\') j += 2;
        else if (src[j] === '$') break;
        else if (!display && src[j] === '\n' && src[j + 1] === '\n') break;
        else j++;
      }
      const closed = display ? src.startsWith('$$', j) : src[j] === '$';
      if (!closed) {
        issues.push({ ...pos(i), rule: 'unclosed-math', message: 'Formula opened with $ is never closed', fixable: false });
        i++;
        continue;
      }
      push('math', i, j + (display ? 2 : 1));
      continue;
    }
    i++;
  }
  flush(src.length);
  return segs;
}

interface Rule {
  id: string;
  message: string;
  re: RegExp;
  replace: (m: RegExpExecArray) => string;
}

const OPS: Record<string, string> = { '<=': '\\le', '>=': '\\ge', '!=': '\\ne', '≤': '\\le', '≥': '\\ge', '≠': '\\ne', '×': '\\times', '·': '\\cdot' };

const TEXT_RULES: Rule[] = [
  { id: 'md-bold', message: 'Markdown **bold** → \\textbf{}', re: /\*\*([^*\n]+?)\*\*/g, replace: (m) => `\\textbf{${m[1]}}` },
  { id: 'md-italic', message: 'Markdown *italic* → \\textit{}', re: /(?<![*\w\\])\*(?![\s*])([^*\n]+?)(?<!\s)\*(?![*\w])/g, replace: (m) => `\\textit{${m[1]}}` },
  { id: 'md-code', message: 'Markdown `code` → \\t{}', re: /(?<!`)`(?!`)([^`'\n]+)`(?!`)/g, replace: (m) => `\\t{${m[1]}}` },
  { id: 'md-heading', message: 'Markdown heading → \\textbf{}', re: /^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*$/gm, replace: (m) => `\\textbf{${m[1]}}` },
  { id: 'ascii-operator', message: 'Comparison written outside math → $\\le$ / $\\ge$ / $\\ne$', re: /<=|>=|!=|[≤≥≠×]/g, replace: (m) => `$${OPS[m[0]]}$` },
  { id: 'straight-quotes', message: 'Straight quotes "…" → ``…\'\'', re: /"([^"\n]+)"/g, replace: (m) => `\`\`${m[1]}''` },
  { id: 'ellipsis', message: '"..." → \\ldots', re: /(?<!\.)\.\.\.(?!\.)/g, replace: () => '\\ldots{}' },
  // Only before a real line break: `$` would also match the end of a text segment (before a formula).
  { id: 'trailing-space', message: 'Trailing whitespace', re: /[ \t]+(?=\n)/g, replace: () => '' },
];

const MATH_RULES: Rule[] = [
  {
    id: 'math-operator',
    message: 'ASCII operator in math → \\le / \\ge / \\ne',
    re: /<=|>=|!=|[≤≥≠×·]/g,
    // A control word needs a space only when a letter follows (\le n, not \len).
    replace: (m) => `${OPS[m[0]]}${/[A-Za-z]/.test(m.input[m.index + m[0].length] ?? '') ? ' ' : ''}`,
  },
  {
    id: 'math-exponent-braces',
    message: 'Multi-digit exponent or index needs braces: 10^18 renders as 10¹8',
    re: /([\^_])(\d{2,}|[A-Za-z]{2,}(?![A-Za-z{]))/g,
    replace: (m) => `${m[1]}{${m[2]}}`,
  },
  {
    id: 'math-e-notation',
    message: 'Programming-style number (1e9) → 10^9',
    re: /(?<![\w.])(\d+)[eE](\d+)(?!\w)/g,
    replace: (m) => {
      const exp = m[2].length > 1 ? `{${m[2]}}` : m[2];
      return m[1] === '1' ? `10^${exp}` : `${m[1]} \\cdot 10^${exp}`;
    },
  },
  { id: 'math-star', message: '* as multiplication → \\cdot', re: /(?<=[\w)}])\s*\*\s*(?=[\w(\\])/g, replace: () => ' \\cdot ' },
  { id: 'math-ellipsis', message: '"..." in math → \\ldots', re: /\.\.\./g, replace: () => '\\ldots ' },
];

const HAN = /\p{Script=Han}/u;
const FULLWIDTH: Record<string, string> = { ',': '，', ';': '；', ':': '：', '?': '？', '!': '！', '(': '（', ')': '）' };

function applyRules(text: string, rules: Rule[], base: number, issues: LintIssue[], pos: (o: number) => { line: number; col: number }): string {
  let out = text;
  for (const rule of rules) {
    // Report on the input of this rule, then apply it.
    const re = new RegExp(rule.re.source, rule.re.flags);
    let result = '';
    let last = 0;
    for (let m; (m = re.exec(out)); ) {
      if (m[0] === '' && re.lastIndex === m.index) re.lastIndex++;
      const rep = rule.replace(m);
      if (rep === m[0]) continue;
      // Positions refer to the segment after earlier rules ran; exact enough for display.
      issues.push({ ...pos(base + m.index), rule: rule.id, message: rule.message, fixable: true });
      result += out.slice(last, m.index) + rep;
      last = m.index + m[0].length;
    }
    out = result + out.slice(last);
  }
  return out;
}

/** Chinese statements: space between Han characters and formulas; full-width punctuation around Han text. */
function cjkRules(segs: Seg[], out: string[], issues: LintIssue[], pos: (o: number) => { line: number; col: number }) {
  for (let k = 0; k < segs.length; k++) {
    if (segs[k].kind !== 'math') continue;
    const prev = k > 0 && segs[k - 1].kind === 'text' ? k - 1 : -1;
    const next = k + 1 < segs.length && segs[k + 1].kind === 'text' ? k + 1 : -1;
    if (prev >= 0 && HAN.test(out[prev].slice(-1))) {
      out[prev] += ' ';
      issues.push({ ...pos(segs[k].start), rule: 'cjk-math-space', message: 'Put a space between Chinese text and a formula', fixable: true });
    }
    if (prev >= 0 && /[（「『【]\s+$/.test(out[prev])) {
      out[prev] = out[prev].replace(/\s+$/, '');
      issues.push({ ...pos(segs[k].start), rule: 'cjk-punct-space', message: 'No space between full-width punctuation and a formula', fixable: true });
    }
    if (next >= 0) {
      const t = out[next];
      if (HAN.test(t[0] ?? '')) {
        out[next] = ` ${t}`;
        issues.push({ ...pos(segs[next].start), rule: 'cjk-math-space', message: 'Put a space between a formula and Chinese text', fixable: true });
      } else if (/^\s+[，。；：？！、）」』】]/.test(t)) {
        out[next] = t.replace(/^\s+/, '');
        issues.push({ ...pos(segs[next].start), rule: 'cjk-punct-space', message: 'No space between a formula and full-width punctuation', fixable: true });
      } else if (/^[,;:?!](?=\s*\p{Script=Han})/u.test(t)) {
        out[next] = FULLWIDTH[t[0]] + t.slice(1).replace(/^\s+/, '');
        issues.push({ ...pos(segs[next].start), rule: 'cjk-fullwidth', message: 'Use full-width punctuation in Chinese text', fixable: true });
      }
    }
  }
  for (let k = 0; k < segs.length; k++) {
    if (segs[k].kind !== 'text') continue;
    const re = /(?<=\p{Script=Han})[,;:?!]|[,;:?!](?=\p{Script=Han})|(?<=\p{Script=Han})\((?=[^)]*\p{Script=Han})|(?<=\p{Script=Han}[^(]*)\)(?=\p{Script=Han}|[，。]|$)/gu;
    let first = -1;
    const fixed = out[k].replace(re, (ch, off: number) => {
      if (first < 0) first = off;
      return FULLWIDTH[ch] ?? ch;
    });
    if (fixed !== out[k]) {
      issues.push({ ...pos(segs[k].start + Math.max(first, 0)), rule: 'cjk-fullwidth', message: 'Use full-width punctuation in Chinese text', fixable: true });
      out[k] = fixed;
    }
  }
}

/** Markdown bullet / numbered lists → itemize / enumerate (line based, outside verbatim). */
function convertLists(src: string, issues: LintIssue[], verbatimLines: Set<number>): string {
  const lines = src.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    const bullet = /^\s*[-*+]\s+(.*)$/;
    const numbered = /^\s*\d+[.)]\s+(.*)$/;
    const kind = !verbatimLines.has(i) && bullet.test(lines[i]) ? 'itemize' : !verbatimLines.has(i) && numbered.test(lines[i]) ? 'enumerate' : null;
    if (!kind) {
      out.push(lines[i++]);
      continue;
    }
    issues.push({ line: i + 1, col: 1, rule: 'md-list', message: `Markdown list → \\begin{${kind}}`, fixable: true });
    // Nesting follows the indentation, two spaces per level; each level is its own
    // list (a numbered list inside a bulleted one, …). Indentation is set by indentLists.
    const stack: { kind: string; level: number }[] = [];
    const listKind = (l: string) => (bullet.test(l) ? 'itemize' : numbered.test(l) ? 'enumerate' : null);
    for (let k: string | null; i < lines.length && !verbatimLines.has(i) && (k = listKind(lines[i])); i++) {
      const level = Math.floor(lines[i].match(/^ */)![0].length / 2);
      while (stack.length && stack[stack.length - 1].level > level) out.push(`\\end{${stack.pop()!.kind}}`);
      const top = stack[stack.length - 1];
      if (top && top.level === level && top.kind !== k) out.push(`\\end{${stack.pop()!.kind}}`);
      if (!stack.length || stack[stack.length - 1].level < level) {
        out.push(`\\begin{${k}}`);
        stack.push({ kind: k, level });
      }
      out.push(`\\item ${lines[i].match(k === 'itemize' ? bullet : numbered)![1]}`);
    }
    while (stack.length) out.push(`\\end{${stack.pop()!.kind}}`);
  }
  return out.join('\n');
}

const LIST_ENVS = /\\(begin|end)\{(itemize|enumerate)\}/g;

/**
 * Indent list structure by nesting depth, two spaces per level: \begin / \end of a list
 * at the depth outside it, its \item lines one level deeper. Other lines are left alone.
 */
function indentLists(src: string, issues: LintIssue[]): string {
  const lines = src.split('\n');
  let depth = 0;
  let verbatim: string | null = null;
  return lines
    .map((line, n) => {
      if (verbatim) {
        if (line.includes(`\\end{${verbatim}}`)) verbatim = null;
        return line;
      }
      const v = line.match(/\\begin\{(verbatim|lstlisting)\}/);
      if (v && !line.includes(`\\end{${v[1]}}`)) verbatim = v[1];
      const code = line.replace(/(?<!\\)%.*$/, '');
      const t = code.trimStart();
      let target: number | null = null;
      if (/^\\end\{(itemize|enumerate)\}/.test(t)) target = Math.max(depth - 1, 0);
      else if (/^\\begin\{(itemize|enumerate)\}/.test(t)) target = depth;
      else if (/^\\item\b/.test(t) && depth > 0) target = depth;
      for (const m of code.matchAll(LIST_ENVS)) depth = Math.max(depth + (m[1] === 'begin' ? 1 : -1), 0);
      if (target === null) return line;
      const want = ' '.repeat(2 * target) + line.trimStart();
      if (want !== line) issues.push({ line: n + 1, col: 1, rule: 'list-indent', message: 'Indent lists by two spaces per level', fixable: true });
      return want;
    })
    .join('\n');
}

export const LINT_RULE_IDS = [
  ...TEXT_RULES.map((r) => r.id),
  ...MATH_RULES.map((r) => r.id),
  'md-list',
  'md-code-block',
  'list-indent',
  'cjk-math-space',
  'cjk-punct-space',
  'cjk-fullwidth',
  'blank-lines',
  'unclosed-math',
  'unbalanced-braces',
] as const;

export function lintStatement(src: string, opts: { lang: string }): LintResult {
  const text = src.replace(/\r\n/g, '\n');
  const issues: LintIssue[] = [];
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const pos = (o: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= o) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: o - lineStarts[lo] + 1 };
  };

  const segs = segment(text, issues, pos);
  const out = segs.map((s) => (s.kind === 'text' ? applyRules(s.text, TEXT_RULES, s.start, issues, pos) : s.kind === 'math' ? applyRules(s.text, MATH_RULES, s.start, issues, pos) : s.kind === 'verbatim' && /^[ \t]*`{3,}/.test(s.text) && /\n[ \t]*`{3,}[ \t]*\n?$/.test(s.text) ? s.text.replace(/^[ \t]*`{3,}[^\n]*\n/, '\\begin{verbatim}\n').replace(/\n[ \t]*`{3,}[ \t]*(\n?)$/, '\n\\end{verbatim}$1') : s.text));
  if (opts.lang === 'zh') cjkRules(segs, out, issues, pos);

  // Brace balance in text (report only).
  let depth = 0;
  for (const s of segs) {
    if (s.kind !== 'text') continue;
    for (let i = 0; i < s.text.length; i++) {
      if (s.text[i] === '\\') i++;
      else if (s.text[i] === '{') depth++;
      else if (s.text[i] === '}' && --depth < 0) {
        issues.push({ ...pos(s.start + i), rule: 'unbalanced-braces', message: 'Closing } without a matching {', fixable: false });
        depth = 0;
      }
    }
  }
  if (depth > 0) issues.push({ line: lineStarts.length, col: 1, rule: 'unbalanced-braces', message: `${depth} unclosed {`, fixable: false });

  const verbatimLines = new Set<number>();
  for (const s of segs) {
    if (s.kind !== 'verbatim') continue;
    const a = pos(s.start).line - 1;
    const b = pos(s.start + s.text.length).line - 1;
    for (let l = a; l <= b; l++) verbatimLines.add(l);
  }
  let fixed = indentLists(convertLists(out.join(''), issues, verbatimLines), issues);
  const collapsed = segment(fixed, [], () => ({ line: 1, col: 1 })).map(s => s.kind === 'verbatim' ? s.text : s.text.replace(/\n{3,}/g, '\n\n')).join('');
  if (collapsed !== fixed) issues.push({ line: 1, col: 1, rule: 'blank-lines', message: 'More than one blank line in a row', fixable: true });
  fixed = collapsed;
  issues.sort((a, b) => a.line - b.line || a.col - b.col);
  return { issues, fixed, changed: fixed !== text };
}
