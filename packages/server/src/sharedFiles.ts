import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { STD_PREFIX, type SharedFileEntry, type SharedListResponse } from '@polyforge/shared';

/** Descriptions of the testlib standard checkers as shown by Polygon. */
const CHECKER_DESCRIPTIONS: Record<string, string> = {
  ncmp: 'Compare ordered sequences of signed int64 numbers',
  wcmp: 'Compare sequences of tokens',
  lcmp: 'Compare files as sequence of tokens in lines',
  fcmp: 'Compare files as sequence of lines',
  hcmp: 'Compare two signed huge integers',
  icmp: 'Compare two signed int32',
  uncmp: 'Compare unordered sequences of signed int64 numbers',
  yesno: 'YES or NO (case insensitive)',
  nyesno: 'Multiple YES/NO (case insensitive)',
  caseicmp: 'Single int64 checker with testcase-support',
  casencmp: 'Many int64s checker with testcase-support',
  casewcmp: 'Tokens checker with testcase-support',
  acmp: 'Compare two doubles, maximal absolute error 1.5E-6',
  dcmp: 'Compare two doubles, maximal absolute or relative error 1E-6',
  rcmp: 'Compare two doubles, maximal absolute error 1.5E-6',
  rcmp4: 'Compare two sequences of doubles, max absolute or relative error 1E-4',
  rcmp6: 'Compare two sequences of doubles, max absolute or relative error 1E-6',
  rcmp9: 'Compare two sequences of doubles, max absolute or relative error 1E-9',
  rncmp: 'Compare two sequences of doubles, maximal absolute error 1.5E-5',
  pointscmp: 'Example of scored checker',
  pointsinfo: 'Example of checker with points_info',
};

/** First line of a leading block comment, used as a description for templates. */
function leadingComment(src: string): string | undefined {
  const m = src.match(/^\s*\/\*+\s*\n?\s*\*?\s*(.+)/);
  if (m) return m[1].trim();
  const l = src.match(/^\s*\/\/\s*(.+)/);
  return l?.[1].trim();
}

async function listDir(sharedDir: string, sub: string, isChecker: boolean): Promise<SharedFileEntry[]> {
  const dir = path.join(sharedDir, sub);
  let names: string[];
  try {
    names = (await fsp.readdir(dir)).filter((n) => /\.(cpp|cc|py)$/.test(n)).sort();
  } catch {
    return [];
  }
  return Promise.all(
    names.map(async (name) => {
      const base = name.replace(/\.[^.]+$/, '');
      let description = isChecker ? CHECKER_DESCRIPTIONS[base] : undefined;
      if (!description) {
        const src = await fsp.readFile(path.join(dir, name), 'utf8').catch(() => '');
        description = isChecker ? src.match(/setName\("([^"%]+)"/)?.[1] : leadingComment(src);
      }
      return { name, path: `${sub}/${name}`, ref: isChecker ? `${STD_PREFIX}${base}` : undefined, description };
    }),
  );
}

export async function listShared(sharedDir: string): Promise<SharedListResponse> {
  const [checkers, validators, generators] = await Promise.all([
    listDir(sharedDir, 'checkers', true),
    listDir(sharedDir, 'validators', false),
    listDir(sharedDir, 'generators', false),
  ]);
  return { checkers, validators, generators };
}

/** Map `std:ncmp` to `checkers/ncmp.cpp` inside the shared directory. */
export function stdRefToPath(ref: string): string | null {
  if (!ref.startsWith(STD_PREFIX)) return null;
  const name = ref.slice(STD_PREFIX.length);
  if (!/^[\w-]+$/.test(name)) return null;
  return `checkers/${name}.cpp`;
}
