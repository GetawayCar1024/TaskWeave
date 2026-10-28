# Hydro FPS and LemonLime native comparison modes

Research date: **2026-10-28**. Target: **TaskWeave 0.4.1**. This supplements [package-formats.md](./package-formats.md). Platform facts below are traced to official documentation, format-owner sources, and first-party implementations. Recommendations are identified as TaskWeave implementation decisions.

Pinned snapshots:

- Hydro: [`f5c2ac14`](https://github.com/hydro-dev/Hydro/tree/f5c2ac14e182b8f1238b1ee1a6e78e4fb0fdd816); official documentation: [`7e6c11f7`](https://github.com/hydro-dev/hydro-dev.github.io/tree/7e6c11f7fa31a9b7523b1ce2860394e010393005). The inspected FPS importer package is **`@hydrooj/fps-importer` 1.6.0**. [H-FPS-PACKAGE]
- FPS format owner: [`zhblue/freeproblemset@96419f1e`](https://github.com/zhblue/freeproblemset/tree/96419f1ee6b178f7943e976144208b58f631fa1c); its reference implementation, HUSTOJ: [`9d5a5000`](https://github.com/zhblue/hustoj/tree/9d5a5000005897fd06f0d36cf5ed80d51b22d0c7).
- LemonLime: [`Project-LemonLime/Project_LemonLime@69aa2237`](https://github.com/Project-LemonLime/Project_LemonLime/tree/69aa22370706a4f14b394a6e27aa92e7eca4a8f5).

## Implementation conclusions

1. **Add FPS as another exchange format alongside existing Hydro ZIP support.** Official Hydro documentation accepts UTF-8 FPS XML, or a ZIP containing one or more FPS XML documents. Its ordinary Hydro ZIP is a separate format with `problem.yaml`, statements, `testdata/`, and `additional_file/`. Hydro's own inspected exporter writes that native ZIP format; its FPS plugin implements import. TaskWeave's FPS export will therefore be an independently implemented writer targeting Hydro's importer. [H-FPS-DOC] [H-NATIVE-DOC] [H-NATIVE-EXPORT]
2. **Hydro FPS compatibility is a subset of FPS.** Hydro imports title, statement sections, samples, source/tags, global limits, textual tests, embedded images, remote references, and solution listings. It **does not read `<spj>`, `<tpj>`, `<interactor>`, `<prepend>`, `<template>`, or `<append>`**, although the FPS DTD declares them. An FPS containing a special judge can import into Hydro without installing that judge. Exporting such a task as an ordinary comparison problem would change its semantics. [F-DTD] [H-FPS-RUN]
3. **Use actual Lemon CDF modes `0`, `1`, and `3` for in-process built-ins.** Keep `specialJudge: ""`. The enum also includes `2` (external `diff`), `4` (Lemon SPJ), and `5` (Testlib SPJ). Native built-ins require no checker executable in the exported archive. Existing `lemon:*` source presets remain custom **mode 4** checkers. [M-ENUM] [M-DISPATCH] [M-TASK-JSON] [T-PRESETS]
4. **Local equivalents need the upstream comparison rules, including verdicts.** Mode 1 is whitespace-skipping comparison with line-position checks, not unrestricted whitespace-token comparison. Mode 3 uses absolute **or** relative tolerance, `long double`, and C numeric scanning. The source has observable EOF/chunk/parser quirks; the tables below provide tested examples rather than relying on UI descriptions. [M-READER] [M-LINES] [M-SPACES] [M-REAL]
5. **FPS has no verified portable representation for TaskWeave's full scoring/asset model.** The DTD has no subtask scores/dependencies, per-case limits, testset names, arbitrary attachments, file-IO basename, or multilingual-statement manifest. Hydro's importer creates only global-limit config and relies on filename-based test discovery. Preserve these features through the existing native Hydro ZIP and detect FPS export losses explicitly. [F-DTD] [H-FPS-RUN] [H-AUTO] [H-NATIVE-DOC]

## 1. Hydro's documented FPS entry point and implementation boundary

The plugin registers **`/problem/import/fps`**, exposed as **“From FPS File” / “从 FPS 文件导入”**, requiring problem-creation permission. Official documentation specifies:

- One FPS XML document, or a ZIP containing one or more such documents.
- **UTF-8**, regardless of another encoding claimed in an XML declaration: the plain-file branch explicitly reads bytes as UTF-8 before parsing.
- A configurable default **64 MiB** import-file limit; the source setting is `import-fps.limit`, default `64 * 1024 * 1024`. This is a Hydro import budget, not an FPS schema limit. [H-FPS-DOC] [H-FPS-POST]

Each `<item>` creates a new problem owned by the importing user. The importer passes `null` as the problem ID; it does not recover a local PID from `<url>` or an invented `<id>`. It assigns the statement the server language (`server.language`, otherwise `zh`), not a per-item language. It performs successive problem writes rather than an all-or-nothing problemset transaction. [H-FPS-RUN]

### Documented ZIP support has a source-level defect at this snapshot

The plain XML path is straightforward. In the ZIP fallback, the source does:

```ts
const content = entry.getData(new Zip.TextWriter());
const result = await xml2js.parseStringPromise(content);
```

`getData` returns a **Promise**, but is not awaited. Hydro's exported `Zip` is `@zip.js/zip.js`; `xml2js` converts its input with `str.toString()`, so the Promise is parsed as `[object Promise]`, rather than XML. Per-entry exceptions are swallowed, potentially ending with “No valid fps format file found”. This is a source-level discrepancy with the documentation, not evidence that every deployed Hydro version has the defect. **Prefer a standalone `.xml` as TaskWeave's primary FPS export; implement ZIP-of-FPS import locally as documented, and verify ZIP delivery against the target Hydro version.** [H-FPS-POST] [H-ZIP] [ZIP-GETDATA] [XML2JS-PARSE]

The source checks the uploaded file's size before deciding whether it is XML or ZIP, and checks each ZIP member's uncompressed size against the same setting. It does not implement a total expanded-XML budget across members. Companion files beside XML are not resolved as statement assets or testdata: the ZIP loop attempts to parse non-directory entries as XML. [H-FPS-POST]

## 2. Exact FPS XML vocabulary

The format owner's README identifies HUSTOJ as the reference implementation and links the current DTD. The DTD is the schema reference; Hydro's parser does not validate against it. HUSTOJ's current exporter emits **`fps version="1.6"`**; the official A+B fixture uses `1.4`. These are FPS version strings, independent of XML's `version="1.0"` and the plugin's version. Hydro does not branch on `fps/@version`. [F-README] [F-DTD] [F-EXPORT] [F-EXAMPLE] [H-FPS-RUN]

### Envelope

```xml
<?xml version="1.0" encoding="UTF-8"?>
<fps version="1.6" url="https://github.com/zhblue/freeproblemset/">
  <generator name="TaskWeave 0.4.1"/>
  <item>...</item>
  <item>...</item>
</fps>
```

- Root: `<fps>`, optional `version` and `url` attributes; children `generator*`, then `item*`.
- `<generator>`: character data, required `name`, optional `url`; empty/self-closing is used in official exports.
- `<item>`: one problem; there is no native FPS contest/participant/scoring envelope.
- Official examples include a public `DOCTYPE` pointing to `http://hustoj.com/fps.current.dtd`. It is not needed by Hydro's parser. An importer should accept that conventional declaration without depending on a live DTD download. [F-DTD] [F-EXPORT] [F-EXAMPLE] [H-FPS-POST]

### Item fields and Hydro's interpretation

`+` means one or more, `?` optional, `*` zero or more in the pinned DTD. Scalar element contents are **character data**, not arbitrary child XML elements. [F-DTD]

| XML field | DTD shape | Actual Hydro FPS handling |
| --- | --- | --- |
| `title` | `title+` | Joins repeated values with a space, then HTML-decodes the title. Emit one title. |
| `url` | `url?` | Ignored; preserve as provenance locally. |
| `time_limit` | `time_limit+`, optional `unit` attribute | Reads first element's text and `unit`, concatenating them into Hydro `config.time`. **Supply both a nonempty numeric text value and `unit` for Hydro.** |
| `memory_limit` | `memory_limit+`, optional `unit` | Same concatenation into `config.memory`. |
| `description` | `description+` | First value becomes Problem Description. |
| `input`, `output` | Each `?` | First value becomes Input Format / Output Format. These describe the interface, not testcase contents. |
| `sample_input`, `sample_output` | Each `*` | Samples paired by array position and embedded in the statement. Not uploaded as judged testdata. |
| `test_input`, `test_output` | Each `*`, optional `name` | Text becomes testcase files; exact naming and pairing rules below. |
| `hint` | `hint?` | First value becomes Hint. |
| `source` | `source?` | All encountered values are joined for a Source section; also split on literal spaces into tags, dropping empty pieces. It is not a structured tag array. |
| `solution` | `solution*`, required `language` | All sources become one Hydro **solution/explanation post**, labelled with their language and code fences. They are not imported as executable reference-solution submissions. |
| `prepend`, `template`, `append` | Each `*`, required `language` | Ignored. Preserve source/language locally. |
| `spj`, `tpj`, `interactor` | Each `?`, optional `language` | Ignored. Their presence must not be mistaken for installed Hydro judging configuration. |
| `remote_oj`, `remote_id` | Each `?` | Nonempty `remote_oj` selects `type: remote_judge`; `subType` is its text, except `bas` maps to `ybtbas`; `target` is first `remote_id`. |
| `img` | `img*`, containing `src+`, `base64+` | First `src` identifies a statement reference; first `base64` decodes into an additional file. See image limitations below. |

Sources for every Hydro entry in this table: the complete [FPS conversion routine][H-FPS-RUN] and [HTML content builder][H-CONTENT]. DTD attributes are **`name`**, **`language`**, and **`unit`** as shown; there is no standard `encoding="base64"` attribute on tests, `<attachment>` element, or `<special_judge>` element. The SPJ element is named **`spj`**. [F-DTD]

The DTD's literal item content model is:

```text
(title+,url?,time_limit+,memory_limit+,description+,input?,output?,
 sample_input*,sample_output*,test_input*,test_output*,hint?,source?,
 solution*,prepend*,template*,append*,spj?,tpj?,interactor?,
 remote_oj?,remote_id?,img*)
```

**Do not reject real FPS solely for this declared ordering.** HUSTOJ's own exporter interleaves input/output test elements, emits embedded images before descriptions, and can place other fields differently. Hydro accesses named arrays rather than enforcing the DTD sequence. An exporter can use the DTD order; a compatibility importer needs to handle the actual first-party examples as well. [F-DTD] [F-EXPORT-TESTS] [F-EXPORT]

### Tests: names, pairing, empty files, and the legacy variant

Hydro's exact logic is:

1. If `test_output` exists, loop over the **`test_input` array length**, processing input `i` and output `i`.
2. A node's filename is **`@filename`**, if present; otherwise **`(@name || oneBasedPosition) + ".in"/".out"`**. `name` is a **stem**, so `name="test_01"` produces `test_01.in/out`.
3. `filename` is a documented-in-source compatibility extension attributed to `winterant/OnlineJudge`; it is **not declared in the FPS DTD**. It is a complete filename, e.g. `filename="case1.ans"`.
4. Text is `node._`, or the node itself if it is a string, written with `Buffer.from(text)` (UTF-8). There is no testcase base64 decoding.
5. Missing nodes are skipped. An **unnamed empty element** normally parses as an empty string and is skipped by `if (!node)`. A **named empty element** is an object containing attributes, so it produces a zero-byte file. Emit `name` on **both** members of every pair, including empty files.
6. If **no `test_output` exists**, Hydro has a legacy HUSTOJ fallback interpreting successive `test_input` entries as alternating input, output, input, output. This is distinct from genuine input-only/SPJ data. [H-FPS-RUN] [XML2JS-DEFAULTS]

Hydro does not explicitly join tests by `name`; names determine the files it writes, and its judge subsequently discovers matching filenames. Unequal arrays can lose extra answers or leave unmatched files. The local importer should validate pair counts/names, retain document order and original names, handle the recognized **even-length alternating legacy form**, and diagnose ambiguous input-only data instead of inventing answers. [H-FPS-RUN] [H-AUTO]

For Hydro-targeted FPS export, use simple matching numeric stems such as `1`, `2`, `3`. Hydro writes no explicit case list for FPS, so filenames such as `1_1`/`2_1` can infer `min` subtasks, while ungrouped numeric names infer `sum`; names without numbers may not be discovered at all. The meaning of the original scoring cannot be recovered from the XML alone. [H-FPS-RUN] [H-AUTO]

## 3. Encoding, CDATA, images, and attachments

### Text is UTF-8 XML, not a binary container

- Emit `<?xml version="1.0" encoding="UTF-8"?>` and real UTF-8 bytes. Hydro's explicit UTF-8 file read does not implement transcoding from GBK/GB18030/UTF-16 just because a declaration requests it. UTF-8 BOMs are stripped by its `xml2js` parser. [H-FPS-DOC] [H-FPS-POST] [XML2JS-PARSE]
- Statement HTML is normally stored **as text inside CDATA**, e.g. `<description><![CDATA[<p>A &lt; B</p>]]></description>`. Do not turn HTML tags into child nodes of `description`. `xml2js` exposes strings/`_` text, which is what Hydro consumes. [F-EXAMPLE] [H-FPS-RUN]
- CDATA and ordinary escaped XML text can both carry test/source text. Preserve spaces, tabs, empty strings, and final-newline presence. `xml2js` defaults have `trim: false`, `normalize: false`; Hydro does not add `.trim()` to test contents. Do not HTML-decode all testcase/source fields: `&lt;` inside CDATA is the literal four-character string `&lt;`, whereas `&lt;` outside CDATA is XML markup for `<`. Hydro explicitly HTML-decodes **title**, not testcase text. [XML2JS-DEFAULTS] [XML2JS-PARSE] [H-FPS-RUN] [XML-CDATA]
- CDATA cannot contain `]]>`. Split it as **`]]]]><![CDATA[>`**; HUSTOJ's `fixcdata` uses exactly this replacement. Example: `<![CDATA[a]]]]><![CDATA[>b]]>` decodes to `a]]>b`. An XML serializer must also escape attribute quotes/ampersands. [F-CDATA] [XML-CDATA]
- **CDATA does not make arbitrary bytes legal XML.** XML 1.0 excludes NUL and most C0 controls, including byte `0x1A`. HUSTOJ's exporter actually deletes `0x1A`; copying that behavior would silently alter testdata. XML 1.0 also specifies CRLF/bare-CR normalization to LF, so cross-parser byte-perfect CR preservation must be designed explicitly (e.g. character references outside CDATA) and tested. Keep original import bytes/provenance; prefer native Hydro ZIP for data that cannot be represented faithfully in UTF-8 XML. [F-CDATA] [XML-CHARS] [XML-EOL]

**TaskWeave recommendation:** accept standard escaped text and CDATA, concatenate adjacent text/CDATA nodes, and keep test text independent of HTML rendering. Preserve nonrepresentable binary data through native packages rather than emitting an invented base64 testcase extension. The FPS DTD and Hydro importer provide no such decoding mechanism. [F-DTD] [H-FPS-RUN]

### Statement rendering and samples

Hydro combines description/input/output/samples/hint/source using its **HTML** content builder. Samples become `<pre><code class="language-input1">…` and matching `language-output1` blocks. The builder inserts sample strings directly; it does not HTML-escape them at that point. Include samples containing `<`, `&`, and literal HTML in rendering checks. [H-CONTENT]

If any description/input/output/hint contains `[md]`, the importer labels the resulting statement `.md` and removes every `[md]` / `[/md]` marker. Otherwise it labels it `.html`. This is a Hydro/HUSTOJ convention, not a DTD-declared statement-format field; an unmarked Markdown paragraph is otherwise treated as HTML content. The importer does not reconstruct multiple language variants. [H-FPS-RUN]

### Embedded images

The actual format is a nested record, **not** `<img src="..." encoding="base64">`:

```xml
<img>
  <src><![CDATA[fps-assets/sum/diagram.png]]></src>
  <base64><![CDATA[iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC]]></base64>
</img>
```

The example base64 is a complete **69-byte, 1×1 red PNG**, generated for this note. Its statement counterpart is literal HTML such as `<img src="fps-assets/sum/diagram.png" alt="diagram">` inside description CDATA. Use plain base64 bytes in `<base64>`, not a `data:image/png;base64,` prefix. HUSTOJ exports precisely `img/src/base64` records; Hydro directly calls `Buffer.from(value, 'base64')`. [F-DTD] [F-EXPORT-IMAGES] [H-FPS-RUN]

Hydro's exact implementation:

- Decodes each image and stores it using `ProblemModel.addAdditionalFile`.
- Constructs the filename as **`randomstring(8) + lastDotSuffixOfSrc`**; the source currently inserts **no dot** between the random part and suffix.
- Performs **one** `content.replace(src, "file://" + filename)` per image record, so repeated references to the same source are not all rewritten.
- Does not download `src`; it uses the embedded base64. An external image link without a matching `img` record remains an external reference. [H-FPS-RUN]

**TaskWeave recommendation:** retain original `src → bytes` mappings, use stable collision-free asset filenames, and rewrite every matching local reference during local import/rendering. Record the upstream first-occurrence/filename limitations for Hydro-targeted output, rather than deleting duplicate image uses. The [ordinary Hydro asset format][H-NATIVE-DOC] uses `additional_file/` with normal `file://filename` references and is the better-supported path for complex statement assets.

### Arbitrary attachments

Neither the pinned FPS DTD nor Hydro's importer has an `<attachment>`, `<file>`, ZIP-relative asset manifest, or `additional_file/` sidecar mechanism for FPS. A PDF next to `problem.xml` in a ZIP is not thereby imported. Although Hydro's `img` handler does not inspect the decoded MIME type, **using image records as generic attachment records is not a portable FPS attachment guarantee**; HUSTOJ's importer explicitly restricts image extensions to `jpeg,jpg,svg,png,gif,bmp`. Preserve arbitrary documents through existing ordinary Hydro ZIP support. [F-DTD] [H-FPS-RUN] [H-FPS-POST] [F-IMPORT-IMAGES] [H-NATIVE-DOC]

## 4. Special judges, limits, scoring, and multi-problem FPS

### FPS judge-source conventions

The classic source node is:

```xml
<spj language="C++"><![CDATA[
/* HUSTOJ-style checker source, normally stored as spj.cc */
]]></spj>
```

HUSTOJ exports `spj.c` as `language="C"`, or `spj.cc` as `language="C++"`. Its documented classic SPJ receives **input, reference answer, contestant output**, in that order, and returns **0 for AC**, nonzero for WA. Hydro's native `checker_type: hustoj` adapter implements that same argument order. This differs from ordinary Testlib's input/contestant/answer order and Lemon's six-argument protocol. [F-EXPORT-SPJ] [F-SPJ-DOC] [H-CHECKERS]

Current FPS also declares/exports:

- `<tpj language="C++">…</tpj>` for HUSTOJ's Testlib-style judge-source convention; the first-party `tpj.cc` example calls `registerTestlibCmd`.
- `<interactor language="C++">…</interactor>` for interactor source.
- `<spj language="Text">text judge</spj>` as HUSTOJ's text-judge marker; this is not C/C++ source.
- `prepend` / `template` / `append` with `language` for language-specific source templates/wrappers. [F-DTD] [F-EXPORT-SPJ] [F-TPJ]

**Hydro's FPS importer ignores all of these nodes.** It never sets `checker_type`, `checker`, `interactor`, or extra-file lists from them. Local import should retain the source and its original convention, recognizing that an arbitrary `<spj>` does not identify a Testlib checker. A Hydro-targeted FPS export that requires a judge/interactor must report that it cannot install those semantics through the official importer. Native Hydro ZIP can carry `testdata/config.yaml`, `checker_type: hustoj` / `testlib` / `lemon`, referenced source files, and extra headers. [H-FPS-RUN] [H-CHECKERS] [H-TESTDATA-DOC]

### Limits and scoring

- The FPS DTD defines text plus a free-form `unit` attribute, not a numeric range or unit enumeration. Canonical first-party exports use **`<time_limit unit="s">1.5</time_limit>`** and **`<memory_limit unit="mb">256</memory_limit>`**. HUSTOJ import also explicitly supports time `ms` and memory `kb` (dividing by 1000 / 1024). [F-DTD] [F-EXPORT] [F-IMPORT-LIMITS]
- Hydro concatenates text and unit, then its judge parses units. Time supports `s`, `ms`, `us` and floors to integer ms. Memory uses 1024-based `k/m/g` with optional `b`, rounding upward to whole MiB. For TaskWeave's ms/MiB model, export `unit="ms"` with integer ms and `unit="mb"` with whole MiB, or seconds as in the canonical example. [H-FPS-RUN] [H-UNITS]
- Hydro's FPS-generated `config.yaml` has only global `time`, `memory`, plus remote-judge fields when applicable. Per-case/group limits, dependency edges, original scores, file-IO names, and language-rate overrides are not transferred. Hydro infers tests/subtasks from filenames and allocates unspecified scores from 100; preserving a filename is not preserving its original scoring. [H-FPS-RUN] [H-AUTO]
- FPS's schema supplies no maximum test count. Hydro judge deployment defaults are separately **100 tests**, **60 seconds summed configured testcase time** (including process multiplicity), and **512 MiB maximum case memory**; they are configurable judge budgets, not XML validation rules. A package can import and still exceed judging budgets. [H-JUDGE-CONFIG] [H-JUDGE-LIMITS]
- Statement samples are distinct from judged tests. To judge a sample in Hydro after FPS import, include it explicitly among `test_input`/`test_output` as well; do not silently add every sample as a scored case. [H-FPS-RUN]

### Minimal complete single-problem example

This example uses the documented fields and supplies named data even when exporting a single pair. The line breaks **inside** the test CDATA are intentional testcase bytes; sample text here has no final newline. [F-EXAMPLE] [H-FPS-RUN]

```xml
<?xml version="1.0" encoding="UTF-8"?>
<fps version="1.6" url="https://github.com/zhblue/freeproblemset/">
  <generator name="TaskWeave 0.4.1"/>
  <item>
    <title><![CDATA[A + B]]></title>
    <time_limit unit="s">1</time_limit>
    <memory_limit unit="mb">256</memory_limit>
    <description><![CDATA[<p>Print the sum of the two integers.</p>]]></description>
    <input><![CDATA[<p>Two integers a and b.</p>]]></input>
    <output><![CDATA[<p>Print a+b.</p>]]></output>
    <sample_input><![CDATA[1 2]]></sample_input>
    <sample_output><![CDATA[3]]></sample_output>
    <test_input name="1"><![CDATA[1 2
]]></test_input>
    <test_output name="1"><![CDATA[3
]]></test_output>
    <source><![CDATA[arithmetic]]></source>
  </item>
</fps>
```

Expected Hydro artifacts: one new problem, an HTML statement with one sample pair, tag `arithmetic`, `testdata/1.in` = `1 2\n`, `testdata/1.out` = `3\n`, and global config `time: 1s`, `memory: 256mb`. No SPJ is installed. The image block from the preceding section can be added after `source`, with its reference added to the description. [H-FPS-RUN]

### Multi-problem packaging

Use **one `<fps>` document with multiple `<item>` children** for a problemset. Do not concatenate complete XML documents. The DTD permits `item*`, and Hydro iterates those items. HUSTOJ's contest export selects contest problems in contest order but serializes them as ordinary items; that is not a portable contest definition. [F-DTD] [H-FPS-RUN] [F-EXPORT]

The documented ZIP alternative is:

```text
fps-set.zip
├── part-001.xml      # one <fps> containing one or several <item>s
└── part-002.xml
```

HUSTOJ's own optional ZIP export contains one `problem.xml`; Hydro documents one or more XMLs. Account for the Hydro ZIP defect described above. For TaskWeave import selection, use a stable **XML-entry path + item ordinal**, retaining title/source URL separately; duplicate titles and independently numbered tests in different items are valid use cases. This selection key is a TaskWeave implementation recommendation. [F-EXPORT-ZIP] [H-FPS-DOC] [H-FPS-POST]

For comparison, retain ordinary Hydro ZIP handling:

```text
hydro.zip
└── sum/
    ├── problem.yaml
    ├── problem_zh.md
    ├── testdata/config.yaml
    ├── testdata/1.in
    ├── testdata/1.out
    └── additional_file/handout.pdf
```

The native importer also accepts `problem.yaml` at ZIP root for one problem. FPS-ZIP detection must inspect its XML root; a `.zip` suffix alone cannot distinguish the formats. [H-NATIVE-DOC] [H-NATIVE-IMPORT]

## 5. LemonLime native mode names, enums, and CDF keys

The exact zero-based `Task::ComparisonMode` enum, corresponding UI labels, and translations are: [M-ENUM] [M-UI] [M-ZH]

| `.cdf` number | C++ enum | Exact UI name | Chinese UI name | Execution |
| --- | --- | --- | --- | --- |
| **0** | `LineByLineMode` | `Line-by-line mode` | `逐行比较模式` | In-process `compareLineByLine` |
| **1** | `IgnoreSpacesMode` | `Line-by-line mode (ignore extra spaces and tabs)` | `逐行比较模式（忽略多余空格和制表符）` | In-process `compareIgnoreSpaces`; constructor default |
| **2** | `ExternalToolMode` | `External tool mode (diff)` | `外部工具模式（diff）` | Launches configured external `diff` |
| **3** | `RealNumberMode` | `Real number mode` | `实数比较模式` | In-process `compareRealNumbers` |
| **4** | `LemonSpecialJudgeMode` | `Special judge mode (lemon)` | `自定义校验器模式（lemon）` | External six-argument SPJ |
| **5** | `TestlibSpecialJudgeMode` | `Special judge mode (testlib)` | `自定义校验器模式（testlib）` | External three-argument Testlib SPJ |

Exact task-level serialized keys:

| Key | Type and use |
| --- | --- |
| `comparisonMode` | **Integer enum**, not its string name. |
| `realPrecision` | Integer exponent `p` for mode 3; nominal tolerance `10^-p`. Constructor/UI default **3**. UI range **0–18**; the JSON reader itself does not range-check it. |
| `diffArguments` | One string for mode 2. Constructor default `--ignore-space-change --text --brief`. |
| `specialJudge` | Executable path relative to **`data/`** for modes 4/5. Use `""` for built-ins. |

The writer persists all four keys even when a particular mode ignores some of them. There are no separate `absoluteTolerance`, `relativeTolerance`, `checker`, or `checkerType` keys in this serializer. UI minimum 0 comes from the `QSpinBox` default; maximum 18 is explicit. [M-TASK-JSON] [M-ENUM] [M-PRECISION-UI] [QT-SPIN]

### Complete native CDF example

The JSON CDF version is the **string `"1.0"`**. Emit UTF-8 JSON beginning with `{`, with **no BOM or leading whitespace**: the loader chooses JSON versus old binary format from the first byte. It changes the working directory to the CDF's directory. [M-CONTEST-JSON] [M-SAVE-LOAD]

```text
contest/
├── contest.cdf
├── data/sum/1.in
├── data/sum/1.ans
└── source/
```

`contest.cdf`:

```json
{
  "version": "1.0",
  "contestTitle": "TaskWeave native comparisons",
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
      "realPrecision": 6,
      "specialJudge": "",
      "compilerConfiguration": { "g++": "default" },
      "answerFileExtension": "ans",
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

This is derived from the [official CDF fixture][M-FIXTURE] and serializers, not a new TaskWeave CDF schema. To select another built-in, change the task's comparison fields as follows; the rest stays a normal native task:

```json
{ "comparisonMode": 0, "realPrecision": 6, "specialJudge": "" }
```

```json
{ "comparisonMode": 3, "realPrecision": 6, "specialJudge": "" }
```

`realPrecision: 6` is an explicit example/TaskWeave choice; it is **not LemonLime's default 3**. [M-ENUM]

CDF details important for implementation:

- `inputFiles`, `outputFiles`, and `specialJudge` paths are relative to **`data/`**, so the JSON references `sum/1.in`, not `data/sum/1.in`. [M-PATHS] [M-JUDGER]
- `taskType: 0` means Traditional. Data-only **authoring** is not `AnswersOnly` (`taskType: 1`), which changes what contestants submit. [M-ENUM] [M-DISPATCH]
- `timeLimit` and `memoryLimit` are integer **milliseconds / MiB**, and `fullScore` is integer. Each `testCases` entry can contain several input/output pairs; its score is the **minimum** of their scores, with common limits. Additive cases should be separate entries. [M-CASE-JSON] [M-MANUAL-CASES] [M-JUDGER]
- `answerFileExtension` finds contestant answer files in `AnswersOnly` mode; it does not constrain the extension of explicit reference `outputFiles`. The official fixture uses `.ans` reference outputs with `answerFileExtension: "out"`. [M-FIXTURE] [M-JUDGER]
- Dependency persistence appends strings such as **`"1_lemon_SUbtaskDEPENDENCE_fLAg"`** to `inputFiles`, without a matching output entry. Switching comparison mode must preserve this existing test/subtask representation. [M-CASE-JSON]

## 6. Exact built-in comparison behavior and local parity

### Verification method

The comparison bodies and `BufferedStreamReader` were extracted from the pinned upstream `casejudger.cpp`, compiled in a temporary Windows harness with **GCC 15.1.0, `-std=c++17 -O2 -static`**, and exercised for **75 case/mode combinations**. The only stubs replaced Qt path/message wrappers, task precision access, and cancellation (always false); the reader, numeric scanning, comparisons, and verdict assignments were unchanged. `long double` reported **18 decimal digits**. Upstream source SHA-256: `149604f89b9eb9667a5f02787944b71aa35017a68360b671989c7d46639131dc`. The tables report these isolated native decisions, not a full LemonLime GUI or Hydro deployment test. [M-READER] [M-LINES] [M-SPACES] [M-REAL]

Notation below: `U` = contestant output, `R` = reference answer, C-style escapes show exact text, and `A32` means 32 ASCII `a` characters. AC awards the case's full score; WA/PE/FileError/OLE in these built-ins award zero. [M-LINES] [M-SPACES] [M-REAL]

### Shared text reader: necessary for modes 0 and 1

- Files are opened with C `fopen(..., "r")`, then buffered using `fread`; comparisons use byte strings, not Unicode-normalized text.
- `tryNextLine` consumes **one** LF, CR, or CRLF terminator and increments a 1-based line number.
- Each read returns at most **32 bytes**. Long lines/tokens are consumed in successive chunks, not truncated.
- EOF is latched only when a subsequent character peek actually finds end of file. Reaching a newline or the 32-byte boundary does not itself mark EOF.
- `nextUntilNewLine` calls `tryNextLine` **before every chunk**, including the first read. `nextUntilSpace` skips `std::isspace` bytes first, tracking CR/LF line changes. In the ordinary C locale whitespace includes space, tab, LF, CR, vertical tab, and form feed; a JavaScript Unicode `\s` is not a faithful substitute. The source passes plain `char` to `isspace`, so non-ASCII/runtime-locale edge behavior is not a platform-independent Unicode contract. [M-READER]

### Mode 0: `LineByLineMode`

Documented intent: compare lines while tolerating different platform line terminators. Actual implementation: compare consecutive **32-byte newline-delimited chunks**. Leading/trailing spaces and tabs are significant. It does **not** compare reader line numbers. Before comparing chunk contents, it rejects `U.eof && !R.eof` as WA; the following supposed OLE condition duplicates that same condition and is unreachable. [M-MANUAL-MODES] [M-LINES]

This produces asymmetric final-newline behavior and chunk-boundary effects; it is not `Buffer.equals`, `trimEnd()`, or Testlib `fcmp`. [M-READER] [M-LINES]

### Mode 1: `IgnoreSpacesMode`

Actual loop:

1. Read one whitespace-skipping, at-most-32-byte chunk from each file.
2. If chunks differ, reject (ordinary extra/missing/mismatching tokens result in WA).
3. If chunks are equal and **both readers already reached EOF**, accept immediately.
4. Otherwise, equal chunks with different line numbers yield **PresentationError**, score 0; continue if line numbers match. [M-SPACES]

Consequences: extra leading/in-line spaces and tabs are normally ignored; blank lines before/between tokens normally affect the line comparison; trailing whitespace is accepted. But the both-EOF check precedes line checking, and token boundaries at exactly 32 bytes are not remembered across reads. Those two quirks matter for strict local equivalence. [M-READER] [M-SPACES]

#### Native text-mode fixtures

| U | R | Mode 0 | Mode 1 | What it verifies |
| --- | --- | --- | --- | --- |
| `"1 2\n"` | `"1 2\n"` | AC | AC | Baseline. |
| `"  1\t 2 \t\n\n"` | `"1 2\n"` | WA | AC | Spaces/tabs/trailing whitespace. |
| `"1 2\r\n3\r\n"` | `"1 2\n3\n"` | AC | AC | CRLF/LF. Bare-CR version also AC in both. |
| `"1 2"` | `"1 2\n"` | **WA** | AC | Missing final newline is significant asymmetrically in mode 0. |
| `"1 2\n"` | `"1 2"` | AC | AC | Reverse direction. |
| `"1 2\n\n"` | `"1 2\n"` | AC | AC | Extra terminal blank line. Reversing U/R is WA in mode 0. |
| `"\n1 2\n"` | `"1 2\n"` | **AC** | **PE** | Initial newline is consumed by mode 0's first read. |
| `"1\n2\n"` | `"1 2\n"` | WA | **PE** | Line-position enforcement. |
| `"1\n2"` | `"1 2"` | WA | **AC** | Both EOFs skip the final token's line-position check. |
| `"1\n2"` | `"1 2\n"` | WA | PE | One reader not yet at EOF restores the line check. |
| `"1 3\n"` | `"1 2\n"` | WA | WA | Different content. |
| `""` | `""` | AC | AC | Empty answers. |
| `"1 2 3\n"` | `"1 2\n"` | WA | WA | Extra token is not OLE in these text modes. |
| `"1\f2\n"` | `"1 2\n"` | WA | AC | Form feed is whitespace in mode 1. |
| `A32 + " b\n"` | `A32 + "b\n"` | WA | **AC** | A token boundary at exactly 32 bytes can disappear. At 31 bytes this is WA in both. |
| `A32 + "\nb\n"` | `A32 + "b\n"` | **AC** | PE | A line boundary at exactly 32 bytes can disappear in mode 0. |
| `A32 + "X\n"` | `A32 + "Y\n"` | WA | WA | Long content is actually consumed beyond byte 32. |
| `A32 + A32` | `A32 + A32 + "\n"` | AC | AC | Exact chunk boundary changes final-newline behavior. |

All results in this table were verified with the isolated native source harness. [M-READER] [M-LINES] [M-SPACES]

### Mode 3: `RealNumberMode`

For contestant value `a`, reference value `b`, precision `p`, the source initializes `long double eps = 1` and multiplies it by the **double literal `0.1`**, `p` times. Thus the configured tolerance is nominally `10^-p`, represented through floating-point multiplication, not decimal rounding to `p` places. [M-REAL]

For finite values, it rejects only if **both** conditions hold:

```text
abs(a - b) > eps
AND
abs(a - b) > eps * abs(b)
```

Equivalently, it accepts if absolute error **or** relative-to-the-reference error is within tolerance, including the boundary. The finite acceptance region is `abs(a-b) <= eps * max(1, abs(b))`. There are no independently configurable absolute/relative epsilon fields. [M-REAL] [M-PRECISION-UI]

Other exact behavior:

- Reads with **`fscanf(..., "%Lf", ...)` into `long double`**. Line layout is not compared; numeric spellings such as `1`, `1.0`, `1e0`, and signed zero can agree.
- NaN status must match, and infinity status must match. Two NaNs pass. The source does **not** compare infinity signs: `-inf` versus `inf` passes under its Boolean/numeric condition. One non-finite value versus a finite value fails.
- Invalid contestant numeric text (`fscanf` returns 0) → **WA**. Invalid reference numeric text → **FileError**. Too few contestant numbers → WA; extra contestant numbers → **OutputLimitExceeded**. Both EOF → AC.
- After **every** scan pair it calls `fgetc` on the reference stream only, discarding one character before checking scan results. This is meant for a line counter but can swallow punctuation or a following sign. Parsing is therefore not the same as splitting both files into full whitespace-delimited numeric tokens.
- C runtime numeric syntax and precision matter. Tested MinGW accepts hexadecimal floats and adjacent signed numbers. JavaScript `Number` has fewer significant bits than the tested `long double`: converting all tokens to `Number` would accept some cases native Lemon rejects at high precision. [M-REAL]

#### Native real-mode fixtures

All use `realPrecision: 6` except the final row. [M-REAL]

| U | R | Verdict | Reason |
| --- | --- | --- | --- |
| `"1\n2\n"` | `"1 2\n"` | AC | Numeric mode ignores line placement. |
| `"0.0000009\n"` | `"0\n"` | AC | Inside absolute tolerance. |
| `"0.0000011\n"` | `"0\n"` | WA | Outside absolute tolerance. |
| `"1000000.9\n"` | `"1000000\n"` | AC | Relative tolerance accepts an absolute difference of 0.9. |
| `"1000001.1\n"` | `"1000000\n"` | WA | Outside both tolerances. |
| `"1.0000010000005\n"` | `"1\n"` | WA | Relative scale is the reference. Reversing U/R is AC. |
| `"1e0 +2.000 -0\n"` | `"1 2 0\n"` | AC | Equivalent numeric spellings. |
| `"nan\n"` | `"nan\n"` | AC | Matching NaN classification. |
| `"nan\n"` | `"1\n"` | WA | Non-finite classification mismatch. |
| `"-inf\n"` | `"inf\n"` | **AC** | Native infinity-sign quirk. |
| `"abc\n"` | `"1\n"` | WA | Invalid contestant token. |
| `"1\n"` | `"abc\n"` | FileError | Invalid reference token. |
| `"1 2\n"` | `"1\n"` | OLE | Extra contestant number. Reverse direction → WA. |
| `"1 2\n"` | `"1,2\n"` | **AC** | The reference comma is discarded by `fgetc`. |
| `"1\n"` | `"1x"` | **AC** | A final reference garbage character can be discarded. |
| `"1,2\n"` | `"1 2\n"` | WA | Contestant stream gets no extra `fgetc`. |
| `"0x1p+1\n"` | `"2\n"` | AC | C numeric scanning accepts a hex float in this runtime. |
| `"1+2\n"` | `"1 2\n"` | AC | Whitespace is not required between these numeric scans. |
| `"1 2\n"` | `"1-2\n"` | **AC** | Reference `-` discarded; contestant `1 -2` instead yields WA. |
| `"9007199254740993\n"` | `"9007199254740992\n"` | **WA at p=18** | Native long double distinguishes values that JavaScript Number merges. |

**TaskWeave recommendation:** version local equivalents against the pinned source rules, with native-oracle tests for EOF/chunk behavior and high-precision numbers. A local C++ comparison helper can supply equivalent long-double/C-scanner behavior while the exported CDF still selects native mode 3; that local implementation need not become an exported SPJ. If deliberately implementing only the cleaner intended semantics, document the differences rather than claiming full equivalence. Exact floating boundary results can depend on the target C/C++ runtime's `long double` representation. [M-REAL]

### Mode 2: external `diff` is a separate execution dependency

The native code calls `QProcess::execute(diffPath, args)`, giving full score only for exit status 0 and WA otherwise. `diffPath` is application settings state: on Windows it constructs a `diff.exe` path from the current directory when settings are loaded; on other platforms the source defaults to `/usr/bin/diff`. There is no task-level `diffPath` CDF key. [M-DIFF] [M-PATHS]

At the pinned snapshot, `QStringList(task->getDiffArguments())` produces **one argument containing the whole string**, followed by absolute reference path and contestant path. It does not shell-split the default multi-option string. This is another source-level interoperability issue: do not claim that an arbitrary local GNU-diff flag parser is identical to this invocation. A single option such as `diffArguments: "-b"` is a concrete native configuration shape; execution still requires the matching external tool. Modes **0/1/3** are the compiler-/checker-executable-free export choices. [M-DIFF] [M-TASK-JSON]

## 7. Built-in versus custom SPJ; retain `lemon:*` sources

### Native built-in

```json
{ "comparisonMode": 1, "specialJudge": "", "realPrecision": 6 }
```

LemonLime calls its own comparator directly. Do not put a generated C++ source path in `specialJudge`, compile a checker during native export preflight, or change the mode to 4 as an implementation convenience. The source dispatch makes these different package behaviors. [M-DISPATCH]

### Custom Lemon protocol, including existing presets

```json
{ "comparisonMode": 4, "specialJudge": "sum/checker.exe", "realPrecision": 6 }
```

The executable is `data/sum/checker.exe` on Windows. Native Lemon passes:

```text
checker INPUT CONTESTANT_OUTPUT REFERENCE_ANSWER FULL_SCORE SCORE_FILE MESSAGE_FILE
```

There are six arguments after the executable. The checker must exit 0 and create the score file containing a **nonnegative integer**; the message file is optional. Missing/invalid score file gives `InvalidSpecialJudge`; nonzero process exit gives `SpecialJudgeRunTimeError`. Score 0 → WA, between 0 and full score → PartlyCorrect, at least full score → CorrectAnswer. The upstream code does not clamp an over-full score before storing it. [M-LEMON-SPJ] [M-MANUAL-SPJ]

TaskWeave's existing presets are exactly **`lemon:ncmp`, `lemon:wcmp`, `lemon:lcmp`, `lemon:fcmp`, `lemon:rcmp6`, `lemon:yesno`**. Their sources use the separately vendored Testlib for Lemons and `registerLemonChecker`. They belong in this custom mode, including their existing source/header packaging and protocol check. In particular, `lemon:wcmp` can accept moved tokens without line-position checks, and `lemon:rcmp6` uses Testlib `doubleCompare`/`readDouble`; neither is a native-comparator identity just because the names sound similar. [T-PRESETS] [T-PRESET-TESTS] [T-RCMP6]

### Custom ordinary Testlib protocol

```json
{ "comparisonMode": 5, "specialJudge": "sum/testlib-checker.exe", "realPrecision": 6 }
```

Lemon passes **input, contestant output, reference answer**, captures stderr, and parses its prefix: `ok` gives full score, `FAIL` gives InvalidSpecialJudge, `partially correct (N)` gives integer `N * fullScore / 100`, and `points X` multiplies `X * fullScore` into the integer score. The inspected implementation bases this decision on stderr text rather than checking the process exit code as mode 4 does. Thus “Testlib checker” and “Testlib for Lemons checker” cannot share the same export protocol merely because both include a file named `testlib.h`. [M-TESTLIB-SPJ] [M-MANUAL-SPJ]

## 8. Repo integration points and implementation/test checklist

These are observations of the current local tree and implementation recommendations, not upstream schema claims:

- [`packages/shared/src/packages.ts`](../../packages/shared/src/packages.ts) currently distinguishes `hydro-problem` and `hydro-data`, and exports `hydro`. Add FPS format choices without conflating them with those existing ordinary ZIP operations. [`packages/server/src/imports/packages.ts`](../../packages/server/src/imports/packages.ts) currently starts package inspection/import through `readZip`; plain FPS XML needs an entry path before ZIP-only parsing.
- Reuse the existing candidate-selection workflow with **XML member + item index** identities. Preserve raw XML and unsupported fields, named images, judge/template sources, and solution languages as durable import provenance. Import provided input/answer pairs as authoritative answers using the existing answer-baseline mechanism; a supplied solution listing is not permission to regenerate and replace those answers.
- [`packages/shared/src/problem.ts`](../../packages/shared/src/problem.ts) currently models `lemon_checker` only as a source entry. Represent the new native comparison selection and precision explicitly, with custom source selection retaining `lemon:*` meanings. Native mode/precision must survive save/load, export, and local judging selection.
- [`packages/server/src/judge/lemonlime.ts`](../../packages/server/src/judge/lemonlime.ts), `preflightLemonChecker`, currently requires a Lemon C++ source for full-authoring tasks. `addLemonProblem` currently chooses only `hasChecker ? 4 : 1`, with `realPrecision: 6`. Native-mode selection needs to bypass checker-source compilation/protocol preflight while writing the selected **0/1/3** directly to CDF. Keep the custom-source route and its preflight for mode 4.
- Local invocation in [`judge/invocation.ts`](../../packages/server/src/judge/invocation.ts), quick runs in [`judge/quickrun.ts`](../../packages/server/src/judge/quickrun.ts), and [`judge/execute.ts`](../../packages/server/src/judge/execute.ts) currently dispatch ordinary `config.checker`/Testlib behavior. Updating the CDF alone does not provide equivalent local judging. Connect an explicit Lemon-comparison choice to shared local comparison dispatch, with consistent `OK`/`WA`/`PE`/failure/output-limit mapping.

### FPS implementation-driving fixtures

1. Import/export the complete single-item example; extend to two items with duplicate titles and independently named `1.in/out`. Inspect/select each independently. Also test a ZIP with two complete FPS XMLs and existing ordinary Hydro ZIPs.
2. UTF-8 Chinese text; UTF-8 BOM; HTML in CDATA; XML-escaped text; literal `&lt;` within test CDATA; adjacent CDATA split around `]]>`; whitespace-only and zero-byte **named** tests; CRLF/bare-CR/final-newline preservation policy.
3. Multiple ordered sample pairs distinct from hidden tests; missing/mismatched arrays; named pairs; the non-DTD `filename` extension; recognized alternating legacy `test_input` pairs; ambiguous input-only data.
4. Embedded PNG with verified decoded bytes; same image referenced twice and in multiple sections; two images with the same basename but different source IDs; external images without embedded bytes; PDF/other attachments retained in native ZIP/provenance.
5. Global seconds/ms and mb/kb conversion; absent required Hydro limit attributes; invalid/unrepresentable UTF-8/XML testcase bytes; names that would trigger Hydro auto-grouping. Verify unsupported per-case limits/scoring/dependencies/file-IO do not silently become a different judged task.
6. `<spj>`, `<tpj>`, `<interactor>`, `language="Text"`, templates, and solutions retain their source roles; Hydro FPS compatibility reporting states which are not installed. Keep native ZIP checker/asset handling available.

### Lemon implementation-driving checks

1. Export each native mode with its exact integer and `specialJudge: ""`; built-in-only archives need no checker build. Open/save-compatible JSON starts with `{`, uses `"version":"1.0"`, and retains relative paths, test limits, scores, bundles, and dependencies.
2. Run the text/numeric fixture tables against local equivalents. Include missing reference/output files, 31/32/33-byte boundaries, trailing/leading blank lines, PE line moves, p=0/3/6/18, relative-scale asymmetry, NaN/inf, numeric count errors, and large values that exceed JavaScript integer precision.
3. Preserve all six current `lemon:*` presets as custom mode 4; their existing six-argument score-file tests remain meaningful. Native mode 1 and `lemon:wcmp` must remain observably different on newline movement.
4. An internal local helper implementation must not cause exported native mode 0/1/3 tasks to acquire `specialJudge` or mode 4. Keep precision independent of custom `lemon:rcmp6`'s fixed source tolerance.

## 9. LemonLime package IMPORT and file reconciliation

Added **2026-10-28** for the expanded 0.4.1 import scope. This section uses the same LemonLime snapshot, plus the still-active binary writer at [`981b90f6` (2021-03-21)][M-OLD-SAVE] and Qt's own serialization implementations.

### 9.1 Descriptor format, package root, and selection

- **JSON CDF:** UTF-8 JSON object `{ "version": "1.0", "contestTitle": "…", "tasks": [...], "contestants": [...] }`; task/test keys are in section 5. Current saves use compact JSON. Missing `version` is accepted as `1.0`; a different **string** version is rejected. Upstream's `READ_JSON` helper returns errors that callers often ignore, including a non-string version; local import should validate the actual field types instead of reproducing that permissiveness. [M-CONTEST-JSON] [M-TASK-JSON] [M-JSON-HELPERS]
- **Legacy binary CDF:** the envelope and positional schema below; it is not XML or compressed JSON. Native loading checks the first byte for `{` or `[` and otherwise tries binary. **Check the binary magic on original bytes before any whitespace trimming: its first byte is `0x20`, an ASCII space.** Accepting BOM/leading whitespace for JSON can be a local importer convenience; emit JSON starting with `{` for native compatibility. [M-SAVE-LOAD] [M-BINARY-MAGIC]
- A native contest is a **directory containing a CDF with sibling `data/` and `source/`**, not a standardized ZIP manifest. A ZIP is transport for that directory. Resolve a descriptor at `wrapper/event/contest.cdf` against `wrapper/event/data/…`; retain arbitrary wrapper folders. Do not assume a test's subdirectory equals `sourceFileName` or the task title. A bare CDF contains configuration/results, not the bytes of tests, checkers, or contestant programs. [M-CONTEST-LAYOUT] [M-SAVE-LOAD] [M-JUDGER]
- **Multi-CDF recommendation:** enumerate each descriptor and its tasks using **CDF archive path + task ordinal**. Descriptors sharing one directory may be alternative/stale configurations over the same files; do not merge them by title/source name or automatically select the first. Each selected CDF keeps its own relative root and task order. This is TaskWeave import policy derived from Lemon's single-descriptor loading behavior. [M-SAVE-LOAD]

### 9.2 Legacy binary: exact current-reader-compatible wire format

The native magic is **`0x20111127`**. Neither the CDF format version nor a QDataStream version is stored in the binary envelope. The reader and historical writer do not call `setByteOrder` or `setVersion`, so QDataStream defaults apply: **big-endian**, with the library's compiled stream version. [M-BINARY-MAGIC] [M-SAVE-LOAD] [M-OLD-SAVE] [Q-STREAM]

| Offset | Wire type | Meaning |
| --- | --- | --- |
| 0 | `quint32`, BE | `0x20111127` (`20 11 11 27`). |
| 4 | `quint16`, BE | Qt `qChecksum` of the **entire following qCompress buffer**, including its four-byte size header. |
| 6 | `qint32`, BE | Byte length `N` of that qCompress buffer. This is the current reader's explicit `int len`. |
| 10 | `N` raw bytes | Written/read using `writeRawData`/`readRawData`: **no additional QByteArray length prefix**. |
| 10, inside that buffer | `quint32`, BE | Uncompressed-length **hint**. |
| 14 | zlib stream | Inflate this to obtain the positional QDataStream contest payload. Use zlib-wrapped inflate, not gzip or raw-deflate decoding. |

Qt's default checksum is **ISO 3309 CRC-16**: reflected polynomial `0x8408` (normal polynomial `0x1021`), initial `0xFFFF`, final complement/XOR `0xFFFF`. Qt implements it with a 16-entry nibble table. `qCompress` prepends four big-endian size bytes to ordinary zlib output; `qUncompress` treats that value as an allocation hint, not an authoritative bound on the actual expanded size. [Q-CHECKSUM] [Q-COMPRESS]

**Primitive/container decoding:** `int`/explicit enum/count fields below are signed 32-bit; booleans occupy **one byte**, with no alignment padding. `QString` is a length prefix followed by **UTF-16BE bytes**, where the length is bytes, not characters; `0xFFFFFFFF` means null, `0` means empty. `QStringList`/`QList<T>` are a length followed by elements; `QMap<QString,QString>` is a length followed by key/value QString pairs. Qt 5 uses `quint32` string/container lengths; Qt 6.7+ additionally recognizes `0xFFFFFFFE` followed by a 64-bit length. This extension does not change explicitly streamed `int` counts. Ordinary bounded, small-value records use the same layout across those versions. [Q-SCALARS] [Q-STREAM] [Q-STRING] [Q-CONTAINERS] [Q-OLD-STREAM]

Exact decompressed payload order (`S` = QString, `SL` = QStringList, `i32` = signed 32-bit):

```text
Contest:
  S contestTitle; i32 taskCount; Task[taskCount]; i32 contestantCount; Contestant[contestantCount]

Task:
  S problemTitle, sourceFileName, inputFileName, outputFileName
  bool standardInputCheck, standardOutputCheck
  i32 packedType                 # taskType = packedType & 255; subFolderCheck = bool(packedType >> 8)
  i32 comparisonMode; S diffArguments; i32 realPrecision; S specialJudge
  if taskType == 2: S interactor, grader, interactorName
  if taskType == 3 or 4:
    i32 sourceCount; (S sourceFilesPath, S sourceFilesName)[sourceCount]
    i32 graderCount; (S graderFilesPath, S graderFilesName)[graderCount]
  QMap<S,S> compilerConfiguration; S answerFileExtension
  i32 testCaseCount; TestCase[testCaseCount]

TestCase:
  i32 fullScore, timeLimit, memoryLimit; SL inputFilesWithDependencySentinels; SL outputFiles

Contestant:
  S contestantName; QList<bool> checkJudged; SL sourceFile; SL compileMesaage
  QList<QList<SL>> inputFiles, message
  QList<QList<QList<i32>>> score, timeUsed, memoryUsed
  quint32 judgingTime_date, judgingTime_time; quint8 judgingTime_timespec
  i32 compileStateCount; i32 compileState[compileStateCount]
  i32 resultTaskCount; { i32 groupCount; { i32 caseCount; i32 result[caseCount] }[groupCount] }[resultTaskCount]
```

`compileMesaage` is the upstream spelling. Legacy memory-history values remain **32-bit**, although current JSON uses `qint64`; the current binary reader explicitly reads the old three-dimensional int list and converts it. The date/time fields are explicitly serialized Julian-day/milliseconds/time-spec integers, **not** native `QDateTime` serialization. [M-BINARY-CONTEST] [M-BINARY-TASK] [M-BINARY-CASE] [M-BINARY-CONTESTANT] [M-OLD-TASK] [M-OLD-CONTESTANT]

**Practical Node support: yes, for this bounded, current-reader-compatible layout.** `Buffer.readUInt*BE` / `readInt32BE`, a copied buffer's `swap16().toString('utf16le')`, a small CRC routine, and `node:zlib.inflateSync(qCompressed.subarray(4), { maxOutputLength })` suffice; no Qt installation is needed for decoding. Validate envelope length/checksum, counts, strings, enums, and buffer boundaries before publishing imported problems. Retain the original CDF; contestant/history fields are provenance, not problem programs. [N-BUFFER] [N-INFLATE] [M-BINARY-CONTESTANT]

**Version boundary:** Qt 5.15's compiled stream version is **19**; Qt 6.8's is **22** (`Qt_6_7`). Neither number appears in a CDF. The historical Qt6 writer branch streamed `data.length()` and container `.size()` without narrowing casts: on 64-bit Qt6 these expressions can serialize as 64-bit `qsizetype`, while the current CDF reader expects 32-bit explicit counts/length. Do not advertise arbitrary historical binary variants as the one supported schema or guess widths until a parse happens to succeed. Report a recognized-but-unsupported layout with its original bytes preserved; a Lemon version able to open it can re-save to current JSON. [Q-STREAM] [Q-OLD-STREAM] [M-OLD-SAVE] [M-OLD-CONTEST] [M-OLD-TASK] [M-SAVE-LOAD]

### 9.3 Test entries, duplicate files, subtasks, and dependencies

1. Each `testCases[i]` is a scoring bundle with **one full score**, common ms/MiB limits, and ordered input/output occurrences. Remove dependency sentinel entries from `inputFiles` **before** positional pairing with `outputFiles`. Do not pair by basename when explicit arrays already give the mapping. [M-CASE-JSON] [M-BINARY-CASE]
2. Bundle score is the minimum of its constituent runs; task total adds bundle scores. Preserve zero scores. The same pair may appear in several bundles with different scores/limits, or occur repeatedly within one bundle: `addSingleCase` simply appends, and judging loops over the entries. Deduplicating file storage must not delete logical occurrences or membership-specific limits. The same input paired with different answers is a different logical case. [M-CASE-JSON] [M-JUDGER] [M-TASK-TOTALS]
3. The exact sentinel is **`<1-based-earlier-entry>_lemon_SUbtaskDEPENDENCE_fLAg`**. It refers to the enclosing task's `testCases` array positions, not file IDs, global task IDs, or filename prefixes. Translate via an original-entry-index → local-group-ID map. Validate positive, unique, earlier indices as the native UI does; do not shift them by dropping empty/missing-file entries. [M-CASE-JSON] [M-BINARY-CASE]
4. Dependency gating is **not universally “every prerequisite earned full marks”**: native judging skips a dependent only for negative predecessor status and carries partial completion ratios using scale **1,000,000**. Built-in all-or-zero comparisons map naturally to all-pass dependencies; custom-SPJ partial scoring needs the native semantics or an unresolved-scoring marker. [M-DEPENDENCY] [M-DEPENDENCY-FLOW]

Example: entry 1 has `inputFiles: ["p/1.in", "p/2.in"]`, matching outputs and `fullScore: 30`; entry 2 has `inputFiles: ["p/2.in", "1_lemon_SUbtaskDEPENDENCE_fLAg"]`, `outputFiles: ["p/2.out"]`, and `fullScore: 70`. Import two groups with a shared underlying pair and dependency 2 → 1; preserve each group's own limits. The sentinel is not a missing input file. [M-CASE-JSON] [M-JUDGER]

### 9.4 Task types, program references, and contestant separation

These are **`taskType`** values, independent of `comparisonMode`. All referenced task/test fields are persisted by the serializers; preparation defines their actual filesystem roles. [M-ENUM] [M-TASK-JSON] [M-PREPARE]

| `taskType` | Import meaning and path roles |
| --- | --- |
| `0` Traditional | Contestant source basename is `sourceFileName`; `inputFileName`/`outputFileName` are runtime IO names, with `standardInputCheck`/`standardOutputCheck` deciding redirection. They are not testcase filenames. |
| `1` AnswersOnly | Contestants submit answer files. Their names derive from each input reference's **complete basename** plus `answerFileExtension`; explicit `outputFiles` still identify reference answers. Do not convert this to batch merely because local authoring is data-only. |
| `2` Interaction | NOI-style linked interaction: `data/interactor` is copied under `interactorName` (normally a header); `data/grader` becomes `__grader.cpp`, compiled with contestant source. This is not a pipe-based external interactor. |
| `3` Communication | Paired `sourceFilesPath[]`/`sourceFilesName[]` identify **contestant** files and copied build names. Paired `graderFilesPath[]`/`graderFilesName[]` identify **data/** assets and copied build names. These are linked together. Preserve both path/name mappings and header roles. |
| `4` CommunicationExec | Same reference-list structure, but contestant sources are built separately and an orchestration grader named `grader.*` is selected from grader paths. It is a distinct runtime, not automatically equivalent to local linked-grader mode. Preserve unsupported semantics explicitly. |

The contestant root is `source/<contestant>/`, or `source/<contestant>/<sourceFileName>/` when `subFolderCheck` is true. `sourceFilesPath` is relative to that contestant root; `graderFilesPath`, `interactor`, `grader`, tests, and SPJ executable paths are relative to `data/`. **Contestant submissions/results are separate from problem-author sources:** a CDF has no statement body or designated main/reference solution, generator, or validator source field. Importing a problem does not require contestant directories to exist or make their first `.cpp` a standard solution. [M-CONTEST-LAYOUT] [M-TASK-JSON] [M-PREPARE] [M-JUDGER] [M-BINARY-CONTESTANT]

Validate matching lengths of each program path/name array pair and collisions among copied build names. The names are compilation-time identities, so flattening or renaming supplied headers independently can break contestant includes. [M-PREPARE]

`compilerConfiguration` maps compiler **names to configuration names**, e.g. `{"g++":"default"}` or `{"g++":"disable"}`; it does not contain compiler commands, installed language definitions/time-memory multipliers, or checker build commands. Native load drops unknown compiler names and resets unknown configuration names to `default` according to the local desktop settings. Preserve the original mapping during TaskWeave import instead of claiming to recover exact flags from a configuration label. SPJ modes 4/5 reference an **executable**, with no native checker-source manifest. [M-COMPILER-REFRESH] [M-PREPARE] [M-LEMON-SPJ] [M-TESTLIB-SPJ]

### 9.5 Recommended inventory/config reconciliation

Native CDF loading reads metadata; actual file checks mainly occur during judging. The following recovery rules are **TaskWeave recommendations**, not claims that Lemon automatically repairs its CDF. Record every original → resolved path and every unresolved reference in the import preview/provenance. [M-SAVE-LOAD] [M-JUDGER] [M-LINES] [M-LEMON-SPJ]

| Situation | Recommended behavior |
| --- | --- |
| Exact references exist | Use CDF pair ordering, bundles, scores, limits, and dependencies. Accept arbitrary explicit data extensions; extension filters are for discovery, not a restriction on configured references. |
| Slash / `./` differences | Normalize separators and harmless relative segments within the selected package namespace, retaining original text. Do not flatten to basename or search contestant folders to satisfy data references. Absolute/external or package-escaping paths stay unresolved. |
| Case mismatch | Try exact normalized path first; use a case-folded **full-path** match only if unique, and report the repair. Case-colliding archive entries are ambiguous even on a case-insensitive host. |
| Stale `.out` versus `.ans`, or redundant `data/` prefix | If exact lookup fails, offer only a unique same-directory/same-stem answer-suffix repair, or unique removal of the duplicated data prefix within the same CDF root. Report the substitution. Existing conflicting candidates require resolution; do not choose by ZIP order. `answerFileExtension` does not override reference `outputFiles`. |
| Missing input / answer or unequal real pair arrays | Preserve configuration and identify the exact entry/occurrence as incomplete; prevent ready-to-judge publication/export until resolved. A missing answer is not an empty answer—even native SPJs require its file to exist. **Exception:** native AnswersOnly with an in-process comparator can use the input path solely as a contestant-answer naming key, without opening the input file; preserve that task type rather than fabricate bytes. |
| Orphan complete pairs / single unpaired files | Retain all bytes and expose unconfigured complete pairs separately. Offer explicit addition with scoring/limit choices; do not silently insert them into existing bundles or redistribute their points. Keep unpaired files as unresolved/extra assets. Native auto-add scans new data subfolders and matches configured extensions (fallback `.in` with `.out`/`.ans`), but is not CDF reconciliation. |
| SPJ executable present, source absent | This can be a valid native Lemon package. Preserve executable bytes, comparison mode, path, and any supplied source assets; mark local source-based judging/rebuilding unresolved if unsupported. Do not silently substitute a built-in or infer a `lemon:*` preset from an executable filename. Missing the executable itself is a different missing-reference error. |
| Missing grader/header versus missing contestant code | Referenced **data/** grader/header files are problem dependencies and must be resolved. `sourceFilesPath` describes contestant obligations; absence of submitted contestant code does not invalidate a problem-definition import. Preserve non-batch task type and path/name mappings. |
| Multiple CDFs / empty task list / CDF-only upload | Select descriptors explicitly and keep roots independent. An empty task list may coexist with actual data; offer a clearly unconfigured data import with explicit defaults. A CDF-only upload can recover metadata but cannot manufacture its external files. |

A concrete first-party reconciliation fixture is [`manual/public/example.zip`][M-IMPORT-EXAMPLE]: **3,521 bytes**, SHA-256 `9a52043988557b1a28bf9a37a5e5bbce104dc7acf44b3043e2e98404c472a792`. Its wrapper is `example/`; `example/example.cdf` is exactly `{"contestTitle":"example","contestants":[],"tasks":[]}` (54 bytes, no version). It nevertheless contains two complete pairs under `example/data/plus/` and five contestant-language directories under `example/source/`. Thus an empty CDF task list does not establish that the package has no usable data. The native manual/auto-add implementation describes discovering these unconfigured folders. [M-IMPORT-EXAMPLE] [M-AUTO-ADD] [M-MANUAL-AUTO]

### 9.6 Minimal legacy fixture and verification artifacts

A **constructed schema fixture**, derived from the historical writer/current reader above, is **185 bytes**: magic `0x20111127`, checksum `0x8A43`, qCompress length **175**, inflated payload length **300**. It contains contest `Legacy fixture`, one Traditional `sum` task, native comparison mode 1, one 100-point / 1000-ms / 256-MiB pair `sum/1.in` → `sum/1.ans`, and zero contestants. Its complete CDF bytes are:

```base64
IBERJ4pDAAAArwAAASx4nFWPSwrCQBBEXxCyEBFx7cJ9iOIRdOXCS8R8NKATMRH0xh7D6skYkWEy1V1dVR1gwYGSExk5L5ZU1DzpeHBXHyLdMVsxie5OVUwr9io0CWgljVM9HepGbxeZluCxJ9WpleTEmneq6ZvPNZxzFnbiS+XYbCdkm/TVUZpancpv8PONpUh0LL3wfKbsi3TGmWMbJgsYvXvoP7Ow7ZrN8AfWn//1vw58AGE8Jks=
```

SHA-256: **`0b46c0f19a9da39dff48f85815f0319bab8e9dd81297ecc534ddd1ee7fab3bac`**. An independent Node **v24.16.0** verifier checked the envelope, CRC (bitwise implementation versus the fixture generator's Qt-style nibble table), bounded inflate, UTF-16BE decoding, every payload field, and full payload consumption against expected JSON. This verifies the source-derived wire fixture; a Lemon GUI import was not exercised.

Artifacts are under **`C:\Users\Administrator\AppData\Local\Temp\opencode\fps-lemon-research\cdf-import\`**:

- `legacy-minimal\contest.cdf`, `legacy-minimal\data\sum\1.in` (`1 2\n`), `legacy-minimal\data\sum\1.ans` (`3\n`).
- `legacy-minimal.zip`: wrapped single-CDF package; `legacy-minimal.expected.json`: its JSON-equivalent projection (the binary itself has no `version` field).
- `make-fixture.py` and `verify-fixture.mjs`: research generator and independent Node verification, respectively.
- `upstream-example.zip`: byte-exact downloaded official example for empty-CDF/orphan-pair/wrapper/contestant-separation tests.

## Primary source index

### Hydro

[H-FPS-DOC]: https://github.com/hydro-dev/hydro-dev.github.io/blob/7e6c11f7fa31a9b7523b1ce2860394e010393005/content/docs/Hydro/plugins/fps-importer.en.md#L5-L16
[H-FPS-PACKAGE]: https://github.com/hydro-dev/Hydro/blob/f5c2ac14e182b8f1238b1ee1a6e78e4fb0fdd816/packages/fps-importer/package.json#L1-L15
[H-FPS-RUN]: https://github.com/hydro-dev/Hydro/blob/f5c2ac14e182b8f1238b1ee1a6e78e4fb0fdd816/packages/fps-importer/index.ts#L19-L85
[H-FPS-POST]: https://github.com/hydro-dev/Hydro/blob/f5c2ac14e182b8f1238b1ee1a6e78e4fb0fdd816/packages/fps-importer/index.ts#L87-L144
[H-CONTENT]: https://github.com/hydro-dev/Hydro/blob/f5c2ac14e182b8f1238b1ee1a6e78e4fb0fdd816/packages/hydrooj/src/lib/content.ts#L97-L172
[H-ZIP]: https://github.com/hydro-dev/Hydro/blob/f5c2ac14e182b8f1238b1ee1a6e78e4fb0fdd816/packages/hydrooj/src/libs.ts#L1-L21
[H-NATIVE-DOC]: https://github.com/hydro-dev/hydro-dev.github.io/blob/7e6c11f7fa31a9b7523b1ce2860394e010393005/content/docs/Hydro/user/problem-format.md#L5-L41
[H-NATIVE-IMPORT]: https://github.com/hydro-dev/Hydro/blob/f5c2ac14e182b8f1238b1ee1a6e78e4fb0fdd816/packages/hydrooj/src/model/problem.ts#L571-L621
[H-NATIVE-EXPORT]: https://github.com/hydro-dev/Hydro/blob/f5c2ac14e182b8f1238b1ee1a6e78e4fb0fdd816/packages/hydrooj/src/model/problem.ts#L840-L911
[H-TESTDATA-DOC]: https://github.com/hydro-dev/hydro-dev.github.io/blob/7e6c11f7fa31a9b7523b1ce2860394e010393005/content/docs/Hydro/user/testdata.mdx#L28-L134
[H-AUTO]: https://github.com/hydro-dev/Hydro/blob/f5c2ac14e182b8f1238b1ee1a6e78e4fb0fdd816/packages/common/subtask.ts#L30-L180
[H-UNITS]: https://github.com/hydro-dev/Hydro/blob/f5c2ac14e182b8f1238b1ee1a6e78e4fb0fdd816/framework/utils/lib/common.ts#L161-L180
[H-CHECKERS]: https://github.com/hydro-dev/Hydro/blob/f5c2ac14e182b8f1238b1ee1a6e78e4fb0fdd816/packages/hydrojudge/src/checkers.ts#L132-L193
[H-JUDGE-CONFIG]: https://github.com/hydro-dev/Hydro/blob/f5c2ac14e182b8f1238b1ee1a6e78e4fb0fdd816/packages/hydrojudge/src/config.ts#L18-L29
[H-JUDGE-LIMITS]: https://github.com/hydro-dev/Hydro/blob/f5c2ac14e182b8f1238b1ee1a6e78e4fb0fdd816/packages/hydrojudge/src/cases.ts#L14-L35

### FPS format owner and reference implementation

[F-README]: https://github.com/zhblue/freeproblemset/blob/96419f1ee6b178f7943e976144208b58f631fa1c/README.md#L31-L70
[F-DTD]: https://github.com/zhblue/freeproblemset/blob/96419f1ee6b178f7943e976144208b58f631fa1c/fps.current.dtd#L1-L51
[F-EXAMPLE]: https://github.com/zhblue/freeproblemset/blob/96419f1ee6b178f7943e976144208b58f631fa1c/fps-zhblue-A%2BB.xml#L1-L34
[F-CDATA]: https://github.com/zhblue/hustoj/blob/9d5a5000005897fd06f0d36cf5ed80d51b22d0c7/trunk/web/admin/problem_export_xml.php#L17-L26
[F-EXPORT-TESTS]: https://github.com/zhblue/hustoj/blob/9d5a5000005897fd06f0d36cf5ed80d51b22d0c7/trunk/web/admin/problem_export_xml.php#L42-L69
[F-EXPORT-IMAGES]: https://github.com/zhblue/hustoj/blob/9d5a5000005897fd06f0d36cf5ed80d51b22d0c7/trunk/web/admin/problem_export_xml.php#L101-L169
[F-EXPORT]: https://github.com/zhblue/hustoj/blob/9d5a5000005897fd06f0d36cf5ed80d51b22d0c7/trunk/web/admin/problem_export_xml.php#L195-L293
[F-EXPORT-SPJ]: https://github.com/zhblue/hustoj/blob/9d5a5000005897fd06f0d36cf5ed80d51b22d0c7/trunk/web/admin/problem_export_xml.php#L294-L330
[F-EXPORT-ZIP]: https://github.com/zhblue/hustoj/blob/9d5a5000005897fd06f0d36cf5ed80d51b22d0c7/trunk/web/admin/problem_export_xml.php#L338-L371
[F-IMPORT-LIMITS]: https://github.com/zhblue/hustoj/blob/9d5a5000005897fd06f0d36cf5ed80d51b22d0c7/trunk/web/admin/problem_import_xml.php#L141-L187
[F-IMPORT-IMAGES]: https://github.com/zhblue/hustoj/blob/9d5a5000005897fd06f0d36cf5ed80d51b22d0c7/trunk/web/admin/problem_import_xml.php#L255-L294
[F-SPJ-DOC]: https://github.com/zhblue/hustoj/blob/9d5a5000005897fd06f0d36cf5ed80d51b22d0c7/docs/SpecialJudge.md#L17-L25
[F-TPJ]: https://github.com/zhblue/hustoj/blob/9d5a5000005897fd06f0d36cf5ed80d51b22d0c7/trunk/install/tpj.cc#L1-L20

### LemonLime

[M-ENUM]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/core/task.h#L22-L36
[M-UI]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/forms/taskeditwidget.ui#L211-L253
[M-ZH]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/translations/zh_CN.ts#L2445-L2468
[M-PRECISION-UI]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/forms/taskeditwidget.ui#L340-L375
[M-TASK-JSON]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/core/task.cpp#L241-L383
[M-CONTEST-JSON]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/core/contest.cpp#L228-L297
[M-CASE-JSON]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/core/testcase.cpp#L74-L151
[M-FIXTURE]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/tests/data/TestContest1/TestContest1.cdf
[M-SAVE-LOAD]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/lemon.cpp#L603-L703
[M-PATHS]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/base/settings.cpp#L690-L713
[M-JUDGER]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/core/taskjudger.cpp#L420-L551
[M-READER]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/core/casejudger.cpp#L99-L216
[M-LINES]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/core/casejudger.cpp#L218-L274
[M-SPACES]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/core/casejudger.cpp#L276-L340
[M-DIFF]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/core/casejudger.cpp#L342-L355
[M-REAL]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/core/casejudger.cpp#L357-L458
[M-LEMON-SPJ]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/core/casejudger.cpp#L460-L571
[M-TESTLIB-SPJ]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/core/casejudger.cpp#L573-L689
[M-DISPATCH]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/core/casejudger.cpp#L691-L855
[M-MANUAL-MODES]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/manual/src/content/docs/contest.typ#L50-L65
[M-MANUAL-SPJ]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/manual/src/content/docs/contest.typ#L79-L191
[M-MANUAL-CASES]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/manual/src/content/docs/contest.typ#L217-L234

### Supporting primary sources and local evidence

[XML2JS-PARSE]: https://github.com/Leonidas-from-XIV/node-xml2js/blob/cf3e061e22e98152b88068c2345bc02581f4d6c7/lib/parser.js#L119-L360
[XML2JS-DEFAULTS]: https://github.com/Leonidas-from-XIV/node-xml2js/blob/cf3e061e22e98152b88068c2345bc02581f4d6c7/lib/defaults.js#L29-L52
[ZIP-GETDATA]: https://github.com/gildas-lormeau/zip.js/blob/a6ba5033db457d5c97b39c32c338894bd5726132/index.d.ts#L2850-L2867
[XML-CDATA]: https://www.w3.org/TR/2008/REC-xml-20081126/#sec-cdata-sect
[XML-CHARS]: https://www.w3.org/TR/2008/REC-xml-20081126/#charsets
[XML-EOL]: https://www.w3.org/TR/2008/REC-xml-20081126/#sec-line-ends
[QT-SPIN]: https://doc.qt.io/qt-6/qspinbox.html#minimum-prop
[T-PRESETS]: ../../assets/shared/lemon/README.md
[T-PRESET-TESTS]: ../../packages/server/scripts/test-compatibility-completion.ts
[T-RCMP6]: ../../assets/shared/lemon/checkers/rcmp6.cpp

[M-CONTEST-LAYOUT]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/manual/src/content/docs/contest.typ#L7-L26
[M-JSON-HELPERS]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/base/LemonUtils.hpp#L16-L146
[M-BINARY-MAGIC]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/core/contest.h#L13-L20
[M-BINARY-CONTEST]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/core/contest.cpp#L298-L319
[M-BINARY-TASK]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/core/task.cpp#L386-L455
[M-BINARY-CASE]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/core/testcase.cpp#L153-L176
[M-BINARY-CONTESTANT]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/core/contestant.cpp#L195-L309
[M-OLD-SAVE]: https://github.com/Project-LemonLime/Project_LemonLime/blob/981b90f6b2a9de320ba774faa4ced4f5d6c64a01/src/lemon.cpp#L589-L611
[M-OLD-CONTEST]: https://github.com/Project-LemonLime/Project_LemonLime/blob/981b90f6b2a9de320ba774faa4ced4f5d6c64a01/src/core/contest.cpp#L342-L356
[M-OLD-TASK]: https://github.com/Project-LemonLime/Project_LemonLime/blob/981b90f6b2a9de320ba774faa4ced4f5d6c64a01/src/core/task.cpp#L245-L301
[M-OLD-CONTESTANT]: https://github.com/Project-LemonLime/Project_LemonLime/blob/981b90f6b2a9de320ba774faa4ced4f5d6c64a01/src/core/contestant.cpp#L180-L212
[M-PREPARE]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/core/taskjudger.cpp#L38-L252
[M-COMPILER-REFRESH]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/core/task.cpp#L189-L219
[M-TASK-TOTALS]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/core/task.cpp#L222-L239
[M-DEPENDENCY]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/core/subtaskdependencelib.h#L15-L30
[M-DEPENDENCY-FLOW]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/core/taskjudger.cpp#L391-L542
[M-IMPORT-EXAMPLE]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/manual/public/example.zip
[M-AUTO-ADD]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/src/lemon.cpp#L825-L959
[M-MANUAL-AUTO]: https://github.com/Project-LemonLime/Project_LemonLime/blob/69aa22370706a4f14b394a6e27aa92e7eca4a8f5/manual/src/content/docs/contest.typ#L292-L310
[Q-STREAM]: https://github.com/qt/qtbase/blob/b839e9b36db3a4e50dfb34521d8ef8de1fd01969/src/corelib/serialization/qdatastream.h#L49-L240
[Q-SCALARS]: https://github.com/qt/qtbase/blob/b839e9b36db3a4e50dfb34521d8ef8de1fd01969/src/corelib/serialization/qdatastream.cpp#L787-L902
[Q-STRING]: https://github.com/qt/qtbase/blob/b839e9b36db3a4e50dfb34521d8ef8de1fd01969/src/corelib/text/qstring.cpp#L9590-L9669
[Q-CONTAINERS]: https://github.com/qt/qtbase/blob/b839e9b36db3a4e50dfb34521d8ef8de1fd01969/src/corelib/serialization/qdatastream.h#L286-L483
[Q-OLD-STREAM]: https://github.com/qt/qtbase/blob/40143c189b7c1bf3c2058b77d00ea5c4e3be8b28/src/corelib/serialization/qdatastream.h#L70-L355
[Q-CHECKSUM]: https://github.com/qt/qtbase/blob/b839e9b36db3a4e50dfb34521d8ef8de1fd01969/src/corelib/text/qbytearray.cpp#L470-L518
[Q-COMPRESS]: https://github.com/qt/qtbase/blob/b839e9b36db3a4e50dfb34521d8ef8de1fd01969/src/corelib/text/qbytearray.cpp#L692-L817
[N-BUFFER]: https://nodejs.org/download/release/v24.11.0/docs/api/buffer.html#bufreaduint32beoffset
[N-INFLATE]: https://nodejs.org/download/release/v24.11.0/docs/api/zlib.html#zlibinflatesyncbuffer-options
