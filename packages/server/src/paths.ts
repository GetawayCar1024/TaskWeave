import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { legacyEnv } from '@taskweave/shared';

/**
 * Locations of bundled files. Two layouts are supported:
 *  - the monorepo (sources run with tsx): <root>/assets, <root>/packages/server/runner,
 *    <root>/packages/web/dist
 *  - the desktop package (bundled): <root>/assets, <root>/runner,
 *    <root>/web
 * The root is the nearest ancestor of this module that contains assets/templates.
 */
function findRoot(): string {
  const override = process.env.TASKWEAVE_ROOT || process.env[legacyEnv('ROOT')];
  if (override) return path.resolve(override);
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(dir, 'assets', 'templates'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('TaskWeave: cannot find the assets directory');
    dir = parent;
  }
}

export const ROOT = findRoot();

const first = (...candidates: string[]) => candidates.find((p) => existsSync(p)) ?? candidates[0];

export const ASSETS_DIR = path.join(ROOT, 'assets');
const runnerFile = process.platform === 'linux' ? 'runner-linux.cpp' : 'runner.cpp';
export const RUNNER_SRC = first(...(ROOT.endsWith('.asar') ? [path.join(ROOT + '.unpacked', 'runner', runnerFile)] : []), path.join(ROOT, 'runner', runnerFile), path.join(ROOT, 'packages', 'server', 'runner', runnerFile));
export const WEB_DIST = first(path.join(ROOT, 'web'), path.join(ROOT, 'packages', 'web', 'dist'));
