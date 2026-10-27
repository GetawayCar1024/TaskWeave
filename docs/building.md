# Building Taskweave

Each release includes `Taskweave-<version>-source.zip`, an archive of the exact tagged
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
Desktop resources use `app.asar`; `runner/runner.cpp` is unpacked alongside it so g++
can compile the local judge without extracting all application resources.
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
Taskweave reads them from the system fonts (Windows includes them) or from the
`fonts` folder of the Taskweave global directory. The desktop build refuses to
package them if copies are placed in `packages/web/public/cnoi/fonts/`.

See `THIRD_PARTY_NOTICES.md` and the license files included with the source for
third-party provenance and license terms. Taskweave itself is licensed under
AGPL-3.0-or-later (`LICENSE`).

## Application identity and icons

The approved master icon is `assets/branding/taskweave.svg`. Run `pnpm icons` to
regenerate the 512px desktop PNG, multi-size ICO and browser assets with the
installed Electron renderer. Generated icons are included in the source archive.

New installations use `~/.taskweave`; an existing `~/.polyforge/config.toml` is
automatically reused when no Taskweave configuration exists. `TASKWEAVE_HOME`,
`TASKWEAVE_ROOT` and `TASKWEAVE_TOKEN` also accept their `POLYFORGE_*` aliases.
Installer identity, private workspace package names and on-disk format markers
retain their compatible identifiers so older projects and exported packages work.
