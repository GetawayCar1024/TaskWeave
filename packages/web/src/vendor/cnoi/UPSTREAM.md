# Bundled CNOI statement generator

Source: https://github.com/Mr-Python-in-China/cnoi-statement-generator

Pinned commit: `43d437ba80d2cd42e04344d59928cfa23fdeb569` (2.0.6).

`compiler/`, `cnoi/unifiedPlugins.ts` and `cnoi/typst/` are unchanged upstream sources.
`notes.md` is upstream `examples/CSP-S2024/extra-precaution.md`.
The fonts in `public/cnoi/fonts/` are the fonts listed in upstream `templates/cnoi/fonts.ts`,
except SimSun, SimHei and KaiTi: their license does not permit redistribution, so PolyForge
loads them from the user's system fonts (see `packages/server/src/systemFonts.ts`).
Typst packages `mitex:0.2.5` and `oxifmt:1.0.0` are bundled with their original licenses.

Upstream is AGPL-3.0; see LICENSE. PolyForge's integration code lives outside this directory.
Distribution of this integrated component must preserve attribution and satisfy AGPL source and license obligations; the private status of this repository does not remove those obligations.

PolyForge supplies contest data and converts Polygon TeX/hybrid source to upstream Markdown.
Upstream owns Markdown → Typst conversion and all OI page layout. The embedded worker uses the same Typst compiler version as upstream (0.7.0-rc2).

PolyForge adaptations (2026-10-18): `lib/cnoiTemplate.ts` localizes template labels,
date formatting, headings and page numbers for English documents at compilation
time; it also removes a leading blank line in generated footnote bodies to align
markers with the first text line. Section headings retain upstream 【】 brackets
in both languages. Vendored files remain unchanged.

PolyForge adaptations (2026-10-25): the cover, overview tables and instructions
are optional (`pf_toc` in content.json; tutorials never have them), with extra
space above the instructions; English paragraphs are slightly tighter; footnotes
are emitted by PolyForge as per-section endnotes (as in the CF statements) instead
of upstream page footnotes.
`lib/cnoi-notes.en.md` is PolyForge's English translation of upstream `notes.md` and
is covered by the upstream license. SVG previews use the upstream Typst renderer
version and the same document as PDF exports.
