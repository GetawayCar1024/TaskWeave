import { parse as parseToml } from 'smol-toml';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Additional OI phrases are installed separately, preserving customized CF definitions. */
export async function readSharedDefs(sharedDir: string): Promise<string> {
  const base = await fs.readFile(path.join(sharedDir, 'defs.toml'), 'utf8');
  const oi = await fs.readFile(path.join(sharedDir, 'oi', 'defs.toml'), 'utf8').catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return '';
    throw e;
  });
  return `${base.trimEnd()}\n\n${oi.trim()}\n`;
}

/**
 * Codeforces' defs.toml writes multi-line bodies as `body = '` … `'` (a line with a
 * lone quote), which strict TOML rejects; turn those into ''' literals first.
 */
export function parseDefsToml(text: string): unknown {
  const fixed = text
    .replace(/\r\n/g, '\n')
    .replace(/= '\n/g, "= '''\n")
    .replace(/^'$/gm, "'''");
  return parseToml(fixed);
}

/**
 * The defs.toml to give a Polygon problem: the shared file as is when the problem has a
 * Chinese statement, otherwise the original Codeforces version (the shared file without
 * its [[chinese.command]] blocks).
 */
export function defsForProblem(text: string, withChinese: boolean): string {
  if (withChinese) return text;
  const lf = text.replace(/\r\n/g, '\n');
  // A block runs from its header to the end of its body ('…' or '''…''' closed on its own line).
  const out = lf.replace(/\n?\[\[chinese\.command\]\]\n(?:(?!body = )[^\n]*\n)*body = ('''|')\n[\s\S]*?\n\1\n/g, '');
  return text.includes('\r\n') ? out.replace(/\n/g, '\r\n') : out;
}
