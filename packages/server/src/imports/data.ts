import path from 'node:path';
import { parseDocument } from 'yaml';
import { parse as parseToml } from 'smol-toml';
import { compressRanges, type TestGroup, type TestsetConfig } from '@polyforge/shared';
import { HttpError, validateFileName } from '../util/fs.js';
import { splitScore } from '../judge/lemonlime.js';
import { luoguScript, type LuoguSubtask } from '../judge/luogu.js';
import { checkGroups } from '../workspace/problems.js';

export type DataFormat = 'luogu' | 'hydro' | 'auto' | 'joi';
export interface DataPair { input: string; output: string; inputData: Buffer; outputData: Buffer }
export interface DataPlan {
  pairs: DataPair[];
  groups: TestGroup[];
  cases: NonNullable<TestsetConfig['cases']>;
  samples: number[];
  used: Set<string>;
  warnings: string[];
  timeLimit: number;
  memoryLimit: number;
  sourceConfig: Record<string, any>;
  unresolvedScoring?: boolean;
  pointsEnabled?: boolean;
}

export const badPackage = (message: string): never => { throw new HttpError(400, 'invalid_package', message); };
export function yamlObject(bytes: Buffer | undefined, name: string): Record<string, any> {
  if (!bytes) return {};
  if (bytes.length > 4 * 1024 * 1024) return badPackage(`${name}: configuration exceeds 4 MiB.`);
  const doc = parseDocument(bytes.toString('utf8'), { uniqueKeys: true });
  if (doc.errors.length) return badPackage(`${name}: ${doc.errors[0].message}`);
  let value: unknown;
  try { value = doc.toJS({ maxAliasCount: 50 }); } catch (e) { return badPackage(`${name}: ${(e as Error).message}`); }
  if (value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return badPackage(`${name}: expected a YAML mapping.`);
  return value as Record<string, any>;
}

const number = (v: unknown, label: string, fallback?: number): number => {
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return badPackage(`${label}: expected a nonnegative number.`);
  return v;
};
const positive = (v: unknown, label: string, fallback: number) => {
  const n = number(v, label, fallback);
  if (n <= 0) return badPackage(`${label}: expected a positive number.`);
  return n;
};

export function hydroLimit(value: unknown, kind: 'time' | 'memory', fallback: number): number {
  if (value === undefined) return fallback;
  const m = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|us|s|[kmg]b?)?$/i);
  if (!m) return badPackage(`Invalid Hydro ${kind} limit: ${value}`);
  const unit = m[2]?.toLowerCase() ?? '';
  const factors: Record<string, number> = kind === 'time' ? { '': 1, ms: 1, us: .001, s: 1000 } : { '': 1, k: 1 / 1024, kb: 1 / 1024, m: 1, mb: 1, g: 1024, gb: 1024 };
  if (factors[unit] === undefined) return badPackage(`Invalid Hydro ${kind} unit: ${unit}`);
  const result = (kind === 'time' ? Math.floor : Math.ceil)(Number(m[1]) * factors[unit]);
  if (!Number.isSafeInteger(result) || result <= 0) return badPackage(`Invalid Hydro ${kind} limit: ${value}`);
  return result;
}

const natural = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
export function dataReader(files: Map<string, Buffer>, used: Set<string>) {
  const byName = new Map([...files.keys()].map(k => [k.toLowerCase(), k]));
  const find = (name: string) => byName.get(name.toLowerCase());
  const read = (name: unknown, nullable = false): [string, Buffer] => {
    if (nullable && (name === undefined || name === '' || name === '/dev/null')) return ['', Buffer.alloc(0)];
    if (typeof name !== 'string') return badPackage('A test case has no filename.');
    name = name.replace(/\\/g, '/').replace(/^\.\//, '');
    validateFileName(name as string);
    const key = find(name as string);
    if (!key) return badPackage(`Missing file referenced by configuration: ${name}`);
    used.add(key);
    return [key, files.get(key)!];
  };
  const pair = (input: unknown, output: unknown, nullable = false): DataPair => {
    const [inName, inputData] = read(input, nullable), [outName, outputData] = read(output, nullable);
    if (inName && inName === outName) return badPackage(`Input and answer refer to the same file: ${inName}`);
    return { input: inName, output: outName, inputData, outputData };
  };
  const pairedOutput = (input: string) => {
    const stem = input.replace(/\.(?:in|txt)(?:\.txt)?$/i, '');
    const candidates = ['out', 'ans', 'out.txt', 'ans.txt'].flatMap(ext => [`${stem}.${ext}`, `${stem}.${ext}`.replace(/input/gi, 'output')]);
    return candidates.map(find).find(Boolean);
  };
  return { find, pair, pairedOutput };
}
const reader = dataReader;

/** Recognize only our declarative Luogu script subset, never evaluate imported code. */
function scoringScript(script: string, initial: LuoguSubtask[]): LuoguSubtask[] | null {
  const compact = (s: string) => s.replace(/[()\s]/g, '');
  const parts = script.matchAll(/(?:if\s+([^;]+);\s*then\s*)?@total_score\s*=\s*@total_score\s*\+\s*(@score\d+|\d+(?:\.\d+)?);\s*(fi)?/g);
  const result: LuoguSubtask[] = [];
  for (const m of parts) {
    const current = initial[result.length];
    if (!current || !!m[1] !== !!m[3]) return null;
    const cond = m[1] ? compact(m[1]).split('and') : [];
    if (cond.some(c => !/^@status\d+==AC$/.test(c))) return null;
    const ids = cond.map(c => Number(c.match(/\d+/)![0]));
    const additive = m[2].startsWith('@score');
    if (additive && m[2] !== `@score${current.id}`) return null;
    if (!additive && !ids.includes(current.id)) return null;
    result.push({ ...current, policy: additive ? 'EACH_TEST' : 'COMPLETE_GROUP', points: additive ? current.points : Number(m[2]), dependencies: ids.filter(id => !(!additive && id === current.id)) });
  }
  if (result.length !== initial.length) return null;
  for (const time of ['sum', 'min', 'max'] as const) for (const memory of ['sum', 'min', 'max'] as const) {
    if (compact(luoguScript(result, { time, memory })) === compact(script)) return result;
  }
  return null;
}

export function parseLuoguData(files: Map<string, Buffer>): DataPlan {
  const used = new Set<string>(), r = reader(files, used), warnings: string[] = [];
  const configName = r.find('config.yml') ?? r.find('config.yaml');
  const source = configName ? files.get(configName) : undefined;
  const cfg = yamlObject(source, configName ?? 'config.yml');
  const inputs = [...files.keys()].filter(f => /\.in$/i.test(f)).sort(natural);
  if (!inputs.length) return badPackage('No .in/.out or .in/.ans pairs in this data package.');
  const pairs = inputs.map(input => r.pair(input, r.pairedOutput(input) ?? badPackage(`Missing answer for ${input}`)));
  const cases: DataPlan['cases'] = {};
  const groups = new Map<number, number[]>();
  const defaults = splitScore(100, pairs.length);
  let defaultScores = false;
  pairs.forEach((p, i) => {
    const a = cfg[p.input] ?? {}, b = cfg[p.output] ?? {};
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) badPackage('Invalid filename configuration.');
    for (const key of Object.keys(a)) if (b[key] !== undefined && JSON.stringify(a[key]) !== JSON.stringify(b[key])) badPackage(`Conflicting config for ${p.input} and ${p.output}: ${key}`);
    const c = { ...a, ...b };
    if (c.score === undefined) defaultScores = true;
    const id = number(c.subtaskId, 'subtaskId', 0);
    if (!Number.isSafeInteger(id)) badPackage('subtaskId must be an integer.');
    if (c.isPretest !== undefined && typeof c.isPretest !== 'boolean') badPackage('isPretest must be a boolean.');
    cases[i + 1] = { points: number(c.score, `${p.input}.score`, defaults[i]), time_limit: positive(c.timeLimit, 'timeLimit', 1000), memory_limit: positive(c.memoryLimit, 'memoryLimit', 256 * 1024) / 1024, ...(c.isPretest ? { pretest: true } : {}) };
    groups.set(id, [...(groups.get(id) ?? []), i + 1]);
  });
  if (defaultScores) warnings.push('Some tests have no score in config.yml; their local scores default to an even share of 100. Review subtask scores.');
  let subtasks: LuoguSubtask[] = [...groups].sort(([a], [b]) => a - b).map(([id, indices]) => ({ id, label: `subtask-${id}`, points: indices.reduce((s, i) => s + cases[i].points!, 0), policy: 'EACH_TEST', dependencies: [] }));
  const scriptName = r.find('score.txt') ?? r.find('scoring-script.txt');
  const script = scriptName ? files.get(scriptName)!.toString('utf8') : '';
  let unresolvedScoring = false;
  if (script.trim()) {
    const recognized = scoringScript(script, subtasks);
    if (recognized) subtasks = recognized;
    else { unresolvedScoring = true; warnings.push('The Luogu scoring script cannot be represented as local subtasks. The original script is preserved in Other files; edit the subtask configuration before judging or exporting.'); }
  }
  let samples: number[] = [];
  const metadata = source?.toString('utf8').match(/^# polyforge-scoring: (.+)$/m)?.[1];
  if (metadata && !unresolvedScoring) {
    try {
      const m = JSON.parse(metadata);
      if (m.version === 1 && Array.isArray(m.subtasks) && m.subtasks.length === subtasks.length) {
        // Labels and samples are hints only: all scoring semantics come from config + the verified script.
        for (const s of subtasks) {
          const original = m.subtasks.find((x: any) => x.id === s.id);
          if (typeof original?.label === 'string' && original.label.trim()) s.label = original.label;
        }
        if (Array.isArray(m.samples)) samples = m.samples.filter((i: unknown) => Number.isInteger(i) && Number(i) > 0 && Number(i) <= pairs.length);
      }
    } catch { warnings.push('Invalid Taskweave metadata comment; imported the official config.yml fields instead.'); }
  }
  const names = new Map(subtasks.map(s => [s.id, s.label]));
  const localGroups = subtasks.map(s => ({ name: s.label, points: s.points, policy: s.policy, tests: compressRanges(groups.get(s.id)!), dependencies: s.dependencies.map(d => names.get(d) ?? badPackage(`Unknown subtask dependency: ${d}`)) }));
  return { pairs, groups: checkGroups('tests', localGroups), cases, samples, used, warnings, sourceConfig: cfg, timeLimit: cases[1].time_limit!, memoryLimit: Math.ceil(cases[1].memory_limit!), unresolvedScoring };
}

export function parseHydroData(files: Map<string, Buffer>): DataPlan {
  const used = new Set<string>(), r = reader(files, used), warnings: string[] = [];
  const configName = r.find('config.yaml') ?? r.find('config.yml');
  let cfg = yamlObject(configName ? files.get(configName) : undefined, configName ?? 'config.yaml');
  if (!configName && r.find('config.ini')) {
    const lines = files.get(r.find('config.ini')!)!.toString('utf8').split(/\r?\n/), count = Number(lines[0]);
    if (!Number.isSafeInteger(count) || count < 1 || count > 10000) badPackage('Invalid Hydro config.ini test count.');
    cfg = { subtasks: lines.slice(1, count + 1).map((line, i) => {
      const [input, output, time, score, memory] = line.split('|');
      return { id: i + 1, type: 'min', score: Number(score), time: `${time}s`, memory: memory ? `${Number(memory) / 1024}m` : '256m', cases: [{ input, output }] };
    }) };
    if (cfg.subtasks.length !== count) badPackage('Truncated Hydro config.ini.');
  }
  const timeLimit = hydroLimit(cfg.time, 'time', 1000), memoryLimit = hydroLimit(cfg.memory, 'memory', 256);
  if (cfg.cases !== undefined && !Array.isArray(cfg.cases)) badPackage('Hydro cases must be a list.');
  if (cfg.subtasks !== undefined && !Array.isArray(cfg.subtasks)) badPackage('Hydro subtasks must be a list.');
  let subtasks: any[] = cfg.cases?.length ? [{ type: 'sum', cases: cfg.cases }] : structuredClone(cfg.subtasks ?? []);
  if (!subtasks.some(s => s.cases?.length)) {
    const auto = new Map<number, any>();
    for (const s of subtasks) if (Number.isSafeInteger(s.id) && s.id > 0) auto.set(s.id, { ...s, cases: [] });
    for (const input of [...files.keys()].sort(natural)) {
      const m = path.posix.basename(input).match(/^(([\w.-]*?)(?:(\d*)[-_])?(\d+))\.(?:in|txt|in\.txt)$/i);
      if (!m) continue;
      const output = r.pairedOutput(input);
      if (!output) continue;
      const id = Number(m[3] || 1);
      if (!auto.has(id)) auto.set(id, { id, type: m[3] ? 'min' : 'sum', cases: [] });
      auto.get(id).cases.push({ input, output });
    }
    subtasks = [...auto.values()];
  }
  if (!subtasks.length) return badPackage('No test cases in Hydro package.');
  subtasks.sort((a, b) => Number(a.id) - Number(b.id));
  const defaultScores = splitScore(Math.max(0, 100 - subtasks.reduce((s, g) => s + number(g.score, 'subtask score', 0), 0)), subtasks.filter(s => !s.score).length);
  let defaultIndex = 0, unresolvedScoring = false;
  const pairs: DataPair[] = [], groups: TestGroup[] = [], cases: DataPlan['cases'] = {};
  const pairIndices = new Map<string, number>();
  const ids = subtasks.map((s, i) => s.id ?? i + 1);
  if (ids.some(id => !Number.isSafeInteger(id) || id < 0) || new Set(ids).size !== ids.length) badPackage('Hydro subtask IDs must be unique nonnegative integers.');
  for (const [pos, s] of subtasks.entries()) {
    if (!Array.isArray(s.cases) || !s.cases.length) badPackage(`Hydro subtask ${ids[pos]} has no cases.`);
    const points = s.score || defaultScores[defaultIndex++];
    const type = s.type ?? 'min';
    if (!['min', 'sum'].includes(type)) { unresolvedScoring = true; warnings.push(`Hydro subtask ${ids[pos]} uses unsupported scoring ${type}; edit its local subtask configuration before judging or exporting.`); }
    const time = hydroLimit(s.time, 'time', timeLimit), memory = hydroLimit(s.memory, 'memory', memoryLimit);
    const caseDefaults = splitScore(Math.max(0, points - s.cases.reduce((n: number, c: any) => n + number(c.score, 'case score', 0), 0)), s.cases.filter((c: any) => !c.score).length);
    let caseDefaultIndex = 0;
    const indices: number[] = [];
    const groupCases: NonNullable<TestGroup['cases']> = {};
    for (const c of s.cases) {
      const pair = r.pair(c.input, c.output, true);
      const identity = JSON.stringify([pair.input, pair.output]);
      let index = pairIndices.get(identity);
      if (index === undefined) { pairs.push(pair); index = pairs.length; pairIndices.set(identity, index); }
      if (indices.includes(index)) badPackage(`Hydro subtask ${ids[pos]} repeats the same test.`);
      indices.push(index);
      if (pairs.length > 10000) badPackage('Too many test cases (maximum 10000).');
      const score = c.score || (type === 'sum' ? caseDefaults[caseDefaultIndex++] : points);
      groupCases[index] = { points: score, time_limit: hydroLimit(c.time, 'time', time), memory_limit: hydroLimit(c.memory, 'memory', memory) };
      cases[index] ??= { ...groupCases[index] };
      if (type === 'min' && score !== points) { unresolvedScoring = true; warnings.push(`Hydro subtask ${ids[pos]} has unequal case scores in min mode; its raw configuration is preserved.`); }
      if (!pair.output) warnings.push(`Test ${index} has no reference output in Hydro; imported an empty answer. A special judge may be required.`);
    }
    const dependencies = s.if ?? [];
    if (!Array.isArray(dependencies) || dependencies.some(d => !ids.includes(d))) badPackage(`Invalid dependencies for Hydro subtask ${ids[pos]}.`);
    groups.push({ name: `subtask-${ids[pos]}`, points, policy: type === 'sum' ? 'EACH_TEST' : 'COMPLETE_GROUP', tests: compressRanges(indices),
      time_limit: time, memory_limit: memory, cases: groupCases, dependencies: dependencies.map((d: number) => `subtask-${d}`) });
    if (s.score === 0 || s.cases.some((c: any) => c.score === 0)) warnings.push(`Hydro subtask ${ids[pos]} contains zero scores; Hydro treats them as unspecified. Local scores follow Hydro's defaults; the original YAML is preserved.`);
  }
  const checkedGroups = checkGroups('tests', groups);
  for (const key of ['time_limit_rate', 'memory_limit_rate', 'multi_pass']) if (cfg[key]) warnings.push(`Hydro ${key} is preserved in Other files but is not applied by the local judge.`);
  if (cfg.type && cfg.type !== 'default') warnings.push(`Hydro problem type ${cfg.type} is preserved; configure the corresponding local judge mode and programs before enabling full authoring.`);
  return { pairs, groups: checkedGroups, cases, samples: [], used, warnings, timeLimit, memoryLimit, sourceConfig: cfg, unresolvedScoring };
}

function companionData(files: Map<string, Buffer>, cfg: Record<string, any>): DataPlan {
  const used = new Set<string>(), r = reader(files, used), cases: DataPlan['cases'] = {}, pairs: DataPair[] = [];
  if (!Array.isArray(cfg.cases) || cfg.cases.length > 10000) return badPackage('Companion cases must be a list of at most 10000 tests.');
  if (cfg.subtasks !== undefined && !Array.isArray(cfg.subtasks)) return badPackage('Companion subtasks must be a list.');
  for (const group of cfg.subtasks ?? []) {
    if (group.id === undefined || !['min', 'sum'].includes(group.aggregation) || !Array.isArray(group.cases)) return badPackage('Companion subtasks require an id, min/sum aggregation and a case list.');
  }
  const ids = new Map<string, number>();
  const samples: number[] = [];
  for (const row of cfg.cases) {
    const id = String(row.id ?? pairs.length + 1);
    if (ids.has(id)) return badPackage(`Duplicate case id: ${id}`);
    const index = pairs.length + 1; ids.set(id, index); pairs.push(r.pair(row.input, row.output));
    cases[index] = { points: row.score, time_limit: row.time_ms, memory_limit: row.memory_mib, original_input: row.original_input ?? row.input, original_output: row.original_output ?? row.output };
    if (row.sample) samples.push(index);
  }
  const groups: TestGroup[] = (cfg.subtasks ?? []).map((group: any) => ({ name: String(group.id), policy: group.aggregation === 'sum' ? 'EACH_TEST' : 'COMPLETE_GROUP',
    points: group.points, test_points: group.test_points, time_limit: group.time_ms, memory_limit: group.memory_mib,
    cases: group.overrides && Object.fromEntries(Object.entries(group.overrides).map(([id, value]) => [ids.get(id) ?? badPackage(`Unknown case id: ${id}`), value])),
    tests: compressRanges((group.cases ?? []).map((id: unknown) => ids.get(String(id)) ?? badPackage(`Unknown case id: ${id}`))), dependencies: group.dependencies ?? [] }));
  return { pairs, cases, groups: checkGroups('tests', groups), samples, used, warnings: [], timeLimit: cfg.problem?.time_ms ?? 1000, memoryLimit: cfg.problem?.memory_mib ?? 256,
    sourceConfig: cfg, pointsEnabled: cfg.points_enabled ?? groups.length > 0 };
}

/** Directory pairing is independent of scoring: JOI/AtCoder have no universal score manifest. */
export function parseInoutData(files: Map<string, Buffer>): DataPlan {
  const used = new Set<string>(), r = reader(files, used);
  const inputs = [...files.keys()].filter(name => /^in\//i.test(name)).sort(natural);
  if (!inputs.length) return badPackage('No input files found under in/.');
  const pairs = inputs.map(input => r.pair(input, r.find('out/' + input.slice(input.indexOf('/') + 1)) ?? badPackage(`Missing answer for ${input}`)));
  return { pairs, cases: {}, groups: [], samples: [], used, warnings: [], sourceConfig: {}, timeLimit: 1000, memoryLimit: 256, pointsEnabled: false };
}

function configKind(value: Record<string, any>): 'hydro' | 'luogu' | 'companion' | undefined {
  if (value.format === 'polyforge-inout') {
    if (value.version !== 1) return badPackage('Unsupported polyforge-inout configuration version.');
    return 'companion';
  }
  if (Array.isArray(value.subtasks) || Array.isArray(value.cases) || typeof value.checker_type === 'string') return 'hydro';
  if (['time', 'memory'].some(key => value[key] !== undefined && /^(?:\d+(?:\.\d+)?)\s*(?:ms|us|s|[kmg]b?)?$/i.test(String(value[key]).trim())) || typeof value.filename === 'string') return 'hydro';
  if (Object.entries(value).some(([key, val]) => /\.(in|out|ans)(?:\.txt)?$/i.test(key) && val && typeof val === 'object')) return 'luogu';
  return undefined;
}

export function parseData(files: Map<string, Buffer>, format: DataFormat): DataPlan {
  if (format === 'luogu') return parseLuoguData(files);
  if (format === 'hydro') return parseHydroData(files);
  const names = [...files.keys()].filter(name => /\.(ya?ml|json|toml|ini|txt|cfg|conf)$/i.test(name) && !/^(in|out)\//i.test(name))
    .sort((a, b) => Number(!/^(polyforge|config)\./i.test(a)) - Number(!/^(polyforge|config)\./i.test(b)) || a.localeCompare(b));
  let configError: unknown;
  for (const name of names) {
    const bytes = files.get(name)!;
    if (bytes.length > 4 * 1024 * 1024) continue;
    let cfg: Record<string, any>;
    try { cfg = /\.toml$/i.test(name) ? parseToml(bytes.toString('utf8')) as Record<string, any> : yamlObject(bytes, name); }
    catch (e) { if (/^(config|polyforge)\.ya?ml$/i.test(name)) configError = e; continue; }
    const kind = configKind(cfg);
    if (!kind) continue;
    if (kind === 'companion') return companionData(files, cfg);
    const virtual = new Map(files);
    const canonical = kind === 'hydro' ? 'config.yaml' : 'config.yml';
    // JSON is valid YAML; preserve the original file separately while using its recognized shape.
    virtual.set(canonical, /\.toml$/i.test(name) ? Buffer.from(JSON.stringify(cfg)) : bytes);
    return kind === 'hydro' ? parseHydroData(virtual) : parseLuoguData(virtual);
  }
  if (configError) throw configError;
  const ini = names.find(name => /\.ini$/i.test(name) && /^\s*\d+\s*\r?\n/.test(files.get(name)!.toString('utf8')));
  if (ini) { const virtual = new Map(files); virtual.set('config.ini', files.get(ini)!); return parseHydroData(virtual); }
  if (format === 'joi' || [...files.keys()].some(name => /^in\//i.test(name))) return parseInoutData(files);
  const used = new Set<string>(), r = reader(files, used);
  const inputs = [...files.keys()].filter(name => /\.in$/i.test(name)).sort(natural);
  if (!inputs.length) return badPackage('No .in/.out or .in/.ans pairs in this data package.');
  const pairs = inputs.map(input => r.pair(input, r.pairedOutput(input) ?? badPackage(`Missing answer for ${input}`)));
  return { pairs, cases: {}, groups: [], samples: [], used, warnings: [], sourceConfig: {}, timeLimit: 1000, memoryLimit: 256, pointsEnabled: false };
}
