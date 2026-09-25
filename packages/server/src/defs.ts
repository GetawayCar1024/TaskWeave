import { parse as parseToml } from 'smol-toml';

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
