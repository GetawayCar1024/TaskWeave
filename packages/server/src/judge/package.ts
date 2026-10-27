import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { polygonFeatureWarnings, polygonLossWarnings, groupLayout, groupTotal, judgeMode, convertStatement, statementSyntaxWarnings, DEFAULT_TESTSET, LANG_TO_POLYGON, STATEMENT_SECTIONS, STD_PREFIX, parseIndexList, testsetsOf, testLimitLookup, type SolutionTag, type TestsManifest } from '@polyforge/shared';
import type { JobCtx } from '../jobs.js';
import { defsForProblem, readSharedDefs } from '../defs.js';
import { stdRefToPath } from '../sharedFiles.js';
import { atomicWrite, exists, safeJoin, HttpError } from '../util/fs.js';
import { ZipWriter } from '../util/zip.js';
import { pickLanguage } from './compiler.js';
import type { Judge, ProblemCtx } from './index.js';
import { parseScript } from './script.js';
import { answerPath, generateTests, inputPath } from './tests.js';
import { flattenFiles } from '@polyforge/shared';
import { buildTree } from '../workspace/files.js';
import { addAttachments } from '../workspace/attachments.js';
import { readStatementSections, wholeStatementLanguages, wholeStatementWarning } from '../workspace/statements.js';
import { checkGroups } from '../workspace/problems.js';

/** problem.xml solution tags. RE has no dedicated tag in the package format; "rejected" covers it. */
const XML_TAG: Record<SolutionTag, string> = {
  MA: 'main',
  OK: 'accepted',
  WA: 'wrong-answer',
  TL: 'time-limit-exceeded',
  'TL-OR-OK': 'time-limit-exceeded-or-accepted',
  TM: 'time-limit-exceeded-or-memory-limit-exceeded',
  ML: 'memory-limit-exceeded',
  RE: 'rejected',
  PE: 'presentation-error',
  RJ: 'rejected',
  NR: 'do-not-run',
  FL: 'failed',
};

const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface PackageResult {
  file: string;
  size: number;
  tests: number;
  warnings: string[];
}

export const exportDir = (ctx: ProblemCtx) => path.join(ctx.work, 'export');

/**
 * Export a Polygon-style package (DESIGN §9 M5): problem.xml, sources, statements
 * (sections and an assembled problem.tex per language, tutorials), and all tests with
 * answers. Tests are generated first. With `into`, entries go into an outer zip under
 * a prefix (contest packages) instead of a file of their own.
 */
export async function exportPackage(judge: Judge, ctx: ProblemCtx, job: JobCtx, into?: { zip: ZipWriter; prefix: string }, nativePolygon = false): Promise<PackageResult> {
  const warnings: string[] = [];
  const { config, ref } = ctx;
  const legacyOi = config.problem.type === 'oi' && !nativePolygon;
  if (!legacyOi) warnings.push(...polygonLossWarnings(config));
  warnings.push(...wholeStatementWarning(await wholeStatementLanguages(ref.dir)));
  const unsupported = polygonFeatureWarnings(config, 'package');
  if (!legacyOi && unsupported.length) throw new HttpError(400, 'polygon_features', unsupported.join('\n'));
  if (judgeMode(config.problem) === 'grader' && !legacyOi) throw new HttpError(400, 'grader_polygon', 'Grader problems cannot use Polygon packages. Export the contest to LemonLime instead.');
  const sets = testsetsOf(config);
  const manifests = new Map<string, TestsManifest>();
  for (const ts of sets) {
    job.progress(0, 3, `generating ${ts.name}`);
    const m = await generateTests(judge, ctx, { signal: job.signal, progress: (d, t) => job.progress(0, 3, `generating ${ts.name} ${d}/${t}`) }, ts.name);
    if (!m.ok) {
      if (legacyOi) warnings.push(...m.errors.map(error => `${ts.name}: ${error}`));
      else throw new HttpError(400, 'polygon_export', `${ts.name}: ${m.errors.join('\n')}`);
    }
    manifests.set(ts.name, m);
    if (ts.groups) for (const group of checkGroups(ts.name, ts.group)) {
      const indices = parseIndexList(group.tests ?? '');
      if (!indices.length || indices.some(index => !m.tests.some(test => test.index === index))) throw new HttpError(400, 'polygon_export', `${ts.name}/${group.name}: subtask is empty or refers to missing tests.`);
      if (config.tests.points && groupTotal(group) === undefined) throw new HttpError(400, 'polygon_export', `${ts.name}/${group.name}: subtask has no score.`);
    }
  }
  const manifest = manifests.get(DEFAULT_TESTSET)!;
  job.progress(1, 3, 'packing');

  const writer = into?.zip ?? new ZipWriter({ async: true });
  const entries = new Map<string, Buffer>();
  const zip = { add: (name: string, data: Buffer | string) => {
    const bytes = typeof data === 'string' ? Buffer.from(data) : data;
    const old = entries.get(name);
    if (old) { if (!old.equals(bytes)) throw new HttpError(400, 'polygon_export', `Package file collision: ${name}`); return; }
    entries.set(name, bytes); writer.add((into?.prefix ?? '') + name, bytes);
  } };
  if (legacyOi) {
    for (const f of flattenFiles(await buildTree(ref.dir))) {
      if (f.path.startsWith('attachments/') || f.path === 'files/testlib.h') continue;
      zip.add(f.path, await fsp.readFile(safeJoin(ref.dir, f.path)));
    }
    await addAttachments(zip, ref.dir, 'attachments/');
    zip.add('files/testlib.h', await fsp.readFile(path.join(judge.global.sharedDir, 'testlib.h')));
    if (!(await exists(path.join(ref.dir, 'files/defs.toml')))) zip.add('files/defs.toml', await readSharedDefs(judge.global.sharedDir));
    let count = 0;
    for (const [name, m] of manifests) for (const test of m.tests) {
      count++;
      for (const [ext, file] of [['in', inputPath(ctx, test.index, name)], ['ans', answerPath(ctx, test.index, name)]]) {
        if (await exists(file)) zip.add(`data/${name}/${test.index}.${ext}`, await fsp.readFile(file));
      }
    }
    if (into) return { file: '', size: 0, tests: count, warnings };
    const file = `${config.problem.name}-oi-${Date.now()}.zip`;
    const data = await writer.finishAsync();
    await atomicWrite(path.join(exportDir(ctx), file), data);
    return { file, size: data.length, tests: count, warnings };
  }
  const languages = (await judge.global.readLanguages()).languages;
  const typeOf = (rel: string) => {
    try {
      return pickLanguage(languages, rel, judge.langOf(config, rel))?.lang.polygon;
    } catch {
      return undefined;
    }
  };
  const read = (rel: string) => fsp.readFile(safeJoin(ref.dir, rel));
  const src = (p: string, type?: string) => `<source path="${x(p)}"${type ? ` type="${x(type)}"` : ''}/>`;

  // ---- files: resources + executables ----
  const resources: string[] = [];
  zip.add('files/testlib.h', await fsp.readFile(path.join(judge.global.sharedDir, 'testlib.h')));
  resources.push('<file path="files/testlib.h" type="h.g++"/>');
  const allFiles = flattenFiles(await buildTree(ref.dir));
  const ownFiles = allFiles.filter(f => f.path.startsWith('files/')).map(f => f.path.slice('files/'.length)).sort();
  for (const f of ownFiles) {
    if (f === 'testlib.h') continue;
    zip.add(`files/${f}`, await read(`files/${f}`)); resources.push(`<file path="files/${x(f)}"/>`);
  }
  // Preserve source-relative include trees (and imported original assets) without flattening.
  for (const f of allFiles) if (!/^tests\//.test(f.path) && !/^statement\//.test(f.path)) zip.add(`files/project/${f.path}`, await read(f.path));
  if (!entries.has('files/project/testlib.h')) zip.add('files/project/testlib.h', await fsp.readFile(path.join(judge.global.sharedDir, 'testlib.h')));
  for (const name of entries.keys()) if (name.startsWith('files/project/') && /\.(?:h|hpp|hh|hxx|inc)$/i.test(name)) resources.push(`<file path="${x(name)}"/>`);
  // The statement macros (\Def…), like testlib.h: the shared defs.toml unless the problem has its own.
  const defs = ownFiles.includes('defs.toml') ? null : await readSharedDefs(judge.global.sharedDir).catch(() => null);
  if (defs !== null) {
    // With a Chinese statement the version with the Chinese macros, else the original one.
    const zh = !!config.problem.title.zh?.trim() || (await fsp.stat(path.join(ref.dir, 'statement', 'zh')).then((s) => s.isDirectory()).catch(() => false));
    zip.add('files/defs.toml', Buffer.from(defsForProblem(defs, zh), 'utf8'));
    resources.push('<file path="files/defs.toml"/>');
  }
  const executables: string[] = [];
  for (const [, gsrc] of await judge.generators(ctx)) {
    const name = `files/project/${gsrc}`;
    zip.add(name, await read(gsrc));
    executables.push(`<executable>${src(name, typeOf(gsrc))}</executable>`);
  }

  // ---- assets ----
  const assets: string[] = [];
  const role = async (rel: string) => {
    const name = `files/project/${rel}`;
    zip.add(name, await read(rel));
    return src(name, typeOf(rel));
  };
  if (config.checker) {
    const c = config.checker.source;
    if (c.startsWith(STD_PREFIX)) {
      const rel = stdRefToPath(c)!;
      const text = await fsp.readFile(path.join(judge.global.sharedDir, rel));
      zip.add('files/check.cpp', text);
      zip.add('check.cpp', text);
      assets.push(`<checker name="std::${x(c.slice(STD_PREFIX.length))}.cpp" type="testlib">${src('files/check.cpp', 'cpp.g++17')}<copy path="check.cpp"/></checker>`);
    } else {
      zip.add('check.cpp', await read(c));
      assets.push(`<checker type="testlib">${await role(c)}<copy path="check.cpp"/></checker>`);
    }
  } else warnings.push('no checker configured');
  if (config.problem.interactive && config.interactor) assets.push(`<interactor>${await role(config.interactor.source)}</interactor>`);
  if (config.validator) assets.push(`<validators><validator>${await role(config.validator.source)}</validator></validators>`);
  const sols: string[] = [];
  for (const s of config.solutions) {
    if (!(await exists(safeJoin(ref.dir, s.source)))) continue;
    const name = `files/project/${s.source}`;
    zip.add(name, await read(s.source));
    sols.push(`<solution tag="${XML_TAG[s.tag]}">${src(name, typeOf(s.source))}</solution>`);
  }
  assets.push(`<solutions>${sols.join('')}</solutions>`);

  // ---- tests: one <testset> per testset, files under <testset>/NN (Polygon layout) ----
  const samples = new Set(parseIndexList(config.tests.samples ?? ''));
  // Polygon statements only show samples of "tests"; statement/<lang>/constraints.tex and samples/ are OI-only.
  for (const ts of sets) if (ts.name !== DEFAULT_TESTSET && parseIndexList(ts.samples ?? '').length) warnings.push(`${ts.name}: samples outside the "tests" testset are not part of Polygon statements`);
  const testsetXml: string[] = [];
  let count = 0;
  const provenance: Record<string, unknown> = {};
  for (const ts of sets) {
    const m = manifests.get(ts.name)!;
    const layout = groupLayout(ts, !!config.tests.points), limits = testLimitLookup(config, ts);
    const groups = new Map(ts.group.map(group => [group.name, group]));
    const rows = m.tests.flatMap(test => (layout.memberships[test.index]?.length ? layout.memberships[test.index] : ['']).map(group => ({ test, group })));
    const n = rows.length; count += n;
    const effective = rows.map(row => limits(row.test.index, groups.get(row.group)));
    const time = effective[0]?.timeLimit ?? config.problem.time_limit, memory = effective[0]?.memoryLimit ?? config.problem.memory_limit;
    if (effective.some(limit => limit.timeLimit !== time || limit.memoryLimit !== memory)) throw new HttpError(400, 'polygon_features', `${ts.name}: Polygon supports one time/memory limit per testset. The selected subtasks or tests have different limits.`);
    if (!Number.isSafeInteger(memory * 1024 * 1024)) throw new HttpError(400, 'polygon_features', 'Polygon memory must be exactly representable in whole bytes.');
    if (time < 250 || time > 15000 || time % 50 || !Number.isInteger(memory) || memory < 4 || memory > 1024) warnings.push(`${ts.name}: this XML preserves ${time} ms / ${memory} MiB; Polygon's service accepts 250–15000 ms in steps of 50 and 4–1024 MiB.`);
    if (n !== m.tests.length) warnings.push(`${ts.name}: shared tests were copied for each Polygon group membership.`);
    const width = n < 100 ? 2 : n < 1000 ? 3 : 4;
    const pad = (i: number) => String(i).padStart(width, '0');
    const scriptText = ts.script ? await read(ts.script).then((b) => b.toString('utf8')).catch(() => '') : '';
    const cmds = new Map<string, string>();
    try {
      for (const c of parseScript(scriptText)) cmds.set(c.text, [c.generator, ...c.args].join(' '));
    } catch {
      /* invalid script: tests are exported without commands */
    }
    if (scriptText) zip.add(ts.name === DEFAULT_TESTSET ? 'scripts/gen.txt' : `scripts/gen-${ts.name}.txt`, scriptText);
    const testsXml: string[] = [];
    for (const [position, row] of rows.entries()) {
      const t = row.test, ordinal = position + 1;
      const inFile = inputPath(ctx, t.index, ts.name);
      const ansFile = answerPath(ctx, t.index, ts.name);
      zip.add(`${ts.name}/${pad(ordinal)}`, await fsp.readFile(inFile));
      zip.add(`${ts.name}/${pad(ordinal)}.a`, await fsp.readFile(ansFile));
      const group = groups.get(row.group);
      const indices = group ? [...new Set(parseIndexList(group.tests ?? ''))].sort((a, b) => a - b) : [];
      const points = group?.policy === 'EACH_TEST' ? layout.byGroup[group.name]?.[t.index] : group ? (t.index === indices[indices.length - 1] ? group.points ?? 0 : 0) : ts.cases?.[t.index]?.points;
      provenance[`${ts.name}:${ordinal}`] = { source: `${ts.name}:${t.index}`, input: t.originalInput ?? (t.origin === 'manual' ? t.source : undefined), output: t.originalOutput };
      const attrs = [
        t.origin === 'script' && cmds.get(t.source) ? `cmd="${x(cmds.get(t.source)!)}"` : '',
        `method="${t.origin === 'manual' ? 'manual' : 'generated'}"`,
        ts.name === DEFAULT_TESTSET && samples.has(t.index) ? 'sample="true"' : '',
        row.group ? `group="${x(row.group)}"` : '',
        config.tests.points && points !== undefined ? `points="${points}"` : '',
      ].filter(Boolean);
      testsXml.push(`<test ${attrs.join(' ')}/>`);
    }
    const groupsXml = ts.groups
      ? `<groups>${ts.group
          .map(
            (g) =>
              `<group name="${x(g.name)}"${config.tests.points && groupTotal(g) !== undefined ? ` points="${groupTotal(g)}"` : ''} points-policy="${g.policy === 'EACH_TEST' ? 'each-test' : 'complete-group'}">${
                g.dependencies?.length ? `<dependencies>${g.dependencies.map((d) => `<dependency group="${x(d)}"/>`).join('')}</dependencies>` : ''
              }</group>`,
          )
          .join('')}</groups>`
      : '';
    testsetXml.push(`    <testset name="${x(ts.name)}">
      <time-limit>${time}</time-limit>
      <memory-limit>${memory * 1024 * 1024}</memory-limit>
      <test-count>${n}</test-count>
      <input-path-pattern>${x(ts.name)}/%0${width}d</input-path-pattern>
      <answer-path-pattern>${x(ts.name)}/%0${width}d.a</answer-path-pattern>
      <tests>${testsXml.join('')}</tests>${groupsXml}
    </testset>`);
  }
  zip.add('polyforge-tests.json', JSON.stringify({ format: 'polyforge-polygon', version: 1, tests: provenance }));

  // ---- statements & tutorials (per language; tutorials follow the statement languages) ----
  const statements: string[] = [];
  const tutorials: string[] = [];
  const names = Object.entries(config.problem.title).map(([lang, title]) => `<name language="${x(LANG_TO_POLYGON[lang] ?? lang)}" value="${x(title)}"/>`);
  const sampleTests = manifest.tests.filter((t) => samples.has(t.index));
  for (const lang of (await fsp.readdir(path.join(ref.dir, 'statement')).catch(() => [] as string[])).sort()) {
    if (lang === 'images') continue;
    const source = await readStatementSections(ref.dir, lang);
    const sec: Record<string, string> = {};
    for (const s of STATEMENT_SECTIONS) {
      const converted = convertStatement(source[s] ?? '', 'polygon');
      sec[s] = converted.tex;
      warnings.push(...statementSyntaxWarnings(`statement/${lang}/${s}.tex`, converted.warnings));
    }
    if (!sec.legend && !sec.input && !sec.output && !sec.tutorial) continue;
    const plang = LANG_TO_POLYGON[lang] ?? lang;
    const title = config.problem.title[lang] || config.problem.name;
    const dir = `statement-sections/${plang}`;
    zip.add(`${dir}/name.tex`, title);
    for (const [s, text] of Object.entries(sec)) if (text) zip.add(`${dir}/${s}.tex`, text);
    for (const [k, t] of sampleTests.entries()) {
      const n = String(k + 1).padStart(2, '0');
      const exampleIn = t.statementInput ? safeJoin(ref.dir, t.statementInput) : inputPath(ctx, t.index);
      zip.add(`${dir}/example.${n}`, await fsp.readFile(exampleIn).catch(() => Buffer.alloc(0)));
      const exampleOut = t.statementOutput ? safeJoin(ref.dir, t.statementOutput) : answerPath(ctx, t.index);
      zip.add(`${dir}/example.${n}.a`, await fsp.readFile(exampleOut).catch(() => Buffer.alloc(0)));
      // exmpfile in problem.tex refers to files next to it.
      zip.add(`statements/${plang}/example.${n}`, await fsp.readFile(exampleIn).catch(() => Buffer.alloc(0)));
      zip.add(`statements/${plang}/example.${n}.a`, await fsp.readFile(exampleOut).catch(() => Buffer.alloc(0)));
    }
    if (sec.legend || sec.input || sec.output) {
      const io = (v: string, std: string) => (v === std || !v ? `standard ${std === 'stdin' ? 'input' : 'output'}` : v);
      const tex = [
        `\\begin{problem}{${title}}{${io(config.problem.input, 'stdin')}}{${io(config.problem.output, 'stdout')}}{${config.problem.time_limit / 1000} second${config.problem.time_limit === 1000 ? '' : 's'}}{${config.problem.memory_limit} megabytes}`,
        '',
        sec.legend,
        '',
        sec.input && `\\InputFile\n\n${sec.input}\n`,
        sec.output && `\\OutputFile\n\n${sec.output}\n`,
        sec.interaction && `\\Interaction\n\n${sec.interaction}\n`,
        sec.scoring && `\\Scoring\n\n${sec.scoring}\n`,
        sampleTests.length ? `\\Examples\n\n${sampleTests.map((_, k) => `\\exmpfile{example.${String(k + 1).padStart(2, '0')}}{example.${String(k + 1).padStart(2, '0')}.a}`).join('\n')}\n` : '',
        sec.notes && `\\Note\n\n${sec.notes}\n`,
        '\\end{problem}',
        '',
      ]
        .join('\n')
        .replace(/\n{3,}/g, '\n\n');
      zip.add(`statements/${plang}/problem.tex`, tex);
      statements.push(`<statement charset="UTF-8" language="${x(plang)}" mathjax="true" path="statements/${x(plang)}/problem.tex" type="application/x-tex"/>`);
      if (!sec.tutorial) warnings.push(`statement language ${lang} has no tutorial`);
    } else if (sec.tutorial) warnings.push(`tutorial language ${lang} has no statement`);
    if (sec.tutorial) {
      zip.add(`statements/${plang}/tutorial.tex`, `\\begin{tutorial}{${title}}\n\n${sec.tutorial}\n\n\\end{tutorial}\n`);
      tutorials.push(`<tutorial charset="UTF-8" language="${x(plang)}" mathjax="true" path="statements/${x(plang)}/tutorial.tex" type="application/x-tex"/>`);
    }
  }
  for (const image of allFiles.filter(file => file.path.startsWith('statement/images/'))) {
    const name = image.path.slice('statement/images/'.length), bytes = await read(image.path);
    zip.add(`statement-sections/images/${name}`, bytes);
    for (const lang of Object.keys(config.problem.title)) {
      const plang = LANG_TO_POLYGON[lang] ?? lang;
      zip.add(`statements/${plang}/${name}`, bytes); zip.add(`statement-sections/${plang}/${name}`, bytes);
    }
  }

  const io = (v: string, std: string) => (v === std ? '' : v);
  const xml = `<?xml version="1.0" encoding="utf-8" standalone="no"?>
<problem revision="1" short-name="${x(config.problem.name)}">
  <names>${names.join('')}</names>
  <statements>${statements.join('')}</statements>
  <tutorials>${tutorials.join('')}</tutorials>
  <judging input-file="${x(io(config.problem.input, 'stdin'))}" output-file="${x(io(config.problem.output, 'stdout'))}"${config.problem.interactive ? ' run-count="1"' : ''}>
${testsetXml.join('\n')}
  </judging>
  <files>
    <resources>${resources.join('')}</resources>
    <executables>${executables.join('')}</executables>
  </files>
  <assets>${assets.join('')}</assets>
  <tags/>
</problem>
`;
  zip.add('problem.xml', xml);
  if (into) return { file: '', size: 0, tests: count, warnings };

  job.progress(2, 3, 'writing');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const file = `${config.problem.name}-${stamp}.zip`;
  const data = await writer.finishAsync();
  await atomicWrite(path.join(exportDir(ctx), file), data);
  job.progress(3, 3, 'done');
  return { file, size: data.length, tests: count, warnings };
}
