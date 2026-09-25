import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locations of bundled files. Two layouts are supported:
 *  - the monorepo (sources run with tsx): <root>/assets, <root>/packages/server/runner,
 *    <root>/packages/web/dist
 *  - the release package (bundled, `npx polyforge`): <root>/assets, <root>/runner,
 *    <root>/web
 * The root is the nearest ancestor of this module that contains assets/templates.
 */
function findRoot(): string {
  if (process.env.POLYFORGE_ROOT) return path.resolve(process.env.POLYFORGE_ROOT);
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(dir, 'assets', 'templates'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('PolyForge: cannot find the assets directory');
    dir = parent;
  }
}

export const ROOT = findRoot();

const first = (...candidates: string[]) => candidates.find((p) => existsSync(p)) ?? candidates[0];

export const ASSETS_DIR = path.join(ROOT, 'assets');
export const RUNNER_SRC = first(path.join(ROOT, 'runner', 'runner.cpp'), path.join(ROOT, 'packages', 'server', 'runner', 'runner.cpp'));
export const WEB_DIST = first(path.join(ROOT, 'web'), path.join(ROOT, 'packages', 'web', 'dist'));
