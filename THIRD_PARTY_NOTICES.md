# Third-party components in PolyForge 0.3.0

## CNOI statement generator

Source: https://github.com/Mr-Python-in-China/cnoi-statement-generator

Pinned commit: 43d437ba80d2cd42e04344d59928cfa23fdeb569 (2.0.6).
License: GNU Affero General Public License, version 3; see
`third-party/cnoi/LICENSE` in the desktop app or
`packages/web/src/vendor/cnoi/LICENSE` in the source archive.

The original compiler and Typst template sources, upstream notes template and
attribution are included under `third-party/cnoi/` in the desktop app.
PolyForge's integration and English adaptation are included under
`third-party/cnoi-integration/`. The full corresponding application source and
build scripts are supplied as `PolyForge-0.3.0-source.zip` alongside the binaries:
https://github.com/GetawayCar1024/polyforge/releases/tag/v0.3.0

The source archive contains all workspace packages, the dependency lockfile,
bundled assets, original upstream sources, and integration code. To build on
Windows with Node.js 20+ and pnpm, run `pnpm install --frozen-lockfile`, then
`pnpm desktop`. Build instructions are also in README.md and SOURCE_BUILD.md.
The repository and release retain their existing private visibility.

## Fonts and Typst packages

The OI renderer retains the original CNOI font set for the owner's private use.
The CNOI software license does not replace font-specific licensing terms.
The bundled Typst package archives (`mitex` and `oxifmt`) contain their upstream
licenses. Do not interpret this private release as granting additional rights
to redistribute fonts or other third-party assets.

## Testlib for Lemons

Source: https://github.com/GitPinkRabbit/Testlib-for-Lemons

Pinned commit: ce95947b3894572e6664c8906bf8768d26c7a77e.
MIT license and original notices: `assets/shared/lemon/LICENSE` and `testlib.h`.
Ordinary testlib is retained separately with its notices in `assets/shared/testlib.h`.

## JavaScript dependencies

The desktop build includes license and notice files found in the installed
dependency packages under `third-party/npm/`; each folder includes a small
package metadata file identifying its name, version and declared license.
Electron's own license and Chromium notices are included by electron-builder.

Individual components remain subject to their respective licenses. This notice
does not change copyright ownership or replace the enclosed license texts.
