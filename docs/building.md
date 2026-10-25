# Building PolyForge

Each release includes `PolyForge-<version>-source.zip`, an archive of the exact tagged
source tree with the vendored CNOI sources, templates, bundled fonts, lockfile and build
scripts. It excludes personal problem data, credentials, node_modules and build output.
The same source is available from the public repository at the release tag.

On Windows x64, install Node.js 20+ and pnpm, then:

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

The OI template also uses SimSun, SimHei and KaiTi. Their license does not permit
redistribution, so they are not part of the source or the binaries: at run time
PolyForge reads them from the system fonts (Windows includes them) or from the
`fonts` folder of the PolyForge global directory. The desktop build refuses to
package them if copies are placed in `packages/web/public/cnoi/fonts/`.

See `THIRD_PARTY_NOTICES.md` and the license files included with the source for
third-party provenance and license terms. PolyForge itself is licensed under
AGPL-3.0-or-later (`LICENSE`).
