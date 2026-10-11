/**
 * Build the desktop app (Electron) into packages/desktop/dist:
 *   packages/desktop/app/        what goes into the app (no asar: g++ needs runner.cpp on disk)
 *     main.cjs                   Electron main + the whole server, bundled with esbuild
 *     preload.cjs                window.polyforgeDesktop
 *     web/ assets/ runner/       the same layout as the npm package
 *   packages/desktop/dist/       PolyForge Setup <version>.exe (installer) and PolyForge <version>.exe (portable)
 *
 * Usage: pnpm desktop            (pnpm desktop -- --dir: unpacked app only, for a quick try)
 */
import { build as esbuild } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desk = path.join(root, 'packages/desktop');
const out = path.join(desk, 'app');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const dirOnly = process.argv.includes('--dir');
/** --app-only: just packages/desktop/app (run it with the installed Electron). */
const appOnly = process.argv.includes('--app-only');

if (!existsSync(path.join(root, 'packages/web/dist/index.html'))) {
  console.error('packages/web/dist is missing: run `pnpm build` first');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = { bundle: true, platform: 'node', target: 'node22', sourcemap: false, legalComments: 'none', logLevel: 'warning', external: ['electron', 'bufferutil', 'utf-8-validate'] };
await esbuild({
  ...common,
  entryPoints: [path.join(desk, 'src/main.ts')],
  outfile: path.join(out, 'main.cjs'),
  // CommonJS: there Electron always gives its own 'electron' module (ESM resolution can pick
  // an 'electron' npm package from a parent node_modules). import.meta.url for the server's
  // path lookups comes from the bundle's own file.
  format: 'cjs',
  define: { 'import.meta.url': '__pfImportMetaUrl' },
  banner: { js: "const __pfImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
});
await esbuild({ ...common, entryPoints: [path.join(desk, 'src/preload.cts')], outfile: path.join(out, 'preload.cjs'), format: 'cjs' });

cpSync(path.join(root, 'packages/web/dist'), path.join(out, 'web'), { recursive: true });
const webAssets = readdirSync(path.join(out, 'web/assets'));
if (!existsSync(path.join(out, 'web/index.html')) || !webAssets.some((f) => f.endsWith('.js'))) {
  console.error('app/web is incomplete');
  process.exit(1);
}
cpSync(path.join(root, 'assets'), path.join(out, 'assets'), { recursive: true });
cpSync(path.join(desk, 'build/icon.png'), path.join(out, 'icon.png'));
mkdirSync(path.join(out, 'runner'));
cpSync(path.join(root, 'packages/server/runner/runner.cpp'), path.join(out, 'runner/runner.cpp'));
writeFileSync(
  path.join(out, 'package.json'),
  JSON.stringify({ name: 'polyforge', productName: 'PolyForge', version, description: 'Local-first problem preparation for Codeforces Polygon', main: 'main.cjs', author: 'PolyForge', license: 'UNLICENSED' }, null, 2),
);

if (appOnly) {
  console.log('packages/desktop/app built');
  process.exit(0);
}

// electron-builder: reuse the Electron that is installed; its own tools (NSIS, rcedit) from a mirror if set.
process.env.ELECTRON_BUILDER_BINARIES_MIRROR ??= 'https://npmmirror.com/mirrors/electron-builder-binaries/';
const require = createRequire(path.join(desk, 'package.json'));
const electronPkg = JSON.parse(readFileSync(require.resolve('electron/package.json'), 'utf8'));
const { build } = require('electron-builder');
const files = await build({
  // Packaging is local; releases are published separately after review.
  publish: 'never',
  projectDir: desk,
  config: {
    appId: 'dev.polyforge.desktop',
    productName: 'PolyForge',
    directories: { app: out, output: path.join(desk, 'dist') },
    asar: false,
    // The exe is never a plain Node (ELECTRON_RUN_AS_NODE, e.g. set by VS Code terminals, would
    // make it one and it would exit at once); also a hardening measure.
    electronFuses: { runAsNode: false },
    electronVersion: electronPkg.version,
    electronDist: path.join(path.dirname(require.resolve('electron/package.json')), 'dist'),
    // Icon and version info go into the exe (rcedit); there is no code signing certificate.
    win: { target: dirOnly ? ['dir'] : ['nsis', 'portable'], icon: path.join(desk, 'build/icon.ico'), signExecutable: false },
    // Desktop and Start-menu shortcuts: PolyForge starts with a double click.
    nsis: { oneClick: false, allowToChangeInstallationDirectory: true, perMachine: false, shortcutName: 'PolyForge', createDesktopShortcut: true, createStartMenuShortcut: true, runAfterFinish: true },
    portable: { artifactName: 'PolyForge-${version}-portable.exe' },
    artifactName: 'PolyForge-${version}-setup.${ext}',
  },
});
console.log(`desktop app built (PolyForge ${version}):\n${files.map((f) => `  ${path.relative(root, f)}`).join('\n')}`);
