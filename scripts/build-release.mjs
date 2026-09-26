/**
 * Build a self-contained npm package in release/ (DESIGN §9 M5: "npx 一键启动"):
 *   release/
 *     package.json        name "polyforge", bin "polyforge", no runtime dependencies
 *     bin/polyforge.mjs   launcher
 *     server.mjs          the whole server bundled with esbuild
 *     web/                built frontend
 *     assets/             defaults copied into ~/.polyforge on first start
 *     runner/runner.cpp   compiled with the local g++ on first use
 *
 * Usage: pnpm release        (then `npm pack` in release/, or `npx ./release`)
 */
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'release');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;

if (!existsSync(path.join(root, 'packages/web/dist/index.html'))) {
  console.error('packages/web/dist is missing: run `pnpm build` first');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, 'bin'), { recursive: true });

await build({
  entryPoints: [path.join(root, 'packages/server/src/index.ts')],
  outfile: path.join(out, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: false,
  legalComments: 'none',
  // Native accelerators of ws are optional and loaded in try/catch.
  external: ['bufferutil', 'utf-8-validate'],
  // CommonJS dependencies call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __pfCreateRequire } from 'node:module'; const require = __pfCreateRequire(import.meta.url);" },
  logLevel: 'warning',
});

cpSync(path.join(root, 'packages/web/dist'), path.join(out, 'web'), { recursive: true });
// Never ship a package without the frontend (a half-finished copy once left web/ empty).
const webAssets = existsSync(path.join(out, 'web/assets')) ? readdirSync(path.join(out, 'web/assets')) : [];
if (!existsSync(path.join(out, 'web/index.html')) || !webAssets.some((f) => f.endsWith('.js')) || !webAssets.some((f) => f.endsWith('.css'))) {
  console.error('release/web is incomplete (index.html and the JS / CSS assets are required)');
  process.exit(1);
}
cpSync(path.join(root, 'assets'), path.join(out, 'assets'), { recursive: true });
mkdirSync(path.join(out, 'runner'));
cpSync(path.join(root, 'packages/server/runner/runner.cpp'), path.join(out, 'runner/runner.cpp'));
cpSync(path.join(root, 'README.md'), path.join(out, 'README.md'));

writeFileSync(
  path.join(out, 'bin/polyforge.mjs'),
  `#!/usr/bin/env node
// PolyForge launcher: starts the local server and opens the browser.
import('../server.mjs');
`,
);

writeFileSync(
  path.join(out, 'package.json'),
  JSON.stringify(
    {
      name: 'polyforge',
      version,
      description: 'Local-first problem preparation for Codeforces Polygon',
      type: 'module',
      bin: { polyforge: 'bin/polyforge.mjs' },
      files: ['bin', 'server.mjs', 'web', 'assets', 'runner', 'README.md'],
      engines: { node: '>=20' },
      os: ['win32'],
      license: 'UNLICENSED',
    },
    null,
    2,
  ) + '\n',
);
console.log(`release/ built (polyforge ${version})`);
