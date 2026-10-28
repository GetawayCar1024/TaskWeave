import path from 'node:path';
import { compressRanges, problemTomlSchema, type PackageCandidate, type PackageImportOptions, type PackageImportResult, type TestGroup } from '@polyforge/shared';
import type { Judge } from '../judge/index.js';
import { HttpError, validateFileName } from '../util/fs.js';
import { readCdf } from './cdf.js';
import { PackageReferences } from './references.js';
import { dataReader } from './data.js';
import { publishProblem } from './publish.js';

function fail(message: string): never { throw new HttpError(400, 'lemon_import', message); }
const slug = (text: string) => text.toLowerCase().replace(/\.(cpp|cc|cxx|pas)$/i, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
const integer = (value: unknown, label: string, min = 0) => { if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > 2147483647) fail(`${label}: expected an integer from ${min} to 2147483647.`); return Number(value); };
const text = (value: unknown, label: string, fallback = ''): string => { if (value === undefined) return fallback; if (typeof value !== 'string') fail(`${label}: expected text.`); return value; };
const bool = (value: unknown, label: string): boolean => { if (value === undefined) return true; if (typeof value !== 'boolean') fail(`${label}: expected a boolean.`); return value; };
const paths = (value: unknown, label: string): string[] => { if (!Array.isArray(value) || value.some(item => typeof item !== 'string') || value.length > 20000) fail(`${label}: expected a filename list.`); return value; };
interface Item { entry: string; file: string; prefix: string; task: Record<string, any>; index: number; unconfigured?: boolean; error?: string }
function dataFiles(files: Map<string, Buffer>, prefix: string) {
  const expected = prefix + 'data/';
  const root = [...files.keys()].find(file => file.toLowerCase().startsWith(expected.toLowerCase()))?.slice(0, expected.length) ?? expected;
  return { root, files: new Map([...files].filter(([file]) => file.startsWith(root)).map(([file, bytes]) => [file.slice(root.length), bytes])) };
}

function items(files: Map<string, Buffer>): Item[] {
  const result: Item[] = [];
  for (const [file, original] of files) {
    if (!/\.cdf$/i.test(file)) continue;
    const prefix = file.slice(0, file.lastIndexOf('/') + 1);
    try {
      const cdf = readCdf(original);
      if (cdf.tasks.length) cdf.tasks.forEach((task: Record<string, any>, index: number) => result.push({ entry: `${file}#${index + 1}`, file, prefix, task, index }));
      else {
        const data = dataFiles(files, prefix).files, groups = new Map<string, string[]>(), reader = dataReader(data, new Set());
        for (const input of data.keys()) if (/\.in$/i.test(input) && reader.pairedOutput(input)) {
          const folder = path.posix.dirname(input); groups.set(folder, [...(groups.get(folder) ?? []), input]);
        }
        if (!groups.size) fail('CDF has no tasks or complete unconfigured data pairs.');
        for (const [index, [folder, inputs]] of [...groups].entries()) result.push({ entry: `${file}#unconfigured-${index + 1}`, file, prefix, index, unconfigured: true,
          task: { sourceFileName: path.posix.basename(folder), problemTitle: path.posix.basename(folder), taskType: 0, comparisonMode: 1, standardInputCheck: true, standardOutputCheck: true,
            testCases: inputs.map(input => ({ inputFiles: [input], outputFiles: [reader.pairedOutput(input)], fullScore: 0, timeLimit: 1000, memoryLimit: 256 })) } });
      }
    } catch (e) { result.push({ entry: file, file, prefix, task: {}, index: 0, error: (e as Error).message }); }
  }
  if (!result.length) fail('No LemonLime CDF descriptor found. Choose the contest folder or its ZIP.');
  return result;
}

function plan(archive: Map<string, Buffer>, item: Item, options: PackageImportOptions) {
  if (item.error) fail(item.error);
  const task = item.task;
  if (!task || typeof task !== 'object' || Array.isArray(task)) fail('Invalid CDF task.');
  const type = integer(task.taskType ?? 0, 'taskType');
  if (![0, 2, 3].includes(type)) fail(`Lemon taskType ${type} is not a local batch/grader problem. Its original CDF must be handled in LemonLime.`);
  const mode = integer(task.comparisonMode ?? 1, 'comparisonMode');
  if (mode > 5) fail(`Unknown Lemon comparison mode: ${mode}`);
  const warnings: string[] = [];
  if (item.unconfigured) warnings.push('CDF has no task configuration. Imported only the discovered complete pairs, without scores; configure subtasks explicitly.');
  const { files: data, root: dataRoot } = dataFiles(archive, item.prefix), refs = new PackageReferences(data, warnings), used = new Set<string>();
  if (dataRoot !== item.prefix + 'data/') warnings.push(`Package data directory corrected: data/ -> ${dataRoot.slice(item.prefix.length)}`);
  const resolve = (file: string, answer = false) => {
    const normalized = file.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
    let value: string | undefined;
    if (/^data\//i.test(normalized) && !data.has(normalized) && (value = refs.find(normalized.slice(5), answer))) {
      warnings.push(`Package reference corrected: ${file} -> ${value}`);
    } else value = refs.require(file, answer);
    used.add(value); return value;
  };
  const sourceName = text(task.sourceFileName, 'sourceFileName'), originalTitle = text(task.problemTitle, 'problemTitle');
  const name = options.name || slug(sourceName || originalTitle) || `lemon-${item.index + 1}`;
  const title = originalTitle || sourceName || name;
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
  const ownPrefix = `other/lemonlime/`;
  for (const [file, bytes] of archive) if (file.startsWith(item.prefix)) local.set(ownPrefix + file.slice(item.prefix.length), bytes);
  const doc: Record<string, any> = {
    problem: { name, title: options.title ?? { [options.lang || 'en']: title }, data_only: true, time_limit: options.timeLimit ?? task.testCases[0].timeLimit, memory_limit: options.memoryLimit ?? task.testCases[0].memoryLimit,
      input: ioFile(bool(task.standardInputCheck, 'standardInputCheck'), task.inputFileName, 'input'), output: ioFile(bool(task.standardOutputCheck, 'standardOutputCheck'), task.outputFileName, 'output'), judge_mode: type === 0 ? 'batch' : 'grader' },
    tests: { manual: 'tests/manual', answers: 'provided', points: !item.unconfigured, groups: !item.unconfigured, group: item.unconfigured ? [] : groups, cases },
    lemon_import: { descriptor: item.file, task_index: item.index },
  };
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
    if (sources.length === 1) {
      const source = ownPrefix + dataRoot.slice(item.prefix.length) + sources[0];
      doc.lemon_checker = { source, ...(mode === 5 ? { protocol: 'testlib' } : {}) };
      if (mode === 5) doc.checker = { source };
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
    warnings.push('Lemon contestant submissions were preserved as extra files, not registered as a reference solution.');
  }
  const extras = [...data.keys()].filter(file => /\.(in|out|ans)$/i.test(file) && !used.has(file));
  if (extras.length) warnings.push(`Unconfigured data files were preserved in Other files: ${extras.slice(0, 12).join(', ')}${extras.length > 12 ? ', …' : ''}`);
  local.set('other/lemonlime-import.md', Buffer.from(`# LemonLime import\n\n${warnings.map(warning => '- ' + warning).join('\n')}\n`));
  problemTomlSchema.parse(doc);
  return { doc, local, title, name, tests: indices.size, warnings };
}

export function lemonCandidates(files: Map<string, Buffer>, options: PackageImportOptions): PackageCandidate[] {
  return items(files).map(item => {
    try { const value = plan(files, item, options); return { entry: item.entry, title: value.title, name: value.name, tests: value.tests, files: value.local.size, size: [...value.local.values()].reduce((sum, value) => sum + value.length, 0), timeLimit: value.doc.problem.time_limit, memoryLimit: value.doc.problem.memory_limit, warnings: value.warnings }; }
    catch (e) { return { entry: item.entry, title: String(item.task?.problemTitle || item.file), name: slug(String(item.task?.sourceFileName || '')) || `lemon-${item.index + 1}`, error: (e as Error).message }; }
  });
}
export async function importLemon(judge: Judge, files: Map<string, Buffer>, options: PackageImportOptions, problemId?: string): Promise<PackageImportResult> {
  const all = items(files), item = all.find(item => item.entry === options.entry) ?? (all.length === 1 && !options.entry ? all[0] : undefined);
  if (!item) fail('Select a LemonLime task from the package.');
  const value = plan(files, item, options);
  if (problemId) fail('Import LemonLime tasks from the home page to preserve their judging configuration.');
  return { problem: await publishProblem(judge, value.local, value.doc, options.root, options.folder), tests: value.tests, extras: [...value.local.keys()].filter(file => file.startsWith('other/')), warnings: value.warnings };
}
