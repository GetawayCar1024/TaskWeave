import path from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { compressRanges, DEFAULT_TESTSET, LANG_FROM_POLYGON, STATEMENT_SECTIONS, TESTSET_NAME_RE,
  type PackageCandidate, type PackageImportOptions, type PackageImportResult, type SolutionTag, type TestGroup } from '@polyforge/shared';
import type { Judge } from '../judge/index.js';
import { parseScript } from '../judge/script.js';
import { validateFileName } from '../util/fs.js';
import { checkGroups } from '../workspace/problems.js';
import { badPackage } from './data.js';
import { publishProblem } from './publish.js';

type Xml = Record<string, any>;
const list = <T>(value: T | T[] | undefined): T[] => value === undefined || value === '' ? [] : Array.isArray(value) ? value : [value];
const obj = (value: unknown, where: string): Xml => value && typeof value === 'object' && !Array.isArray(value) ? value as Xml : badPackage(`${where}: expected an XML element.`);
const attr = (node: Xml, key: string) => typeof node[`@_${key}`] === 'string' ? node[`@_${key}`] as string : undefined;
const numeric = (value: unknown, where: string, positive = false) => {
  const n = typeof value === 'string' && value.trim() ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(n) || n < 0 || positive && n === 0) return badPackage(`${where}: invalid number.`);
  return n;
};
const langOf = (value: string) => LANG_FROM_POLYGON[value.toLowerCase()] ?? (/^[a-z]{2,8}$/.test(value) && value !== 'images' ? value : 'en');
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'imported-problem';
const subtree = (files: Map<string, Buffer>, prefix: string) => new Map([...files].filter(([name]) => name.startsWith(prefix)).map(([name, data]) => [name.slice(prefix.length), data]));

/** No DTD or external entities; validate syntax before following any package reference. */
export function polygonXml(bytes: Buffer | undefined): Xml {
  if (!bytes || bytes.length > 4 * 1024 * 1024) return badPackage('Missing or oversized Polygon problem.xml.');
  const source = bytes.toString('utf8');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) return badPackage('XML DTDs and entity declarations are not supported.');
  const validation = XMLValidator.validate(source);
  if (validation !== true) return badPackage(`Invalid problem.xml: ${validation.err.msg}`);
  const parsed = new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false, trimValues: false }).parse(source);
  const problem = obj(parsed.problem, 'problem.xml/problem');
  if (!problem.judging?.testset) return badPackage('This problem.xml is not a Polygon judging descriptor.');
  return problem;
}

export function polygonPath(pattern: unknown, index: number): string {
  if (typeof pattern !== 'string') return badPackage('Missing Polygon test path pattern.');
  const matches = [...pattern.matchAll(/%(?:0?(\d+))?d/g)];
  if (matches.length !== 1 || pattern.replace(matches[0][0], '').includes('%')) return badPackage(`Unsupported Polygon path pattern: ${pattern}`);
  const width = Number(matches[0][1] ?? 0);
  if (width > 16) return badPackage('Polygon path padding is too large.');
  const name = pattern.replace(matches[0][0], String(index).padStart(width, '0')).replace(/\\/g, '/').replace(/^\.\//, '');
  validateFileName(name); return name;
}

function descriptor(files: Map<string, Buffer>): string | undefined {
  return [...files.keys()].find(name => /^problem\.xml\.polygon$/i.test(name)) ?? [...files.keys()].find(name => /^problem\.xml$/i.test(name));
}

export function polygonCandidates(files: Map<string, Buffer>): PackageCandidate[] {
  const discovered = [...new Set([...files.keys()].filter(name => /(?:^|\/)problem\.xml(?:\.polygon)?$/i.test(name)).map(name => name.slice(0, name.lastIndexOf('/') + 1)))].sort();
  const validRoots = new Set(discovered.filter(root => { try { const entries = subtree(files, root); polygonXml(entries.get(descriptor(entries)!)); return true; } catch { return false; } }));
  // A source/provenance directory may retain an old problem.xml inside a real problem.
  const roots = discovered.filter(root => ![...validRoots].some(parent => parent !== root && root.startsWith(parent)));
  if (!roots.length) return badPackage('No Polygon problem.xml in this archive.');
  return roots.map(entry => {
    const name = slug(path.posix.basename(entry.slice(0, -1)) || 'imported-problem');
    try {
      const filesInProblem = subtree(files, entry), p = polygonXml(filesInProblem.get(descriptor(filesInProblem)!));
      const titles = Object.fromEntries(list<Xml>(p.names?.name).map(n => [langOf(attr(n, 'language') ?? 'english'), attr(n, 'value') ?? '']));
      const sets = list<Xml>(p.judging.testset), primary = sets.find(ts => attr(ts, 'name') === 'tests') ?? sets[0];
      return { entry, name: slug(attr(p, 'short-name') || name), title: titles.zh || titles.en || Object.values(titles)[0] || name, titles,
        timeLimit: numeric(primary['time-limit'], 'time-limit', true), memoryLimit: numeric(primary['memory-limit'], 'memory-limit', true) / 1024 / 1024,
        tests: sets.reduce((sum, ts) => sum + list(ts.tests?.test).length, 0) };
    } catch (e) { return { entry, name, title: name, error: (e as Error).message }; }
  });
}

const TAGS: Record<string, SolutionTag> = { main: 'MA', accepted: 'OK', 'wrong-answer': 'WA', 'time-limit-exceeded': 'TL',
  'time-limit-exceeded-or-accepted': 'TL-OR-OK', 'time-limit-exceeded-or-memory-limit-exceeded': 'TM', 'memory-limit-exceeded': 'ML',
  'runtime-error': 'RE', 'presentation-error': 'PE', rejected: 'RJ', 'do-not-run': 'NR', failed: 'FL' };

/** Strip only Polygon's problem wrapper; section commands remain in the editable body. */
function texSections(source: string): Record<string, string> {
  let text = source.replace(/^\uFEFF/, '');
  const start = /\\begin\{problem\}/.exec(text);
  if (start) {
    let at = start.index + start[0].length;
    for (let i = 0; i < 5; i++) {
      while (/\s/.test(text[at] ?? '') && at < text.length) at++;
      if (text[at] !== '{') return { legend: text };
      let depth = 1; at++;
      while (at < text.length && depth) { if (text[at] === '\\') at += 2; else { if (text[at] === '{') depth++; if (text[at] === '}') depth--; at++; } }
    }
    text = text.slice(at).replace(/\\end\{problem\}[\s\S]*$/, '');
  }
  const sections: Record<string, string> = {}, names: Record<string, string> = { InputFile: 'input', OutputFile: 'output', Interaction: 'interaction', Scoring: 'scoring', Examples: 'examples', Note: 'notes' };
  let key = 'legend', at = 0;
  for (const match of text.matchAll(/\\(InputFile|OutputFile|Interaction|Scoring|Examples|Note)\b/g)) {
    sections[key] = (sections[key] ?? '') + text.slice(at, match.index).trim(); key = names[match[1]]; at = match.index! + match[0].length;
  }
  sections[key] = (sections[key] ?? '') + text.slice(at).trim(); delete sections.examples; return sections;
}

export function readPolygonPackage(archive: Map<string, Buffer>, options: PackageImportOptions) {
  const candidates = polygonCandidates(archive);
  const candidate = candidates.find(c => c.entry === options.entry) ?? (options.entry === undefined && candidates.length === 1 ? candidates[0] : undefined);
  if (!candidate) return badPackage('Select a problem directory from the Polygon archive.');
  if (candidate.error) return badPackage(candidate.error);
  const files = subtree(archive, candidate.entry), xml = polygonXml(files.get(descriptor(files)!));
  const local = new Map<string, Buffer>(), warnings: string[] = [], extras: string[] = [];
  let provenance: Record<string, any> = {};
  const provenanceBytes = files.get('polyforge-tests.json');
  if (provenanceBytes && provenanceBytes.length < 4 * 1024 * 1024) {
    try { const value = JSON.parse(provenanceBytes.toString('utf8')); if (value.format === 'polyforge-polygon' && value.version === 1 && value.tests && typeof value.tests === 'object') provenance = value.tests; }
    catch { warnings.push('Invalid Taskweave filename metadata; used the native Polygon paths.'); }
  }
  for (const [name, bytes] of files) { local.set(`other/polygon/${name}`, bytes); extras.push(`other/polygon/${name}`); }
  if (candidate.entry) for (const [name, bytes] of archive) if (!candidates.some(c => name.startsWith(c.entry))) local.set(`other/polygon/archive/${name}`, bytes);
  const read = (value: unknown, required = true): [string, Buffer | undefined] => {
    if (typeof value !== 'string' || !value) return badPackage('Missing Polygon file reference.');
    const name = value.replace(/\\/g, '/').replace(/^\.\//, ''); validateFileName(name);
    const bytes = files.get(name);
    if (!bytes && required) return badPackage(`Missing file referenced by problem.xml: ${name}`);
    return [name, bytes];
  };
  const doc: Record<string, any> = { problem: { name: options.name?.trim() || candidate.name, type: 'cf', title: options.title ?? candidate.titles ?? {},
    time_limit: options.timeLimit ?? candidate.timeLimit, memory_limit: options.memoryLimit ?? candidate.memoryLimit,
    input: attr(xml.judging, 'input-file') || 'stdin', output: attr(xml.judging, 'output-file') || 'stdout', data_only: true },
    tests: {}, testsets: {}, solutions: [], generators: [], polygon_source_types: {} };
  const roles = new Set<string>();
  const source = (value: unknown, role: string): { source: string } | undefined => {
    if (!value) return undefined;
    const node = obj(value, role), reference = node.source ?? node.copy;
    if (!reference) { warnings.push(`${role}: binary-only source preserved in Other files.`); return undefined; }
    const [name, bytes] = read(attr(obj(reference, `${role}/source`), 'path'), false);
    if (!bytes) { warnings.push(`${role}: source ${name} is missing; its descriptor was retained.`); return undefined; }
    roles.add(name);
    const relative = `other/polygon/${name}`, type = attr(reference, 'type');
    if (type) doc.polygon_source_types[relative] = type;
    return { source: relative };
  };
  doc.checker = source(xml.assets?.checker, 'checker');
  if (!doc.checker) {
    const standard = attr(xml.assets?.checker ?? {}, 'name')?.match(/^std::([\w-]+)(?:\.cpp)?$/)?.[1];
    if (standard) doc.checker = { source: `std:${standard}` };
  }
  const validators = list<Xml>(xml.assets?.validators?.validator);
  doc.validator = source(validators[0], 'validator');
  if (validators.length > 1) warnings.push('Several Polygon validators were retained; the first is the local problem validator.');
  doc.interactor = source(xml.assets?.interactor, 'interactor');
  if (doc.interactor) { doc.problem.judge_mode = 'io'; doc.problem.interactive = true; }
  for (const solution of list<Xml>(xml.assets?.solutions?.solution)) {
    const reference = source(solution, 'solution'); if (!reference) continue;
    const originalTag = attr(solution, 'tag') ?? 'accepted', tag = TAGS[originalTag] ?? 'NR';
    if (!TAGS[originalTag]) warnings.push(`Solution tag ${originalTag} is preserved in problem.xml; the local solution is marked NR.`);
    doc.solutions.push({ ...reference, tag });
  }
  if (doc.solutions.length && !doc.solutions.some((s: any) => s.tag === 'MA')) {
    (doc.solutions.find((s: any) => s.tag === 'OK') ?? doc.solutions[0]).tag = 'MA';
    warnings.push('No main solution was declared; selected the first accepted source as the local main solution.');
  }
  for (const executable of list<Xml>(xml.files?.executables?.executable)) {
    const name = attr(executable.source ?? {}, 'path');
    if (name && roles.has(name)) continue;
    const reference = source(executable, 'executable'); if (reference) doc.generators.push(reference);
  }
  for (const resource of list<Xml>(xml.files?.resources?.file)) read(attr(resource, 'path'));
  const selfTests = (suite: Xml | undefined, checker: boolean) => {
    if (!suite) return;
    const tests = list<Xml>(suite.tests?.test);
    if (numeric(suite['test-count'], 'program test-count') !== tests.length) return badPackage('Program test-count does not match its self-tests.');
    for (const [ordinal, test] of tests.entries()) {
      const verdict = attr(test, 'verdict') ?? '', index = ordinal + 1;
      if (!checker && !['valid', 'invalid'].includes(verdict)) { warnings.push(`Unknown validator-test verdict: ${verdict}`); continue; }
      const stem = checker ? `checker-tests/${index}` : `validator-tests/${index}.${verdict}`;
      const input = read(polygonPath(suite['input-path-pattern'], index)); local.set(`${stem}.in`, input[1]!);
      if (checker) {
        local.set(`${stem}.out`, read(polygonPath(suite['output-path-pattern'], index))[1]!);
        local.set(`${stem}.ans`, read(polygonPath(suite['answer-path-pattern'], index))[1]!);
        local.set(`${stem}.verdict`, Buffer.from(({ 'wrong-answer': 'wa', 'presentation-error': 'pe' } as Record<string, string>)[verdict] ?? verdict));
      }
    }
  };
  selfTests(xml.assets?.checker?.testset, true); selfTests(validators[0]?.testset, false);

  const samples: { index: number; manual: string }[] = [];
  let count = 0, incomplete = false, pointsEnabled = false;
  const names = new Set<string>();
  for (const ts of list<Xml>(xml.judging.testset)) {
    const name = attr(ts, 'name') ?? DEFAULT_TESTSET;
    if (!TESTSET_NAME_RE.test(name) || names.has(name)) return badPackage(`Invalid or duplicate Polygon testset: ${name}`);
    names.add(name);
    const tests = list<Xml>(ts.tests?.test), expected = numeric(ts['test-count'], `${name}/test-count`);
    if (expected !== tests.length || !Number.isSafeInteger(expected) || expected > 10000) return badPackage(`${name}: test-count does not match the judging tests.`);
    const time = numeric(ts['time-limit'], `${name}/time-limit`, true), memory = numeric(ts['memory-limit'], `${name}/memory-limit`, true) / 1024 / 1024;
    const manual = name === 'tests' ? 'tests/manual' : `tests/${name}`;
    const cases: Record<string, any> = {}, memberships = new Map<string, number[]>(), script: string[] = [];
    const groupCases = new Map<string, NonNullable<TestGroup['cases']>>();
    const identities = new Map<number, { input: Buffer | undefined; output: Buffer | undefined }>();
    const sampleIndices: number[] = [];
    let generated = false;
    for (const [position, node] of tests.entries()) {
      const ordinal = position + 1, test = obj(node, `${name}/test ${ordinal}`), original = provenance[`${name}:${ordinal}`];
      const sourceId = typeof original?.source === 'string' && original.source.startsWith(name + ':') ? Number(original.source.slice(name.length + 1)) : NaN;
      const index = Number.isSafeInteger(sourceId) && sourceId > 0 && sourceId <= 100000 ? sourceId : ordinal;
      const input = polygonPath(ts['input-path-pattern'], ordinal), output = polygonPath(ts['answer-path-pattern'], ordinal);
      const [, inputData] = read(input, false), [, outputData] = read(output, false);
      const previous = identities.get(index);
      if (previous && (!inputData || !outputData || !previous.input?.equals(inputData) || !previous.output?.equals(outputData))) return badPackage('Shared Polygon test metadata refers to different data.');
      identities.set(index, { input: inputData, output: outputData });
      const method = attr(test, 'method') ?? 'manual';
      if (!['manual', 'generated'].includes(method)) return badPackage(`${name}/${index}: unknown test method ${method}.`);
      if (inputData) local.set(`${manual}/${index}.in`, inputData);
      else {
        const command = attr(test, 'cmd');
        if (method !== 'generated' || !command) return badPackage(`Missing input ${input}; a standard package needs its generator command.`);
        const normalized = command.replace(/^(?:\.\/)?([^\s]+)/, (_all, exe: string) => path.posix.basename(exe).replace(/\.(?:exe|cpp)$/i, ''));
        try { parseScript(`${normalized} > ${index}`); } catch { return badPackage(`Cannot import generator command for ${input}. Build a Linux/Windows package containing its data.`); }
        script.push(`${normalized} > ${index}`); generated = true;
      }
      if (outputData) local.set(`${manual}/${index}.ans`, outputData); else generated = true;
      const rawPoints = attr(test, 'points');
      pointsEnabled ||= rawPoints !== undefined;
      cases[index] = { original_input: typeof original?.input === 'string' ? original.input : input, original_output: typeof original?.output === 'string' ? original.output : output,
        ...(outputData && inputData ? { provided_answer: true } : {}),
        ...(rawPoints !== undefined ? { points: numeric(rawPoints, `${name}/${index}/points`) } : {}),
        ...(time !== candidate.timeLimit ? { time_limit: time } : {}), ...(memory !== candidate.memoryLimit ? { memory_limit: memory } : {}) };
      const group = attr(test, 'group'); if (group) {
        const list = memberships.get(group) ?? []; if (list.includes(index)) return badPackage(`Polygon subtask ${group} repeats one shared test.`);
        list.push(index); memberships.set(group, list);
        if (rawPoints !== undefined) { const overrides = groupCases.get(group) ?? {}; overrides[index] = { points: numeric(rawPoints, `${group}/${index}/points`) }; groupCases.set(group, overrides); }
      }
      if (attr(test, 'sample') === 'true' && !sampleIndices.includes(index)) { sampleIndices.push(index); if (name === 'tests') samples.push({ index, manual }); }
      if (inputData && !roles.has(input)) local.delete(`other/polygon/${input}`);
      if (outputData && !roles.has(output)) local.delete(`other/polygon/${output}`);
    }
    const groups: TestGroup[] = list<Xml>(ts.groups?.group).map(g => {
      const name = attr(g, 'name') ?? badPackage('Polygon group has no name.');
      const indices = memberships.get(name) ?? [], policy = attr(g, 'points-policy') ?? 'complete-group';
      if (!['each-test', 'complete-group'].includes(policy)) return badPackage(`Unknown Polygon group points policy: ${policy}`);
      const total = attr(g, 'points');
      pointsEnabled ||= total !== undefined;
      return { name, tests: compressRanges(indices), policy: policy === 'each-test' ? 'EACH_TEST' : 'COMPLETE_GROUP',
        points: total !== undefined ? numeric(total, `group ${name}/points`) : indices.reduce((n, index) => n + (groupCases.get(name)?.[index]?.points ?? cases[index].points ?? 0), 0), cases: groupCases.get(name),
        dependencies: list<Xml>(g.dependencies?.dependency).map(dep => attr(dep, 'group') ?? badPackage(`Missing dependency of ${name}`)) };
    });
    for (const group of memberships.keys()) if (!groups.some(g => g.name === group)) return badPackage(`Unknown Polygon test group: ${group}`);
    const configuration = { manual, answers: generated ? 'generated' : 'provided', cases, groups: groups.length > 0, group: checkGroups(name, groups),
      ...(sampleIndices.length ? { samples: compressRanges(sampleIndices) } : {}), ...(script.length ? { script: `tests/script-${name}.txt` } : {}) };
    if (script.length) local.set(`tests/script-${name}.txt`, Buffer.from(script.join('\n') + '\n'));
    if (name === DEFAULT_TESTSET) doc.tests = configuration; else doc.testsets[name] = configuration;
    count += identities.size; incomplete ||= generated;
  }
  doc.tests.points = pointsEnabled;
  if (attr(xml.judging, 'treat-points-from-checker-as-percent') === 'true') {
    for (const ts of [doc.tests, ...Object.values(doc.testsets)] as any[]) ts.unresolved_scoring = true;
    warnings.push('Polygon checker-percent scoring is preserved in the original descriptor. Review the local scoring before judging or converting formats.');
  }
  if (incomplete) warnings.push('This standard Polygon package has unbuilt data. Sources and commands were imported; generate tests to build missing inputs/answers.');

  const statementRoots = new Map<string, string>();
  for (const file of files.keys()) {
    const match = /^statement-sections\/([^/]+)\/[^/]+\.tex$/i.exec(file);
    if (match && match[1] !== 'images') statementRoots.set(langOf(match[1]), `statement-sections/${match[1]}/`);
  }
  for (const section of [...list<Xml>(xml.statements?.statement), ...list<Xml>(xml.tutorials?.tutorial)]) {
    const language = langOf(attr(section, 'language') ?? 'english'), [name, bytes] = read(attr(section, 'path'), false);
    if (!bytes) { warnings.push(`Statement ${name} is missing from the archive.`); continue; }
    if (statementRoots.has(language)) continue;
    if (/\.tex$/i.test(name) && !/tutorial/i.test(name)) {
      const root = path.posix.dirname(name) + '/'; statementRoots.set(language, root);
      const properties = files.get(root + 'problem-properties.json');
      let source: Record<string, string> = {};
      if (properties && properties.length < 4 * 1024 * 1024) {
        try { const value = JSON.parse(properties.toString('utf8')); for (const key of STATEMENT_SECTIONS) if (typeof value[key] === 'string') source[key] = value[key]; }
        catch { warnings.push(`Invalid ${root}problem-properties.json; imported the TeX statement.`); }
      }
      if (!Object.values(source).some(Boolean)) source = texSections(bytes.toString('utf8'));
      for (const [key, value] of Object.entries(source)) local.set(`statement/${language}/${key}.tex`, Buffer.from(value));
    } else if (/\.(md|txt)$/i.test(name)) { local.set(`statement/${language}/statement.tex`, bytes); statementRoots.set(language, path.posix.dirname(name) + '/'); }
  }
  for (const [lang, root] of statementRoots) {
    if (root.startsWith('statement-sections/')) for (const section of STATEMENT_SECTIONS) {
      const bytes = files.get(`${root}${section}.tex`); if (bytes) local.set(`statement/${lang}/${section}.tex`, bytes);
    }
    const tutorial = files.get(`${root}tutorial.tex`); if (tutorial && !local.has(`statement/${lang}/tutorial.tex`)) local.set(`statement/${lang}/tutorial.tex`, tutorial);
    for (const [ordinal, sample] of samples.entries()) {
      const number = String(ordinal + 1).padStart(2, '0');
      for (const [suffix, localSuffix] of [['', 'in'], ['.a', 'out']]) {
        const bytes = files.get(`${root}example.${number}${suffix}`);
        if (bytes && !local.has(`${sample.manual}/${sample.index}.statement.${localSuffix}`)) local.set(`${sample.manual}/${sample.index}.statement.${localSuffix}`, bytes);
      }
    }
    for (const [name, bytes] of files) if (/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(name) && name.startsWith(root)) {
      const relative = name.slice(root.length), target = `${lang}/${relative}`;
      local.set(`statement/images/${target}`, bytes);
      for (const key of STATEMENT_SECTIONS) {
        const section = `statement/${lang}/${key}.tex`, text = local.get(section)?.toString('utf8');
        if (text) local.set(section, Buffer.from(text.split(`{${relative}}`).join(`{${target}}`).split(`](${relative})`).join(`](${target})`)));
      }
    }
  }
  for (const [name, bytes] of files) if (name.startsWith('statement-sections/images/')) local.set(`statement/images/${name.slice('statement-sections/images/'.length)}`, bytes);
  const hasStatement = [...local.keys()].some(name => /^statement\/[^/]+\/(?:legend|statement)\.tex$/.test(name) && local.get(name)!.toString().trim());
  doc.problem.data_only = !(hasStatement && doc.validator && doc.checker && doc.solutions.length);
  if (incomplete && doc.problem.data_only) warnings.push('Missing authoring programs or editable statement: complete these before building the package.');
  local.set('other/polygon/IMPORT.md', Buffer.from(`# Polygon package\n\n${warnings.map(warning => '- ' + warning).join('\n')}\n\nOriginal descriptor and unconsumed resources are preserved here. Imported materialized answers remain authoritative.\n`));
  return { candidate, doc, local, tests: count, extras: extras.filter(file => local.has(file)), warnings };
}

export async function importPolygonPackage(judge: Judge, archive: Map<string, Buffer>, options: PackageImportOptions): Promise<PackageImportResult> {
  const result = readPolygonPackage(archive, options);
  return { problem: await publishProblem(judge, result.local, result.doc, options.root), tests: result.tests, extras: result.extras, warnings: result.warnings };
}
