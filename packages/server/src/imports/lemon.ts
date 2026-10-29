import { promises as fs } from 'node:fs';
import path from 'node:path';
import { compressRanges, PROBLEM_NAME_RE, problemTomlSchema, validSourceName, type ContestPackageImportRequest, type ContestPackageImportResult, type ContestPackageValidation,
  type LemonContestCandidate, type LemonTaskCandidate, type ProblemSummary, type TestGroup } from '@taskweave/shared';
import type { Judge } from '../judge/index.js';
import type { ContestRegistry } from '../workspace/contests.js';
import { contestFile } from '../workspace/contestFiles.js';
import { libraryParent } from '../workspace/library.js';
import { pathKey } from '../global.js';
import { atomicWrite, exists, HttpError, validateFileName } from '../util/fs.js';
import { readCdf } from './cdf.js';
import { PackageReferences } from './references.js';
import { dataReader } from './data.js';
import { publishProblem } from './publish.js';

export const LEMON_CONTEST_ONLY = 'LemonLime packages are imported as whole contests. Use Import local package on the Contests page.';

function fail(message: string): never { throw new HttpError(400, 'lemon_import', message); }
const slug = (text: string) => text.toLowerCase().replace(/\.(cpp|cc|cxx|pas)$/i, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
const natural = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
const integer = (value: unknown, label: string, min = 0) => { if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > 2147483647) fail(`${label}: expected an integer from ${min} to 2147483647.`); return Number(value); };
const text = (value: unknown, label: string, fallback = ''): string => { if (value === undefined) return fallback; if (typeof value !== 'string') fail(`${label}: expected text.`); return value; };
const bool = (value: unknown, label: string): boolean => { if (value === undefined) return true; if (typeof value !== 'boolean') fail(`${label}: expected a boolean.`); return value; };
const paths = (value: unknown, label: string): string[] => { if (!Array.isArray(value) || value.some(item => typeof item !== 'string') || value.length > 20000) fail(`${label}: expected a filename list.`); return value; };
/** Contest letters: A–Z, then AA, AB, … */
export const contestLetter = (i: number): string => (i >= 26 ? contestLetter(Math.floor(i / 26) - 1) : '') + String.fromCharCode(65 + i % 26);

interface Task { key: string; index: number; task: Record<string, any>; unconfigured?: boolean }
/** One CDF; its directory is the package root of the contest. */
interface Contest { entry: string; prefix: string; title: string; tasks: Task[] }

function dataFiles(files: Map<string, Buffer>, prefix: string) {
  const expected = prefix + 'data/';
  const root = [...files.keys()].find(file => file.toLowerCase().startsWith(expected.toLowerCase()))?.slice(0, expected.length) ?? expected;
  return { root, files: new Map([...files].filter(([file]) => file.startsWith(root)).map(([file, bytes]) => [file.slice(root.length), bytes])) };
}

function readContest(files: Map<string, Buffer>, entry: string): Contest {
  const bytes = files.get(entry);
  if (!bytes || !/\.cdf$/i.test(entry)) fail('Select a LemonLime contest from the package.');
  const prefix = entry.slice(0, entry.lastIndexOf('/') + 1), cdf = readCdf(bytes);
  const title = typeof cdf.contestTitle === 'string' ? cdf.contestTitle.trim() : '';
  if (cdf.tasks.length) return { entry, prefix, title, tasks: cdf.tasks.map((task: Record<string, any>, index: number) => ({ key: String(index + 1), index, task })) };
  const data = dataFiles(files, prefix).files, groups = new Map<string, string[]>(), reader = dataReader(data, new Set());
  for (const input of [...data.keys()].sort(natural)) if (/\.in$/i.test(input) && reader.pairedOutput(input)) {
    const folder = path.posix.dirname(input); groups.set(folder, [...(groups.get(folder) ?? []), input]);
  }
  if (!groups.size) fail('CDF has no tasks or complete unconfigured data pairs.');
  return { entry, prefix, title, tasks: [...groups].map(([folder, inputs], index) => {
    const name = folder === '.' ? path.posix.basename(entry).replace(/\.cdf$/i, '') : path.posix.basename(folder);
    return { key: `data:${folder}`, index, unconfigured: true, task: { sourceFileName: name, problemTitle: name, taskType: 0, comparisonMode: 1, standardInputCheck: true, standardOutputCheck: true,
      testCases: inputs.map(input => ({ inputFiles: [input], outputFiles: [reader.pairedOutput(input)], fullScore: 0, timeLimit: 1000, memoryLimit: 256 })) } };
  }) };
}

/** Plan one task as a problem. `consumed` lists the archive files it copies, so the contest keeps only the rest. */
function plan(files: Map<string, Buffer>, contest: Contest, item: Task, options: { name?: string; title?: string; lang?: string } = {}) {
  const task = item.task;
  if (!task || typeof task !== 'object' || Array.isArray(task)) fail('Invalid CDF task.');
  const type = integer(task.taskType ?? 0, 'taskType');
  if (![0, 2, 3].includes(type)) fail(`Lemon taskType ${type} is not a local batch/grader problem. Its original CDF must be handled in LemonLime.`);
  const mode = integer(task.comparisonMode ?? 1, 'comparisonMode');
  if (mode > 5) fail(`Unknown Lemon comparison mode: ${mode}`);
  const warnings: string[] = [];
  if (item.unconfigured) warnings.push('CDF has no task configuration. Imported only the discovered complete pairs, without scores; configure subtasks explicitly.');
  const { files: data, root: dataRoot } = dataFiles(files, contest.prefix), refs = new PackageReferences(data, warnings, true);
  const dataDir = dataRoot.slice(contest.prefix.length), tests = new Set<string>(), referenced = new Set<string>();
  if (dataDir !== 'data/') warnings.push(`Package data directory corrected: data/ -> ${dataDir}`);
  const resolve = (file: string, answer = false) => {
    const normalized = file.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
    let value: string | undefined;
    if (/^data\//i.test(normalized) && !data.has(normalized) && (value = refs.find(normalized.slice(5), answer))) {
      warnings.push(`Package reference corrected: ${file} -> ${value}`);
    } else value = refs.require(file, answer);
    referenced.add(value); return value;
  };
  const original = text(task.sourceFileName, 'sourceFileName').trim().replace(/\.(cpp|cc|cxx|pas)$/i, ''), originalTitle = text(task.problemTitle, 'problemTitle').trim();
  const name = options.name || slug(original || originalTitle) || `lemon-${item.index + 1}`;
  const title = options.title || originalTitle || original || name;
  const ioFile = (standard: boolean, value: unknown, label: 'input' | 'output') => {
    if (standard) return label === 'input' ? 'stdin' : 'stdout';
    const file = text(value, label + 'FileName'); validateFileName(file);
    if (/[\\/]/.test(file)) fail(`${label}FileName must be a simple runtime filename.`);
    return file;
  };
  const local = new Map<string, Buffer>(), cases: Record<string, any> = {}, groups: TestGroup[] = [], indices = new Map<string, number>();
  if (!Array.isArray(task.testCases) || !task.testCases.length || task.testCases.length > 10000) fail('CDF task has no test entries or too many entries.');
  for (const [position, row] of task.testCases.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail(`Entry ${position + 1}: invalid testcase configuration.`);
    const score = integer(row.fullScore, `Entry ${position + 1} score`), time = integer(row.timeLimit, `Entry ${position + 1} time`, 1), memory = integer(row.memoryLimit, `Entry ${position + 1} memory`, 1);
    const declared = paths(row.inputFiles, 'inputFiles'), answers = paths(row.outputFiles, 'outputFiles');
    const dependencies: string[] = [], inputs: string[] = [];
    for (const value of declared) {
      const dependency = /^(\d+)_lemon_SUbtaskDEPENDENCE_fLAg$/.exec(value);
      if (!dependency) { inputs.push(value); continue; }
      const before = Number(dependency[1]);
      if (before < 1 || before > position) fail(`Entry ${position + 1}: invalid preceding dependency ${before}.`);
      if (!dependencies.includes(`subtask-${before}`)) dependencies.push(`subtask-${before}`);
    }
    if (!inputs.length || inputs.length !== answers.length) fail(`Entry ${position + 1}: input/output occurrence counts do not match.`);
    const members: number[] = [], occurrences = new Map<string, number>();
    for (const [i, input] of inputs.entries()) {
      const inFile = resolve(input), outFile = resolve(answers[i], true);
      if (inFile === outFile) fail(`Entry ${position + 1}: input and answer use the same file.`);
      tests.add(inFile); tests.add(outFile);
      const pair = JSON.stringify([inFile, outFile]), occurrence = occurrences.get(pair) ?? 0; occurrences.set(pair, occurrence + 1);
      const key = `${pair}:${occurrence}`;
      let index = indices.get(key);
      if (index === undefined) {
        index = indices.size + 1; if (index > 10000) fail('Too many Lemon test occurrences.'); indices.set(key, index);
        local.set(`tests/manual/${index}.in`, data.get(inFile)!); local.set(`tests/manual/${index}.ans`, data.get(outFile)!);
        cases[index] = { original_input: inFile, original_output: outFile };
      }
      members.push(index);
    }
    groups.push({ name: `subtask-${position + 1}`, tests: compressRanges(members), points: score, policy: 'COMPLETE_GROUP', time_limit: time, memory_limit: memory, ...(dependencies.length ? { dependencies } : {}) });
  }
  const own = (file: string) => `other/lemonlime/${dataDir}${file}`;
  const doc: Record<string, any> = {
    problem: { name, type: 'oi', title: { [options.lang || 'en']: title }, data_only: true, time_limit: task.testCases[0].timeLimit, memory_limit: task.testCases[0].memoryLimit,
      input: ioFile(bool(task.standardInputCheck, 'standardInputCheck'), task.inputFileName, 'input'), output: ioFile(bool(task.standardOutputCheck, 'standardOutputCheck'), task.outputFileName, 'output'), judge_mode: type === 0 ? 'batch' : 'grader' },
    tests: { manual: 'tests/manual', answers: 'provided', points: !item.unconfigured, groups: !item.unconfigured, group: item.unconfigured ? [] : groups, cases },
    lemon_import: { descriptor: contest.entry, task_index: item.index },
  };
  if (original && original !== name) {
    if (validSourceName(original)) doc.problem.source_name = original;
    else warnings.push(`The original source file name ${original} is not a portable file name; the short name is used instead.`);
  }
  if ([0, 1, 3].includes(mode)) {
    const precision = integer(task.realPrecision ?? 3, 'realPrecision'); if (precision > 18) fail('Lemon realPrecision must be 0–18.');
    doc.lemon_comparison = { mode: mode === 0 ? 'lines' : mode === 1 ? 'ignore-spaces' : 'real', precision };
  } else if ([4, 5].includes(mode)) {
    const executable = text(task.specialJudge, 'specialJudge'); if (!executable) fail('CDF special judge path is missing.');
    validateFileName(executable.replace(/\\/g, '/'));
    const normalized = executable.replace(/\\/g, '/').replace(/^(?:\.\/)+/, ''), base = normalized.replace(/\.exe$/i, ''), parent = path.posix.dirname(normalized);
    const isSource = /\.(cpp|cc|cxx)$/i.test(normalized);
    const direct = [...new Set((isSource ? [normalized] : [base + '.cpp', base + '.cc', base + '.cxx']).flatMap(file => refs.find(file) ?? []))];
    const sourceRoot = ((parent === '.' ? '' : parent + '/') + 'checker-sources/').toLowerCase();
    const sources = direct.length ? direct : [...data.keys()].filter(file => file.toLowerCase().startsWith(sourceRoot) && /\.(cpp|cc|cxx)$/i.test(file));
    const binary = isSource ? undefined : refs.find(normalized) ?? refs.find(/\.exe$/i.test(normalized) ? base : normalized + '.exe');
    if (binary) referenced.add(binary);
    if (sources.length === 1) {
      referenced.add(sources[0]);
      doc.lemon_checker = { source: own(sources[0]), ...(mode === 5 ? { protocol: 'testlib' } : {}) };
      if (mode === 5) doc.checker = { source: own(sources[0]) };
      if (!binary) warnings.push(`Lemon checker executable ${executable} is absent; the supplied source ${sources[0]} will be rebuilt for export.`);
    }
    else if (binary) { doc.problem.unresolved_judge = 'The imported Lemon special judge has no unique source. Select a local checker or native comparison before judging/exporting.'; warnings.push(doc.problem.unresolved_judge); }
    else fail(`Missing Lemon checker executable or uniquely identified source: ${executable}`);
    if (groups.some(group => group.dependencies?.length)) { doc.tests.unresolved_scoring = true; warnings.push('Lemon custom-checker partial dependency scoring needs review. Edit subtasks before local judging/exporting.'); }
  } else {
    doc.problem.unresolved_judge = 'The imported Lemon external diff command is not a portable local checker. Select a checker or native comparison.';
    warnings.push(doc.problem.unresolved_judge);
  }
  if (type !== 0) {
    const sourceNames = paths(task.sourceFilesName ?? [], 'sourceFilesName'), sourcePaths = paths(task.sourceFilesPath ?? [], 'sourceFilesPath');
    if (sourceNames.length !== sourcePaths.length) fail('Lemon contestant path/name counts differ.');
    if (sourceNames.length > 1) fail('This Lemon grader requires multiple contestant files. Local grader problems accept one submission source; keep the original package for this runtime.');
    const graderPaths = type === 2 ? [task.grader, task.interactor] : paths(task.graderFilesPath, 'graderFilesPath');
    const graderNames = type === 2 ? ['__grader.cpp', task.interactorName] : paths(task.graderFilesName, 'graderFilesName');
    if (graderPaths.length !== graderNames.length) fail('Lemon grader path/name counts differ.');
    const names = new Set(sourceNames.map(name => name.toLowerCase())), sources: string[] = [], headers: string[] = [];
    for (const file of [...sourceNames, ...sourcePaths]) validateFileName(file.replace(/\\/g, '/'));
    for (const [i, source] of graderPaths.entries()) {
      const file = resolve(text(source, 'grader path')), name = text(graderNames[i], 'grader build name'); validateFileName(name);
      if (/[\\/]/.test(name) || names.has(name.toLowerCase())) fail('Conflicting Lemon grader build filenames.'); names.add(name.toLowerCase());
      const target = `grader/${name}`; local.set(target, data.get(file)!); (/\.(cpp|cc|cxx)$/i.test(name) ? sources : headers).push(target);
    }
    if (!sources.length) fail('No supported grader translation unit found.'); doc.grader = { sources, headers };
  }
  // The task's own data folders, except its tests (already in tests/manual): checkers, graders, notes and unreferenced data.
  const top = (file: string) => file.includes('/') ? file.slice(0, file.indexOf('/') + 1) : file;
  const folders = new Set([...referenced].map(top)), owned = [...data.keys()].filter(file => folders.has(top(file)));
  for (const file of owned) if (!tests.has(file)) local.set(own(file), data.get(file)!);
  const extras = owned.filter(file => /\.(in|out|ans)$/i.test(file) && !tests.has(file));
  if (extras.length) warnings.push(`Unconfigured data files were preserved in Other files: ${extras.slice(0, 12).join(', ')}${extras.length > 12 ? ', …' : ''}`);
  local.set('other/lemonlime/task.json', Buffer.from(JSON.stringify(task, null, 2) + '\n'));
  local.set('other/lemonlime-import.md', Buffer.from(`# LemonLime import\n\nContest: ${contest.entry}\nTask: ${item.index + 1}\n\n${warnings.map(warning => '- ' + warning).join('\n')}\n`));
  problemTomlSchema.parse(doc);
  return { doc, local, title, name, sourceName: original, tests: indices.size, warnings, consumed: new Set(owned.map(file => dataRoot + file)) };
}

const GENERIC_NAMES = new Set(['contest', 'lemon', 'lemonlime']);
function contestName(entry: string, title: string) {
  const file = slug(path.posix.basename(entry).replace(/\.cdf$/i, '')), folder = slug(path.posix.basename(path.posix.dirname(entry)));
  return [...(GENERIC_NAMES.has(file) ? [slug(title), file] : [file, slug(title)]), folder].find(name => PROBLEM_NAME_RE.test(name)) ?? 'lemonlime';
}

/** Every CDF in the upload is one contest candidate with its tasks validated. */
export function lemonContests(files: Map<string, Buffer>): LemonContestCandidate[] {
  const entries = [...files.keys()].filter(file => /\.cdf$/i.test(file)).sort(natural);
  if (!entries.length) fail('No LemonLime CDF descriptor found. Choose the contest folder or its ZIP.');
  return entries.map(entry => {
    const fallback = path.posix.basename(entry).replace(/\.cdf$/i, '');
    let contest: Contest;
    try { contest = readContest(files, entry); } catch (e) { return { entry, title: fallback, name: contestName(entry, ''), tasks: [], error: (e as Error).message }; }
    const tasks = contest.tasks.map((task): LemonTaskCandidate => {
      try {
        const value = plan(files, contest, task);
        return { key: task.key, title: value.title, name: value.name, sourceName: value.sourceName, tests: value.tests, timeLimit: value.doc.problem.time_limit, memoryLimit: value.doc.problem.memory_limit, warnings: value.warnings };
      } catch (e) {
        const source = typeof task.task?.sourceFileName === 'string' ? task.task.sourceFileName : '';
        return { key: task.key, title: typeof task.task?.problemTitle === 'string' && task.task.problemTitle || source || `#${task.index + 1}`, name: slug(source) || `lemon-${task.index + 1}`, sourceName: source, error: (e as Error).message };
      }
    });
    return { entry, title: contest.title || fallback, name: contestName(entry, contest.title), tasks };
  });
}

/** Names, folders and the selection; the archive itself was validated when it was staged. */
export async function validateLemonContest(judge: Judge, contests: ContestRegistry, req: ContestPackageImportRequest): Promise<ContestPackageValidation> {
  const errors: string[] = [], tasks: Record<string, string> = {};
  if (!req || typeof req !== 'object' || !Array.isArray(req.tasks) || req.tasks.some(task => !task || typeof task.key !== 'string') || new Set(req.tasks.map(task => task.key)).size !== req.tasks.length) {
    return { errors: ['Select problems to import.'], tasks };
  }
  try { await contests.checkNew(typeof req.name === 'string' ? req.name.trim() : '', req.folder); } catch (e) { errors.push((e as Error).message); }
  if (req.title !== undefined && (!req.title || typeof req.title !== 'object' || Array.isArray(req.title) || Object.values(req.title).some(value => typeof value !== 'string'))) errors.push('Invalid contest title.');
  if (req.type !== undefined && req.type !== 'cf' && req.type !== 'oi') errors.push('Contest type must be cf or oi');
  const included = req.tasks.filter(task => task.include);
  if (!included.length) errors.push('Select at least one problem to import.');
  let parent: string | undefined;
  try { parent = await libraryParent(judge.registry.requireRoot(req.root), req.problemFolder); } catch (e) { errors.push((e as Error).message); }
  // All problems go to one folder; short names only conflict within it.
  const taken = parent ? (await judge.registry.namesByFolder()).get(pathKey(parent)) : undefined, counts = new Map<string, number>();
  for (const task of included) counts.set(String(task.name ?? '').trim(), (counts.get(String(task.name ?? '').trim()) ?? 0) + 1);
  await Promise.all(included.map(async task => {
    const name = String(task.name ?? '').trim();
    if (!PROBLEM_NAME_RE.test(name)) tasks[task.key] = 'Name must be lowercase letters, digits and dashes (up to 64 characters).';
    else if (counts.get(name)! > 1) tasks[task.key] = `Duplicate problem name in the same folder: ${name}`;
    else if (taken?.has(name)) tasks[task.key] = `Problem name already exists in this folder: ${name}`;
    else if (parent && await exists(path.join(parent, name))) tasks[task.key] = `Folder already exists: ${path.join(parent, name)}`;
  }));
  return { errors, tasks };
}

/**
 * All or nothing: every task is planned before anything is written, and a later failure removes
 * the problems and the contest created so far. The contest keeps every original file that no
 * imported problem copied (CDF, contestant sources, excluded tasks, notes).
 */
export async function importLemonContest(judge: Judge, contests: ContestRegistry, files: Map<string, Buffer>, req: ContestPackageImportRequest): Promise<ContestPackageImportResult> {
  const check = await validateLemonContest(judge, contests, req);
  const problems = Object.entries(check.tasks).map(([key, error]) => `${key}: ${error}`);
  if (check.errors.length || problems.length) throw new HttpError(409, 'invalid_import', [...check.errors, ...problems].join('\n'));
  const contest = readContest(files, req.entry), byKey = new Map(contest.tasks.map(task => [task.key, task]));
  const lang = /^[a-z]{2,8}$/.test(req.lang ?? '') ? req.lang! : 'en';
  const plans = req.tasks.filter(task => task.include).map(selected => {
    const task = byKey.get(selected.key) ?? fail(`Unknown LemonLime task: ${selected.key}`);
    const name = String(selected.name).trim();
    try { return plan(files, contest, task, { name, title: typeof selected.title === 'string' ? selected.title.trim() : '', lang }); }
    catch (e) { throw new HttpError(400, 'lemon_import', `${name}: ${(e as Error).message}`); }
  });
  const consumed = new Set(plans.flatMap(value => [...value.consumed]));
  const roots = [...files.keys()].filter(file => /\.cdf$/i.test(file)).map(file => file.slice(0, file.lastIndexOf('/') + 1));
  const originals = new Map<string, Buffer>();
  for (const [file, bytes] of files) {
    if (consumed.has(file)) continue;
    const owner = roots.filter(root => file.startsWith(root)).sort((a, b) => b.length - a.length)[0];
    if (owner === undefined) originals.set(`lemonlime/archive/${file}`, bytes);
    else if (owner === contest.prefix) originals.set(`lemonlime/${file.slice(owner.length)}`, bytes);
  }
  const created: ProblemSummary[] = [];
  let contestDir: string | undefined;
  try {
    for (const value of plans) created.push(await publishProblem(judge, value.local, value.doc, req.root, req.problemFolder));
    const summary = await contests.create({ name: String(req.name).trim(), title: req.title ?? {}, type: req.type ?? 'oi', folder: req.folder,
      problems: created.map((problem, i) => ({ index: contestLetter(i), problem: problem.id })) });
    contestDir = summary.dir;
    for (const [rel, bytes] of originals) await atomicWrite(await contestFile(summary.dir, rel), bytes);
    const warnings = plans.flatMap((value, i) => value.warnings.map(warning => `${contestLetter(i)}: ${warning}`));
    await atomicWrite(await contestFile(summary.dir, 'lemonlime-import.md'), `# LemonLime import\n\nContest: ${contest.entry}\n\n${created.map((problem, i) => `- ${contestLetter(i)}: ${problem.name}`).join('\n')}\n\n`
      + `Original files that no problem uses (contestant sources, excluded tasks, notes) are kept in lemonlime/.\n\n${warnings.map(warning => '- ' + warning).join('\n')}\n`);
    return { contest: summary, problems: created, warnings };
  } catch (e) {
    if (contestDir) { await fs.rm(contestDir, { recursive: true, force: true }); await contests.scan(); }
    for (const problem of created) await fs.rm(problem.dir, { recursive: true, force: true });
    if (created.length) await judge.registry.scan();
    throw e;
  }
}
