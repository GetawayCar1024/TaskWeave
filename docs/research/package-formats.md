# Luogu, Hydro, and LemonLime package formats

Research date: **2026-10-26**. Sources are official documentation and first-party source/fixtures only. Recommendations below are implementation decisions derived from those sources, rather than additional platform guarantees.

Source snapshots:

- Luogu documentation: [`luogu-dev/docs@9cd55c03`](https://github.com/luogu-dev/docs/tree/9cd55c03faf4ef0d66f8dfa9558d819821c30902).
- Hydro: [`hydro-dev/Hydro@0dba6c4a`](https://github.com/hydro-dev/Hydro/tree/0dba6c4ac1870a96ef83dc2b0e514142181b7075); documentation: [`hydro-dev/hydro-dev.github.io@7e6c11f7`](https://github.com/hydro-dev/hydro-dev.github.io/tree/7e6c11f7fa31a9b7523b1ce2860394e010393005).
- LemonLime: [`Project-LemonLime/Project_LemonLime@69aa2237`](https://github.com/Project-LemonLime/Project_LemonLime/tree/69aa22370706a4f14b394a6e27aa92e7eca4a8f5).

## Implementation conclusions

1. **Luogu single-problem delivery:** produce the requested `data.zip` with input/output files and **filename-keyed `config.yml` at ZIP root**. Include the requested `score.txt` as a companion containing a Luogu scoring script. The archive name `data.zip` and companion filename `score.txt` are product requirements: Luogu documents `config.yml` and a scoring language, but does **not** document automatic loading of `score.txt`. Its general upload instructions prohibit unrelated files. Thus automatic installation/acceptance of this companion is unverified; the script needs a separate scoring-configuration step. [Upload requirements][L-upload] · [Config][L-config] · [Scoring language][L-score]
2. **Luogu data/scoring import:** import per-case scores, limits, pretest flags, and subtask membership from `config.yml`; preserve the scoring script. Recover grouping policies/dependencies only for a script subset the importer actually understands. `subtaskId` alone does not encode an all-or-nothing policy or dependency graph. [Config][L-config] · [Scoring language][L-score]
3. **Hydro full import and testdata import are different operations.** A full package has `problem.yaml`, statements, `testdata/`, and `additional_file/` inside each problem directory. A testdata ZIP contains the contents of `testdata/`, including `config.yaml`. Hydro has separate code paths for these operations. [Format][H-format] · [Full importer][H-import] · [Testdata uploader][H-upload]
4. **Preserve all files and raw metadata.** Hydro's native exporter emits every testdata and additional file, not only `.in`/`.out` pairs. Keep original relative paths/bytes for unrecognized files and unsupported metadata so import/re-export does not erase checkers, headers, documents, statement assets, or future fields. This is especially important where the local model cannot express every scoring/checker feature. [Native exporter][H-export] · [Config types][H-types]
5. **Data-only LemonLime export can use its built-in comparator:** `comparisonMode: 1` (`Task::IgnoreSpacesMode`), `specialJudge: ""`. Its official fixture uses precisely this combination, including `.ans` reference outputs. No custom checker executable is required for this mode. Its actual semantics ignore more than trailing whitespace; see below. [Enum][M-enum] · [Official fixture][M-fixture] · [Dispatch][M-dispatch]

## 1. Luogu

### ZIP layout and limits

The documented upload is a **ZIP containing files directly at root**, with no enclosing problem directory. The documented limits are **50M compressed / 100M uncompressed**; these are website upload limits, not requirements for a local archival format. Each test filename must contain **exactly one contiguous numeric run**: `game001.in` is valid; `T1-1.in` and `game.in` are not. Use simple consecutive numbered export names and retain an original-to-exported name mapping. [L-upload]

A minimal documented data/config payload is:

```text
data.zip
├── sum1.in
├── sum1.out
└── config.yml
```

For the requested product delivery, add `score.txt` at that same root. There is no official documentation found for `score.txt` as an auto-imported data-package member; its contents can still be valid **official scoring-script syntax**. Keep that distinction in export instructions. The flat-layout/upload restrictions and script language are documented independently. [L-upload] [L-score]

Every traditional test needs **one input and one reference-output file**, even if the latter is empty for a special judge. Luogu's default comparison ignores line-ending spaces and final newlines; it is not described as a whitespace-token checker. Standard input/output is used for traditional submissions. The data-format guidance asks for Unix LF input, ASCII-compatible encoding, and normally a final newline. Preserve imported bytes; any newline normalization should be an explicit transformation. [L-data] [L-upload]

### `config.yml`: actual schema

This is a YAML mapping keyed by the **input OR output filename**, not a `cases:`/`subtasks:` document. Configure each pair once. Missing fields/cases receive Luogu's defaults, and later website changes override the uploaded configuration. YAML indentation must use spaces. [L-config]

| Field under a filename | Meaning |
| --- | --- |
| `timeLimit` | Time limit in milliseconds. |
| `memoryLimit` | Memory limit in KB as stated in the config documentation; Luogu's result API describes memory in KiB. Exporting a MiB value therefore uses `MiB * 1024`. |
| `score` | That test case's score. The official example uses `233`; do not invent a maximum of 100 for individual config entries. |
| `isPretest` | Boolean identifying a Codeforces-format **pretest**. This is not a statement-sample flag. |
| `subtaskId` | Membership in a subtask. This field supplies neither a group aggregation policy nor dependency edges. |

Sources: [config definition and example][L-config], [result API units/types][L-result]. There are no documented `checker`, `samples`, `dependencies`, or group-level `type` fields in this file. The published config page also does not specify a default score-splitting algorithm, numeric subtask-ID bounds, or precedence if both filenames configure the same pair. Do not guess those on import. [L-config]

Minimal `config.yml`:

```yaml
sum1.in:
  timeLimit: 1000
  memoryLimit: 262144
  score: 100
  subtaskId: 1
```

`sum1.in` may contain `1 2\n` and `sum1.out` may contain `3\n`. Either `sum1.in:` or `sum1.out:` is a valid config key. If an importer renames a reference answer from `.ans` to `.out`, resolve the old config key **before** renaming it. [L-config]

### `score.txt`: interpretation and constraints

**Treat the requested file as a scoring-script companion, not a numeric score table.** The official language is a small imperative language with assignments, arithmetic, comparisons, bitwise/logical operators, and nested conditionals. There is no documented `score.txt` table grammar or filename convention. An unknown numeric/text file with that name should be retained as an asset rather than silently reinterpreted as an official score format. [L-score]

Official language rules:

- Variables begin with `@`; the remainder can contain English letters, digits, and underscores.
- Assignments use `=`. Arithmetic supports `+`, `-`, `*`, `/`, `%`, parentheses, and C-like precedence.
- Operators include `and`, `or`, `not`, `xor`; comparisons include `==`, `!=`, `>=`, `>`, `<=`, `<`.
- Conditional form is `if CONDITION; then ... else ... fi`. Statements and the **condition before `then`** use semicolons. Multiple branches can be expressed by nested `if` statements.
- The input variables are `@statusX`, `@scoreX`, `@timeX`, `@memoryX`. **At subtask level, X denotes test-case IDs; at problem level, X denotes subtask IDs.** The script may also modify these input/result variables.
- Set all four result variables: `@total_score`, `@final_status`, `@final_time`, `@final_memory`.
- Documented test-case status constants are `AC`, `WA`, `TLE`, `MLE`; subtask/problem constants are `AC`, `UNAC`. Assigning an invalid status constant causes `UKE`.

All of these are specified by [L-score]. The official result API declares scores, times, and memory as integers. This supports integer score exports, but the script/config docs do not specify floating-point rounding, integer overflow, or division-by-zero behavior; retain exact imported text instead of inventing numeric semantics. [L-result]

#### Concrete grouped-scoring example

For three pairs `sum1.in/out`, `sum2.in/out`, `sum3.in/out`, use this `config.yml`:

```yaml
sum1.in:
  timeLimit: 1000
  memoryLimit: 262144
  score: 15
  subtaskId: 1
sum2.in:
  timeLimit: 1000
  memoryLimit: 262144
  score: 15
  subtaskId: 1
sum3.in:
  timeLimit: 1000
  memoryLimit: 262144
  score: 70
  subtaskId: 2
```

The following valid **problem-level** script awards 30 for passing subtask 1, then 70 for passing subtask 2 with dependency 1. It uses summed time and maximum memory. It assumes the subtask results supplied by Luogu accurately report `AC` only when all constituent cases pass. This script implements the desired bundled scoring; that behavior is not encoded by `subtaskId` alone. [L-config] [L-score]

```text
@total_score = 0;
if @status1 == AC; then
    @total_score = @total_score + 30;
fi
if (@status1 == AC) and (@status2 == AC); then
    @total_score = @total_score + 70;
fi
if @total_score == 100; then
    @final_status = AC;
else
    @final_status = UNAC;
fi
@final_time = @time1 + @time2;
@final_memory = @memory1;
if @memory2 > @final_memory; then
    @final_memory = @memory2;
fi
```

Store this text as the requested `score.txt`. Configure it as the **whole-problem scoring script** in Luogu; filename inclusion alone is not a documented installation mechanism. An additive group can instead contribute `@scoreX`, provided the subtask's own scoring computes the intended sum. [L-score]

**Import consequences:** a general script can calculate scores from time/memory, combine cases with arbitrary Boolean conditions, and rewrite result variables. It cannot in general be reduced losslessly to `{group points, min/sum policy, dependencies}`. Implement a parser/recognizer for the exporter-produced subset, preserving raw script and scope; distinguish fully reconstructed scoring from merely retained scoring. Preserve explicit zero scores. Keep time/memory aggregation independent of point aggregation. These recommendations follow from the expressive operations in [L-score].

### Checker, samples, metadata, and answer suffixes

- A Luogu SPJ is **`checker.cpp` at archive root**, uses Testlib, and also requires the website's **Special Judge** tag. Current docs name Testlib 0.9.45 and `g++ -fno-asm -std=c++14 -O2`. A `checker:` YAML field does not install it. CF-format tasks also need `validator.cpp`. [L-spj]
- Interactive tasks use root `interactive_lib.cpp` and the **交互题** tag. IO-interactive tasks use `checker.cpp` as the interactor plus an empty `interactive_lib.cpp`. Preserve these assets rather than classifying every source as an ordinary checker. [L-interactive]
- The documented data upload/config is not a full-problem statement package. The creation workflow saves a statement separately and then uploads data. Neither statement language/attachments nor sample text has a field in `config.yml`; `isPretest` must remain distinct. [L-upload] [L-config]
- **Export recommendation:** emit `.in`/`.out` pairs. **Import recommendation:** accept existing `.ans` reference files as well, match by stem or an explicit source-format mapping, and retain original filenames. The cited Luogu package pages do not enumerate all accepted answer suffixes, so this recommendation should not be presented as a verified Luogu `.ans` upload guarantee. Hydro and LemonLime support `.ans` explicitly, as documented below. [L-config] [L-data] [H-auto] [M-fixture]

## 2. Hydro testdata packages

### Layout and configuration discovery

A testdata-only ZIP is a collection of data files and optional `config.yaml`, conventionally flat:

```text
testdata.zip
├── config.yaml
├── 1.in
├── 1.ans
└── notes.txt
```

The website's **testdata file upload** unpacks ZIP entries and adds them as testdata. It does not interpret `problem.yaml` as a new problem, import statements, or route attachments to `additional_file`. It passes entry names through `sanitize-filename`, so nested paths are not preserved as native directories by this upload path. Use a flat testdata ZIP for interoperability; locally retain an original path map instead of flattening colliding names. [H-upload]

The judge checks `config.yaml`, then `config.yml`, then legacy `config.ini`; **`.yaml` wins when both YAML spellings exist**. Canonical export should use `config.yaml`. The website additionally recognizes `Config.yaml`/`Config.yml` when updating its stored config, while the judge's disk lookup is lowercase; canonical lowercase avoids that mismatch. [H-readcases] [H-config-events]

With no explicit case list, Hydro discovers numbered `.in` files paired with `.out` or `.ans`; `sample.in` is not auto-discovered because it has no number. The documented defaults are **1 second / 256 MB**. Explicit `cases` entries can reference filenames without digits. [H-testdata] [H-auto]

### Actual `config.yaml` fields

| Field | Import/export meaning |
| --- | --- |
| `type` | `default`, `interactive`, `communication`, `submit_answer`, `objective`, or `remote_judge`; default is the ordinary output-comparison problem type. Preserve the actual type. |
| `time`, `memory` | Global limits, overridden by subtask limits and then individual case limits. Prefer explicit unit strings such as `1000ms`, `1s`, `256m`. |
| `subtasks` | List of subtask objects: `id`, `type`, `score`, `if`, `time`, `memory`, `cases`. |
| `subtasks[].type` | `min`, `max`, or `sum`; unspecified normalized type is `min`. |
| `subtasks[].if` | Array of required **subtask IDs**. Preserve ID relationships, not merely positions in an unsorted array. |
| `cases` / `subtasks[].cases` | List of `{input, output, score?, time?, memory?}`. Paths refer to files in the testdata namespace, not to `<problem>/testdata/...`. |
| Top-level `cases` | Legacy shorthand still supported in current source. A nonempty list **overrides `subtasks`** and becomes one `sum` subtask. Prefer `subtasks` for new exports. |
| `checker_type` | Current editor enum: `default`, `strict`, `lemon`, `syzoj`, `hustoj`, `testlib`, `qduoj`, `kattis`. This selects the checker protocol, not its filename. |
| `checker` | Source filename or built-in Testlib checker name. Schema also accepts `{file, lang}`. A name without a dot is resolved in Hydro's bundled Testlib checkers. |
| `interactor`, `manager`, `validator` | Source reference, schema permits string or `{file, lang}`. These have distinct roles. |
| `user_extra_files`, `judge_extra_files` | Lists of testdata files supplied to contestant compilation/execution or judge-side programs. Preserve every referenced file and each list independently. |
| `filename` | File-IO basename: `foo` means `foo.in`/`foo.out`; omit for standard IO. |
| `langs` | Allowed **submission language IDs**, e.g. `cc` or `cc.cc11o2`; these are not statement languages. |
| `time_limit_rate`, `memory_limit_rate` | Per-submission-language multipliers; overrides combine with judge/language configuration. |
| Other fields | Preserve `detail`, `subType`, `target`, `answers`, `redirect`, `template`, `num_processes`, `multi_pass`, and unrecognized metadata even when unsupported locally. The editor schema and runtime type declarations are not identical. |

Sources: [official testdata docs][H-testdata], [editor schema][H-schema], [runtime types][H-types], [case reader][H-yaml], [normalizer][H-normalize], [extra-file/compiler handling][H-compile].

**Units:** the runtime treats numeric/bare integer time as **milliseconds**, numeric/bare integer memory as **MiB**. Suffixed time accepts `s`, `ms`, `us`; memory accepts case-insensitive `k/m/g` with optional `b`, using 1024-based conversions. Time conversion floors to milliseconds; memory conversion rounds up to MiB. Prefer unit strings to avoid `time: 1` accidentally meaning 1 ms. Limits inherit **case > subtask > global > defaults**; language rates are applied afterward. [H-units] [H-normalize] [H-readcases]

### Scoring and dependency gotchas

- **`min`:** the subtask's result is the minimum of its case scores. With an ordinary AC/WA checker, a 30-point group should give each case a possible **30**, not `30 / caseCount`; the group then contributes 30 only if every case passes. `max` takes the maximum, and `sum` adds case scores. [H-normalize] [H-flow]
- **Defaults:** the normalizer apportions the remaining part of 100 among subtasks with unspecified/falsy scores. Within a `sum` subtask, it similarly distributes its remaining score among unspecified/falsy case scores. Integer remainders go to later entries. In non-`sum` groups, unspecified case score is the full subtask score. [H-normalize]
- **Zero is a gotcha:** the runtime uses `score || default` and `!score`, so explicit `0` can be treated as unspecified and replaced. The editor schema describes scores as integers from **1 to 100**, while the runtime normalizer does not enforce that schema. Avoid using a zero-score subtask as the universal representation of samples; retain imported zeros/raw config and surface the representability issue. [H-schema] [H-normalize]
- **Top-level `score` is not a safe total-score mechanism:** although present in the schema, top-level `cases` is wrapped as `{cases, type: 'sum'}` without transferring that score to the subtask. Encode scores in explicit subtasks/cases. [H-schema] [H-yaml] [H-normalize]
- **Use explicit positive IDs**, for example `id: 1` followed by `id: 2, if: [1]`. The docs' old example uses `if: [0]` without an explicit `id: 0`; current normalization defaults IDs to **1-based**, and the flow checks dependencies by result ID. Do not copy the old example literally. [H-testdata] [H-normalize] [H-flow]
- For emitted dependency graphs, order IDs topologically and retain direct edges. The flow suppresses scoring when a required subtask failed and propagates dependency failure while walking subtasks; unknown dependency IDs are not validated here. A failed prerequisite is not equivalent to merely earning less than full score under a custom checker. [H-flow]
- Auto-discovery prefers `.out` candidates before `.ans`, including some uppercase/`.txt` variants. Numbered group names such as `a1_1.in` can infer `min` subtasks; ungrouped numbered pairs infer `sum`. When an explicit config names outputs, it wins. Export explicit lists to avoid accidental regrouping or ambiguity. Preserve the unselected answer file as an extra asset. [H-auto] [H-yaml] [H-readcases]
- An explicit case's `output` is optional in the editor schema; normalization maps an omitted output to `/dev/null`. That can be intentional for a custom checker, and is different from failing to find a named answer file. A built-in-comparator LemonLime export still needs actual reference-output files. Preserve this distinction when importing SPJ-only data. [H-schema] [H-normalize] [M-compare]

### Minimal compatible testdata config

For the `1.in`/`1.ans` archive above:

```yaml
type: default
time: 1s
memory: 256m
checker_type: default
subtasks:
  - id: 1
    type: sum
    score: 100
    cases:
      - input: 1.in
        output: 1.ans
        score: 100
```

`checker_type: default` needs no checker source. Hydro implements it by trimming trailing spaces/tabs/CR and terminal empty lines before comparison; `strict` takes a separate comparison path. A custom Testlib checker can instead be configured with `checker_type: testlib` and `checker: chk.cc`; `checker: wcmp` selects a bundled Testlib checker. The docs recommend `.cc` with the default language configuration; extension/ID handling depends on installed judge languages. Testlib `wcmp` compares whitespace-separated tokens, so do not silently map it to a line-preserving comparison. [H-checkers] [H-compile] [H-yaml] [H-testdata] [H-wcmp]

Concrete grouped example (files `a1.in/out`, `a2.in/out`, `b1.in/ans`, `b2.in/ans`):

```yaml
type: default
time: 1s
memory: 256m
checker_type: default
subtasks:
  - id: 1
    type: min
    score: 30
    cases:
      - input: a1.in
        output: a1.out
        time: 500ms
      - input: a2.in
        output: a2.out
  - id: 2
    type: sum
    score: 70
    if: [1]
    time: 2s
    memory: 512m
    cases:
      - input: b1.in
        output: b1.ans
        score: 35
      - input: b2.in
        output: b2.ans
        score: 35
```

Here each group-1 case defaults to a possible 30 points; group 1 contributes at most 30, and group 2 contributes at most 70 only when dependency 1 passes. The case-specific 500 ms override must survive import. [H-normalize] [H-flow]

## 3. Hydro whole-problem packages

### Native directory structure

The documented exchange format permits multiple immediate problem directories with arbitrary folder names:

```text
problems.zip
└── a-plus-b/
    ├── problem.yaml
    ├── problem_zh.md
    ├── problem_en.md
    ├── testdata/
    │   ├── config.yaml
    │   ├── 1.in
    │   ├── 1.ans
    │   └── helper.txt
    └── additional_file/
        ├── diagram.png
        └── handout.pdf
```

Use the preceding minimal testdata config in `testdata/config.yaml`. The **full importer also accepts `problem.yaml` at ZIP root** as a single problem. Otherwise it checks immediate child directories for that file; it is not a recursive search through unlimited wrapper directories. The native exporter uses numeric problem directories, but folder names are not the problem's displayed PID. [H-format] [H-import] [H-export]

Minimal metadata compatible with the documented legacy format and the current importer:

```yaml
pid: P1000
title: A + B
tag:
  - arithmetic
```

`title` is required in practice (current source accepts `name` as a fallback). `pid` is optional; invalid/conflicting IDs can be reassigned. Current PID validation allows a letter-leading alphanumeric ID, optionally prefixed by a registered namespace and `-`. Tags are imported from `tag`, not `tags`. Current import also handles `difficulty` and `hidden`; title is trimmed. [H-import]

Native exports contain `owner`, `nSubmit`, `nAccept`, and (CLI export) `difficulty`. The importer does **not** simply restore all exported fields: its operator normally determines the new owner, and it does not restore the exported submission/accept counters. Preserve these as source metadata when local import needs lossless archival retention rather than manufacturing local submission history. [H-export] [H-import]

For native Hydro packages, judging limits belong in `testdata/config.yaml`. The full importer's compatibility paths can also convert `problem.yaml`'s `limits.time_limit` (seconds) and `limits.memory` into judge config, or read `domjudge-problem.ini`'s `timelimit`. These compatibility overrides are separate from the native metadata schema; retain their source values when encountered. [H-import]

### Statements, languages, samples, attachments

**Legacy/doc format:** `problem_zh.md`, `problem_zh_CN.md`, `problem_en.md`, etc. carry Markdown statements. Language codes can be short or full. `additional_file/` stores downloadable/renderable attachments, referenced as `file://filename` from the statement. [H-format]

The current legacy finder also recognizes `problem.<language>.md` and PDF variants. It checks plain `problem.md` first, then `problem.pdf`, then language-suffixed files. Thus a plain `problem.md` takes precedence over multilingual files. It searches the problem root, then `statement/`, then `problem_statement/`; absent an override, it falls back to `problem.yaml`'s `content`, including legacy JSON-string language maps, and its `html` flag. Preserve the original formats rather than renaming every statement to one English Markdown file. [H-legacy] [H-manifest] [H-content]

**Current native manifest format:** current official source/export has added an explicit `statements` list to `problem.yaml`. Support this **as well as** the documented legacy naming convention. [H-manifest] [H-export]

```yaml
pid: P1000
title: A + B
tag: [arithmetic]
statements:
  - name: zh.md
    lang: zh
    source: problem_zh.md
  - name: en.md
    lang: en
    source: problem_en.md
  - name: handout.pdf
    lang: en
    file: handout.pdf
```

In that example, the two `source` files sit next to `problem.yaml`; `file: handout.pdf` points to **`additional_file/handout.pdf`**. Each entry must have a unique safe filename `name`, a nonempty `lang`, and **exactly one of `source` or `file`**. Both references must be simple filenames without path separators and must exist as files. `source` cannot be `problem.yaml`. The presence of `statements`, even `statements: []`, disables the legacy fallback. The exporter writes textual entries as `problem_${entry.name}` and binary entries as additional-file references. [H-manifest] [H-export]

**Samples live in statement markup**, using corresponding numbered fences; there is no `samples` or per-case `sample` property in the native testdata schema. [H-statement-docs] [H-schema]

````markdown
## A + B

Print the sum of the two integers.

```input1
1 2
```

```output1
3
```

![Diagram](file://diagram.png)
[Handout](file://handout.pdf)
````

Hydro groups `input1`/`output1` together for sample display. A full importer should retain this syntax, extract paired samples when the local model supports them, and keep each statement's language association. An actual `sample1.in` in auto-discovered **testdata** can become a scored case; an attachment or statement sample is not automatically a scored case. [H-statement-docs] [H-auto]

### Extra files and full-import boundaries

- Preserve **every** `testdata/*` file (including unused outputs, configs, SPJs, headers, scripts, generators) and **every** `additional_file/*` attachment; the exporter copies those namespaces wholesale. Ordinary attachments are not automatically judge-side files. Lists such as `judge_extra_files` are explicit semantic references into testdata. [H-export] [H-yaml] [H-compile]
- Preserve statement sources and unknown metadata as well as the normalized title/cases. Current imports validate manifest source references before importing, so dropping a source or PDF can invalidate the entire problem import. [H-manifest]
- Hydro's full importer also has compatibility branches for ICPC-like `attachments/`, `generators/`, `include/`, `data/*`, `output_validators/`, `statement/`, `problem_statement/`, `solution/`, `std/`, and `submissions/`. These are not synonymous with the native `additional_file/` directory. For example, `attachments`/`include` files may populate both extra-file lists; `solution/*` becomes solutions; up to five `std/*` files are submitted as reference programs. Preserve these source roles/assets rather than silently treating all of them as test pairs. [H-import]
- The native full importer flattens some one-level nested testdata/compatibility directories and reads only direct files from `additional_file/`. For portable native exports, keep each namespace flat and resolve name collisions explicitly; for local archival import, preserve original relative paths and avoid destructive basename-only flattening. [H-import]
- Treat the full package as a problem-creation/import operation and the testdata ZIP as data for a selected problem. Detecting `.in` files somewhere inside an archive is insufficient to choose the operation. A full import must also recover statements, language variants, samples, tags/title/PID, attachments, limits, scoring, and checker configuration. [H-import] [H-upload]

## 4. LemonLime built-in comparator and `.cdf`

### Exact enum and persisted value

`Task::ComparisonMode` is a zero-based C++ enum:

| Value in `.cdf` | Enum |
| --- | --- |
| `0` | `LineByLineMode` |
| **`1`** | **`IgnoreSpacesMode`** |
| `2` | `ExternalToolMode` |
| `3` | `RealNumberMode` |
| `4` | `LemonSpecialJudgeMode` |
| `5` | `TestlibSpecialJudgeMode` |

The task JSON field is **`comparisonMode`**, persisted as a number, and the reader casts it back to the enum. The UI label is **“Line-by-line mode (ignore extra spaces and tabs)”**, translated as **“逐行比较模式（忽略多余空格和制表符）”**. `IgnoreSpacesMode` is also the Task constructor's default. [M-enum] [M-task-json] [M-label] [M-translation]

Use `comparisonMode: 1` and `specialJudge: ""` for the requested built-in choice. Mode 1 directly invokes `compareIgnoreSpaces`; modes 4/5 invoke external special judges. Do not require checker compilation/protocol preflight for mode 1. A complete set of imported inputs/reference answers is sufficient to construct the problem's judge data, without a generator or reference-solution source. [M-dispatch] [M-fixture]

### Whitespace semantics: important distinction

Despite the shorthand “ignore trailing whitespace”, the implementation is **token comparison with line-position checks**:

- It skips `std::isspace` characters while reading tokens, including extra spaces/tabs within a line and leading whitespace.
- Equal token chunks must appear on the same line; mismatched line numbers produce **PresentationError** with score 0.
- Once both readers reach EOF it accepts without comparing final line numbers, permitting trailing whitespace/newlines.
- It recognizes LF, CR, and CRLF as line terminators.

Therefore `1  2\t\n` and `1 2\n` compare equal, but moving the second token to the next line can produce PE. This built-in mode is broader than Luogu/Hydro's documented trailing-whitespace-only default comparator. Preserve that distinction in any checker mapping or label. [M-reader] [M-compare] [L-data] [H-checkers]

### Concrete minimal `.cdf` example

Current LemonLime saves JSON `.cdf` files. The top-level format version is the **string** `"1.0"`; the reader also tolerates its absence. Write the JSON with `{` as its first byte: the loader selects the JSON path from the first byte, so a BOM or preceding whitespace can incorrectly select the old binary loader. [M-save-load] [M-contest-json]

```text
contest.zip
├── contest.cdf
├── data/
│   └── sum/
│       ├── 1.in
│       └── 1.ans
└── source/
```

`contest.cdf` (derived from the official fixture and serializers):

```json
{
  "version": "1.0",
  "contestTitle": "Imported data",
  "contestants": [],
  "tasks": [
    {
      "problemTitle": "A + B",
      "sourceFileName": "sum",
      "inputFileName": "sum.in",
      "outputFileName": "sum.out",
      "standardInputCheck": true,
      "standardOutputCheck": true,
      "taskType": 0,
      "subFolderCheck": false,
      "comparisonMode": 1,
      "diffArguments": "--ignore-space-change --text --brief",
      "realPrecision": 3,
      "specialJudge": "",
      "compilerConfiguration": { "g++": "default" },
      "answerFileExtension": "out",
      "testCases": [
        {
          "fullScore": 100,
          "timeLimit": 1000,
          "memoryLimit": 256,
          "inputFiles": ["sum/1.in"],
          "outputFiles": ["sum/1.ans"]
        }
      ]
    }
  ]
}
```

The field names/types and `.ans` output reference are demonstrated by [M-fixture], [M-task-json], [M-case-json], and [M-contest-json]. Important details:

- `inputFiles`/`outputFiles` paths are **relative to `data/`**, so do not write `data/sum/1.in` into the JSON. The working directory is set to the `.cdf` directory, and the judger prefixes the configured data path. [M-save-load] [M-paths] [M-judge]
- Case time is integer **ms** and memory is integer **MiB**; `fullScore` is an integer. [M-case-json] [M-case-types] [M-limit-ui]
- `taskType: 0` is Traditional; **data-only authoring** is not LemonLime's `AnswersOnly` submission type. The standard-IO booleans permit normal contestant stdin/stdout submissions. [M-enum] [M-dispatch]
- `answerFileExtension: "out"` is used to locate contestant files in **AnswersOnly** mode; it does not require reference answers to end in `.out`. Explicit `outputFiles` may name `.ans`, as in the official fixture. [M-judge] [M-fixture]
- A LemonLime `testCases` entry can bundle multiple input/output pairs and takes their minimum score. To represent additive tests, use separate entries with their individual scores. Dependency IDs are one-based previous entries; serialization appends the exact sentinel string such as `"1_lemon_SUbtaskDEPENDENCE_fLAg"` to `inputFiles` and does not add a corresponding output filename. [M-case-json] [M-judge]
- All pairs bundled in one entry share its `timeLimit`/`memoryLimit`. Preserve source per-case limits or explicitly address this representational difference when converting a group with heterogeneous limits. [M-case-json] [M-judge]

## Primary source index

### Luogu

- [L-upload]: official problem workflow, upload layout/limits, standard IO.
- [L-config]: official filename-keyed `config.yml` schema and precedence.
- [L-data]: traditional data requirements and default comparison semantics.
- [L-score]: scoring language, scopes, variables, statuses, and example.
- [L-spj]: SPJ file naming, Testlib version, upload/tag requirements.
- [L-interactive]: interactive library/checker packaging.
- [L-result]: official OpenAPI scoring result types and units.

### Hydro

- [H-format], [H-testdata], [H-statement-docs]: official exchange-format, testdata, and statement documentation.
- [H-import], [H-manifest], [H-legacy], [H-export]: actual full-import/export and statement precedence.
- [H-upload], [H-config-events]: testdata ZIP handling and config-name recognition.
- [H-types], [H-schema], [H-yaml], [H-readcases]: runtime/editor schemas and config loading.
- [H-auto], [H-normalize], [H-flow], [H-units]: pairing, scores, dependencies, and limits.
- [H-checkers], [H-compile], [H-content]: comparison, extra-file/compiler, and statement handling. [H-wcmp] is the official Testlib checker at the commit Hydro vendors.

### LemonLime

- [M-enum], [M-label], [M-translation], [M-task-json]: comparator enum, UI name, persistence.
- [M-reader], [M-compare], [M-dispatch]: actual whitespace behavior and checker selection.
- [M-fixture], [M-save-load], [M-contest-json], [M-case-json]: official fixture and `.cdf` serialization.
- [M-paths], [M-judge], [M-case-types], [M-limit-ui]: paths, grouping/dependencies, and units.

[L-upload]: https://help.luogu.com.cn/manual/luogu/problem/
[L-config]: https://help.luogu.com.cn/manual/luogu/problem/testcase-config
[L-data]: https://help.luogu.com.cn/manual/luogu/problem/testcase-format
[L-score]: https://help.luogu.com.cn/manual/luogu/problem/scoring-script
[L-spj]: https://help.luogu.com.cn/manual/luogu/problem/special-judge
[L-interactive]: https://help.luogu.com.cn/manual/luogu/problem/interactive-problems
[L-result]: https://github.com/luogu-dev/lgapi-docs/blob/e09c79271d382fd9d6c6925e2bc57da839c8482b/openapi/judge.yaml
[H-format]: https://github.com/hydro-dev/hydro-dev.github.io/blob/7e6c11f7fa31a9b7523b1ce2860394e010393005/content/docs/Hydro/user/problem-format.md#L5-L41
[H-testdata]: https://github.com/hydro-dev/hydro-dev.github.io/blob/7e6c11f7fa31a9b7523b1ce2860394e010393005/content/docs/Hydro/user/testdata.mdx#L5-L134
[H-statement-docs]: https://github.com/hydro-dev/hydro-dev.github.io/blob/7e6c11f7fa31a9b7523b1ce2860394e010393005/content/docs/Hydro/user/problem.mdx#L43-L66
[H-import]: https://github.com/hydro-dev/Hydro/blob/0dba6c4ac1870a96ef83dc2b0e514142181b7075/packages/hydrooj/src/model/problem.ts#L571-L838
[H-manifest]: https://github.com/hydro-dev/Hydro/blob/0dba6c4ac1870a96ef83dc2b0e514142181b7075/packages/hydrooj/src/model/problem.ts#L658-L725
[H-legacy]: https://github.com/hydro-dev/Hydro/blob/0dba6c4ac1870a96ef83dc2b0e514142181b7075/packages/hydrooj/src/model/problem.ts#L56-L72
[H-export]: https://github.com/hydro-dev/Hydro/blob/0dba6c4ac1870a96ef83dc2b0e514142181b7075/packages/hydrooj/src/model/problem.ts#L840-L911
[H-upload]: https://github.com/hydro-dev/Hydro/blob/0dba6c4ac1870a96ef83dc2b0e514142181b7075/packages/hydrooj/src/handler/problem.ts#L746-L803
[H-config-events]: https://github.com/hydro-dev/Hydro/blob/0dba6c4ac1870a96ef83dc2b0e514142181b7075/packages/hydrooj/src/model/problem.ts#L915-L932
[H-types]: https://github.com/hydro-dev/Hydro/blob/0dba6c4ac1870a96ef83dc2b0e514142181b7075/packages/common/types.ts#L1-L66
[H-schema]: https://github.com/hydro-dev/Hydro/blob/0dba6c4ac1870a96ef83dc2b0e514142181b7075/packages/ui-default/components/monaco/schema/problemconfig.ts#L1-L123
[H-yaml]: https://github.com/hydro-dev/Hydro/blob/0dba6c4ac1870a96ef83dc2b0e514142181b7075/packages/common/cases.ts#L5-L50
[H-readcases]: https://github.com/hydro-dev/Hydro/blob/0dba6c4ac1870a96ef83dc2b0e514142181b7075/packages/hydrojudge/src/cases.ts#L72-L117
[H-auto]: https://github.com/hydro-dev/Hydro/blob/0dba6c4ac1870a96ef83dc2b0e514142181b7075/packages/common/subtask.ts#L30-L132
[H-normalize]: https://github.com/hydro-dev/Hydro/blob/0dba6c4ac1870a96ef83dc2b0e514142181b7075/packages/common/subtask.ts#L144-L180
[H-flow]: https://github.com/hydro-dev/Hydro/blob/0dba6c4ac1870a96ef83dc2b0e514142181b7075/packages/hydrojudge/src/flow.ts#L16-L139
[H-units]: https://github.com/hydro-dev/Hydro/blob/0dba6c4ac1870a96ef83dc2b0e514142181b7075/framework/utils/lib/common.ts#L161-L180
[H-checkers]: https://github.com/hydro-dev/Hydro/blob/0dba6c4ac1870a96ef83dc2b0e514142181b7075/packages/hydrojudge/src/checkers.ts#L62-L134
[H-wcmp]: https://github.com/MikeMirzayanov/testlib/blob/2d20123984e9479b8a56ebe0d6a51e23ad7c35b3/checkers/wcmp.cpp
[H-compile]: https://github.com/hydro-dev/Hydro/blob/0dba6c4ac1870a96ef83dc2b0e514142181b7075/packages/hydrojudge/src/task.ts#L210-L264
[H-content]: https://github.com/hydro-dev/Hydro/blob/0dba6c4ac1870a96ef83dc2b0e514142181b7075/packages/hydrooj/src/lib/content.ts#L26-L62
[M-enum]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/core/task.h#L22-L36
[M-label]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/forms/taskeditwidget.ui#L211-L253
[M-translation]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/translations/zh_CN.ts#L2448-L2452
[M-task-json]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/core/task.cpp#L241-L383
[M-reader]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/core/casejudger.cpp#L162-L215
[M-compare]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/core/casejudger.cpp#L276-L340
[M-dispatch]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/core/casejudger.cpp#L691-L831
[M-fixture]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/tests/data/TestContest1/TestContest1.cdf
[M-save-load]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/lemon.cpp#L603-L703
[M-contest-json]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/core/contest.cpp#L228-L297
[M-case-json]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/core/testcase.cpp#L74-L151
[M-paths]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/base/settings.cpp#L709-L713
[M-judge]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/core/taskjudger.cpp#L420-L552
[M-case-types]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/core/testcase.h#L17-L51
[M-limit-ui]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/forms/testcaseeditwidget.ui#L338-L469
