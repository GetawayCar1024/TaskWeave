import { z } from 'zod';
import { groupLayout } from './judge.js';

export const SOLUTION_TAGS = ['MA', 'OK', 'WA', 'TL', 'TL-OR-OK', 'TM', 'ML', 'RE', 'PE', 'RJ', 'NR', 'FL'] as const;
export type SolutionTag = (typeof SOLUTION_TAGS)[number];

export const STATEMENT_LANGS = ['zh', 'en'] as const;
export type StatementLang = (typeof STATEMENT_LANGS)[number];

export const STATEMENT_SECTIONS = ['legend', 'input', 'output', 'interaction', 'scoring', 'notes', 'tutorial'] as const;
export type StatementSection = (typeof STATEMENT_SECTIONS)[number];
/** statement.tex is the single-file alternative to these sections; tutorials stay separate. */
export const STATEMENT_BODY_SECTIONS = STATEMENT_SECTIONS.filter(s => s !== 'tutorial');
export type StatementMode = 'sections' | 'whole';

/**
 * Sections only used by OI-style documents (not part of Polygon statements):
 * `statement/<lang>/constraints.tex`, placed before the notes. Empty files are not rendered.
 */
export const OI_SECTIONS = ['constraints'] as const;
export type OiSection = (typeof OI_SECTIONS)[number];

/** Per-sample explanation (OI documents only): `statement/<lang>/samples/<index>.tex`, or `<testset>-<index>.tex` outside "tests". */
export function sampleNotePath(lang: string, index: number, testset = 'tests'): string {
  return `statement/${lang}/samples/${testset === 'tests' ? '' : `${testset}-`}${index}.tex`;
}

/** Legacy layout metadata, accepted for old TOML; it no longer restricts a workspace. */
export const problemTypeSchema = z.enum(['cf', 'oi']);
export type ProblemType = z.infer<typeof problemTypeSchema>;
export const judgeModeSchema = z.enum(['batch', 'io', 'grader']);
export type JudgeMode = z.infer<typeof judgeModeSchema>;
/** Older projects encode I/O interaction with `interactive` only. */
export function judgeMode(problem: { judge_mode?: JudgeMode; interactive?: boolean }): JudgeMode {
  return problem.judge_mode ?? (problem.interactive ? 'io' : 'batch');
}

/** Prefix for references to files in the global `shared/` directory, e.g. `std:ncmp`. */
export const STD_PREFIX = 'std:';
export const LEMON_PREFIX = 'lemon:';
export const lemonComparisonSchema = z.object({ mode: z.enum(['lines', 'ignore-spaces', 'real']), precision: z.number().int().min(0).max(18).default(3) });
export type LemonComparison = z.infer<typeof lemonComparisonSchema>;
export const LEMON_COMPARISON_MODES = { lines: 0, 'ignore-spaces': 1, real: 3 } as const;

/** Polygon problem names: lowercase latin letters, digits and dashes. */
export const PROBLEM_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Contestant directory / program / sample stem (LemonLime sourceFileName); must also be a portable file name. */
export const SOURCE_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
export const validSourceName = (name: string) => SOURCE_NAME_RE.test(name) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name);
/** Contestant-facing file name: an explicit source name, otherwise the short name. */
export const sourceName = (problem: { name: string; source_name?: string }) => problem.source_name || problem.name;

const localized = z.record(z.string(), z.string());

/** A program referenced from problem.toml; `lang` overrides the extension-based language. */
const sourceEntry = z.object({ source: z.string(), lang: z.string().optional() }).loose();

/** Testset names: Polygon allows latin letters, digits, dashes. */
export const TESTSET_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

export const GROUP_POLICIES = ['COMPLETE_GROUP', 'EACH_TEST'] as const;

export function distinctIoFiles(input: string, output: string): boolean {
  const normalize = (value: string) => value.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/\.\//g, '/').toLowerCase();
  return normalize(input || 'stdin') !== normalize(output || 'stdout');
}

const testGroupSchema = z
  .object({
    name: z.string(),
    points: z.number().finite().nonnegative().optional(),
    /** Uniform score of each case in sum mode. `points` remains the legacy group total. */
    test_points: z.number().finite().nonnegative().optional(),
    time_limit: z.number().int().positive().optional(),
    memory_limit: z.number().finite().positive().optional(),
    /** Imported membership-specific overrides (shared tests may differ between groups). */
    cases: z.record(z.string().regex(/^[1-9]\d*$/), z.object({
      points: z.number().finite().nonnegative().optional(),
      time_limit: z.number().int().positive().optional(),
      memory_limit: z.number().finite().positive().optional(),
    })).optional(),
    /** COMPLETE_GROUP: minimum of test scores; EACH_TEST: sum of test scores. */
    policy: z.enum(GROUP_POLICIES).optional(),
    /** Groups that must pass completely for this group to score. */
    dependencies: z.array(z.string()).optional(),
    tests: z.string().optional(),
    /** Validator used for the tests of this group instead of the problem validator (local only). */
    validator: z.string().optional(),
  })
  .loose();

const testsetSchema = z
  .object({
    script: z.string().optional(),
    /** Folder with manual tests; default tests/manual for "tests", tests/<name> otherwise. */
    manual: z.string().optional(),
    /** Imported/manual answers are authoritative and must not be regenerated by the main solution. */
    answers: z.enum(['generated', 'provided']).optional(),
    /** Immutable original answers, stored outside disposable caches. */
    answer_baseline: z.string().regex(/^[a-f0-9]{24}$/).optional(),
    /** Imported per-case overrides; limits use the same ms / MiB units as the problem. */
    cases: z.record(z.string().regex(/^[1-9]\d*$/), z.object({
      points: z.number().finite().nonnegative().optional(),
      time_limit: z.number().int().positive().optional(),
      memory_limit: z.number().positive().optional(),
      pretest: z.boolean().optional(),
      provided_answer: z.boolean().optional(),
      original_input: z.string().optional(),
      original_output: z.string().optional(),
    })).optional(),
    unresolved_scoring: z.boolean().optional(),
    groups: z.boolean().optional(),
    group: z.array(testGroupSchema).optional(),
    /** Tests shown as examples in the statement, e.g. "1-2". */
    samples: z.string().optional(),
    /** Sample test indices supplied as files instead of printed inline. */
    large_samples: z.string().optional(),
  })
  .loose();

export const problemTomlSchema = z.object({
  problem: z
    .object({
      name: z.string(),
      /** Contestant source / directory name when it differs from the short name. */
      source_name: z.string().optional(),
      type: problemTypeSchema.default('cf'),
      title: localized.default({}),
      time_limit: z.number().int().positive().default(1000),
      memory_limit: z.number().finite().positive().default(256),
      input: z.string().default('stdin'),
      output: z.string().default('stdout'),
      interactive: z.boolean().default(false),
      judge_mode: judgeModeSchema.optional(),
      /** Existing input/answer workspace: files and AI are available, authoring-only judging is gated. */
      data_only: z.boolean().default(false),
      /** A native imported checker/runtime that needs an explicit local replacement. */
      unresolved_judge: z.string().optional(),
    })
    .loose().refine(p => distinctIoFiles(p.input, p.output), { message: 'Input and output filenames must be different.', path: ['output'] }),
  polygon: z.object({ id: z.number().int().optional() }).loose().default({}),
  checker: sourceEntry.optional(),
  /** Independent Lemon export checker; imported ordinary Testlib sources retain CDF mode 5. */
  lemon_checker: sourceEntry.extend({ protocol: z.enum(['lemon', 'testlib']).optional() }).optional(),
  /** Native Lemon mode; also used by the local C++ comparator. */
  lemon_comparison: lemonComparisonSchema.optional(),
  validator: sourceEntry.optional(),
  interactor: sourceEntry.optional(),
  /** C++ translation units linked with each submission, plus supplied headers. */
  grader: z.object({ sources: z.array(z.string()).min(1), headers: z.array(z.string()).default([]) }).optional(),
  solutions: z.array(sourceEntry.extend({ tag: z.enum(SOLUTION_TAGS) })).refine(
    list => !list.length || list.filter(s => s.tag === 'MA').length === 1,
    'Solutions must have exactly one MA',
  ).default([]),
  generators: z.array(sourceEntry).default([]),
  exports: z.object({ luogu: z.object({ time: z.enum(['sum', 'min', 'max']), memory: z.enum(['sum', 'min', 'max']) }).optional() }).optional(),
  source_languages: z.record(z.string(), z.string()).default({}),
  polygon_source_types: z.record(z.string(), z.string()).default({}),
  /** The Polygon testset "tests" (also used for statements and answers). */
  tests: testsetSchema
    .extend({
      /** Points are enabled for the whole problem (Polygon: problem.enablePoints). */
      points: z.boolean().optional(),
    })
    .loose()
    .default({}),
  /** Further testsets, e.g. [testsets.pretests]. */
  testsets: z.record(z.string().regex(TESTSET_NAME_RE), testsetSchema).default({}),
}).loose();

export type ProblemToml = z.infer<typeof problemTomlSchema>;
export type TestGroup = z.infer<typeof testGroupSchema>;

/** Polygon accepts test points with at most 2 digits after the decimal point. */
export function polygonPointsOk(points: number): boolean {
  return Math.abs(points * 100 - Math.round(points * 100)) < 1e-6;
}

/** Problem features Polygon cannot represent; these block pushing / Polygon packages. */
export function polygonFeatureWarnings(config: ProblemToml, target: 'sync' | 'package' = 'sync'): string[] {
  const warnings = testsetsOf(config).some(ts => ts.largeSamples?.trim()) ? ['Polygon does not support downloadable large samples. Show all samples in the statement before syncing.'] : [];
  if (target === 'sync' && config.problem.data_only) warnings.push('Compatibility-mode problems cannot sync with Polygon. Complete the statement, validator, checker and main solution, then enable full authoring.');
  if (config.problem.unresolved_judge) warnings.push(config.problem.unresolved_judge);
  if (testsetsOf(config).some(ts => ts.unresolvedScoring)) warnings.push('Imported scoring is not representable. Edit the subtask configuration before judging or exporting.');
  if (target === 'sync') {
    if (config.problem.time_limit < 250 || config.problem.time_limit > 15000 || config.problem.time_limit % 50 !== 0) warnings.push('Polygon requires 250–15000 ms in steps of 50 ms.');
    if (!Number.isInteger(config.problem.memory_limit) || config.problem.memory_limit < 4 || config.problem.memory_limit > 1024) warnings.push('Polygon requires integer memory limits from 4 to 1024 MiB.');
    if (testsetsOf(config).some(ts => Object.values(ts.cases ?? {}).some(c => (c.time_limit !== undefined && c.time_limit !== config.problem.time_limit) || (c.memory_limit !== undefined && c.memory_limit !== config.problem.memory_limit)))) warnings.push('Polygon does not support per-test time or memory limits. Use the problem limits before syncing.');
    if (testsetsOf(config).some(ts => ts.group.some(g => (g.time_limit !== undefined && g.time_limit !== config.problem.time_limit) || (g.memory_limit !== undefined && g.memory_limit !== config.problem.memory_limit) || Object.values(g.cases ?? {}).some(c => (c.time_limit !== undefined && c.time_limit !== config.problem.time_limit) || (c.memory_limit !== undefined && c.memory_limit !== config.problem.memory_limit))))) warnings.push('Polygon does not support per-subtask time or memory limits. Use the problem limits before syncing.');
    if (testsetsOf(config).some(ts => Object.values(groupLayout(ts, false).memberships).some(names => names.length > 1))) warnings.push('Polygon sync assigns each test to one group. Polygon ZIP export can duplicate shared memberships; use that package or separate the tests before syncing.');
  }
  if (config.tests.points) for (const ts of testsetsOf(config)) {
    const layout = groupLayout(ts, true);
    const scores = [...Object.values(layout.points), ...Object.values(layout.byGroup).flatMap(points => Object.values(points))];
    if (scores.some(points => !polygonPointsOk(points))) warnings.push(`${ts.name}: Polygon requires test points with at most 2 decimal places.`);
    if (scores.some(points => points >= 1e9)) warnings.push(`${ts.name}: Polygon requires test points below 1000000000.`);
  }
  return warnings;
}

/** Local-only features that are not synced to Polygon (sync goes on, without them). */
export function polygonLossWarnings(config: ProblemToml): string[] {
  return testsetsOf(config).flatMap(ts => ts.group.filter(g => g.validator?.trim()).map(g => `${ts.name}/${g.name}: per-group validators are local only and are not synced to Polygon.`));
}

export const DEFAULT_TESTSET = 'tests';

export interface TestsetConfig {
  name: string;
  script?: string;
  /** Problem-relative folder with the manual tests. */
  manual: string;
  answers?: 'generated' | 'provided';
  answerBaseline?: string;
  cases?: Record<string, { points?: number; time_limit?: number; memory_limit?: number; pretest?: boolean; provided_answer?: boolean; original_input?: string; original_output?: string }>;
  unresolvedScoring?: boolean;
  groups: boolean;
  group: TestGroup[];
  samples?: string;
  largeSamples?: string;
}

/** All testsets of a problem, "tests" first. */
export function testsetsOf(config: ProblemToml): TestsetConfig[] {
  const t = config.tests;
  const out: TestsetConfig[] = [
     { name: DEFAULT_TESTSET, script: t.script, manual: t.manual ?? 'tests/manual', answers: t.answers, answerBaseline: t.answer_baseline, cases: t.cases, unresolvedScoring: t.unresolved_scoring, groups: !!t.groups, group: t.group ?? [], samples: t.samples, largeSamples: t.large_samples },
  ];
  for (const [name, s] of Object.entries(config.testsets ?? {})) {
    if (name === DEFAULT_TESTSET) continue;
    out.push({ name, script: s.script, manual: s.manual ?? `tests/${name}`, answers: s.answers, answerBaseline: s.answer_baseline, cases: s.cases, unresolvedScoring: s.unresolved_scoring, groups: !!s.groups, group: s.group ?? [], samples: s.samples, largeSamples: s.large_samples });
  }
  return out;
}

export function testsetOf(config: ProblemToml, name = DEFAULT_TESTSET): TestsetConfig | undefined {
  return testsetsOf(config).find((t) => t.name === name);
}

export interface ProblemStatus {
  statement: boolean;
  /** Languages that have a statement / a non-empty tutorial (these should match). */
  statementLangs: string[];
  tutorialLangs: string[];
  validator: boolean;
  checker: boolean;
  std: boolean;
  manualTests: number;
  hasScript: boolean;
  polygonId?: number;
}

export interface ProblemSummary {
  type: ProblemType;
  dataOnly?: boolean;
  /** URL-safe identifier (folder name, disambiguated across roots). */
  id: string;
  name: string;
  title: Record<string, string>;
  dir: string;
  root: string;
  folder?: string;
  timeLimit: number;
  memoryLimit: number;
  /** "stdin" or the input file name; likewise output. */
  input: string;
  output: string;
  interactive: boolean;
  judgeMode?: JudgeMode;
  status: ProblemStatus;
  /** Set when problem.toml could not be parsed. */
  error?: string;
}

export interface FileNode {
  name: string;
  /** Posix path relative to the problem directory. */
  path: string;
  type: 'file' | 'dir';
  size?: number;
  children?: FileNode[];
}

export interface ProblemDetail {
  summary: ProblemSummary;
  /** Parsed problem.toml, or null if it is invalid. */
  config: ProblemToml | null;
  tree: FileNode[];
}

export interface CreateProblemRequest {
  folder?: string;
  dataOnly?: boolean;
  statementMode?: StatementMode;
  judgeMode?: JudgeMode;
  type?: ProblemType;
  name: string;
  root?: string;
  title?: Record<string, string>;
  timeLimit?: number;
  memoryLimit?: number;
  interactive?: boolean;
}

/** Partial update of problem.toml. `null` removes the section. */
export interface PatchProblemRequest {
  /** Short name and folder are renamed together; references use the persistent identity. */
  name?: string;
  /** Contestant source file name; null or empty follows the short name. */
  sourceName?: string | null;
  luogu?: { time: 'sum' | 'min' | 'max'; memory: 'sum' | 'min' | 'max' };
  /** Leaving data-only mode requires the full authoring files to exist. */
  dataOnly?: boolean;
  judgeMode?: JudgeMode;
  grader?: { sources: string[]; headers: string[] } | null;
  language?: { source: string; lang: string | null };
  title?: Record<string, string>;
  timeLimit?: number;
  memoryLimit?: number;
  interactive?: boolean;
  input?: string;
  output?: string;
  checker?: string | null;
  lemonChecker?: string | null;
  lemonComparison?: LemonComparison | null;
  validator?: string | null;
  interactor?: string | null;
  /** Set (or with tag null, remove) the tag of one solution. */
  solution?: { source: string; tag: SolutionTag | null };
  /** Register (true) or unregister (false) a generator. */
  generator?: { source: string; enabled: boolean };
  /** tests.samples, e.g. "1-2"; empty string removes it. */
  samples?: string;
  /** Subset of samples supplied as files rather than shown inline. */
  largeSamples?: string;
  /** Bind to a Polygon problem id; null unbinds. */
  polygonId?: number | null;
  /** Create / update a testset (groups and script); null deletes it ("tests" cannot be deleted). */
  testsets?: Record<string, TestsetPatch | null>;
  /** tests.points: points enabled for the whole problem. */
  points?: boolean;
}

export interface TestsetPatch {
  answers?: 'generated' | 'provided';
  /** Samples of this testset (for "tests" the top-level `samples` works too); empty string removes. */
  samples?: string;
  largeSamples?: string;
  script?: string | null;
  groups?: boolean;
  group?: TestGroup[];
}
