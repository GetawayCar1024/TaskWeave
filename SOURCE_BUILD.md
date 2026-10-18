# Building PolyForge 0.3.0

The release includes `PolyForge-0.3.0-source.zip`, an archive of the exact tagged
source tree, with vendored CNOI sources, templates, fonts, lockfile and build scripts.
It excludes personal problem data, credentials, node_modules and build output.

On Windows x64, install Node.js 20+ and pnpm (the release uses pnpm 11.20.0), then:

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm desktop
```

The installer and portable executable are written to `packages/desktop/dist/`.
For an app directory without installers:

```powershell
pnpm build
node scripts/build-desktop.mjs --app-only
```

Running local judging additionally requires g++ (MinGW-w64) on PATH. No TeX
installation is needed for the bundled OI renderer. Dependency installation
requires network access; the installed renderer's fonts and WASM are local.

See THIRD_PARTY_NOTICES.md and the original license files included with the
source for third-party provenance and license terms.
