# Building TaskWeave

Each release includes `TaskWeave-<version>-source.zip`, an archive of the exact tagged
source tree with the vendored CNOI sources, templates, bundled fonts, lockfile and build
scripts. It excludes personal problem data, credentials, node_modules and build output.
The same source is available from the public repository at the release tag.

On Windows x64, install Node.js 20+ and pnpm, then:

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm desktop
```

The installer and portable executable are written to `packages/desktop/dist/`.

On Linux x64, use `node scripts/build-desktop.mjs --linux` after building the web
frontend. It produces AppImage and tar.gz packages. The native Linux runner is
compiled with g++ on first use. See [Linux build and validation](linux.md).
Desktop resources use `app.asar`; `runner/runner.cpp` is unpacked alongside it so g++
can compile the local judge without extracting all application resources.
For an app directory without installers:

```powershell
pnpm build
node scripts/build-desktop.mjs --app-only
```

Running local judging additionally requires g++ on PATH (MinGW-w64 on Windows). No TeX
installation is needed for the bundled OI renderer. Dependency installation
requires network access; the installed renderer's fonts and WASM are local.

The OI template also uses SimSun, SimHei and KaiTi. Their license does not permit
redistribution, so they are not part of the source or the binaries: at run time
TaskWeave reads them from the system fonts (Windows includes them) or from the
`fonts` folder of the TaskWeave global directory, which is the only location
searched on Linux. The desktop build refuses to
package them if copies are placed in `packages/web/public/cnoi/fonts/`.

See `THIRD_PARTY_NOTICES.md` and the license files included with the source for
third-party provenance and license terms. TaskWeave itself is licensed under
AGPL-3.0-or-later (`LICENSE`).

## Application identity and icons

The approved master icon is `assets/branding/taskweave.svg`. Run `pnpm icons` to
regenerate the 512px desktop PNG, multi-size ICO and browser assets with the
installed Electron renderer. Generated icons are included in the source archive.

The global profile and workspace state use `.taskweave`. `TASKWEAVE_HOME`,
`TASKWEAVE_ROOT` and `TASKWEAVE_TOKEN` configure locations and local API access.
Private packages use `@taskweave/*`; desktop IPC, API headers and new package
metadata use the same namespace. Upgrade readers migrate old state and preserve
identities, editor preferences, histories and original-answer backups.
