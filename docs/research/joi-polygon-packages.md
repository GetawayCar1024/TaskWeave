# JOI/AtCoder in/out ZIPs and Polygon problem packages

Research date: **2026-10-27**. Target: **PolyForge 0.3.4**. This note supplements [package-formats.md](./package-formats.md). Platform claims below come from official documentation, platform developers, or actual archives published by contest organizers. Proposed PolyForge conventions are identified explicitly.

Source snapshots: Polygon's official API documentation at [`Codeforces/polygon-misc@8430c507`](https://github.com/Codeforces/polygon-misc/tree/8430c5076f7bcf39dd079ca0c34d46ed23fa459c); Hydro source at [`0dba6c4a`](https://github.com/hydro-dev/Hydro/tree/0dba6c4ac1870a96ef83dc2b0e514142181b7075). Luogu's live help pages were checked against the sources in the preceding note.

## Implementation conclusions

1. **Offer “JOI/AtCoder-style in/out ZIP” as a directory-pair format.** A real JOI task ZIP has `in/01-01.txt` and `out/01-01.txt`; a contest ZIP can contain several problem directories with this structure. The directory names establish input/output roles; `.txt` alone does not. Preserve the complete original relative filenames and bytes. [J-ambulance] [J-2027-data]
2. **There is no universal JOI/AtCoder scoring manifest established by these sources.** JOI publishes contest-specific scoring information separately as TXT or PDF; sampled data ZIPs contain no config. If PolyForge needs round-trip limits, scoring, dependencies, and names, document a **PolyForge companion**, such as `polyforge.yaml`, rather than claiming that `config.yaml` is a JOI or AtCoder standard. [J-2025-page] [J-2026-score] [J-c2-score]
3. **Do not derive authoritative subtasks from `xxx-yyy`.** Official JOI scoring sets overlap and can include selected tests from other filename prefixes and samples. Keep test identity separate from scoring-set membership. [J-2026-score] [J-c2-score]
4. **Polygon ZIP import is descriptor-driven full-problem import.** Import names, statements/tutorials, sample presentation, testsets, group policies/dependencies, sources and their roles, checker/validator tests, and additional assets. API synchronization is a separate operation; local ZIP import need not bind to a Polygon account/problem ID. [P-example] [P-nerc-zip] [P-api]
5. **“Full” is a build option, not a fourth ZIP variant.** Polygon builds `standard`, `linux`, and `windows` packages. Standard lacks generated test data; Linux and Windows contain generated tests. Materialized tests plus sources make the Linux-style variant the useful target for a portable local full export. [P-api-packages]
6. **Polygon complete-group scoring is not the minimum of the stored XML test-point numbers.** Real packages put a group's entire weight on one case and zero on the others. For ordinary AC/WA judging, translate that to an all-pass bundle with the group's total weight. Preserve raw test weights for re-export. [P-groups] [P-roi-zip]
7. **Native per-subtask/per-case limits are format-dependent.** Hydro supports both; Luogu supports per-case limits, so group limits can be expanded onto member cases. Polygon places limits on a **testset**, with no verified native group/case limit field. The JOI in/out directory format stores none. [H-normalize] [L-config] [P-example]
8. **Scan first, then select problems.** A real Polygon contest ZIP contains `contest.xml` and thirteen `problems/<slug>/problem.xml` files. A real JOI ZIP contains six `<problem>/in` and `<problem>/out` pairs. The selection key must include the archive prefix, not just a basename, title, or local numeric test index. [P-nerc-zip] [J-2027-data]

## 1. JOI/AtCoder-style testcase directories

### Actual first-party archives inspected

For small ZIPs, the complete archive was read. For large ZIPs, the complete ZIP central directory was read using HTTP ranges; selected XML/script/data entries were decompressed and CRC-checked. Directory observations do not imply that every large testcase was downloaded or executed.

| Official artifact | Verified contents |
| --- | --- |
| JOI 2025 spring training, **Ambulance**: `ambulance-data.zip`, **51,681 bytes** | Exactly **139 input/output pairs**: `in/01-01.txt` … `in/07-32.txt`, with varying counts per prefix, plus `in/sample-01.txt` … `sample-04.txt`; identical names under `out/`. No enclosing problem folder, statement, or configuration file. [J-ambulance] |
| JOI 2026/2027 first qualifier, first round: `2027-yo1a-data.zip`, **51,525,540 bytes** | Six roots, `2027-yo1a-t1/` … `2027-yo1a-t6/`, each containing `in/` and `out/`. **241 pairs** total; no files outside those `.txt` pairs. Central-directory order is not natural filename order. [J-2027-page] [J-2027-data] |
| JOI 2025/2026 semifinal: `2026-sf-data.zip`, **684,252,845 bytes** | Six roots, `2026-sf-t1/` … `2026-sf-t6/`; **619 pairs** total, all in/out `.txt`. Scoring TXT is linked separately on the official download page. [J-2026-page] [J-2026-data] [J-2026-score] |
| JOI 2025 practice **Ramen**: `ramen-data.zip`, **6,985 bytes** | **Input-only**: fifteen `in/01-01.txt`-style files and `in/s-01.txt`. Separate `ramen-cms.zip` contains `manager.cpp`, `ramen.h`, `stub.cpp`, `stub_preload.cpp`; `ramen-dist.zip` contains `compile.sh`, `grader.cpp`, `ramen.cpp`, `ramen.h`, `sample-01-in.txt`. This is a different task type, not a broken ordinary output-comparison ZIP. [J-spring-page] [J-ramen-data] [J-ramen-cms] [J-ramen-dist] |

SHA-256 of the complete Ambulance ZIP: `ce76638198520ff8626085f1a50d05f557ab9593ff2b8db3947257fa256daf2c`.

Concrete contents of its first sample:

```text
in/sample-01.txt          out/sample-01.txt
6 4 8                    Yes
1 3
2 2
3 4
5 5
```

Both files use LF and finish with a newline in this archive. That is an observation about this fixture, not permission to normalize every imported dataset. [J-ambulance]

Supported discovery shapes should include:

```text
single.zip                  contest.zip
├── in/                     ├── 2027-yo1a-t1/
│   ├── 01-01.txt            │   ├── in/01-01.txt
│   └── sample-01.txt        │   └── out/01-01.txt
└── out/                    └── 2027-yo1a-t2/
    ├── 01-01.txt                ├── in/01-01.txt
    └── sample-01.txt            └── out/01-01.txt
```

These are directly supported by the first two fixtures. Accepting an additional wrapper directory is a useful **importer convenience**. Do not require exactly three digits on each side of the hyphen: the official files above use two. Accept arbitrary matching relative names under `in/` and `out/`; treat a numeric prefix only as an optional grouping suggestion. [J-ambulance] [J-2027-data]

### Where JOI scoring and limits actually live

The 2025 finals page links data, statements, solutions, and `2025-ho-score.txt` separately. Its TXT uses forms such as:

```text
2025-ho-t1 色塗り (Grid Coloring)
time_limit: 2.0
memory_limit: 1024
Subtask 1 (15): "01-*", "sample-01", "sample-02", "sample-03", "04-05", "04-04"
Subtask 2 (10): "02-*", "01-*", "sample-01", "sample-02", "sample-03", "04-04", "04-05"
...
Subtask 5 (30): "*"
% セット名 (配点): ファイル名
```

The official AtCoder statement agrees on **2 seconds / 1024 MiB** and subtask weights **15, 10, 20, 25, 30**. [J-2025-score] [A-joi-a]

The 2026 semifinal TXT has a different presentation: `Subtask1` without a space, generally unquoted selectors, a mixture of `01-*`, `sample-02*`, and `sample-02.txt`, and an explicit `Sample (0): sample*` for problem 5. This is useful source metadata, but not evidence for a single stable machine-readable grammar or auto-loaded ZIP filename. [J-2026-score]

For **Ambulance**, the separate scoring PDF gives weights **4, 8, 5, 18, 15, 31, 19**. Subtask 1 includes `01-*`, `sample-01`, `sample-02`, `sample-03`, **and `02-01`**. Subtask 7 includes `*`. Other subtasks include selected files from several prefixes. [J-c2-score, page 1][J-c2-score]

Consequences for importing:

- Preserve the original TXT/PDF and source link. An optional parser for a **recognized contest-specific TXT dialect** may resolve selectors against the discovered names; it should retain the selectors and explicit resolved membership.
- Preserve shared case membership. A case can belong to more than one scoring set without being physically duplicated. Converting overlaps to dependencies is exact only where the sets really are unions of complete prerequisite sets plus residual tests. Otherwise retain overlapping membership or explicitly duplicated logical memberships.
- Treat samples as presentation metadata independently of scoring. A sample can participate in a scored subtask; `sample-*` does not universally mean “exclude from judging” or “worth zero.” Conversely `s-01.txt` shows that `sample-` is not the sole official sample naming style.
- If scoring/limits are absent, import the pairs with that metadata **unknown**. Any proposed 100-point allocation, limits, or prefix-derived subtasks are local defaults, not recovered facts.

These recommendations follow from the actual overlapping selectors and separate artifacts above. [J-2025-score] [J-2026-score] [J-c2-score] [J-ramen-data]

### AtCoder evidence and scope

AtCoder's first-party announcement says its Dropbox testcase publication was suspended; its current official links page still marks testcases non-public. The current AtCoder Datasets page advertises licensed full test data, checkers, and scoring config, but publishes **no exchange-config schema**. Thus there is no current publicly documented universal AtCoder `config.yml`/`config.yaml` to implement from those sources. Historical ABC/ARC/AGC Dropbox ZIP conventions could not be revalidated against a currently available official download in this research. [A-suspension] [A-links] [A-datasets]

JOI's 2026 semifinal rules explicitly say the competition used AtCoder, while JOI itself publishes its data ZIP and scoring TXT. Those downloads provide a current first-party example for the requested in/out workflow. They establish that workflow, not every internal AtCoder package detail. [J-2026-rules] [J-2026-page]

Other AtCoder task types need their own handling. For example, AHC001 publishes a Rust input-generator/visualizer tool ZIP and a task-specific quality-scoring formula, rather than an ordinary exact-answer in/out package. A directory called `in` is insufficient to identify the judging protocol. [A-ahc]

AtCoder's ordinary output-format relaxation permits replacing or adding whitespace characters (CR/LF/space/tab), unless a statement overrides this. This is closer to whitespace-token comparison than Hydro/Luogu's trailing-whitespace-only default, so keep checker semantics in imported metadata rather than choosing solely by archive layout. [A-rules]

### Proposed PolyForge companion: product convention only

**Recommendation, not an official JOI/AtCoder format:** place optional `polyforge.yaml` next to each problem's `in/` and `out/`. Require a format marker and version; do not interpret an arbitrary `config.yml` as this schema.

```yaml
format: polyforge-inout
version: 1
problem:
  name: sum
  title: { en: A + B }
  time_ms: 1000
  memory_mib: 256
cases:
  - id: "01-01"
    input: in/01-01.txt
    output: out/01-01.txt
    sample: true
  - id: "01-02"
    input: in/01-02.txt
    output: out/01-02.txt
  - id: "02-01"
    input: in/02-01.txt
    output: out/02-01.txt
  - id: "02-02"
    input: in/02-02.txt
    output: out/02-02.txt
subtasks:
  - id: small
    aggregation: min
    points: 30
    time_ms: 500
    memory_mib: 128
    cases: ["01-01", "01-02"]
    dependencies: []
  - id: large
    aggregation: sum
    test_points: 35
    time_ms: 2000
    memory_mib: 512
    cases: ["02-01", "02-02"]
    dependencies: [small]
```

Suggested contract:

- Paths are relative to the selected problem root, with original names preserved. Case and subtask IDs are strings, including leading zeroes. Subtasks reference case IDs, allowing overlaps without name rewriting.
- `min` means one bundle worth `points`; with binary AC/WA cases it contributes that weight iff every member passes. `sum` with `test_points` means **that same weight for each member**; the displayed group maximum is `caseCount * test_points`, not an independent total silently divided among tests.
- Optional per-case score/limit overrides can retain imported heterogeneous data. Heterogeneous sum scores should remain explicit rather than being silently converted to a uniform weight.
- Define inheritance as **case > subtask > problem**. For a case referenced by two groups with different limits, the memberships have different effective judge contexts; a single shared execution at the larger limit is not equivalent.
- `sample` does not imply a score or group. Preserve unknown keys/files and original scoring documents. Native bare in/out export remains useful when only testcase bytes are requested; export with the companion when PolyForge round-tripping is requested.

The local file provides capabilities absent from the bare archive; it does not install limits or scoring in JOI/AtCoder's judging systems.

## 2. Polygon: first-party evidence and package variants

### Verified fixtures

| Source | What it establishes |
| --- | --- |
| Polygon development-team announcement and its directly linked [`problem.xml`][P-example] | Complete machine-readable example: English/Russian statements, named groups, both scoring policies, dependencies, resources, executables, checker and validator tests, solution tags and extra tags. [P-groups] |
| NERC 2025 organizers' `nef-2025-archive.zip`, **142,328,919 bytes** | Real contest ZIP with `contest.xml`, thirteen `problems/<slug>/problem.xml` descriptors, sources, statement sections/JSON/TeX/HTML/PDF, generated image assets, scripts, and Windows executables. In `medical-parity`, XML declares 28 tests, but only manual `tests/01` is stored: `doall.sh` generates the other inputs and **all** `.a` answers. This demonstrates standard-package contents. [P-nerc-page] [P-nerc-zip] |
| Russian Olympiad 2025 organizers' `ru-olymp-roi-2025-archive.zip`, **3,024,459,512 bytes** | Eight problem roots `1/` … `8/`, with Polygon descriptors and materialized `tests/NN` / `tests/NN.a`; zero-score sample groups; `feedback-policy`; complete-group weights concentrated on single tests; checker-percent mode; extra solution tags. `1/` contains all 89 declared pairs. [P-school-2025] [P-roi-zip] |
| Regional Olympiad 2026 organizers' archive | Important mixed-format fixture: `day1/1/problem.xml` is a different judge descriptor (`version="1.0"`, `id="ru.olymp.spb..."`); the original Polygon descriptor is **`day1/1/problem.xml.polygon`**. Seven such renamed Polygon descriptors were inspected. `day2/6` also demonstrates `feedback-policy="points"`. [P-school-2026] [P-regional-zip] |

Descriptor SHA-256 values, useful to reproduce this inspection:

- NERC `problems/medical-parity/problem.xml`: `ef346298bea3a8bf4912a01e17c2e79463be03bb9a5b1dfe6f954841a117eb5b`.
- ROI `1/problem.xml`: `d043d6936a740224520bc9ae42afe22c14a4bbe3b521919ba9279d33bc858a91`.
- ROI `4/problem.xml`: `2606f7de6d0ac8f3740bfa705491e38ffbb471a66398671aeb8d723aa3d8b8cd`.

The ROI archive is an organizer distribution, not a guarantee of an untouched Polygon download variant: for example, its XML references `.exe` files absent from the archive. Its central directory also lacks the declared **`2/tests/323.a`**. Classify available tests and assets by actual references and entries; do not equate a “full” label with complete referential integrity. The available `1/tests/01` and `1/tests/01.a` were fetched and CRC-checked; they use CRLF. [P-roi-zip]

### Standard, Linux, Windows, and “Full”

The current official API documents: [P-api-packages]

| Download `type` | Generated tests | Compiled programs | Implication |
| --- | --- | --- | --- |
| `standard` (default) | Not included | Windows executables; Windows scripts and Linux-via-Wine scripts | Inputs marked `generated` and reference answers may require building the package. |
| `linux` | Included | No compiled binaries | Suitable reference profile for source-plus-materialized-data exchange. |
| `windows` | Included | Windows binaries included | Also usable for importing the testcase bytes and source metadata. |

`problem.buildPackage(full=true)` creates all three variants; `full=false` creates only standard. There is **no documented `type=full`**. Verification is a separate `verify` build parameter. A standard package with absent generated inputs is not malformed just because the local importer cannot execute its generator. [P-api-packages]

**PolyForge recommendation:** preserve the descriptor, source programs, commands, and available data when importing standard archives, recording unresolved generated tests. Full export should materialize the selected testsets and their answers, or state exactly which references remain unresolved. Imported provided answers must stay authoritative. Generator execution/answer generation is an explicit judging/build operation, not filename detection.

The official help describes exported ZIPs as packages used by online judges and a separate “Add tests from archive” feature. The API provides individual authoring operations and package downloads. These sources do not establish a universal “upload this full ZIP to Polygon and restore the entire problem” endpoint. Implementing local Polygon ZIP import/export therefore does not by itself implement API synchronization. [P-manual] [P-api]

### Multiple problems and descriptor discovery

The NERC contest structure is:

```text
nef-2025-archive.zip
├── contest.xml
├── statements/english/          # contest-wide statement build sources
└── problems/
    ├── alphabet/problem.xml
    ├── battle/problem.xml
    ├── ...
    └── medical-parity/
        ├── problem.xml
        ├── files/
        ├── solutions/
        ├── statements/
        ├── statement-sections/
        ├── scripts/
        ├── tests/01
        ├── check.cpp
        ├── check.exe
        └── doall.sh
```

Actual contest XML shape, abbreviated to two entries:

```xml
<contest url="https://polygon.codeforces.com/c/53803">
  <names>
    <name language="english" value="ICPC 2025--2026, NERC -- Northern Eurasia Finals"/>
  </names>
  <statements>
    <statement language="english" type="application/pdf"
      url="https://polygon.codeforces.com/c/53803/english/statements.pdf"/>
  </statements>
  <problems>
    <problem index="a" url="https://polygon.codeforces.com/p5gkdVj/elizarov/alphabet"/>
    <problem index="m" url="https://polygon.codeforces.com/p9OQ2rY/elizarov/medical-parity"/>
  </problems>
</contest>
```

The contest entries have **`index` and `url`, not a local `path` attribute**. Match those URLs to each problem descriptor's URL, with a checked local-prefix/short-name fallback. ZIP entry order here starts with problem M; contest order comes from `contest.xml`. Root folders are neither required to equal the contest index nor the displayed title. [P-nerc-zip]

Recommended discovery rules:

- Recognize a single root `problem.xml`, wrapped single problems, and collections of descriptor roots. Inspect XML structure, not only the filename. The first-party example and inspected recent exports do **not** have `model="polygon-1.0"`, so requiring it would reject real packages. [P-example] [P-nerc-zip]
- An optional compatibility path can recognize `problem.xml.polygon` in converted archives. Do not parse the neighboring foreign-judge `problem.xml` as Polygon or create two copies of the same problem. [P-regional-zip]
- Show each candidate's prefix, title/short-name, test counts, limits, statement languages, and data availability; import only the selected candidates. Selection and filename resolution should use the exact archive prefix.
- Keep arbitrary loose multi-problem ZIP support as a product discovery rule. Preserve a real `contest.xml` and contest-level assets when present. A URL-only contest descriptor is a catalog, not proof the referred problems are inside the ZIP. [P-api] [P-nerc-zip]

## 3. Polygon `problem.xml`: element and attribute shapes

### Metadata, tests, and scoring

The following paths are relative to `<problem>`. Source facts are demonstrated by [P-example], [P-nerc-zip], [P-roi-zip], and [P-regional-zip].

| XML location | Verified shape and interpretation |
| --- | --- |
| Root `<problem>` | Attributes `revision`, `short-name`, `url`. Keep original values as provenance; a Polygon URL is not a local workspace ID. |
| `names/name` | Attributes `language="english"`, `value="Minimal Sum"`, etc. Languages are strings, not limited to `en`/`zh`. |
| `statements/statement`, `tutorials/tutorial` | `language`, `path`, `type`; text variants can also have `charset` and `mathjax`. `path` is relative to this problem root. Multiple formats can exist for one language. |
| `judging` | `input-file="" output-file=""` means standard IO in the actual packages. Preserve nonempty file names. `cpu-name` and `cpu-speed` are provenance; `run-count="1"` occurs on both batch and interactive problems. |
| `judging/@treat-points-from-checker-as-percent` | Exact spelling verified as `"true"` in ROI problem 4. This is judging behavior, not a `properties/property` invented by a converter. |
| `judging/testset` | `name="tests"` or another testset name. A testset is a suite of tests, not one subtask. Polygon's manual explicitly permits multiple testsets. [P-manual] |
| `testset/time-limit`, `memory-limit` | Text child elements: time in **ms**, memory in **bytes**. For example `2000` and `268435456` mean 2 seconds / 256 MiB. |
| `testset/test-count` | Number of enumerated judging tests. Cross-check with the number of direct `tests/test` children. |
| `testset/input-path-pattern`, `answer-path-pattern` | For example `tests/%02d` and `tests/%02d.a`. Use the stored pattern and **1-based order** of the direct test elements to identify paths. |
| `testset/tests/test` | Attributes include `method="manual"` or `method="generated"`, `cmd="gen ..."`, `sample="true"`, `group="subtask1"`, and `points="1.0"`. Optional fields may be absent; an absent point value is different from explicit zero. |
| `testset/groups/group` | String `name`; `points-policy="each-test"` or `"complete-group"`; complete-group examples have a `points` total. Do not require `points` on each-test groups. |
| `group/@feedback-policy` | Observed `complete`, `icpc`, `points`; preserve the field independently of scoring. API vocabulary is `COMPLETE`, `ICPC`, `POINTS`, `NONE`. [P-api-groups] |
| `group/dependencies/dependency` | Attribute **`group="subtask1"`**, referring to group names. The dependency list is not a comma-separated XML attribute or numeric positional index. |
| `properties/property` | `name="tests-wellformed" value="true"` is present in the fixtures. Preserve unknown properties; do not infer the complete property vocabulary from one example. |
| `tags/tag` | Attribute `value`, e.g. `value="math"`. Preserve tags and exact values. |
| `stresses` | `stress-count`, `stress-path-pattern`, and `list/stress` with `index` and `path`; Cacti has a real `stresses/001`. Preserve these assets as authoring metadata. |

Important parsing details:

- **Printf width is a minimum.** `%02d` produces `01`, `99`, `100`, `406`. ROI problem 2 declares **406 tests with `%02d`**. Inferring `%03d` from the test count would look for nonexistent `001`. [P-roi-zip]
- **No suffix-based rediscovery:** judging inputs can have no extension; answers are `.a` in these exports. Resolve XML references before any optional renaming. Preserve the source pattern and original case paths.
- **Use direct-child paths.** `assets/checker/testset` and `assets/validators/validator/testset` are program-verification data, not contestant tests. A recursive `//testset` or `//test` search mixes distinct roles. [P-checker-tests] [P-example]
- `method="generated"` describes origin even when the full archive contains the bytes. Do not regenerate a materialized input just because that attribute is present. Keep `cmd` intact; it can describe a generator pipeline, and reconstructing it from filenames is insufficient. [P-manual] [P-roi-zip]
- Keep testset identity in every case/group key. `tests/01` and `pretests/01` are different entries. “Pretest” and “statement sample” are separate concepts. [P-manual] [P-api-tests]

### Sources, judge programs, and solution roles

The official fixtures use these distinct XML structures:

```xml
<files>
  <resources>
    <file path="files/testlib.h" type="h.g++"/>
    <file path="files/olymp.sty"/>
  </resources>
  <executables>
    <executable>
      <source path="files/gen.cpp" type="cpp.g++17"/>
      <binary path="files/gen.exe" type="exe.win32"/>
    </executable>
  </executables>
</files>
<assets>
  <checker name="std::wcmp.cpp" type="testlib">
    <source path="files/check.cpp" type="cpp.g++"/>
    <binary path="check.exe" type="exe.win32"/>
    <copy path="check.cpp"/>
  </checker>
  <validators>
    <validator>
      <source path="files/val.cpp" type="cpp.g++17"/>
    </validator>
  </validators>
  <interactor>
    <source path="files/interact.cpp" type="cpp.g++17"/>
  </interactor>
  <solutions>
    <solution tag="main">
      <source path="solutions/main.cpp" type="cpp.g++17"/>
    </solution>
    <solution tag="time-limit-exceeded">
      <source path="solutions/slow.cpp" type="cpp.g++17"/>
      <extra-tags>
        <extra-tag group="small" tag="accepted"/>
      </extra-tags>
    </solution>
  </solutions>
</assets>
```

This is a shortened, combined example; it illustrates roles, not an instruction to add an interactor to a batch problem. `binary` and checker `copy` are optional in the platform developer's documented examples. The downloaded sources, binary declarations, and actual binary availability must be retained separately. [P-checker-tests] [P-example] [P-nerc-zip]

- **Resources** include headers, libraries, and statement templates; not every resource is a contestant-visible attachment. **Executables** describe source/binary programs, including generators and sometimes a validator/interactor also referenced under `assets`. One file can have several references/roles; do not create duplicate programs or infer “generator” from every executable node. [P-manual] [P-nerc-zip]
- **Checker:** compares contestant output against input/reference answer; Testlib's argument order is `input`, `contestant output`, `jury answer`. A standard checker name such as `std::wcmp.cpp` remains meaningful even though its packaged source is called `files/check.cpp`. **Validator:** checks input validity. **Interactor:** communicates with the submission; it can produce a transcript subsequently checked by the checker. [P-checker-tests] [P-testlib]
- **Solutions:** preserve all tagged programs, not only the first `.cpp`. `main` is the answer-generating model solution; `accepted` is another correct solution. Observed failure tags include `wrong-answer`, `rejected`, `time-limit-exceeded`, `time-limit-exceeded-or-accepted`, and `time-limit-exceeded-or-memory-limit-exceeded`. The API uses different short tags such as `MA`, `OK`, `TL`, `TO`, `TM`, `NR`, `RE`; keep unknown XML tags raw rather than forcing a lossy mapping. [P-roi-zip] [P-api-solutions]
- **Extra tags** retain testset/group-specific expected behavior. The official XML example uses `<extra-tags><extra-tag group="subtask4" tag="wrong-answer"/></extra-tags>`; the API distinguishes testset and test-group extra tags. [P-example] [P-api-solutions]
- **Language/source type IDs are not file extensions.** Actual NERC examples include `cpp.gcc14-64-msys2-g++23`, `python.pypy3-64`, `rust.2021`, `kotlin19`, and binary types `pythonx.pypy3-64`; `binary/@type` can be absent. Preserve original IDs alongside any local compiler mapping. [P-nerc-zip]
- **Graders:** Polygon supports compile-time solution resources, including C++ translation units and Python `main.py` importing the contestant's `solution` module. The API's advanced resource properties include `forTypes`, `main`, `stages`, and `assets`. Preserve their raw XML/metadata and referenced files. The exact advanced-resource XML encoding was **not established in the sampled archives**; do not invent a `<grader>` element or classify a grader as an ordinary standalone generator. [P-graders] [P-materials] [P-api-resources]

Checker/validator self-tests have their own patterns and expected verdicts. The developer's documented checker form is:

```xml
<testset>
  <test-count>2</test-count>
  <input-path-pattern>checker-tests/%02d</input-path-pattern>
  <output-path-pattern>checker-tests/%02d.o</output-path-pattern>
  <answer-path-pattern>checker-tests/%02d.a</answer-path-pattern>
  <tests>
    <test verdict="ok"/>
    <test verdict="wrong-answer"/>
  </tests>
</testset>
```

Here `.o` is a simulated contestant output and `.a` is a jury answer. Validator self-tests use an input pattern and `verdict="valid"` / `"invalid"`. Actual newer exports can prefix these paths with `files/tests/`; always follow the descriptor. [P-checker-tests] [P-example] [P-nerc-zip]

### Statements, samples, and assets

The NERC archive verifies these parallel representations: [P-nerc-zip]

```text
statements/english/problem.tex
statements/english/tutorial.tex
statements/english/problem-properties.json
statements/english/example.01
statements/english/example.01.a
statements/.html/english/problem.html
statements/.html/english/problem-statement.css
statements/.pdf/english/problem.pdf
statement-sections/english/name.tex
statement-sections/english/legend.tex
statement-sections/english/input.tex
statement-sections/english/output.tex
statement-sections/english/tutorial.tex
statement-sections/english/example.01
statement-sections/english/example.01.a
```

Depending on content, sections can include `notes.tex`, `interaction.tex`, and scoring sections; several can be absent. `statement-sections` and `problem-properties.json` are **not enumerated by `<statements>` in these descriptors**. A full importer needs to inspect these locations in addition to the paths explicitly declared in XML. [P-nerc-zip] [P-api-statements]

The observed `problem-properties.json` contains `name`, `language`, `legend`, `input`, `output`, `interaction`, `scoring`, `notes`, `tutorial`, `sampleTests`, `extraResources`, author fields, `inputFile`, `outputFile`, `timeLimit`, and `memoryLimit`. In Medical Parity, `timeLimit` is `3000`, **`memoryLimit` is `1073741824` bytes**, and IO names are `stdin`/`stdout`. Do not apply the API's MB unit to this JSON. `sampleTests` entries have `input`, `output`, `inputFile: "example.01"`, and `outputFile: "example.01.a"`; `extraResources` includes Base64-encoded `.mu` sample-markup resources. Retain the original JSON, including null fields and extensions. [P-nerc-zip]

Recommended import precedence for editable content is an explicit product choice: use available section files or the observed section-bearing JSON, retain the complete TeX, and preserve rendered HTML/PDF. Conflicting representations should stay distinguishable rather than overwriting one another. Polygon's TeX-to-HTML rendering supports a documented subset of TeX, so “converted to Markdown” is not equivalent to retaining the original statement. [P-statement-manual]

**Statement examples are not necessarily jury-answer bytes.** The API explicitly allows alternate input/output/interaction-log presentation for statements. Keep these independently from judging data. The example numbering `example.01` is a presentation ordinal, not necessarily judging test 1. [P-api-tests]

**Retain unlisted assets, including hidden directories.** Knit's graphics source `figures.mp` appears beside the TeX and in `statement-sections/english/`; generated hash-named PNGs appear under `statements/.html/english/`. These files are not all listed as `files/resources/file`. Dropping dot directories or copying only XML-listed statement files breaks renderable HTML. Preserve relative references, styles, images, fonts, raw sources, `.desc` files, and other package members. [P-nerc-zip]

Polygon additionally has publishable **problem materials**, with strategies `NONE`, `WITH_TUTORIAL`, and `WITH_STATEMENT`. These produce separate ZIPs stored in a package. Keep their publication metadata and bytes when encountered; they are not automatically judging tests or statement samples. The precise material-descriptor XML encoding was not present in the sampled fixtures. [P-materials] [P-api-materials]

## 4. Bundled-min and uniform per-test-sum points

For binary testcase results `r_i ∈ {0,1}`, distinguish:

- **Bundle:** `groupScore = P * min(r_i)`. `P` is one group weight.
- **Uniform sum:** `groupScore = w * sum(r_i)`. `w` is one testcase weight; group maximum is `n * w`.

Those are appropriate local authoring concepts. The native representations differ:

| Target | Bundle worth `P` | Uniform sum with testcase weight `w` |
| --- | --- | --- |
| Polygon | `points-policy="complete-group"`, group `points=P`; emitted member test weights sum to `P`. For example one test gets `P`, the others `0`. | `points-policy="each-test"`; each `<test points="w">`. Do not reuse the bundle's per-case weights. [P-groups] [P-roi-zip] |
| Hydro | `type: min`, `score: P`; each case's possible score should be `P` for ordinary binary checking. | `type: sum`, explicit per-case `score: w`, subtask `score: n*w`. [H-normalize] [H-flow] |
| Luogu | `subtaskId` gives membership; use an understood subtask/problem scoring-script policy for all-or-nothing scoring. | Filename-keyed per-case `score: w` plus additive scoring. `subtaskId` alone does not define either aggregation. [L-config] [L-score] |
| Bare JOI/AtCoder in/out | Not encoded. | Not encoded. A PolyForge companion can preserve either local convention. [J-ambulance] [J-2026-data] |

**Verified Polygon weight example:** ROI `1/problem.xml` group `1` contains tests 2–22 and is worth **25**; only test **18** has `points="25.0"`, the rest have `points="0.0"`. Computing the minimum of those stored numbers would incorrectly give 0 even on a completely correct submission. All inspected ROI complete-group `points` attributes equal the sum of their members' test weights. [P-roi-zip]

Import/export rules derived from that evidence:

1. For complete groups, preserve both the bundle total and raw point allocations. Do not promote native zero weights to a request for default scoring; zero-weight cases can still be required to pass.
2. For each-test groups with nonuniform weights, retain the per-test weights. A UI limited to one uniform value needs an explicit imported-overrides state, not averaging or redistributing the scores.
3. Dependencies are pass requirements on named groups. Polygon's developer specifies that a failed test in prerequisite B suppresses A's points; this is not simply “B scored a positive number.” This matters especially for zero-point sample groups. [P-groups]
4. Fractional checker scoring needs its own metadata. The developer documents checker-percent mode as `testPoints * min(checkerPercent, minPercentFromDependencies)` for the generalized each-test policy. Do not assume that arbitrary partial-credit `min`, `max`, or custom scoring can be converted merely by switching `COMPLETE_GROUP`/`EACH_TEST`. Preserve checker behavior and the raw mode. [P-percent] [P-roi-zip]
5. Avoid hidden rounding. Polygon accepts two decimal places per test; Hydro's editor and Luogu's result types use integer scores. A 100-point group with three **uniform additive** integer-weight tests cannot have both equal weights and total 100. `33,33,34` preserves a total but is nonuniform; `33.33` each totals 99.99 in Polygon. Bundled scoring does not need this division. [P-api-tests] [H-schema] [L-result]

### Concrete Polygon XML export example

This is a **constructed export example derived from the verified shapes**, not an assertion that Polygon's website imports arbitrary ZIPs. All referenced files must be included. It describes four materialized input/answer pairs, a 30-point bundle and two 35-point additive tests dependent on the bundle. Standard-IO limits are uniform at 1000 ms / 256 MiB.

```xml
<?xml version="1.0" encoding="utf-8" standalone="no"?>
<problem revision="1" short-name="sum">
  <names><name language="english" value="A + B"/></names>
  <statements>
    <statement charset="UTF-8" language="english" mathjax="true"
      path="statements/english/problem.tex" type="application/x-tex"/>
  </statements>
  <judging input-file="" output-file="" run-count="1">
    <testset name="tests">
      <time-limit>1000</time-limit>
      <memory-limit>268435456</memory-limit>
      <test-count>4</test-count>
      <input-path-pattern>tests/%02d</input-path-pattern>
      <answer-path-pattern>tests/%02d.a</answer-path-pattern>
      <tests>
        <test method="manual" sample="true" group="small" points="0.0"/>
        <test method="manual" group="small" points="30.0"/>
        <test method="manual" group="large" points="35.0"/>
        <test method="manual" group="large" points="35.0"/>
      </tests>
      <groups>
        <group name="small" points="30.0" points-policy="complete-group"
          feedback-policy="complete"/>
        <group name="large" points-policy="each-test" feedback-policy="complete">
          <dependencies><dependency group="small"/></dependencies>
        </group>
      </groups>
    </testset>
  </judging>
  <files>
    <resources><file path="files/testlib.h" type="h.g++"/></resources>
  </files>
  <assets>
    <checker name="std::wcmp.cpp" type="testlib">
      <source path="files/check.cpp" type="cpp.g++17"/>
      <copy path="check.cpp"/>
    </checker>
    <validators>
      <validator><source path="files/val.cpp" type="cpp.g++17"/></validator>
    </validators>
    <solutions>
      <solution tag="main"><source path="solutions/main.cpp" type="cpp.g++17"/></solution>
    </solutions>
  </assets>
</problem>
```

Required paths include `tests/01`, `tests/01.a`, …, `tests/04`, `tests/04.a`, the statement source, `files/testlib.h`, both checker copies, the validator, and the main solution. Include the statement's actual template/image/sample dependencies as well. Sources and bytes should be the user's real programs/data; a placeholder source does not make a full authoring package.

For names such as original `in/01-17.txt` / `out/01-17.txt`, preserve a mapping to the exported Polygon ordinal paths. The verified judging XML supplies a printf pattern rather than an arbitrary per-test filename field. Arbitrary original paths therefore need retained assets/local provenance when canonical numbering is used. For an unchanged Polygon re-export, preserve the imported path patterns and names directly. [P-example] [P-roi-zip]

## 5. Current limits and representability

**These distinguish platform authoring limits, package units, and deployment settings.** An observed contest limit is not a platform-wide maximum; an imported historical/custom package should not be silently clamped to an API bound.

| Target | Verified time/memory rules | Scores and subtask limits |
| --- | --- | --- |
| **Polygon service / API** | `problem.updateInfo`: **250–15,000 ms**, divisible by **50**; memory **4–1024 MB** as termed by the API. XML memory uses bytes; 1024 MiB appears as `1073741824`. [P-api-limits] [P-roi-zip] | Test points **≥ 0, < 10^9, at most 2 decimal places**. No universal 100-point total is stated. Current API docs identify maximum test index as **1000** in material selectors. Limits are problem-wide in the API and stored per testset in XML; no verified native per-group/per-case limit encoding. [P-api-tests] [P-api-materials] [P-example] |
| **Hydro** | Editor accepts positive suffixed time/memory strings with no numeric maximum in that schema. Defaults: **1000 ms / 256 MiB**. Runtime conversion floors suffixed time to ms and rounds suffixed memory up to MiB; bare numeric time is ms, memory MiB. Judge settings default to **100 cases**, **60 s total time budget**, **512 MiB memoryMax**, and are deployment-configurable. [H-schema] [H-units] [H-normalize] [H-settings] | Native **case > subtask > global** limits, then language rates. `min`, `max`, `sum`, numeric IDs and dependency arrays. Editor scores **integer 1–100**, but runtime defaulting is not that validation schema; explicit zero can be replaced because it uses `score || default`. The judge's configuration checks are conditional for trusted/keyed jobs, so its defaults are not universal package limits. [H-normalize] [H-case-reader] |
| **Luogu** | `config.yml` provides **ms** time and **KB** memory; official result API calls memory **KiB**. The current upload/config docs do **not publish a universal hard min/max or time step**. Do not invent one. ZIP upload limits are **50M compressed / 100M uncompressed**, independent of judge memory. [L-config] [L-result] [L-upload] | Per-case limits and scores are native; group limits can be expanded to member cases. The official config example has `score: 233`, so 100 is not a verified per-case cap. Result scores are integers; arbitrary scoring scripts need preservation/recognition rather than automatic reduction to min/sum. [L-config] [L-result] [L-score] |
| **JOI published datasets** | Bare in/out ZIPs have no time/memory fields or global numeric bounds. Contest metadata supplies limits: 2026 semifinal has **2 s / 1024 MB** for all six tasks; 2025 finals includes **3 s / 2048 MiB** for task D. These are examples, not allowed ranges. [J-2026-score] [A-joi-d] | Current JOI rounds document **100 points per task**, with task-specific subtask weights; filenames do not encode the weights/aggregation. No standard per-subtask limit manifest was found. The proposed companion can retain local overrides. [J-2027-page] [J-c2-score] |
| **AtCoder** | Task pages specify seconds and MiB: ABC380 A has **2 s / 1024 MiB**, JOI2025 D **3 s / 2048 MiB**. No public universal setter-limit range or bare-ZIP config schema was established. [A-abc] [A-joi-d] [A-datasets] | Ordinary task scores, JOI subtasks, and AHC task-specific quality scores are distinct systems. A testcase ZIP alone cannot select the scoring semantics or express per-subtask limits. [A-abc] [A-joi-a] [A-ahc] |

Luogu's **official-contest authoring policy** separately recommends at least **500 ms per case**, normally **512 MiB**, and at most **360 s sum of case limits** per task, with stricter budgets for early problems. These are scoped contest-production rules with exceptions, **not documented universal API/upload validation ranges**. [L-contest-policy]

Practical conversion decisions:

- Keep local limits precise and inherited; convert units only at the target boundary. Examples: `256 MiB → 268435456` Polygon bytes; `256 MiB → 262144` Luogu KiB; Hydro `time: 500ms`, `memory: 128m`.
- Polygon's current API requires a 50 ms step. Imported `1234ms`, a 2048 MiB JOI task, or heterogeneous group limits can be retained locally, but an interoperable Polygon push/export cannot silently pretend these equal a permitted uniform limit.
- Testset-specific limits in an imported descriptor must be retained. Turning every subtask into a separate Polygon testset does not preserve a single testset's scoring/dependency semantics.
- Hydro/Luogu exports should apply each group's effective limits to the proper test memberships. Polygon conversion needs an explicit chosen uniform limit or a retained local-only override, with the resulting representational change visible.
- Preserve raw decimal scores and unsupported scoring/checker metadata. Use exact decimal arithmetic for export weights; avoid hidden normalization to 100 or hidden redistribution when a case is added.
- Keep native input/output paths, source IDs, group names, statements, raw descriptors, and extra files alongside normalized local fields. “All assets retained” and “all judging semantics executable locally” are different capabilities and should be reported accurately.

## Primary source index

### JOI and AtCoder

- [J-ambulance]: official small, complete in/out ZIP; directly inspected.
- [J-c2-score]: official scoring PDF, Ambulance membership/weights on page 1.
- [J-2027-page], [J-2027-data]: latest inspected JOI round hosted on AtCoder, six-problem testcase ZIP.
- [J-2026-page], [J-2026-data], [J-2026-score], [J-2026-rules]: separate data/scoring artifacts and AtCoder hosting.
- [J-2025-page], [J-2025-score]: older scoring-TXT dialect and separate downloads.
- [J-spring-page], [J-ramen-data], [J-ramen-cms], [J-ramen-dist]: input-only/grader task variants.
- [A-suspension], [A-links], [A-datasets]: current public testcase availability and absence of a published dataset-config schema.
- [A-joi-a], [A-joi-d], [A-abc], [A-ahc], [A-rules]: task limits/scoring, tool packages, and comparison semantics.

### Polygon

- [P-api] and section links: current service methods/types and bounds.
- [P-manual]: first-party downloadable help; historical package description, source roles, 1-based tests and multiple testsets. Use the current API for current variant behavior.
- [P-groups], [P-example]: platform-developer description and directly linked official XML fixture.
- [P-nerc-page], [P-nerc-zip], [P-school-2025], [P-roi-zip], [P-school-2026], [P-regional-zip]: organizer-published artifacts; internal paths and inspected hashes are recorded above.
- [P-checker-tests], [P-testlib]: first-party checker/validator roles, argument protocols, and self-test XML.
- [P-graders], [P-materials], [P-percent], [P-statement-manual]: developer-authored feature definitions and rendering documentation.

### Hydro and Luogu

- [H-schema], [H-normalize], [H-units], [H-flow], [H-case-reader], [H-settings]: first-party schema, scoring, conversion, and judge settings.
- [L-config], [L-score], [L-result], [L-upload], [L-contest-policy]: official config/scoring/units/upload documentation and scoped authoring policy.

[J-ambulance]: https://www2.ioi-jp.org/camp/2025/2025-sp-tasks/contest2/ambulance-data.zip
[J-c2-score]: https://www2.ioi-jp.org/camp/2025/2025-sp-tasks/contest2/2025-sp-c2-score.pdf
[J-2027-page]: https://www2.ioi-jp.org/joi/2026/2027-yo1/
[J-2027-data]: https://www2.ioi-jp.org/joi/2026/2027-yo1/2027-yo1a-data.zip
[J-2026-page]: https://www2.ioi-jp.org/joi/2025/2026-sf/
[J-2026-data]: https://www2.ioi-jp.org/joi/2025/2026-sf/2026-sf-data.zip
[J-2026-score]: https://www2.ioi-jp.org/joi/2025/2026-sf/2026-sf-score.txt
[J-2026-rules]: https://www.ioi-jp.org/joi/2025/2026-sf-outline#COMP
[J-2025-page]: https://www2.ioi-jp.org/joi/2024/2025-ho/
[J-2025-score]: https://www2.ioi-jp.org/joi/2024/2025-ho/2025-ho-score.txt
[J-spring-page]: https://www2.ioi-jp.org/camp/2025/2025-sp-tasks/
[J-ramen-data]: https://www2.ioi-jp.org/camp/2025/2025-sp-tasks/practice/ramen-data.zip
[J-ramen-cms]: https://www2.ioi-jp.org/camp/2025/2025-sp-tasks/practice/ramen-cms.zip
[J-ramen-dist]: https://www2.ioi-jp.org/camp/2025/2025-sp-tasks/practice/ramen-dist.zip
[A-suspension]: https://atcoder.jp/posts/1377?lang=en
[A-links]: https://atcoder.jp/posts/261
[A-datasets]: https://datasets.atcoder.jp/
[A-joi-a]: https://atcoder.jp/contests/joi2025ho/tasks/joi2025ho_a?lang=en
[A-joi-d]: https://atcoder.jp/contests/joi2025ho/tasks/joi2025ho_d?lang=en
[A-abc]: https://atcoder.jp/contests/abc380/tasks/abc380_a?lang=en
[A-ahc]: https://atcoder.jp/contests/ahc001/tasks/ahc001_a?lang=en
[A-rules]: https://atcoder.jp/contests/abc380/rules?lang=en
[P-api]: https://github.com/Codeforces/polygon-misc/blob/8430c5076f7bcf39dd079ca0c34d46ed23fa459c/API.md
[P-api-limits]: https://codeforces.github.io/polygon-misc/API.html#problemupdateinfo
[P-api-packages]: https://codeforces.github.io/polygon-misc/API.html#problempackage
[P-api-tests]: https://codeforces.github.io/polygon-misc/API.html#problemsavetest
[P-api-groups]: https://codeforces.github.io/polygon-misc/API.html#testgroup
[P-api-solutions]: https://codeforces.github.io/polygon-misc/API.html#problemsavesolution
[P-api-resources]: https://codeforces.github.io/polygon-misc/API.html#resourceadvancedproperties
[P-api-statements]: https://codeforces.github.io/polygon-misc/API.html#problemsavestatement
[P-api-materials]: https://codeforces.github.io/polygon-misc/API.html#problemsetmaterial
[P-manual]: https://polygon.codeforces.com/static/polygon.rtf
[P-groups]: https://codeforces.com/blog/entry/59886
[P-example]: https://assets.codeforces.com/files/polygon/problem.xml
[P-nerc-page]: https://nerc.icpc.global/archive/2025.html
[P-nerc-zip]: https://nerc.icpc.global/archive/2025/nef-2025-archive.zip
[P-school-2025]: https://neerc.ifmo.ru/school/archive/2024-2025.html
[P-roi-zip]: https://neerc.ifmo.ru/school/archive/2024-2025/ru-olymp-roi-2025-archive.zip
[P-school-2026]: https://neerc.ifmo.ru/school/archive/2025-2026.html
[P-regional-zip]: https://neerc.ifmo.ru/school/archive/2025-2026/ru-olymp-regional-2026-archive.zip
[P-checker-tests]: https://codeforces.com/blog/entry/7979
[P-testlib]: https://github.com/MikeMirzayanov/testlib/blob/d0a0161b20add4c973697444c586981fcd2d451b/testlib.h
[P-graders]: https://codeforces.com/blog/entry/66916
[P-materials]: https://codeforces.com/blog/entry/100519
[P-percent]: https://codeforces.com/blog/entry/94047
[P-statement-manual]: https://polygon.codeforces.com/docs/statements-tex-manual
[H-schema]: https://github.com/hydro-dev/Hydro/blob/0dba6c4ac1870a96ef83dc2b0e514142181b7075/packages/ui-default/components/monaco/schema/problemconfig.ts#L9-L44
[H-normalize]: https://github.com/hydro-dev/Hydro/blob/0dba6c4ac1870a96ef83dc2b0e514142181b7075/packages/common/subtask.ts#L144-L180
[H-units]: https://github.com/hydro-dev/Hydro/blob/0dba6c4ac1870a96ef83dc2b0e514142181b7075/framework/utils/lib/common.ts#L157-L180
[H-flow]: https://github.com/hydro-dev/Hydro/blob/0dba6c4ac1870a96ef83dc2b0e514142181b7075/packages/hydrojudge/src/flow.ts#L16-L139
[H-case-reader]: https://github.com/hydro-dev/Hydro/blob/0dba6c4ac1870a96ef83dc2b0e514142181b7075/packages/hydrojudge/src/cases.ts#L14-L46
[H-settings]: https://github.com/hydro-dev/Hydro/blob/0dba6c4ac1870a96ef83dc2b0e514142181b7075/packages/hydrojudge/src/config.ts#L18-L38
[L-config]: https://help.luogu.com.cn/manual/luogu/problem/testcase-config
[L-score]: https://help.luogu.com.cn/manual/luogu/problem/scoring-script
[L-result]: https://github.com/luogu-dev/lgapi-docs/blob/e09c79271d382fd9d6c6925e2bc57da839c8482b/openapi/judge.yaml#L117-L136
[L-upload]: https://help.luogu.com.cn/manual/luogu/problem/
[L-contest-policy]: https://help.luogu.com.cn/rules/academic/lgr/contest-standard
