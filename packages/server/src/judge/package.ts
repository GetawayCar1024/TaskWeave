import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { DEFAULT_TESTSET, LANG_TO_POLYGON, STATEMENT_SECTIONS, STD_PREFIX, parseIndexList, testsetsOf, type SolutionTag, type TestsManifest } from '@polyforge/shared';
import type { JobCtx } from '../jobs.js';
import { stdRefToPath } from '../sharedFiles.js';
import { atomicWrite, exists, safeJoin } from '../util/fs.js';
import { ZipWriter } from '../util/zip.js';
import { pickLanguage } from './compiler.js';
import type { Judge, ProblemCtx } from './index.js';
import { parseScript } from './script.js';
import { answerPath, generateTests, inputPath } from './tests.js';

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
export async function exportPackage(judge: Judge, ctx: ProblemCtx, job: JobCtx, into?: { zip: ZipWriter; prefix: string }): Promise<PackageResult> {
  const warnings: string[] = [];
  const { config, ref } = ctx;
  const sets = testsetsOf(config);
  const manifests = new Map<string, TestsManifest>();
  for (const ts of sets) {
    job.progress(0, 3, `generating ${ts.name}`);
    const m = await generateTests(judge, ctx, { signal: job.signal, progress: (d, t) => job.progress(0, 3, `generating ${ts.name} ${d}/${t}`) }, ts.name);
    if (!m.ok) warnings.push(...m.errors.map((e) => `${ts.name}: ${e}`));
    manifests.set(ts.name, m);
  }
  const manifest = manifests.get(DEFAULT_TESTSET)!;
  job.progress(1, 3, 'packing');

  const zip = into ? { add: (name: string, data: Buffer | string) => into.zip.add(into.prefix + name, data) } : new ZipWriter();
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
  for (const f of (await fsp.readdir(path.join(ref.dir, 'files')).catch(() => [] as string[])).sort()) {
    if (f.startsWith('.') || f === 'testlib.h') continue;
    zip.add(`files/${f}`, await read(`files/${f}`));
    resources.push(`<file path="files/${x(f)}"/>`);
  }
  const executables: string[] = [];
  for (const [, gsrc] of await judge.generators(ctx)) {
    const name = path.posix.basename(gsrc);
    zip.add(`files/${name}`, await read(gsrc));
    executables.push(`<executable>${src(`files/${name}`, typeOf(gsrc))}</executable>`);
  }

  // ---- assets ----
  const assets: string[] = [];
  const role = async (rel: string) => {
    const name = path.posix.basename(rel);
    zip.add(`files/${name}`, await read(rel));
    return src(`files/${name}`, typeOf(rel));
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
    const name = path.posix.basename(s.source);
    zip.add(`solutions/${name}`, await read(s.source));
    sols.push(`<solution tag="${XML_TAG[s.tag]}">${src(`solutions/${name}`, typeOf(s.source))}</solution>`);
  }
  assets.push(`<solutions>${sols.join('')}</solutions>`);

  // ---- tests: one <testset> per testset, files under <testset>/NN (Polygon layout) ----
  const samples = new Set(parseIndexList(config.tests.samples ?? ''));
  const testsetXml: string[] = [];
  const count = manifest.tests.length;
  for (const ts of sets) {
    const m = manifests.get(ts.name)!;
    const n = m.tests.length;
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
    for (const t of m.tests) {
      const inFile = inputPath(ctx, t.index, ts.name);
      const ansFile = answerPath(ctx, t.index, ts.name);
      if (await exists(inFile)) zip.add(`${ts.name}/${pad(t.index)}`, await fsp.readFile(inFile));
      if (await exists(ansFile)) zip.add(`${ts.name}/${pad(t.index)}.a`, await fsp.readFile(ansFile));
      else warnings.push(`${ts.name}: test ${t.index} has no answer`);
      const attrs = [
        t.origin === 'script' && cmds.get(t.source) ? `cmd="${x(cmds.get(t.source)!)}"` : '',
        `method="${t.origin === 'manual' ? 'manual' : 'generated'}"`,
        ts.name === DEFAULT_TESTSET && samples.has(t.index) ? 'sample="true"' : '',
        ts.groups && t.group ? `group="${x(t.group)}"` : '',
        config.tests.points && t.points !== undefined ? `points="${t.points}"` : '',
      ].filter(Boolean);
      testsXml.push(`<test ${attrs.join(' ')}/>`);
    }
    const groupsXml = ts.groups
      ? `<groups>${ts.group
          .map(
            (g) =>
              `<group name="${x(g.name)}"${g.points !== undefined ? ` points="${g.points}"` : ''} points-policy="${g.policy === 'EACH_TEST' ? 'each-test' : 'complete-group'}">${
                g.dependencies?.length ? `<dependencies>${g.dependencies.map((d) => `<dependency group="${x(d)}"/>`).join('')}</dependencies>` : ''
              }</group>`,
          )
          .join('')}</groups>`
      : '';
    testsetXml.push(`    <testset name="${x(ts.name)}">
      <time-limit>${config.problem.time_limit}</time-limit>
      <memory-limit>${config.problem.memory_limit * 1024 * 1024}</memory-limit>
      <test-count>${n}</test-count>
      <input-path-pattern>${x(ts.name)}/%0${width}d</input-path-pattern>
      <answer-path-pattern>${x(ts.name)}/%0${width}d.a</answer-path-pattern>
      <tests>${testsXml.join('')}</tests>${groupsXml}
    </testset>`);
  }
  if (config.scoring?.source) warnings.push('the local scoring program is not part of the package');

  // ---- statements & tutorials (per language; tutorials follow the statement languages) ----
  const statements: string[] = [];
  const tutorials: string[] = [];
  const names: string[] = [];
  const secRead = (lang: string, sec: string) =>
    fsp
      .readFile(path.join(ref.dir, 'statement', lang, `${sec}.tex`), 'utf8')
      .then((s) => s.replace(/\r\n/g, '\n').trim())
      .catch(() => '');
  const sampleTests = manifest.tests.filter((t) => samples.has(t.index));
  for (const lang of (await fsp.readdir(path.join(ref.dir, 'statement')).catch(() => [] as string[])).sort()) {
    if (lang === 'images') continue;
    const sec: Record<string, string> = {};
    for (const s of STATEMENT_SECTIONS) sec[s] = await secRead(lang, s);
    if (!sec.legend && !sec.input && !sec.output && !sec.tutorial) continue;
    const plang = LANG_TO_POLYGON[lang] ?? lang;
    const title = config.problem.title[lang] || config.problem.name;
    names.push(`<name language="${x(plang)}" value="${x(title)}"/>`);
    const dir = `statement-sections/${plang}`;
    zip.add(`${dir}/name.tex`, title);
    for (const [s, text] of Object.entries(sec)) if (text) zip.add(`${dir}/${s}.tex`, text);
    for (const [k, t] of sampleTests.entries()) {
      const n = String(k + 1).padStart(2, '0');
      zip.add(`${dir}/example.${n}`, await fsp.readFile(inputPath(ctx, t.index)).catch(() => Buffer.alloc(0)));
      zip.add(`${dir}/example.${n}.a`, await fsp.readFile(answerPath(ctx, t.index)).catch(() => Buffer.alloc(0)));
      // exmpfile in problem.tex refers to files next to it.
      zip.add(`statements/${plang}/example.${n}`, await fsp.readFile(inputPath(ctx, t.index)).catch(() => Buffer.alloc(0)));
      zip.add(`statements/${plang}/example.${n}.a`, await fsp.readFile(answerPath(ctx, t.index)).catch(() => Buffer.alloc(0)));
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
  for (const img of (await fsp.readdir(path.join(ref.dir, 'statement', 'images')).catch(() => [] as string[])).sort()) {
    if (img.startsWith('.')) continue;
    zip.add(`statement-sections/images/${img}`, await read(`statement/images/${img}`));
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
  const data = (zip as ZipWriter).finish();
  await atomicWrite(path.join(exportDir(ctx), file), data);
  job.progress(3, 3, 'done');
  return { file, size: data.length, tests: count, warnings };
}
