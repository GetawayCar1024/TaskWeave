/**
 * Polygon test scripts (tests/script.txt): one command per line, `gen args > target`
 * where target is `$` (next free index), `N`, or `{a-b,c}` (multi-test generator).
 *
 * Polygon expands scripts with FreeMarker first; the commonly used subset is supported:
 * `<#list a..b as i>`, `<#list a..<b as i>`, `<#list [x, y] as i>`, `<#assign x = e>`,
 * `<#if e>`/`<#elseif e>`/`<#else>`, `${e}` (with `?c`), `<#-- comments -->`.
 */

export type ScriptTarget = { kind: 'auto' } | { kind: 'index'; index: number } | { kind: 'multi'; indices: number[] };

export interface ScriptCommand {
  /** 1-based line in the expanded script. */
  line: number;
  generator: string;
  args: string[];
  target: ScriptTarget;
  /** The command as written (after expansion). */
  text: string;
}

export class ScriptError extends Error {
  constructor(
    message: string,
    public line?: number,
  ) {
    super(line ? `script.txt:${line}: ${message}` : `script.txt: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Expressions

type Value = number | string | boolean | Value[];

type Tok = { t: 'num'; v: number } | { t: 'str'; v: string } | { t: 'id'; v: string } | { t: 'op'; v: string };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if (/\d/.test(c)) {
      let j = i;
      while (j < src.length && /[\d.]/.test(src[j]) && !(src[j] === '.' && src[j + 1] === '.')) j++;
      out.push({ t: 'num', v: Number(src.slice(i, j)) });
      i = j;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) j++;
        s += src[j++];
      }
      if (j >= src.length) throw new ScriptError('unterminated string');
      out.push({ t: 'str', v: s });
      i = j + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /\w/.test(src[j])) j++;
      out.push({ t: 'id', v: src.slice(i, j) });
      i = j;
    } else {
      const two = src.slice(i, i + 3) === '..<' ? '..<' : src.slice(i, i + 2);
      if (['..<', '..', '==', '!=', '<=', '>=', '&&', '||'].includes(two)) {
        out.push({ t: 'op', v: two });
        i += two.length;
      } else if ('+-*/%()<>!=[],?'.includes(c)) {
        out.push({ t: 'op', v: c });
        i++;
      } else {
        throw new ScriptError(`unexpected character "${c}" in expression`);
      }
    }
  }
  return out;
}

class ExprParser {
  private i = 0;
  constructor(
    private toks: Tok[],
    private env: Map<string, Value>,
  ) {}

  done() {
    return this.i >= this.toks.length;
  }
  private peek(v?: string) {
    const t = this.toks[this.i];
    return t && (v === undefined || ((t.t === 'op' || t.t === 'id') && t.v === v)) ? t : undefined;
  }
  private eat(v: string) {
    if (!this.peek(v)) throw new ScriptError(`expected "${v}"`);
    this.i++;
  }
  private accept(...vs: string[]) {
    for (const v of vs) if (this.peek(v)) return this.i++, v;
    return undefined;
  }

  expr(): Value {
    return this.or();
  }
  private or(): Value {
    let l = this.and();
    while (this.accept('||')) l = truthy(l) || truthy(this.and());
    return l;
  }
  private and(): Value {
    let l = this.cmp();
    while (this.accept('&&')) l = truthy(l) && truthy(this.cmp());
    return l;
  }
  private cmp(): Value {
    const l = this.add();
    const op = this.accept('==', '=', '!=', '<=', '>=', '<', '>', 'lt', 'lte', 'gt', 'gte');
    if (!op) return l;
    const r = this.add();
    switch (op) {
      case '==':
      case '=':
        return l === r;
      case '!=':
        return l !== r;
      case '<':
      case 'lt':
        return (l as number) < (r as number);
      case '<=':
      case 'lte':
        return (l as number) <= (r as number);
      case '>':
      case 'gt':
        return (l as number) > (r as number);
      default:
        return (l as number) >= (r as number);
    }
  }
  private add(): Value {
    let l = this.mul();
    for (let op; (op = this.accept('+', '-')); ) {
      const r = this.mul();
      if (op === '+') l = typeof l === 'string' || typeof r === 'string' ? fmt(l) + fmt(r) : num(l) + num(r);
      else l = num(l) - num(r);
    }
    return l;
  }
  private mul(): Value {
    let l = this.unary();
    for (let op; (op = this.accept('*', '/', '%')); ) {
      const r = num(this.unary());
      if (op === '*') l = num(l) * r;
      else if (op === '/') l = num(l) / r;
      else l = num(l) % r;
    }
    return l;
  }
  private unary(): Value {
    if (this.accept('-')) return -num(this.unary());
    if (this.accept('!')) return !truthy(this.unary());
    return this.postfix();
  }
  private postfix(): Value {
    let v = this.primary();
    // Built-ins like ?c / ?string only affect formatting; values print plainly anyway.
    while (this.accept('?')) {
      const t = this.toks[this.i++];
      if (!t || t.t !== 'id') throw new ScriptError('expected built-in name after "?"');
      if (t.v === 'size' && Array.isArray(v)) v = v.length;
    }
    return v;
  }
  private primary(): Value {
    const t = this.toks[this.i++];
    if (!t) throw new ScriptError('unexpected end of expression');
    if (t.t === 'num' || t.t === 'str') return t.v;
    if (t.t === 'id') {
      if (t.v === 'true') return true;
      if (t.v === 'false') return false;
      if (!this.env.has(t.v)) throw new ScriptError(`undefined variable "${t.v}"`);
      return this.env.get(t.v)!;
    }
    if (t.v === '(') {
      const v = this.expr();
      this.eat(')');
      return v;
    }
    if (t.v === '[') {
      const items: Value[] = [];
      if (!this.accept(']')) {
        do items.push(this.expr());
        while (this.accept(','));
        this.eat(']');
      }
      return items;
    }
    throw new ScriptError(`unexpected "${t.v}"`);
  }

  /** `a..b`, `a..<b` or a sequence. */
  iterable(): Value[] {
    const a = this.add();
    const op = this.accept('..', '..<');
    if (!op) {
      if (!Array.isArray(a)) throw new ScriptError('<#list> needs a range or a sequence');
      return a;
    }
    const b = num(this.add());
    const out: number[] = [];
    const end = op === '..' ? b : b - 1;
    if (num(a) <= end) for (let i = num(a); i <= end; i++) out.push(i);
    else if (op === '..') for (let i = num(a); i >= end; i--) out.push(i);
    return out;
  }
}

const num = (v: Value): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
  throw new ScriptError(`expected a number, got ${JSON.stringify(v)}`);
};
const truthy = (v: Value) => (Array.isArray(v) ? v.length > 0 : !!v);
const fmt = (v: Value): string => (Array.isArray(v) ? v.map(fmt).join(',') : String(v));

// ---------------------------------------------------------------------------
// Templates

type Node =
  | { k: 'text'; s: string }
  | { k: 'interp'; e: string }
  | { k: 'assign'; e: string }
  | { k: 'list'; e: string; body: Node[] }
  | { k: 'if'; branches: { cond: string | null; body: Node[] }[] };

/** Find the `>` ending a directive, skipping strings and parentheses. */
function tagEnd(src: string, from: number): number {
  let depth = 0;
  let quote = '';
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === '>' && depth === 0) return i;
  }
  throw new ScriptError('unterminated directive');
}

function parseTemplate(src: string): Node[] {
  let pos = 0;
  const lineAt = (p: number) => src.slice(0, p).split('\n').length;

  function parseNodes(stopAt: string[]): { nodes: Node[]; stop: string | null; arg: string } {
    const nodes: Node[] = [];
    let text = '';
    const flush = () => {
      if (text) nodes.push({ k: 'text', s: text });
      text = '';
    };
    while (pos < src.length) {
      if (src.startsWith('<#--', pos)) {
        const end = src.indexOf('-->', pos);
        if (end < 0) throw new ScriptError('unterminated comment', lineAt(pos));
        pos = end + 3;
      } else if (src.startsWith('${', pos)) {
        const end = src.indexOf('}', pos);
        if (end < 0) throw new ScriptError('unterminated ${', lineAt(pos));
        flush();
        nodes.push({ k: 'interp', e: src.slice(pos + 2, end) });
        pos = end + 1;
      } else if (src.startsWith('</#', pos) || src.startsWith('<#', pos)) {
        const closing = src[pos + 1] === '/';
        const start = pos + (closing ? 3 : 2);
        const end = tagEnd(src, start);
        const inner = src.slice(start, end).trim();
        const name = (closing ? '/' : '') + (inner.match(/^\w+/)?.[0] ?? '');
        const arg = inner.replace(/^\w+/, '').trim();
        const line = lineAt(pos);
        pos = end + 1;
        if (stopAt.includes(name)) {
          flush();
          return { nodes, stop: name, arg };
        }
        flush();
        if (name === 'assign') nodes.push({ k: 'assign', e: arg });
        else if (name === 'list') {
          const r = parseNodes(['/list']);
          if (r.stop !== '/list') throw new ScriptError('missing </#list>', line);
          nodes.push({ k: 'list', e: arg, body: r.nodes });
        } else if (name === 'if') {
          const branches: { cond: string | null; body: Node[] }[] = [];
          let cond: string | null = arg;
          for (;;) {
            const r = parseNodes(['elseif', 'else', '/if']);
            branches.push({ cond, body: r.nodes });
            if (r.stop === '/if') break;
            if (r.stop === null) throw new ScriptError('missing </#if>', line);
            cond = r.stop === 'else' ? null : r.arg;
          }
          nodes.push({ k: 'if', branches });
        } else {
          throw new ScriptError(`unsupported directive <#${name}>`, line);
        }
        // A directive alone on its line should not leave an empty line behind.
        if (src[pos] === '\r') pos++;
        if (src[pos] === '\n') pos++;
      } else {
        text += src[pos++];
      }
    }
    flush();
    return { nodes, stop: null, arg: '' };
  }

  const r = parseNodes([]);
  return r.nodes;
}

function evalExpr(e: string, env: Map<string, Value>): Value {
  const p = new ExprParser(lex(e), env);
  const v = p.expr();
  if (!p.done()) throw new ScriptError(`unexpected tokens in "${e}"`);
  return v;
}

function render(nodes: Node[], env: Map<string, Value>, out: string[]) {
  for (const n of nodes) {
    switch (n.k) {
      case 'text':
        out.push(n.s);
        break;
      case 'interp':
        out.push(fmt(evalExpr(n.e, env)));
        break;
      case 'assign': {
        // <#assign a = 1 b = a + 1>
        const re = /(\w+)\s*=\s*/g;
        const parts: { name: string; start: number; end: number }[] = [];
        for (let m; (m = re.exec(n.e)); ) {
          if (n.e[m.index + m[0].length - 1] === '=' && n.e[m.index + m[0].length] === '=') continue;
          parts.push({ name: m[1], start: m.index, end: m.index + m[0].length });
        }
        if (parts.length === 0) throw new ScriptError(`bad <#assign ${n.e}>`);
        parts.forEach((p, i) => env.set(p.name, evalExpr(n.e.slice(p.end, parts[i + 1]?.start ?? n.e.length), env)));
        break;
      }
      case 'list': {
        const m = n.e.match(/^(.*)\s+as\s+(\w+)$/s);
        if (!m) throw new ScriptError(`bad <#list ${n.e}>`);
        const p = new ExprParser(lex(m[1]), env);
        const items = p.iterable();
        const prev = env.get(m[2]);
        for (const item of items) {
          env.set(m[2], item);
          render(n.body, env, out);
        }
        if (prev === undefined) env.delete(m[2]);
        else env.set(m[2], prev);
        break;
      }
      case 'if': {
        const b = n.branches.find((br) => br.cond === null || truthy(evalExpr(br.cond, env)));
        if (b) render(b.body, env, out);
        break;
      }
    }
  }
}

export function expandTemplate(src: string): string {
  const out: string[] = [];
  render(parseTemplate(src), new Map(), out);
  return out.join('');
}

// ---------------------------------------------------------------------------
// Commands

function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  for (let m; (m = re.exec(s)); ) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]);
  return out;
}

function parseTarget(t: string, line: number): ScriptTarget {
  if (t === '$') return { kind: 'auto' };
  if (/^\d+$/.test(t)) {
    const index = Number(t);
    if (index < 1) throw new ScriptError('test index must be positive', line);
    return { kind: 'index', index };
  }
  const m = t.match(/^\{([\d\s,-]+)\}$/);
  if (m) {
    const indices: number[] = [];
    for (const part of m[1].split(',')) {
      const r = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
      if (!r) throw new ScriptError(`bad test range "${t}"`, line);
      const a = Number(r[1]);
      const b = r[2] ? Number(r[2]) : a;
      if (a < 1 || b < a) throw new ScriptError(`bad test range "${t}"`, line);
      for (let i = a; i <= b; i++) indices.push(i);
    }
    return { kind: 'multi', indices };
  }
  throw new ScriptError(`bad target "${t}" (expected $, a number or {a-b})`, line);
}

export function parseScript(src: string): ScriptCommand[] {
  const expanded = expandTemplate(src.replace(/\r\n/g, '\n'));
  const cmds: ScriptCommand[] = [];
  expanded.split('\n').forEach((raw, i) => {
    const line = i + 1;
    const text = raw.trim();
    if (!text) return;
    const gt = text.lastIndexOf('>');
    if (gt < 0) throw new ScriptError(`missing "> target" in "${text}"`, line);
    const words = splitArgs(text.slice(0, gt));
    if (words.length === 0) throw new ScriptError('missing generator name', line);
    cmds.push({ line, generator: words[0], args: words.slice(1), target: parseTarget(text.slice(gt + 1).trim(), line), text });
  });
  return cmds;
}
