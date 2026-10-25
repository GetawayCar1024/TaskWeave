import { z } from 'zod';

export const SOLUTION_TAGS = ['MA', 'OK', 'WA', 'TL', 'TL-OR-OK', 'TM', 'ML', 'RE', 'PE', 'RJ', 'NR', 'FL'] as const;
export type SolutionTag = (typeof SOLUTION_TAGS)[number];

export const STATEMENT_LANGS = ['zh', 'en'] as const;
export type StatementLang = (typeof STATEMENT_LANGS)[number];

export const STATEMENT_SECTIONS = ['legend', 'input', 'output', 'interaction', 'scoring', 'notes', 'tutorial'] as const;
export type StatementSection = (typeof STATEMENT_SECTIONS)[number];

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

/** Polygon problem names: lowercase latin letters, digits and dashes. */
export const PROBLEM_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const localized = z.record(z.string(), z.string());

/** A program referenced from problem.toml; `lang` overrides the extension-based language. */
const sourceEntry = z.object({ source: z.string(), lang: z.string().optional() }).loose();

/** Testset names: Polygon allows latin letters, digits, dashes. */
export const TESTSET_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

export const GROUP_POLICIES = ['COMPLETE_GROUP', 'EACH_TEST'] as const;

const testGroupSchema = z
  .object({
    name: z.string(),
    points: z.number().finite().nonnegative().optional(),
    /** COMPLETE_GROUP: the points only when every test passes; EACH_TEST: split over the tests. */
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
      type: problemTypeSchema.default('cf'),
      title: localized.default({}),
      time_limit: z.number().int().positive().default(1000),
      memory_limit: z.number().int().positive().default(256),
      input: z.string().default('stdin'),
      output: z.string().default('stdout'),
      interactive: z.boolean().default(false),
      judge_mode: judgeModeSchema.optional(),
    })
    .loose(),
  polygon: z.object({ id: z.number().int().optional() }).loose().default({}),
  checker: sourceEntry.optional(),
  /** Independent checker using the Lemon score/report-file protocol. */
  lemon_checker: sourceEntry.optional(),
  validator: sourceEntry.optional(),
  interactor: sourceEntry.optional(),
  /** C++ translation units linked with each submission, plus supplied headers. */
  grader: z.object({ sources: z.array(z.string()).min(1), headers: z.array(z.string()).default([]) }).optional(),
  solutions: z.array(sourceEntry.extend({ tag: z.enum(SOLUTION_TAGS) })).refine(
    list => !list.length || list.filter(s => s.tag === 'MA').length === 1,
    'Solutions must have exactly one MA',
  ).default([]),
  generators: z.array(sourceEntry).default([]),
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
export function polygonFeatureWarnings(config: ProblemToml): string[] {
  const warnings = testsetsOf(config).some(ts => ts.largeSamples?.trim()) ? ['Polygon does not support downloadable large samples. Show all samples in the statement before syncing.'] : [];
  if (config.tests.points) warnings.push(...testsetsOf(config).filter(ts => ts.groups).flatMap(ts => ts.group.filter(g => g.points !== undefined && !polygonPointsOk(g.points)).map(g => `${ts.name}/${g.name}: Polygon requires test points with at most 2 decimal places.`)));
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
  groups: boolean;
  group: TestGroup[];
  samples?: string;
  largeSamples?: string;
}

/** All testsets of a problem, "tests" first. */
export function testsetsOf(config: ProblemToml): TestsetConfig[] {
  const t = config.tests;
  const out: TestsetConfig[] = [
    { name: DEFAULT_TESTSET, script: t.script, manual: t.manual ?? 'tests/manual', groups: !!t.groups, group: t.group ?? [], samples: t.samples, largeSamples: t.large_samples },
  ];
  for (const [name, s] of Object.entries(config.testsets ?? {})) {
    if (name === DEFAULT_TESTSET) continue;
    out.push({ name, script: s.script, manual: s.manual ?? `tests/${name}`, groups: !!s.groups, group: s.group ?? [], samples: s.samples, largeSamples: s.large_samples });
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
  /** URL-safe identifier (folder name, disambiguated across roots). */
  id: string;
  name: string;
  title: Record<string, string>;
  dir: string;
  root: string;
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
  /** Samples of this testset (for "tests" the top-level `samples` works too); empty string removes. */
  samples?: string;
  largeSamples?: string;
  script?: string | null;
  groups?: boolean;
  group?: TestGroup[];
}
