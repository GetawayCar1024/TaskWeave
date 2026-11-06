import { promises as fs } from 'node:fs';
import path from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { CONTEST_INDEX_RE, LANG_FROM_POLYGON, problemTomlSchema, validSourceName,
  type ContestPackageImportRequest, type ContestPackageImportResult, type LemonContestCandidate, type LemonTaskCandidate, type ProblemSummary } from '@taskweave/shared';
import type { Judge } from '../judge/index.js';
import type { ContestRegistry } from '../workspace/contests.js';
import { contestFile } from '../workspace/contestFiles.js';
import { atomicWrite, HttpError, validateFileName } from '../util/fs.js';
import { readZip } from '../util/zip.js';
import { contestLetter, validateLemonContest } from './lemon.js';
import { polygonCandidates, readPolygonPackage } from './polygon.js';

const fail = (message: string): never => { throw new HttpError(400, 'polygon_contest', message); };
const list = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'polygon-contest';
const subtree = (files: Map<string, Buffer>, prefix: string) => new Map([...files].filter(([name]) => name.startsWith(prefix)).map(([name, bytes]) => [name.slice(prefix.length), bytes]));
interface ProblemEntry { key: string; index: string; prefix: string; zip?: string; files?: Map<string, Buffer>; error?: string }

function descriptor(files: Map<string, Buffer>, entry: string) {
  const bytes = files.get(entry);
  if (!bytes || bytes.length > 4 * 1024 * 1024) return fail('Missing or oversized Polygon contest.xml.');
  const text = bytes.toString('utf8');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) fail('XML DTDs and entity declarations are not supported.');
  const checked = XMLValidator.validate(text);
  if (checked !== true) fail(`Invalid Polygon contest.xml: ${checked.err.msg}`);
  const xml = new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false }).parse(text).contest;
  if (!xml || typeof xml !== 'object') fail('Expected a Polygon contest descriptor.');
  return xml;
}

function readContest(files: Map<string, Buffer>, entry: string) {
  const explicit = /(?:^|\/)contest\.xml$/i.test(entry);
  const prefix = explicit ? entry.slice(0, entry.lastIndexOf('/') + 1) : entry;
  const xml = explicit ? descriptor(files, entry) : null;
  const titles: Record<string, string> = {};
  for (const name of list<Record<string, string>>(xml?.names?.name)) {
    const sourceLanguage = name['@_language'] || '';
    const language = LANG_FROM_POLYGON[sourceLanguage.toLowerCase()] || sourceLanguage;
    if (language && /^[a-z]{2,8}$/.test(language) && typeof name['@_value'] === 'string') titles[language] = name['@_value'];
  }
  const title = titles.zh || titles.en || Object.values(titles)[0] || xml?.['@_name'] || path.posix.basename(prefix.replace(/\/$/, '')) || 'Polygon contest';
  const problemNodes = explicit ? list<Record<string, string>>(xml?.problems?.problem) : polygonCandidates(subtree(files, prefix)).map((candidate, i) => ({ '@_index': contestLetter(i), '@_path': candidate.entry.replace(/\/$/, '') || '.' }));
  if (!problemNodes.length || problemNodes.length > 1000) fail('A Polygon contest must contain 1–1000 problems.');
  const indices = new Set<string>();
  let expanded = [...files.values()].reduce((total, bytes) => total + bytes.length, 0), entries = files.size;
  const problems: ProblemEntry[] = problemNodes.map((node, i) => {
    const index = String(node['@_index'] || contestLetter(i)).toUpperCase();
    if (!CONTEST_INDEX_RE.test(index) || indices.has(index)) fail(`Invalid or duplicate Polygon contest index: ${index}`);
    indices.add(index);
    const value: ProblemEntry = { key: String(i + 1), index, prefix: '' };
    try {
      let relative = node['@_path'];
      if (typeof relative !== 'string' || !relative) fail(`Problem ${index} has no package path.`);
      relative = relative.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/$/, '');
      if (!explicit && relative === '.') relative = '';
      else validateFileName(relative);
      const location = prefix + relative;
      const zipped = files.has(location) && /\.zip$/i.test(location) ? location : files.has(location + '.zip') ? location + '.zip' : undefined;
      if (zipped) {
        value.zip = zipped;
        value.files = readZip(files.get(zipped)!, Math.max(1, 512 * 1024 * 1024 - expanded));
        expanded += [...value.files.values()].reduce((total, bytes) => total + bytes.length, 0); entries += value.files.size;
        if (expanded > 512 * 1024 * 1024 || entries > 20000) fail('Expanded Polygon contest exceeds the package limit.');
      } else {
        value.prefix = location ? location.replace(/\/$/, '') + '/' : '';
        value.files = subtree(files, value.prefix);
      }
      const candidates = polygonCandidates(value.files);
      if (candidates.length !== 1) fail(`Problem ${index} must reference one Polygon problem package.`);
      if (candidates[0].error) fail(candidates[0].error);
    } catch (error) { value.error = (error as Error).message; }
    return value;
  });
  return { entry, prefix, title: String(title), titles, name: slug(path.posix.basename(prefix.replace(/\/$/, '')) || String(title)), problems };
}

function plan(entry: ProblemEntry, options: { name?: string; title?: string; lang?: string; type?: 'cf' | 'oi' } = {}) {
  const files = entry.files;
  if (entry.error || !files) return fail(entry.error || 'Missing Polygon problem.');
  const result = readPolygonPackage(files, { format: 'polygon-package', name: options.name });
  const sourceName = validSourceName(result.sourceName) ? result.sourceName : result.candidate.name;
  if (sourceName !== result.sourceName) result.warnings.push(`The original source file name ${result.sourceName} is not a portable file name; the short name is used instead.`);
  if (sourceName !== result.doc.problem.name) result.doc.problem.source_name = sourceName;
  if (typeof options.title === 'string' && options.title.trim()) result.doc.problem.title = { ...result.doc.problem.title, [options.lang || 'en']: options.title.trim() };
  result.doc.problem.type = options.type ?? 'cf';
  const parsed = problemTomlSchema.safeParse(result.doc);
  if (!parsed.success) fail(`Invalid Polygon problem configuration: ${parsed.error.message}`);
  return { ...result, sourceName };
}

/** Real contest.xml packages, or a collection of standalone Polygon problem directories. */
export function polygonContests(files: Map<string, Buffer>): LemonContestCandidate[] {
  let entries = [...files.keys()].filter(name => /(?:^|\/)contest\.xml$/i.test(name));
  if (!entries.length) {
    const candidates = polygonCandidates(files);
    let prefix = candidates[0].entry;
    while (prefix && !candidates.every(candidate => candidate.entry.startsWith(prefix))) prefix = prefix.replace(/[^/]+\/$/, '');
    entries = [prefix];
  }
  return entries.map(entry => {
    try {
      const contest = readContest(files, entry);
      const tasks: LemonTaskCandidate[] = contest.problems.map(problem => {
        try {
          const value = plan(problem);
          return { key: problem.key, index: problem.index, title: value.candidate.title, titles: value.candidate.titles, name: value.candidate.name, sourceName: value.sourceName,
            tests: value.tests, timeLimit: value.doc.problem.time_limit, memoryLimit: value.doc.problem.memory_limit, warnings: value.warnings };
        } catch (error) { return { key: problem.key, index: problem.index, title: problem.index, name: `problem-${problem.index.toLowerCase()}`, sourceName: '', error: (error as Error).message }; }
      });
      return { format: 'polygon-package', entry, name: contest.name, title: contest.title, titles: contest.titles, tasks };
    } catch (error) { return { format: 'polygon-package', entry, name: 'polygon-contest', title: 'Polygon contest', tasks: [], error: (error as Error).message }; }
  });
}

export async function importPolygonContest(judge: Judge, contests: ContestRegistry, files: Map<string, Buffer>, req: ContestPackageImportRequest): Promise<ContestPackageImportResult> {
  const checked = await validateLemonContest(judge, contests, req);
  if (checked.errors.length || Object.keys(checked.tasks).length) fail([...checked.errors, ...Object.values(checked.tasks)].join('\n'));
  const contest = readContest(files, req.entry), byKey = new Map(contest.problems.map(problem => [problem.key, problem]));
  const selected = req.tasks.filter(task => task.include);
  const lang = /^[a-z]{2,8}$/.test(req.lang ?? '') ? req.lang : 'en';
  const plans = selected.map(task => {
    const entry = byKey.get(task.key) ?? fail(`Unknown Polygon contest problem: ${task.key}`);
    return { entry, result: plan(entry, { name: String(task.name ?? '').trim(), title: task.title, lang, type: req.type }) };
  });
  const consumed = new Set(plans.flatMap(({ entry }) => entry.zip ? [] : [...files.keys()].filter(file => file.startsWith(entry.prefix))));
  const roots = [...new Set([contest.prefix, ...[...files.keys()].filter(file => /(?:^|\/)contest\.xml$/i.test(file)).map(file => file.slice(0, file.lastIndexOf('/') + 1))])];
  const originals = new Map<string, Buffer>();
  for (const [file, bytes] of files) if (!consumed.has(file)) {
    const owner = roots.filter(root => file.startsWith(root)).sort((a, b) => b.length - a.length)[0];
    if (owner === undefined) originals.set('polygon/archive/' + file, bytes);
    else if (owner === contest.prefix) originals.set('polygon/' + file.slice(owner.length), bytes);
  }
  const created: ProblemSummary[] = [];
  let directory: string | undefined;
  try {
    // Planning, schema checking and duplicate-name validation finish before the first write.
    const { publishProblem } = await import('./publish.js');
    for (const { result } of plans) created.push(await publishProblem(judge, result.local, result.doc, req.root, req.problemFolder));
    const summary = await contests.create({ name: req.name.trim(), title: req.title ?? contest.titles, type: req.type ?? 'cf', folder: req.folder,
      problems: created.map((problem, i) => ({ index: plans[i].entry.index, problem: problem.id })) });
    directory = summary.dir;
    for (const [file, bytes] of originals) await atomicWrite(await contestFile(summary.dir, file), bytes);
    const warnings = plans.flatMap(({ entry, result }) => result.warnings.map(warning => `${entry.index}: ${warning}`));
    await atomicWrite(await contestFile(summary.dir, 'polygon-import.md'), `# Polygon contest import\n\n${contest.entry || 'Problem directories'}\n\n${created.map((problem, i) => `- ${plans[i].entry.index}: ${problem.name}`).join('\n')}\n\n${warnings.map(warning => '- ' + warning).join('\n')}\n`);
    return { contest: summary, problems: created, warnings };
  } catch (error) {
    if (directory) { await fs.rm(directory, { recursive: true, force: true }); await contests.scan(); }
    for (const problem of created) await fs.rm(problem.dir, { recursive: true, force: true });
    if (created.length) await judge.registry.scan();
    throw error;
  }
}
