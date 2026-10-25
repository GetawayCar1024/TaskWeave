/**
 * Built-in language presets for languages.toml. The user's file is never overwritten on
 * upgrade, so Settings adds or removes whole sections as text edits, leaving the rest of
 * the file (comments, custom sections) untouched.
 */
export interface LanguagePreset {
  id: string;
  name: string;
  /** The TOML section, header included, without a trailing newline. */
  text: string;
}

const CPP = (std: string) =>
  `g++ -std=${std} -O2 -Wall -static -DONLINE_JUDGE -DFOR_LINUX -Wl,--stack=268435456 -isystem {shared} -o {exe} {src}`;

const section = (id: string, fields: Record<string, string | string[]>) =>
  [`[${id}]`, ...Object.entries(fields).map(([k, v]) => `${k} = ${Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(', ')}]` : JSON.stringify(v)}`)].join('\n');

const preset = (id: string, fields: Record<string, string | string[]> & { name: string }): LanguagePreset => ({ id, name: fields.name, text: section(id, fields) });

export const LANGUAGE_PRESETS: LanguagePreset[] = [
  preset('cpp17', { name: 'C++17 (GCC)', extensions: ['.cpp', '.cc', '.cxx'], compile: CPP('c++17'), run: '{exe}', polygon: 'cpp.g++17' }),
  preset('cpp20', { name: 'C++20 (GCC)', extensions: ['.cpp'], compile: CPP('c++20'), run: '{exe}', polygon: 'cpp.gcc13-64-winlibs-g++20' }),
  preset('cpp23', { name: 'C++23 (GCC)', extensions: ['.cpp'], compile: CPP('c++23'), run: '{exe}', polygon: 'cpp.gcc14-64-msys2-g++23' }),
  preset('c11', { name: 'C11 (GCC)', extensions: ['.c'], compile: 'gcc -std=c11 -O2 -Wall -static -DONLINE_JUDGE -DFOR_LINUX -Wl,--stack=268435456 -isystem {shared} -o {exe} {src} -lm', run: '{exe}', polygon: 'c.gcc' }),
  preset('py3', { name: 'Python 3', extensions: ['.py'], run: 'python {src}', polygon: 'python.3' }),
  preset('pypy3', { name: 'PyPy 3', extensions: ['.py'], run: 'pypy3 {src}', polygon: 'python.pypy3' }),
  preset('java21', { name: 'Java 21', extensions: ['.java'], compile: 'javac -d {dir} {src}', run: 'java -cp {dir} {class}', polygon: 'java21' }),
  // kotlinc is a .bat on Windows, which cannot be started without cmd.
  preset('kotlin', { name: 'Kotlin (JVM)', extensions: ['.kt'], compile: 'cmd /c kotlinc {src} -include-runtime -d {dir}/{class}.jar', run: 'java -jar {dir}/{class}.jar' }),
  preset('rust', { name: 'Rust 2021', extensions: ['.rs'], compile: 'rustc --edition 2021 -O -o {exe} {src}', run: '{exe}' }),
  preset('go', { name: 'Go', extensions: ['.go'], compile: 'go build -o {exe} {src}', run: '{exe}' }),
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const headerRe = /^\s*\[\[?\s*([^\]\s]+)\s*\]\]?\s*(#.*)?$/;

/** Whether languages.toml has a `[id]` section (or subtables of it). */
export function hasLanguageSection(text: string, id: string): boolean {
  return new RegExp(`^\\s*\\[\\s*${escapeRe(id)}\\s*\\]\\s*(#.*)?$`, 'm').test(text);
}

/** Append a preset section; returns the text unchanged when it is already there. */
export function addLanguageSection(text: string, p: LanguagePreset): string {
  if (hasLanguageSection(text, p.id)) return text;
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const body = text.replace(/(\r?\n)*$/, '');
  return (body ? body + nl + nl : '') + p.text.split('\n').join(nl) + nl;
}

/** The raw text of a section, header to before the next section (comments of the next section excluded). */
function sectionRange(lines: string[], id: string): [number, number] | null {
  const owns = (name: string) => name === id || name.startsWith(id + '.');
  const start = lines.findIndex((l) => headerRe.exec(l)?.[1] === id);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length) {
    const m = headerRe.exec(lines[end]);
    if (m && !owns(m[1])) break;
    end++;
  }
  // Comment lines right above the next header describe that section: keep them.
  if (end < lines.length) {
    let keep = end;
    while (keep > start + 1 && /^\s*(#.*)?$/.test(lines[keep - 1])) keep--;
    end = keep;
  }
  return [start, end];
}

export function languageSectionText(text: string, id: string): string | null {
  const lines = text.split(/\r?\n/);
  const r = sectionRange(lines, id);
  return r ? lines.slice(r[0], r[1]).join('\n').trim() : null;
}

/** Remove the `[id]` section (with its subtables); everything else stays as written. */
export function removeLanguageSection(text: string, id: string): string {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const r = sectionRange(lines, id);
  if (!r) return text;
  const [start, end] = r;
  const before = lines.slice(0, start);
  const after = lines.slice(end);
  // Collapse the blank lines left at the seam into one.
  while (before.length && !before[before.length - 1].trim() && (!after.length || !after[0].trim())) before.pop();
  while (!before.length && after.length && !after[0].trim()) after.shift();
  return [...before, ...after].join(nl).replace(/(\r?\n)*$/, '') + nl;
}
