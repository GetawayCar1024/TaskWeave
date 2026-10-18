import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HttpError, safeJoin } from '../util/fs.js';
import type { Judge } from './index.js';

const unsupported = (detail: string): never => { throw new HttpError(400, 'lemon_conversion', `Cannot automatically convert this checker: ${detail}`); };

/** Only rewrite actual C++ tokens, leaving comments and string literals untouched. */
export function convertLemonChecker(source: string): string {
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|R"([^ ()\\\t\r\n]{0,16})\([\s\S]*?\)\1"|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g,
    s => s.replace(/[^\r\n]/g, ' '));
  if (/\b(?:registerLemonChecker|registerLocalChecker)\s*\(/.test(code)) unsupported('the source already uses a local/Lemon checker initializer. Configure it directly as the Lemon checker.');
  if (/\b(?:_pc|quitpi|quitpf|points_info|setAppesMode)\b/.test(code)) unsupported('custom partial-scoring or report APIs require manual conversion.');
  const calls = [...code.matchAll(/\bregisterTestlibCmd\s*\(\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*\)\s*;/g)];
  if (calls.length !== 1 || [...code.matchAll(/\bregisterTestlibCmd\b/g)].length !== 1) unsupported('expected one registerTestlibCmd(argc, argv) call.');
  const includes = [...source.matchAll(/^[ \t]*#[ \t]*include[ \t]*["<]testlib\.h[">]/gm)]
    .filter(m => code.slice(m.index!, m.index! + m[0].length).includes('#'));
  if (includes.length !== 1) unsupported('expected one direct include of testlib.h.');
  const call = calls[0];
  const replacements = [
    { start: includes[0].index!, length: includes[0][0].length, text: '#include "lemon/testlib.h"' },
    { start: call.index!, length: call[0].length, text: `registerLemonChecker(${call[1]}, ${call[2]});${/\bquitp\s*\(/.test(code) ? '\n    quitpRelativeScoring = true; /* Preserve testlib quitp fractional scores. */\n    ' : ''}` },
  ];
  let result = source;
  for (const r of replacements.sort((a, b) => b.start - a.start)) result = result.slice(0, r.start) + r.text + result.slice(r.start + r.length);
  return result;
}

/** Write next to a local source to preserve relative includes; never overwrite any existing file. */
export async function createLemonChecker(judge: Judge, id: string): Promise<{ source: string }> {
  const ctx = await judge.ctx(id), checker = ctx.config.checker;
  if (!checker) throw new HttpError(400, 'lemon_conversion', 'Select and save an ordinary checker first.');
  const resolved = judge.compiler.resolveSource(ctx.ref.dir, checker.source).srcPath;
  if (!/\.(cpp|cc|cxx)$/i.test(resolved)) unsupported('only C++ testlib checkers are supported.');
  const converted = convertLemonChecker(await fs.readFile(resolved, 'utf8'));
  const dir = checker.source.startsWith('std:') ? '' : path.posix.dirname(checker.source.replace(/\\/g, '/'));
  const base = path.basename(resolved, path.extname(resolved));
  for (let i = 1; i < 1000; i++) {
    const source = path.posix.join(dir, `${base}-lemon${i === 1 ? '' : `-${i}`}.cpp`);
    const file = safeJoin(ctx.ref.dir, source);
    try { await fs.writeFile(file, converted, { flag: 'wx' }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue; throw e; }
    try {
      await judge.registry.patch(id, { lemonChecker: source, language: { source, lang: judge.langOf(ctx.config, checker.source) ?? null } });
    } catch (e) { await fs.unlink(file); throw e; }
    return { source };
  }
  return unsupported('too many converted copies. Choose or rename an existing Lemon checker.');
}
