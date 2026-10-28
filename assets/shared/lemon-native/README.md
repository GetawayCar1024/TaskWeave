# LemonLime native comparisons for local judging

`comparator.cpp` adapts the reader and comparison algorithms from
Project-LemonLime/Project_LemonLime commit
`69aa22370706a4f14b394a6e27aa92e7eca4a8f5`, `src/core/casejudger.cpp`.

Original authors and GPL-3.0-or-later notices are preserved in the source.
TaskWeave changes dated 2026-10-28 remove Qt, accept already-selected modes and
precision, open Unicode paths on Windows, and report verdicts as exit codes.
See the accompanying `LICENSE` for GNU GPL version 3.

Build with `g++ -std=c++17 -O2 comparator.cpp -o comparator` (append `.exe` on Windows).
Arguments: `MODE PRECISION INPUT CONTESTANT_OUTPUT REFERENCE_ANSWER`.
Modes: `0` line-by-line, `1` ignore extra spaces/tabs, `3` real numbers.
Exit codes: `0` OK, `1` WA, `2` PE, `3` checker failure, `4` output limit.

The 32-byte text chunks, EOF ordering, C `long double` scanning and asymmetric
reference-character consumption follow the pinned native implementation.
The executable is a local helper. Native Lemon exports select CDF modes 0/1/3
directly and do not bundle it as a special judge. Existing `lemon:*` checker
templates use the separate Testlib for Lemons protocol.
