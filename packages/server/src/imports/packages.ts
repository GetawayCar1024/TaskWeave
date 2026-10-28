import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse, stringify } from 'smol-toml';
import { compressRanges, PROBLEM_NAME_RE, problemTomlSchema, TESTSET_NAME_RE, testsetsOf, type PackageCandidate, type PackageImportOptions, type PackageImportResult } from '@taskweave/shared';
import { atomicWrite, exists, HttpError, safeJoin, validateFileName } from '../util/fs.js';
import { detectPackageFormat, readPackageArchive } from './input.js';
import { prepareProvidedTests } from '../judge/tests.js';
import type { Judge } from '../judge/index.js';
import { badPackage, hydroLimit, parseData, yamlObject, type DataPlan } from './data.js';
import { publishProblem } from './publish.js';
import { snapshotImportedAnswers } from '../workspace/answerBackups.js';
import { polygonCandidates, readPolygonPackage, importPolygonPackage } from './polygon.js';
import { fpsCandidates, importFps } from './fps.js';
import { PackageReferences } from './references.js';
import { importLemon, lemonCandidates } from './lemon.js';
import { packageMetadata } from '../workspace/migrateNames.js';

const formats = ['polygon-package', 'hydro-problem', 'lemonlime', 'fps', 'data', 'joi', 'luogu-data', 'hydro-data'];
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'imported-problem';
const subtree = (files: Map<string, Buffer>, prefix: string) => new Map([...files].filter(([name]) => name.startsWith(prefix)).map(([name, data]) => [name.slice(prefix.length), data]));
const language = (name: string) => {
  const lang = name.toLowerCase().replace(/_/g, '-').split('-')[0];
  return /^[a-z]{2,8}$/.test(lang) && lang !== 'images' ? lang : 'en';
};

export function packageCandidates(files: Map<string, Buffer>, options: PackageImportOptions): PackageCandidate[] {
  if (!formats.includes(options.format)) return badPackage('Unknown import format.');
  if (options.format === 'fps') return fpsCandidates(files, options);
  if (options.format === 'lemonlime') return lemonCandidates(files, options);
  if (options.format === 'polygon-package') return polygonCandidates(files);
  if (options.format === 'joi' || options.format === 'data') {
    const prefixes = new Set<string>();
    const outputs = new Set([...files.keys()].flatMap(file => { const match = /^(.*\/)?out\/.+$/i.exec(file); return match ? [(match[1] ?? '').toLowerCase()] : []; }));
    for (const file of files.keys()) { const match = /^(.*\/)?in\/.+$/i.exec(file); if (match && outputs.has((match[1] ?? '').toLowerCase())) prefixes.add(match[1] ?? ''); }
    if (!prefixes.size) for (const file of files.keys()) if (/\.in$/i.test(file)) prefixes.add(file.slice(0, file.lastIndexOf('/') + 1));
    const roots = [...prefixes].filter(prefix => ![...prefixes].some(other => other !== prefix && prefix.startsWith(other)));
    return (roots.length ? roots : ['']).map(entry => ({ entry, title: '', name: options.name || slug(entry.split('/').filter(Boolean).pop() || 'imported-problem') }));
  }
  if (options.format !== 'hydro-problem') return [{ entry: '', title: '', name: options.name || 'imported-problem' }];
  return [...files.keys()].filter(p => /(?:^|\/)problem\.ya?ml$/i.test(p)).sort().map(file => {
    const meta = packageMetadata(yamlObject(files.get(file), file));
    const entry = file.slice(0, file.lastIndexOf('/') + 1);
    const title = String(meta.title ?? meta.name ?? meta.pid ?? path.posix.basename(entry.slice(0, -1)) ?? 'Imported problem');
    return { entry, title, name: typeof meta.taskweave?.name === 'string' && PROBLEM_NAME_RE.test(meta.taskweave.name) ? meta.taskweave.name : slug(String(meta.pid ?? (entry ? path.posix.basename(entry.slice(0, -1)) : title))) };
  });
}

/** ZIPs made by selecting a folder may have one wrapper. Preserve its contents, including extras. */
function dataFiles(files: Map<string, Buffer>): { files: Map<string, Buffer>; prefix: string } {
  if ([...files.keys()].some(p => /^[^/]+\.(?:in|ya?ml|ini)$/i.test(p))) return { files, prefix: '' };
  const roots = [...new Set([...files.keys()].map(p => p.split('/')[0]))];
  if (roots.length === 1 && [...files.keys()].every(p => p.includes('/'))) {
    const inner = dataFiles(subtree(files, roots[0] + '/'));
    return { files: inner.files, prefix: roots[0] + '/' + inner.prefix };
  }
  if ([...files.keys()].some(p => p.startsWith('testdata/'))) return { files: subtree(files, 'testdata/'), prefix: 'testdata/' };
  return { files, prefix: '' };
}

interface Statement { lang: string; source: string; text: string }
function hydroStatements(files: Map<string, Buffer>, meta: Record<string, any>, fallbackLang: string, warnings: string[]): Statement[] {
  const result: Statement[] = [];
  const add = (source: string, lang: string) => {
    validateFileName(source);
    const bytes = files.get(source) ?? badPackage(`Missing Hydro statement: ${source}`);
    if (/\.(?:md|tex|txt)$/i.test(source)) result.push({ source, lang: language(lang), text: bytes.toString('utf8') });
    else warnings.push(`Statement ${source} is preserved in Other files; add an editable text statement to enable authoring.`);
  };
  if (meta.statements !== undefined) {
    if (!Array.isArray(meta.statements)) return badPackage('Hydro statements must be a list.');
    const names = new Set<string>();
    for (const s of meta.statements) {
      if (!s || typeof s.name !== 'string' || typeof s.lang !== 'string' || !!s.source === !!s.file || names.has(s.name)) badPackage('Invalid Hydro statement manifest entry.');
      names.add(s.name); validateFileName(s.name);
      const file = s.source ?? s.file;
      if (typeof file !== 'string' || /[\\/]/.test(file) || /^problem\.ya?ml$/i.test(file)) badPackage('Invalid Hydro statement source reference.');
      add(s.source ? file : `additional_file/${file}`, s.lang);
    }
    return result;
  }
  for (const base of ['', 'statement/', 'problem_statement/']) {
    const plain = ['problem.md', 'problem.tex', 'problem.pdf'].find(p => files.has(base + p));
    if (plain) { add(base + plain, fallbackLang); return result; }
    const localized = [...files.keys()].filter(p => p.startsWith(base) && !p.slice(base.length).includes('/') && /^problem[_.]([\w-]+)\.(md|tex|pdf)$/i.test(p.slice(base.length))).sort();
    for (const file of localized) add(file, file.slice(base.length).match(/^problem[_.]([\w-]+)\./i)![1]);
    if (localized.length) return result;
  }
  if (meta.content) {
    let content = meta.content;
    if (typeof content === 'string' && content.trim().startsWith('{')) { try { content = JSON.parse(content); } catch { /* plain statement */ } }
    if (typeof content === 'string') result.push({ lang: fallbackLang, source: 'problem.yaml', text: content });
    else if (typeof content === 'object') for (const [lang, text] of Object.entries(content)) if (typeof text === 'string') result.push({ lang: language(lang), source: 'problem.yaml', text });
    if (meta.html) warnings.push('The Hydro statement uses HTML. Its original source is preserved; check the editable statement preview.');
  }
  return result;
}

/** Extract only complete Hydro inputN/outputN fence pairs; retain unmatched fences as authored text. */
function samplesFromStatement(text: string) {
  const fence = /^([ \t]*)(`{3,}|~{3,})(input|output)(\d+)[ \t]*\r?\n([\s\S]*?)^\1\2[ \t]*\r?$/gm;
  const inputs = new Map<string, string>(), outputs = new Map<string, string>();
  for (const m of text.matchAll(fence)) (m[3] === 'input' ? inputs : outputs).set(m[4], m[5].replace(/\r\n/g, '\n'));
  const ids = [...inputs.keys()].filter(id => outputs.has(id)).sort((a, b) => Number(a) - Number(b));
  return { samples: ids.map(id => ({ input: inputs.get(id)!, output: outputs.get(id)! })), text: text.replace(fence, (all, _indent, _fence, _kind, id) => ids.includes(id) ? '' : all) };
}

const defaultChecker = `#include "testlib.h"
#include <string>
#include <vector>
std::vector<std::string> lines(InStream& stream) {
    std::vector<std::string> result;
    while (!stream.eof()) {
        std::string s = stream.readString();
        while (!s.empty() && (s.back() == ' ' || s.back() == '\\t' || s.back() == '\\r')) s.pop_back();
        result.push_back(s);
    }
    while (!result.empty() && result.back().empty()) result.pop_back();
    return result;
}
int main(int argc, char** argv) {
    registerTestlibCmd(argc, argv);
    if (lines(ans) != lines(ouf)) quitf(_wa, "Output differs (ignoring trailing spaces and empty lines)");
    quitf(_ok, "Output matches");
}
`;

function addData(local: Map<string, Buffer>, plan: DataPlan, manual: string) {
  plan.pairs.forEach((p, i) => {
    local.set(`${manual}/${i + 1}.in`, p.inputData);
    local.set(`${manual}/${i + 1}.ans`, p.outputData);
    plan.cases[i + 1] = { ...plan.cases[i + 1], original_input: plan.cases[i + 1]?.original_input ?? p.input, original_output: plan.cases[i + 1]?.original_output ?? p.output };
  });
  return { manual, answers: 'provided', groups: plan.groups.length > 0, group: plan.groups, cases: plan.cases,
    ...(plan.samples.length ? { samples: compressRanges(plan.samples) } : {}),
    ...(plan.unresolvedScoring ? { unresolved_scoring: true } : {}) };
}

function readPackageInput(archive: Map<string, Buffer>, options: PackageImportOptions) {
  if (!formats.includes(options.format)) return badPackage('Unknown import format.');
  if (!archive.size) return badPackage('The ZIP archive contains no files.');
  const full = options.format === 'hydro-problem', format = options.format === 'luogu-data' ? 'luogu' : options.format === 'hydro-data' || full ? 'hydro' : options.format === 'joi' ? 'joi' : 'data';
  const candidates = packageCandidates(archive, options);
  let files = archive, plan: DataPlan, metadata: Record<string, any> = {}, dataPrefix = '', chosen: PackageCandidate | undefined;
  if (full) {
    chosen = candidates.find(c => c.entry === options.entry) ?? (candidates.length === 1 && options.entry === undefined ? candidates[0] : undefined);
    if (!chosen) return badPackage(candidates.length ? 'Select a problem directory from the Hydro archive.' : 'No problem.yaml in this Hydro package.');
    files = subtree(archive, chosen.entry);
    const metadataFile = [...files.keys()].find(p => /^problem\.ya?ml$/i.test(p))!;
    metadata = packageMetadata(yamlObject(files.get(metadataFile), metadataFile));
    dataPrefix = 'testdata/';
    const data = subtree(files, dataPrefix);
    if (!data.size) return badPackage('Hydro problem has no testdata/ directory.');
    plan = parseData(data, 'hydro');
    hydroStatements(files, metadata, language(options.lang ?? 'zh'), []);
    const cfg = plan.sourceConfig;
    const references = new PackageReferences(data, plan.warnings);
    if (cfg.filename !== undefined) {
      if (typeof cfg.filename !== 'string' || /[\\/]/.test(cfg.filename)) return badPackage('Invalid Hydro file-IO name.');
      validateFileName(cfg.filename);
    }
    for (const role of ['checker', 'validator', 'interactor', 'manager']) {
      if (cfg[role] === undefined) continue;
      const file = typeof cfg[role] === 'string' ? cfg[role] : cfg[role]?.file;
      if (typeof file !== 'string' || !file) return badPackage(`Invalid Hydro ${role} reference.`);
      if (role === 'checker' && !file.includes('.')) continue;
      validateFileName(file);
      const actual = references.find(file) ?? badPackage(`Missing Hydro program: ${file}`);
      cfg[role] = typeof cfg[role] === 'string' ? actual : { ...cfg[role], file: actual };
    }
    for (const key of ['user_extra_files', 'judge_extra_files']) {
      if (cfg[key] === undefined) continue;
      if (!Array.isArray(cfg[key])) return badPackage(`Hydro ${key} must be a list.`);
      cfg[key] = cfg[key].map((file: string) => {
        validateFileName(file);
        return references.require(file);
      });
    }
  } else {
    if (options.entry) {
      if (!candidates.some(candidate => candidate.entry === options.entry)) return badPackage('Unknown problem directory in archive.');
      files = subtree(archive, options.entry);
    }
    const data = dataFiles(files); dataPrefix = data.prefix;
    plan = parseData(data.files, format === 'data' ? 'auto' : format);
  }
  return { full, format, candidates, files, plan, metadata, dataPrefix, chosen };
}

/** Validate archive integrity and each candidate's configuration before enabling Import. */
export function inspectPackage(bytes: Buffer | Map<string, Buffer>, options: PackageImportOptions): PackageCandidate[] {
  const archive = bytes instanceof Map ? bytes : readPackageArchive(bytes);
  options = { ...options, format: detectPackageFormat(archive, options.format) };
  if (!archive.size) return badPackage('The ZIP archive contains no files.');
  const candidates = packageCandidates(archive, options);
  if (options.format === 'fps' || options.format === 'lemonlime') return candidates;
  if (!candidates.length) return badPackage('No problem.yaml in this Hydro package.');
  const size = [...archive.values()].reduce((sum, bytes) => sum + bytes.length, 0);
  return candidates.map(candidate => {
    try {
      if (options.format === 'polygon-package') {
        const result = readPolygonPackage(archive, { ...options, entry: candidate.entry });
        const checked = problemTomlSchema.safeParse(result.doc);
        if (!checked.success) return badPackage(`Invalid Polygon configuration: ${checked.error.message}`);
        return { ...candidate, files: result.local.size, size, tests: result.tests, warnings: result.warnings };
      }
      const input = readPackageInput(archive, { ...options, entry: candidate.entry });
      const valid = problemTomlSchema.safeParse({ problem: { name: candidate.name, time_limit: input.plan.timeLimit, memory_limit: input.plan.memoryLimit },
        tests: { cases: input.plan.cases, group: input.plan.groups, points: input.plan.pointsEnabled ?? true } });
      if (!valid.success) return badPackage(`Imported configuration is invalid: ${valid.error.message}`);
      return { ...candidate, files: archive.size, size, tests: input.plan.pairs.length, warnings: input.plan.warnings, timeLimit: input.plan.timeLimit, memoryLimit: input.plan.memoryLimit,
        titles: input.metadata?.taskweave?.titles ?? input.plan.sourceConfig?.problem?.title };
    } catch (e) { return { ...candidate, files: archive.size, size, error: (e as Error).message }; }
  });
}

export async function importPackage(judge: Judge, bytes: Buffer | Map<string, Buffer>, options: PackageImportOptions, problemId?: string): Promise<PackageImportResult> {
  const archive = bytes instanceof Map ? bytes : readPackageArchive(bytes);
  options = { ...options, format: detectPackageFormat(archive, options.format) };
  if (!formats.includes(options.format)) return badPackage('Unknown import format.');
  if (options.format === 'fps') {
    return importFps(judge, archive, options, problemId);
  }
  if (options.format === 'lemonlime') return importLemon(judge, archive, options, problemId);
  if (options.format === 'polygon-package') {
    if (problemId) return badPackage('Polygon packages create new problems.');
    return importPolygonPackage(judge, archive, options);
  }
  const fallbackLang = language(options.lang ?? 'zh');
  const { full, format, candidates, chosen, files, plan, metadata, dataPrefix } = readPackageInput(archive, options);
  const local = new Map<string, Buffer>(), warnings = [...plan.warnings];
  const id = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  const other = `other/${format}${problemId ? '-' + id : ''}`;
  const extras: string[] = [];
  for (const [file, data] of files) {
    if (file.startsWith(dataPrefix) && plan.used.has(file.slice(dataPrefix.length))) continue;
    const dest = `${other}/${file}`;
    local.set(dest, data); extras.push(dest);
  }
  if (full && chosen?.entry) for (const [file, data] of archive) {
    if (candidates.some(c => file.startsWith(c.entry))) continue;
    const dest = `${other}/archive/${file}`;
    local.set(dest, data); extras.push(dest);
  }
  // Keep provenance without relying on transient .taskweave caches.
  local.set(`${other}/taskweave-import.json`, Buffer.from(JSON.stringify({ format: options.format, entry: chosen?.entry,
    testFiles: plan.pairs.map((p, i) => ({ index: i + 1, input: dataPrefix + p.input, output: p.output ? dataPrefix + p.output : null })) }, null, 2)));
  const testset = options.testset ?? 'tests';
  if (!TESTSET_NAME_RE.test(testset)) return badPackage('Invalid target testset name.');
  const manual = problemId ? `tests/imported-${testset}-${id}` : 'tests/manual';
  const testConfig = addData(local, plan, manual);
  let doc: Record<string, any>, dir: string, name: string, originalConfig: string | undefined;
  const registry = judge.registry;
  if (problemId) {
    const ref = await registry.get(problemId);
    const current = await registry.readConfig(ref);
    if (!current.config) return badPackage(current.error ?? 'Invalid problem.toml');
    dir = ref.dir; name = current.config.problem.name;
    originalConfig = await fs.readFile(path.join(dir, 'problem.toml'), 'utf8');
    doc = parse(originalConfig) as Record<string, any>;
    if (testset === 'tests') doc.tests = { ...testConfig, points: plan.pointsEnabled ?? true };
    else { doc.testsets ??= {}; doc.testsets[testset] = testConfig; doc.tests ??= {}; if (plan.pointsEnabled !== false) doc.tests.points = true; }
    // An import into an existing problem only changes data/scoring, not statement or programs.
  } else {
    const root = registry.requireRoot(options.root);
    name = options.name?.trim() || chosen?.name || 'imported-problem';
    if (!PROBLEM_NAME_RE.test(name)) return badPackage('Name must be lowercase letters, digits and dashes (up to 64 characters).');
    dir = path.join(root, name);
    doc = { problem: { name, type: 'cf', data_only: true, title: { [fallbackLang]: chosen?.title || name }, time_limit: plan.timeLimit,
      memory_limit: plan.memoryLimit, input: 'stdin', output: 'stdout', judge_mode: 'batch' }, tests: { ...testConfig, points: plan.pointsEnabled ?? true } };
    if (testset !== 'tests') return badPackage('New problems import their data into the tests testset.');
    if (plan.sourceConfig.format === 'taskweave-inout') {
      const p = plan.sourceConfig.problem;
      if (p?.title) doc.problem.title = p.title;
      if (p?.input) doc.problem.input = p.input;
      if (p?.output) doc.problem.output = p.output;
    }
  }
  if (full && !problemId) {
    const sources = hydroStatements(files, metadata, fallbackLang, warnings);
    const byLang = new Map<string, Statement[]>();
    for (const s of sources) byLang.set(s.lang, [...(byLang.get(s.lang) ?? []), s]);
    let canonicalSamples: ReturnType<typeof samplesFromStatement>['samples'] | undefined;
    for (const [lang, statements] of byLang) {
      const parsed = samplesFromStatement(statements.map(s => s.text).join('\n\n'));
      // Images are copied to the shared statement-assets namespace. File links keep
      // their file:// form, which the preview resolves through the same authenticated API.
      const text = parsed.text.replace(/(!\[[^\]]*\]\()file:\/\/([^\s)]+)(\))/g, '$1$2$3');
      local.set(`statement/${lang}/statement.tex`, Buffer.from(text));
      doc.problem.title[lang] = typeof metadata.taskweave?.titles?.[lang] === 'string' ? metadata.taskweave.titles[lang] : chosen!.title;
      if (!canonicalSamples && parsed.samples.length) canonicalSamples = parsed.samples;
      if (parsed.samples.length && canonicalSamples && parsed.samples.length !== canonicalSamples.length) {
        // Keep a language with different sample numbering exactly as authored.
        local.set(`statement/${lang}/statement.tex`, Buffer.from(statements.map(s => s.text).join('\n\n')));
        warnings.push(`${lang}: the statement has a different sample count; its sample fences were retained. Check sample settings.`);
      } else parsed.samples.forEach((s, i) => {
        local.set(`statement/${lang}/samples/samples-${i + 1}.in`, Buffer.from(s.input));
        local.set(`statement/${lang}/samples/samples-${i + 1}.out`, Buffer.from(s.output));
      });
    }
    for (const [file, data] of files) if (file.startsWith('additional_file/') && /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(file)) local.set(`statement/images/${file.slice('additional_file/'.length)}`, data);
    if (canonicalSamples?.length) {
      canonicalSamples.forEach((s, i) => { local.set(`tests/samples/${i + 1}.in`, Buffer.from(s.input)); local.set(`tests/samples/${i + 1}.ans`, Buffer.from(s.output)); });
      doc.testsets = { samples: { manual: 'tests/samples', answers: 'provided', samples: `1-${canonicalSamples.length}`, groups: true,
        group: [{ name: 'samples', tests: `1-${canonicalSamples.length}`, points: 0, policy: 'EACH_TEST' }] } };
    }
    const cfg = plan.sourceConfig;
    const sourceRef = (value: unknown): string | undefined => {
      const file = typeof value === 'string' ? value : value && typeof value === 'object' ? (value as { file?: string }).file : undefined;
      if (!file) return undefined;
      validateFileName(file);
      const full = `${dataPrefix}${file}`;
      if (!files.has(full)) return badPackage(`Missing Hydro program: ${file}`);
      return `${other}/${full}`;
    };
    if (cfg.filename) {
      if (typeof cfg.filename !== 'string' || /[\\/]/.test(cfg.filename)) badPackage('Invalid Hydro file-IO name.');
      validateFileName(cfg.filename);
      doc.problem.input = `${cfg.filename}.in`; doc.problem.output = `${cfg.filename}.out`;
    }
    const checker = typeof cfg.checker === 'string' ? cfg.checker : cfg.checker?.file;
    if (checker && !checker.includes('.')) {
      if (await exists(path.join(judge.global.sharedDir, 'checkers', `${checker}.cpp`))) doc.checker = { source: `std:${checker}` };
      else warnings.push(`Unknown built-in Hydro checker ${checker}; configure a local checker before enabling authoring.`);
    } else if (checker && cfg.checker_type === 'lemon') doc.lemon_checker = { source: sourceRef(cfg.checker) };
    else if (checker && (!cfg.checker_type || cfg.checker_type === 'testlib')) doc.checker = { source: sourceRef(cfg.checker) };
    else if (checker) warnings.push(`Hydro checker protocol ${cfg.checker_type} is preserved but needs conversion before local judging.`);
    else {
      local.set('checker.cpp', Buffer.from(defaultChecker)); doc.checker = { source: 'checker.cpp' };
      if (cfg.checker_type === 'strict') { local.delete('checker.cpp'); doc.checker = { source: 'std:fcmp' }; }
    }
    if (cfg.validator) doc.validator = { source: sourceRef(cfg.validator) };
    if (cfg.interactor) { doc.interactor = { source: sourceRef(cfg.interactor) }; doc.problem.judge_mode = 'io'; doc.problem.interactive = true; }
    const solutions = [...files.keys()].filter(f => /^(?:std|solutions?|submissions\/accepted)\/.+\.(cpp|cc|cxx|py|java|rs|go)$/i.test(f));
    if (solutions.length) doc.solutions = solutions.map((file, i) => ({ source: `${other}/${file}`, tag: i ? 'OK' : 'MA' }));
    if (metadata.limits && cfg.time === undefined && metadata.limits.time_limit !== undefined) doc.problem.time_limit = hydroLimit(`${metadata.limits.time_limit}s`, 'time', plan.timeLimit);
    const ready = byLang.size > 0 && doc.validator && doc.checker && doc.solutions?.length && (!cfg.type || ['default', 'interactive'].includes(cfg.type));
    doc.problem.data_only = !ready;
  }
  if (!problemId) {
    if (options.title) doc.problem.title = options.title;
    if (options.timeLimit !== undefined) doc.problem.time_limit = options.timeLimit;
    if (options.memoryLimit !== undefined) doc.problem.memory_limit = options.memoryLimit;
  }
  local.set(`${other}/IMPORT.md`, Buffer.from(`# ${options.format}\n\n${warnings.map(w => '- ' + w).join('\n')}\n\n## Source files / 原始文件\n\n${extras.map(p => '- ' + p).join('\n')}\n`));
  const parsed = problemTomlSchema.safeParse(doc);
  if (!parsed.success) return badPackage(`Imported configuration is invalid: ${parsed.error.message}`);
  if (!problemId) return { problem: await publishProblem(judge, local, doc, options.root, options.folder), tests: plan.pairs.length, extras, warnings };
  snapshotImportedAnswers(local, doc);
  const written: string[] = [];
  try {
    for (const [rel, data] of local) {
      const abs = safeJoin(dir, rel);
      if (await exists(abs)) throw new HttpError(409, 'exists', `Import destination already exists: ${rel}`);
      await atomicWrite(abs, data); written.push(abs);
    }
    // Publish last. A parse failure or partial write cannot replace the existing data configuration.
    if (await fs.readFile(path.join(dir, 'problem.toml'), 'utf8') !== originalConfig) throw new HttpError(409, 'conflict', 'problem.toml changed during import. Retry with the current configuration.');
    await atomicWrite(path.join(dir, '.taskweave', 'import-backups', id, 'problem.toml'), originalConfig!);
    await atomicWrite(path.join(dir, 'problem.toml'), stringify(doc));
  } catch (e) {
    for (const file of written) await fs.rm(file, { force: true });
    throw e;
  }
  await registry.scan();
  const ref = await registry.get(problemId);
  const ctx = await judge.ctx(problemId);
  if (ctx.config.problem.data_only || testsetOfProvided(ctx.config, testset)) await prepareProvidedTests(ctx, testset);
  return { problem: await registry.summary(ref), tests: plan.pairs.length, extras, warnings };
}

const testsetOfProvided = (config: import('@taskweave/shared').ProblemToml, name: string) => testsetsOf(config).find(testset => testset.name === name)?.answers === 'provided';
