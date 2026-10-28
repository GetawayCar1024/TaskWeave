/**
 * Build the desktop app (Electron) into packages/desktop/dist:
 *   packages/desktop/app/        sources for app.asar; runner.cpp is unpacked for g++
 *     main.cjs                   Electron main + the whole server, bundled with esbuild
 *     preload.cjs                window.taskweaveDesktop
 *     web/ assets/ runner/       the same layout as the npm package
 *   packages/desktop/dist/       TaskWeave-<version>-setup.exe and TaskWeave-<version>-portable.exe
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
const targetPlatform = process.argv.includes('--linux') ? 'linux' : process.argv.includes('--win') ? 'win32' : process.platform;
if (!['win32', 'linux'].includes(targetPlatform)) throw new Error('Desktop packaging supports Windows and Linux.');

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
   define: { 'import.meta.url': '__twImportMetaUrl' },
   banner: { js: "const __twImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
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
cpSync(path.join(root, 'packages/server/runner'), path.join(out, 'runner'), { recursive: true });
// Keep attribution, upstream source and integration source next to the shipped binary.
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) cpSync(path.join(root, name), path.join(out, name));
cpSync(path.join(root, 'docs/building.md'), path.join(out, 'BUILDING.md'));
// SimSun / SimHei / KaiTi may not be redistributed: never ship them, even if a local copy is lying around.
if (readdirSync(path.join(out, 'web/cnoi/fonts')).some(f => /^sim(sun|hei|kai)/i.test(f))) {
  console.error('app/web/cnoi/fonts contains non-redistributable fonts (SimSun / SimHei / KaiTi); remove them from packages/web/public/cnoi/fonts');
  process.exit(1);
}
const thirdParty = path.join(out, 'third-party');
mkdirSync(thirdParty, { recursive: true });
cpSync(path.join(root, 'packages/web/src/vendor/cnoi'), path.join(thirdParty, 'cnoi'), { recursive: true });
const integration = path.join(thirdParty, 'cnoi-integration');
mkdirSync(integration, { recursive: true });
for (const name of ['cnoi.worker.ts', 'cnoiTemplate.ts', 'cnoiDocument.ts', 'cnoi-notes.en.md']) {
  cpSync(path.join(root, 'packages/web/src/lib', name), path.join(integration, name));
}
cpSync(path.join(root, 'packages/web/src/components/OiContestPreview.vue'), path.join(integration, 'OiContestPreview.vue'));
const packageStore = path.join(root, 'node_modules/.pnpm');
for (const entry of readdirSync(packageStore, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const nm = path.join(packageStore, entry.name, 'node_modules');
  if (!existsSync(nm)) continue;
  const packageDirs = readdirSync(nm, { withFileTypes: true }).filter(x => x.isDirectory())
    .flatMap(x => x.name.startsWith('@') ? readdirSync(path.join(nm, x.name), { withFileTypes: true }).filter(y => y.isDirectory()).map(y => path.join(nm, x.name, y.name)) : [path.join(nm, x.name)]);
  for (const dir of packageDirs) {
    if (!existsSync(path.join(dir, 'package.json'))) continue;
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const destination = path.join(thirdParty, 'npm', `${pkg.name.replace(/[/\\]/g, '__')}@${pkg.version}`);
    mkdirSync(destination, { recursive: true });
    writeFileSync(path.join(destination, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, license: pkg.license, repository: pkg.repository }, null, 2));
    for (const license of readdirSync(dir, { withFileTypes: true })) {
      if (license.isFile() && /^(LICENSE|LICENCE|COPYING|NOTICE)(?:[.-]|$)/i.test(license.name)) cpSync(path.join(dir, license.name), path.join(destination, license.name));
    }
  }
}
writeFileSync(
  path.join(out, 'package.json'),
  JSON.stringify({ name: 'taskweave', productName: 'TaskWeave', version, description: 'Local-first problem preparation, judging and platform packages', main: 'main.cjs', author: 'TaskWeave', license: 'AGPL-3.0-or-later' }, null, 2),
);

if (appOnly) {
  console.log('packages/desktop/app built');
  process.exit(0);
}

// electron-builder: reuse the Electron that is installed; its own tools (NSIS, rcedit) from a mirror if set.
if (process.platform === 'win32') process.env.ELECTRON_BUILDER_BINARIES_MIRROR ??= 'https://npmmirror.com/mirrors/electron-builder-binaries/';
const require = createRequire(path.join(desk, 'package.json'));
const electronPkg = JSON.parse(readFileSync(require.resolve('electron/package.json'), 'utf8'));
const installedElectron = path.join(path.dirname(require.resolve('electron/package.json')), 'dist');
const { build, Platform, Arch } = require('electron-builder');
const files = await build({
  // Packaging is local; releases are published separately after review.
  publish: 'never',
  projectDir: desk,
  targets: (targetPlatform === 'linux' ? Platform.LINUX : Platform.WINDOWS).createTarget(dirOnly ? ['dir'] : targetPlatform === 'linux' ? ['AppImage', 'tar.gz'] : ['nsis', 'portable'], Arch.x64),
  config: {
    appId: 'dev.taskweave.desktop',
    productName: 'TaskWeave',
    directories: { app: out, output: path.join(desk, 'dist') },
    asar: true,
    asarUnpack: ['runner/**'],
    // The exe is never a plain Node (ELECTRON_RUN_AS_NODE, e.g. set by VS Code terminals, would
    // make it one and it would exit at once); also a hardening measure.
    electronFuses: { runAsNode: false },
    electronVersion: electronPkg.version,
    electronDist: targetPlatform === process.platform && existsSync(installedElectron) ? installedElectron : undefined,
    linux: { category: 'Development', executableName: 'taskweave', icon: path.join(desk, 'build/icon.png'), artifactName: 'TaskWeave-${version}-linux-${arch}.${ext}' },
    // Icon and version info go into the exe (rcedit); there is no code signing certificate.
    win: { target: dirOnly ? ['dir'] : ['nsis', 'portable'], icon: path.join(desk, 'build/icon.ico'), signExecutable: false },
    // Desktop and Start-menu shortcuts: TaskWeave starts with a double click.
    // Keep the existing uninstall/upgrade GUID while using the new application namespace.
    nsis: { guid: '900fe186-d19c-5f01-8401-fdfca40fd475', oneClick: false, allowToChangeInstallationDirectory: true, perMachine: false, shortcutName: 'TaskWeave', createDesktopShortcut: true, createStartMenuShortcut: true, runAfterFinish: true },
    portable: { artifactName: 'TaskWeave-${version}-portable.exe' },
    artifactName: 'TaskWeave-${version}-setup.${ext}',
  },
});
console.log(`desktop app built (TaskWeave ${version}):\n${files.map((f) => `  ${path.relative(root, f)}`).join('\n')}`);
