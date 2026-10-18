import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { parseDefsToml, readSharedDefs } from '../defs.js';

interface Command {
  name: string;
  args: string[];
  body: string;
}

/** defs.toml tables per statement language, as the statement preview uses them. */
const TABLES: Record<string, string[]> = { en: ['english', 'common'], zh: ['chinese', 'english', 'common'], ru: ['russian', 'english', 'common'] };

let cache: { key: string; defs: Record<string, { command?: { name: string; args?: string[]; body?: string }[] }> } | null = null;

async function loadDefs(sharedDir: string) {
  const file = path.join(sharedDir, 'defs.toml');
  const st = await fsp.stat(file).catch(() => null);
  if (!st) return {};
  const oi = await fsp.stat(path.join(sharedDir, 'oi', 'defs.toml')).catch(() => null);
  const key = `${sharedDir}:${st.mtimeMs}:${st.size}:${oi?.mtimeMs}:${oi?.size}`;
  if (!cache || cache.key !== key) {
    try {
      cache = { key, defs: parseDefsToml(await readSharedDefs(sharedDir)) as never };
    } catch {
      cache = { key, defs: {} };
    }
  }
  return cache.defs;
}

async function commands(sharedDir: string, lang: string): Promise<Map<string, Command>> {
  const defs = await loadDefs(sharedDir);
  const map = new Map<string, Command>();
  for (const t of TABLES[lang] ?? ['english', 'common']) {
    for (const c of defs[t]?.command ?? []) {
      if (c.name && !map.has(c.name)) map.set(c.name, { name: c.name, args: c.args ?? [], body: (c.body ?? '').trim() });
    }
  }
  return map;
}

/** Read a balanced `[...]` or `{...}` argument starting at `pos` (after spaces), if any. */
function readArg(src: string, pos: number, open: '[' | '{'): { value: string; end: number } | null {
  let i = pos;
  while (src[i] === ' ' || src[i] === '\t') i++;
  if (src[i] !== open) return null;
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let braces = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (open === '[' && c === '{') braces++;
    else if (open === '[' && c === '}') braces--;
    else if (braces === 0 && c === open) depth++;
    else if (braces === 0 && c === close && --depth === 0) return { value: src.slice(i + 1, j), end: j + 1 };
  }
  return null;
}

/**
 * The defs.toml macros used in a statement file, each with its expansion for the
 * arguments given there (optional [..] arguments, {..} also accepted, else defaults).
 * The model otherwise only sees e.g. \DefLimitSum[n][5 \cdot 10^5] and may miss that
 * it states a constraint.
 */
export async function macroExpansions(sharedDir: string, text: string, lang: string): Promise<string[]> {
  const cmds = await commands(sharedDir, lang);
  if (!cmds.size) return [];
  const out: string[] = [];
  const re = /\\([A-Za-z]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const c = cmds.get(m[1]);
    if (!c) continue;
    let pos = m.index + m[0].length;
    const vals = c.args.map((def) => {
      const a = readArg(text, pos, '[') ?? readArg(text, pos, '{');
      if (!a) return def;
      pos = a.end;
      return a.value;
    });
    const call = text.slice(m.index, pos);
    const body = c.body.replace(/#(\d)/g, (_, d: string) => vals[Number(d) - 1] ?? '').replace(/\s+/g, ' ');
    out.push(`${call}  →  ${body}`);
    re.lastIndex = pos;
  }
  return [...new Set(out)];
}

/** Replace the defs.toml macros in a statement text by their bodies (a few rounds, for nested macros). */
export async function expandMacros(sharedDir: string, text: string, lang: string): Promise<string> {
  const cmds = await commands(sharedDir, lang);
  if (!cmds.size) return text;
  let out = text;
  for (let round = 0; round < 5; round++) {
    let changed = false;
    let res = '';
    let last = 0;
    const re = /\\([A-Za-z]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(out))) {
      const c = cmds.get(m[1]);
      if (!c) continue;
      let pos = m.index + m[0].length;
      const vals = c.args.map((def) => {
        const a = readArg(out, pos, '[') ?? readArg(out, pos, '{');
        if (!a) return def;
        pos = a.end;
        return a.value;
      });
      res += out.slice(last, m.index) + c.body.replace(/#(\d)/g, (_, d: string) => vals[Number(d) - 1] ?? '');
      last = pos;
      re.lastIndex = pos;
      changed = true;
    }
    if (!changed) break;
    out = res + out.slice(last);
  }
  return out;
}
