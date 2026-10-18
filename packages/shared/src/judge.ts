import type { SolutionTag, TestsetConfig } from './problem.js';

/** Raw status reported by the runner for one process. */
export type RunStatus = 'OK' | 'RE' | 'TL' | 'ML' | 'OL' | 'IE';

/** Verdict of a solution on one test. `IE` = internal error of the judge itself. */
export type Verdict = 'OK' | 'WA' | 'PE' | 'TL' | 'ML' | 'RE' | 'OL' | 'FAIL' | 'IE' | 'SKIP';

export interface RunStats {
  status: RunStatus;
  exitCode: number;
  timeMs: number;
  wallMs: number;
  memoryKb: number;
  /** Killed by the wall-clock limit while not using CPU (idleness). */
  idle: boolean;
  error?: string;
}

export interface Diagnostic {
  /** Problem-relative path, or absolute path for files outside the problem (e.g. testlib.h). */
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'note';
  message: string;
}

export interface CompileResult {
  source: string;
  ok: boolean;
  cached: boolean;
  /** Language id from languages.toml. */
  lang?: string;
  log: string;
  diagnostics: Diagnostic[];
  durationMs: number;
}

export interface TestInfo {
  largeSample?: boolean;
  index: number;
  origin: 'manual' | 'script';
  /** Manual: problem-relative file. Script: the expanded script command. */
  source: string;
  /** 1-based line of the command in script.txt. */
  line?: number;
  group?: string;
  /**
   * Samples: input / output shown in the statement instead of the test's input and
   * answer (a manual test's NN.statement.in / NN.statement.out next to NN.in; needed
   * for interactive problems). Problem-relative paths.
   */
  statementInput?: string;
  statementOutput?: string;
  /** Samples: test case of each input line (from the validator's setTestCase markup; 0 = none). */
  inputCases?: number[];
  /** Points of the test when points are enabled (derived from its group). */
  points?: number;
  sample?: boolean;
  inputSize?: number;
  answerSize?: number;
  /** null when there is no validator. */
  valid?: boolean | null;
  validatorMessage?: string;
  hasOverview?: boolean;
  error?: string;
}

export interface TestsManifest {
  /** Testset name ("tests" unless the problem has more testsets). */
  testset?: string;
  generatedAt: string;
  ok: boolean;
  tests: TestInfo[];
  errors: string[];
  /** Validator overview (testlib --testOverviewLogFileName) merged over all tests. */
  hasOverview?: boolean;
}

export interface StatementSample {
  index?: number;
  number?: number;
  input: string;
  output: string;
  inputCases?: number[];
  large?: boolean;
  inputFile?: string;
  outputFile?: string;
  inputHash?: string;
  outputHash?: string;
}

export function sampleFileNames(problemName: string, number: number) {
  return { inputFile: `${problemName}/${problemName}${number}.in`, outputFile: `${problemName}/${problemName}${number}.out` };
}
export function largeSampleNotice(sample: StatementSample, lang: string, number: number): string {
  return lang === 'zh' ? `样例 ${number} 见选手目录下的 ${sample.inputFile} 与 ${sample.outputFile}。` : `Sample ${number}: see ${sample.inputFile} and ${sample.outputFile} in the contestant directory.`;
}

export interface CheckerOutcome {
  verdict: Verdict;
  message: string;
  points?: number;
}

export interface InvocationCell {
  wallMs?: number;
  verdict: Verdict;
  timeMs: number;
  memoryKb: number;
  exitCode?: number;
  message?: string;
  points?: number;
  /** Solution output saved for the diff view. */
  hasOutput?: boolean;
}

export interface InvocationSolution {
  source: string;
  tag?: SolutionTag;
  compile?: CompileResult;
  /** Evaluation of the results against the tag. */
  expectation?: TagCheck;
  maxTimeMs?: number;
  maxMemoryKb?: number;
  /** Present when points are enabled. */
  score?: SolutionScore;
}

export interface GroupScore {
  name: string;
  score: number;
  max: number;
  /** Every test of the group passed. */
  passed: boolean;
  /** Not scored because a dependency did not pass. */
  blockedBy?: string[];
}

export interface SolutionScore {
  total: number;
  max: number;
  groups: GroupScore[];
}

/** Per-test results and group definitions a score is computed from. */
export interface ScoringInput {
  tests: { index: number; group?: string; points?: number; verdict: Verdict; checkerPoints?: number }[];
  groups: { name: string; points?: number; policy: 'COMPLETE_GROUP' | 'EACH_TEST'; dependencies: string[]; tests: number[] }[];
}

export interface Invocation {
  id: string;
  createdAt: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  error?: string;
  testset?: string;
  timeLimit: number;
  memoryLimit: number;
  tests: number[];
  solutions: InvocationSolution[];
  /** cells[solutionIndex][testPosition] */
  cells: (InvocationCell | null)[][];
}

export interface InvocationSummary {
  id: string;
  createdAt: string;
  status: Invocation['status'];
  solutions: number;
  tests: number;
  testset?: string;
  ok: boolean;
}

export interface ValidatorTestResult {
  file: string;
  expected: 'VALID' | 'INVALID';
  actual: 'VALID' | 'INVALID' | 'ERROR';
  ok: boolean;
  message: string;
}

export interface CheckerTestResult {
  name: string;
  expected: Verdict;
  actual: Verdict;
  ok: boolean;
  message: string;
}

export interface SelfTestReport<T> {
  compile?: CompileResult;
  results: T[];
  error?: string;
}

export interface QuickRunRequest {
  source: string;
  /** Custom stdin; ignored when `test` is given. */
  input?: string;
  /** Run on a generated test and check the answer with the checker. */
  test?: number;
  /** Testset of `test` (default "tests"). */
  testset?: string;
}

export interface QuickRunResponse {
  compile: CompileResult;
  run?: RunStats;
  verdict?: Verdict;
  checker?: CheckerOutcome;
  stdout: string;
  stderr: string;
  stdoutTruncated?: boolean;
}

export type JobKind = 'generate' | 'invocation' | 'validator-tests' | 'checker-tests' | 'polygon-push' | 'polygon-import' | 'stress' | 'export' | 'contest' | 'contest-import';

export interface JobInfo {
  id: string;
  kind: JobKind;
  problemId: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  progress: { done: number; total: number; message?: string };
  error?: string;
  /** Kind-specific result (TestsManifest, invocation id, self-test report). */
  result?: unknown;
}

export interface TestFileResponse {
  content: string;
  size: number;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Tag semantics (DESIGN §4.2 Invocation): which verdicts a tag allows and which
// verdict must appear at least once.

interface TagRule {
  allowed: Verdict[];
  /** At least one of these must occur. */
  required?: Verdict[];
}

export const TAG_RULES: Record<SolutionTag, TagRule> = {
  MA: { allowed: ['OK'] },
  OK: { allowed: ['OK'] },
  WA: { allowed: ['OK', 'WA', 'PE'], required: ['WA', 'PE'] },
  PE: { allowed: ['OK', 'PE'], required: ['PE'] },
  TL: { allowed: ['OK', 'TL'], required: ['TL'] },
  'TL-OR-OK': { allowed: ['OK', 'TL'] },
  TM: { allowed: ['OK', 'TL', 'ML'], required: ['TL', 'ML'] },
  NR: { allowed: ['OK', 'WA', 'PE', 'TL', 'ML', 'RE', 'OL', 'FAIL'] },
  ML: { allowed: ['OK', 'ML'], required: ['ML'] },
  RE: { allowed: ['OK', 'RE'], required: ['RE'] },
  RJ: { allowed: ['OK', 'WA', 'PE', 'TL', 'ML', 'RE', 'OL', 'FAIL'], required: ['WA', 'PE', 'TL', 'ML', 'RE', 'OL', 'FAIL'] },
  FL: { allowed: ['OK', 'WA', 'PE', 'TL', 'ML', 'RE', 'OL', 'FAIL'], required: ['FAIL'] },
};

export interface TagCheck {
  ok: boolean;
  /** Test positions whose verdict the tag does not allow. */
  unexpected: number[];
  /** Set when a required verdict never occurred. */
  missing?: Verdict[];
  /** OK-tagged solutions using more than half the time limit on some test. */
  slow?: number[];
}

export function checkTag(tag: SolutionTag | undefined, cells: (InvocationCell | null)[], timeLimit: number): TagCheck {
  const rule = tag ? TAG_RULES[tag] : undefined;
  const unexpected: number[] = [];
  const slow: number[] = [];
  const seen = new Set<Verdict>();
  cells.forEach((c, i) => {
    if (!c || c.verdict === 'SKIP') return;
    seen.add(c.verdict);
    if (c.verdict === 'IE') unexpected.push(i);
    else if (rule && !rule.allowed.includes(c.verdict)) unexpected.push(i);
    if ((tag === 'MA' || tag === 'OK') && c.verdict === 'OK' && c.timeMs > timeLimit / 2) slow.push(i);
  });
  const complete = cells.every((c) => c !== null);
  const missing = rule?.required && complete && !rule.required.some((v) => seen.has(v)) ? rule.required : undefined;
  return { ok: unexpected.length === 0 && !missing, unexpected, missing, slow: slow.length ? slow : undefined };
}

/** Parse Polygon-style index lists: "1-10,12,15-20". */
export function parseIndexList(s: string): number[] {
  const out: number[] = [];
  for (const part of s.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.push(i);
    } else if (/^\d+$/.test(p)) out.push(Number(p));
  }
  return out;
}

/** [1,2,3,5] → "1-3,5" (the inverse of parseIndexList). */
export function compressRanges(nums: number[]): string {
  const s = [...new Set(nums)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(i === j ? `${s[i]}` : `${s[i]}-${s[j]}`);
    i = j + 1;
  }
  return out.join(',');
}

export interface StressRequest {
  /** Generator name (as in the script) or source path. */
  generator: string;
  /** Generator arguments; {seed} is replaced by the iteration seed, otherwise it is appended. */
  args: string;
  /** Solution under test. */
  solution: string;
  /** Reference solution; defaults to the MA solution. */
  reference?: string;
  maxIterations?: number;
  timeLimitSec?: number;
  seedStart?: number;
  /** Save the counterexample as tests/manual/stress-NN.in (default true). */
  saveCounterexample?: boolean;
}

export interface StressResult {
  iterations: number;
  found: boolean;
  stoppedBy: 'found' | 'iterations' | 'time' | 'cancelled';
  counterexample?: {
    seed: number;
    args: string;
    verdict: Verdict;
    message: string;
    input: string;
    expected: string;
    output: string;
    savedAs?: string;
  };
}

/**
 * Group of each test and per-test points derived from the group totals (as pushed to
 * Polygon): COMPLETE_GROUP puts the whole score on the last test, EACH_TEST splits it.
 */
export function groupLayout(ts: TestsetConfig, pointsEnabled: boolean): { mapping: Record<string, string>; points: Record<string, number> } {
  const mapping: Record<string, string> = {};
  const points: Record<string, number> = {};
  if (!ts.groups) return { mapping, points };
  for (const g of ts.group) {
    const idx = parseIndexList(g.tests ?? '').sort((a, b) => a - b);
    idx.forEach((i) => (mapping[i] = g.name));
    if (pointsEnabled && g.points && idx.length) {
      if ((g.policy ?? 'COMPLETE_GROUP') === 'COMPLETE_GROUP') {
        idx.forEach((i) => (points[i] = 0));
        points[idx[idx.length - 1]] = g.points;
      } else {
        const each = Math.floor(g.points / idx.length);
        idx.forEach((i) => (points[i] = each));
        points[idx[idx.length - 1]] += g.points - each * idx.length;
      }
    }
  }
  return { mapping, points };
}
