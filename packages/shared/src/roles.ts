import type { FileNode, ProblemToml } from './problem.js';
import { STD_PREFIX } from './problem.js';

export type FileRole =
  | 'config'
  | 'statement'
  | 'tutorial'
  | 'validator'
  | 'checker'
  | 'interactor'
  | 'generator'
  | 'solution'
  | 'test'
  | 'validator-test'
  | 'checker-test'
  | 'resource'
  | 'other';

/** Order in which role groups are shown in the sidebar. */
export const ROLE_ORDER: FileRole[] = [
  'config',
  'statement',
  'tutorial',
  'validator',
  'checker',
  'interactor',
  'generator',
  'solution',
  'test',
  'validator-test',
  'checker-test',
  'resource',
  'other',
];

const SOURCE_EXT = /\.(cpp|cc|cxx|c|py|java|kt|pas|rs|go|js)$/i;

const sameFile = (a: string | undefined, b: string) =>
  !!a && !a.startsWith(STD_PREFIX) && a.replace(/^\.\//, '') === b;

/**
 * Determine the role of a file. Conventions (DESIGN §3.3) come first; problem.toml
 * only adds what conventions cannot express.
 */
export function classifyFile(path: string, config: ProblemToml | null): FileRole {
  if (path === 'problem.toml') return 'config';
  if (/^statement\/[^/]+\/tutorial\.tex$/.test(path)) return 'tutorial';
  if (path.startsWith('statement/images/') && !/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(path)) return 'other';
  if (path.startsWith('statement/')) return 'statement';
  if (path.startsWith('tests/')) return 'test';
  if (path.startsWith('validator-tests/')) return 'validator-test';
  if (path.startsWith('checker-tests/')) return 'checker-test';
  // Registered roles win over the files/ convention, so a source registered from
  // files/ is shown under its role rather than hidden among the resources.
  if (config) {
    if (sameFile(config.validator?.source, path)) return 'validator';
    if (sameFile(config.checker?.source, path)) return 'checker';
    if (sameFile(config.interactor?.source, path)) return 'interactor';
    if (config.solutions.some((s) => sameFile(s.source, path))) return 'solution';
    if (config.generators.some((g) => sameFile(g.source, path))) return 'generator';
  }
  if (path.startsWith('files/')) return 'resource';
  if (path.startsWith('solutions/')) return 'solution';
  if (path.startsWith('generators/')) return 'generator';
  const base = path.includes('/') ? '' : path.replace(SOURCE_EXT, '');
  if (base && SOURCE_EXT.test(path)) {
    if (base === 'validator' || base === 'val') return 'validator';
    if (base === 'checker' || base === 'check' || base === 'chk') return 'checker';
    if (base === 'interactor' || base === 'interact') return 'interactor';
  }
  return 'other';
}

/**
 * Statement and tutorial languages of a problem. Every statement language should have
 * a tutorial and vice versa: the tutorial is a per-language part of the statement.
 */
export function statementLanguages(files: { path: string; size?: number }[]) {
  const statement = new Set<string>();
  const tutorial = new Set<string>();
  for (const f of files) {
    const m = f.path.match(/^statement\/([^/]+)\/([^/]+)\.tex$/);
    if (!m || m[1] === 'images' || (f.size ?? 1) === 0) continue;
    (m[2] === 'tutorial' ? tutorial : statement).add(m[1]);
  }
  const langs = [...statement].sort();
  return {
    statement: langs,
    tutorial: [...tutorial].sort(),
    /** Statement languages without a (non-empty) tutorial. */
    missingTutorial: langs.filter((l) => !tutorial.has(l)),
    /** Tutorials in a language that has no statement. */
    orphanTutorial: [...tutorial].filter((l) => !statement.has(l)).sort(),
  };
}

export function flattenFiles(tree: FileNode[]): FileNode[] {
  const out: FileNode[] = [];
  const walk = (nodes: FileNode[]) => {
    for (const n of nodes) {
      if (n.type === 'file') out.push(n);
      else if (n.children) walk(n.children);
    }
  };
  walk(tree);
  return out;
}

export function isSourceFile(path: string): boolean {
  return SOURCE_EXT.test(path);
}
