# Third-party components in PolyForge

PolyForge itself is licensed under the GNU Affero General Public License,
version 3 or (at your option) any later version; see `LICENSE`. The components
below remain under their own licenses.

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
build scripts are supplied as `PolyForge-<version>-source.zip` alongside the binaries
of every release (https://github.com/GetawayCar1024/polyforge/releases) and in the
public repository at the release tag.

The source archive contains all workspace packages, the dependency lockfile,
bundled assets, original upstream sources, and integration code. To build on
Windows with Node.js 20+ and pnpm, run `pnpm install --frozen-lockfile`, then
`pnpm desktop`. Build instructions are in README.md and docs/building.md
(`BUILDING.md` in the desktop app).

## Fonts and Typst packages

Fonts bundled for the OI renderer (`web/cnoi/fonts/` in the desktop app,
`packages/web/public/cnoi/fonts/` in the source), with their license texts and a
README in the same folder:

- Fira Mono — © 2012-2015 The Mozilla Foundation and Telefonica S.A.; SIL Open
  Font License 1.1 (`FiraMono-OFL.txt`).
- Latin Modern Roman — © 2003, 2009 B. Jackowski and J. M. Nowacki; GUST Font
  License (`GUST-FONT-LICENSE.txt`, based on `LPPL-1.3c.txt`).
- New Computer Modern Math — © 2019-2026 Antonis Tsolomitis; GUST Font License.

The CNOI template also uses SimSun, SimHei and KaiTi (© Beijing ZhongYi
Electronics, supplied with Microsoft Windows). Their license does not permit
redistribution, so PolyForge does not include them: it reads them from the
user's installed system fonts, or from the `fonts` folder of the PolyForge
global directory, and warns when they are missing.

The bundled Typst package archives (`mitex` and `oxifmt`) contain their upstream
licenses.

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
