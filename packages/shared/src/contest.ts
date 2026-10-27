import { z } from 'zod';
import type { LocalCheck } from './ai.js';
import type { ProblemSummary } from './problem.js';
import type { StatementSample } from './judge.js';
import type { LuoguExportOptions } from './packages.js';
import { problemTypeSchema, type ProblemType } from './problem.js';

/**
 * A contest is a folder in a problem root holding `contest.toml`: a title and an
 * ordered list of problems (by problem id, i.e. folder name). Problems stay in their
 * own folders and can belong to several contests.
 */
export const CONTEST_FILE = 'contest.toml';

/** Problem letters: A, B, …, A1, A2. */
export const CONTEST_INDEX_RE = /^[A-Z][A-Z0-9]{0,3}$/;

export const contestStatementOptionsSchema = z.object({
  subtitle: z.string().default(''),
  session: z.string().default(''),
  schedule: z.string().default(''),
  compileOptions: z.string().default(''),
  instructions: z.string().default(''),
});
export type ContestStatementOptions = z.infer<typeof contestStatementOptionsSchema>;

export const contestTomlSchema = z.object({
  contest: z
    .object({
      name: z.string(),
      type: problemTypeSchema.default('cf'),
      title: z.record(z.string(), z.string()).default({}),
    })
    .loose(),
  polygon: z.object({ id: z.number().int().optional() }).loose().default({}),
  statement: contestStatementOptionsSchema.default(() => contestStatementOptionsSchema.parse({})),
  problems: z.array(z.object({ index: z.string().regex(CONTEST_INDEX_RE), problem: z.string() }).loose()).default([]),
});
export type ContestToml = z.infer<typeof contestTomlSchema>;

export interface ContestProblemRef {
  index: string;
  problem: string;
}

export interface ContestSummary {
  type: ProblemType;
  statement?: ContestStatementOptions;
  id: string;
  name: string;
  title: Record<string, string>;
  dir: string;
  root: string;
  polygonId?: number;
  problems: (ContestProblemRef & { found: boolean })[];
  error?: string;
}

export interface ContestDetail {
  summary: ContestSummary;
  problems: (ContestProblemRef & { summary: ProblemSummary | null })[];
}

/** A missing problem or an empty contest has no language available for a complete document. */
export function commonContestLanguages(problems: ContestDetail['problems'], doc: 'statements' | 'tutorials'): string[] {
  if (!problems.length || problems.some(p => !p.summary || p.summary.error)) return [];
  const key = doc === 'statements' ? 'statementLangs' : 'tutorialLangs';
  return [...new Set(problems[0].summary!.status[key])]
    .filter(lang => /^[a-z]{2,8}$/.test(lang) && problems.every(p => p.summary!.status[key].includes(lang)))
    .sort();
}

export interface CreateContestRequest {
  type?: ProblemType;
  name: string;
  title?: Record<string, string>;
  root?: string;
  problems?: ContestProblemRef[];
}

export interface UpdateContestRequest {
  type?: ProblemType;
  name?: string;
  statement?: ContestStatementOptions;
  title?: Record<string, string>;
  problems?: ContestProblemRef[];
  polygonId?: number | null;
}

/** Actions run over every problem of a contest, one after another. */
export const CONTEST_ACTIONS = ['generate', 'invocation', 'checks', 'export', 'polygon-push'] as const;
export type ContestAction = (typeof CONTEST_ACTIONS)[number];

export type LuoguAggregate = 'sum' | 'min' | 'max';

export interface ContestBatchRequest {
  exportFormat?: 'polygon' | 'hydro' | 'luogu' | 'joi' | 'lemonlime';
  /** lemonlime / luogu: testsets to export per problem id (default: ["tests"]). */
  testsets?: Record<string, string[]>;
  /** luogu: how the scoring script combines the time / memory of the subtasks. */
  luogu?: { time: LuoguAggregate; memory: LuoguAggregate };
  /** Per-problem Luogu settings, keyed by stable problem id. */
  luoguByProblem?: Record<string, LuoguExportOptions>;
  lemon?: { subfolders?: boolean };
  commit?: boolean;
  buildPackage?: boolean;
  packageType?: 'standard' | 'full';
  action: ContestAction;
  /** Limit to these indices; all problems when omitted. */
  indices?: string[];
  /** polygon-push: commit message. */
  message?: string;
}

export interface ContestBatchItem {
  invocationId?: string;
  index: string;
  problem: string;
  ok: boolean;
  /** One-line result, e.g. "24 tests", "3 errors, 1 warning", "pushed 5 items". */
  message: string;
  details?: string[];
  /** checks: the local checks themselves, so the UI can show them in its language. */
  checks?: LocalCheck[];
}

export interface ContestBatchResult {
  action: ContestAction;
  items: ContestBatchItem[];
  /** export: contest package file name (download from /api/contests/:id/export/:file). */
  file?: string;
  size?: number;
}

export interface ContestImportRequest {
  type?: ProblemType;
  contestId: number;
  name: string;
  root?: string;
}

/** Statement sources of one problem for the combined contest view. */
export interface ContestStatement {
  /** Whole-file text is already structured by its author; do not add a Description heading. */
  statementMode?: 'whole' | 'sections';
  type?: ProblemType;
  /** OI: the complete statement, including sample descriptions, in one LaTeX file. */
  body?: string;
  index: string;
  problem: string;
  name?: string;
  testCount?: number;
  equalPoints?: boolean;
  title: string;
  timeLimit: number;
  memoryLimit: number;
  interactive: boolean;
  input: string;
  output: string;
  /** Raw LaTeX per section (empty sections omitted). */
  sections: Record<string, string>;
  samples: StatementSample[];
}

/** OI cover matrix; shared by the paper preview and TeX export. */
export function oiOverview(problems: ContestStatement[], lang: string) {
  const zh = lang === 'zh';
  const row = (key: string, label: string, value: (p: ContestStatement) => string, mono = false) => ({ key, label, values: problems.map(value), mono });
  return [
    row('title', zh ? '题目名称' : 'Problem', p => p.title),
    row('type', zh ? '题目类型' : 'Type', p => p.interactive ? (zh ? '交互型' : 'Interactive') : (zh ? '传统型' : 'Batch')),
    row('dir', zh ? '目录' : 'Directory', p => p.name ?? p.problem, true),
    row('exe', zh ? '可执行文件名' : 'Executable', p => p.name ?? p.problem, true),
    row('input', zh ? '输入文件名' : 'Input file', p => !p.input || p.input === 'stdin' ? (zh ? '标准输入' : 'standard input') : p.input, true),
    row('output', zh ? '输出文件名' : 'Output file', p => !p.output || p.output === 'stdout' ? (zh ? '标准输出' : 'standard output') : p.output, true),
    row('time', zh ? '每个测试点时限' : 'Time limit', p => `${(p.timeLimit / 1000).toFixed(1)} ${zh ? '秒' : 's'}`),
    row('memory', zh ? '内存限制' : 'Memory limit', p => `${p.memoryLimit} MiB`),
    row('tests', zh ? '测试点数目' : 'Test cases', p => p.testCount === undefined ? '—' : String(p.testCount)),
    row('points', zh ? '测试点是否等分' : 'Equal points', p => p.equalPoints === undefined ? '—' : p.equalPoints ? (zh ? '是' : 'Yes') : (zh ? '否' : 'No')),
  ];
}

// ---------------------------------------------------------------------------
// Contest ⇄ Polygon sync: status from one or two requests, then only the problems
// that changed on Polygon are fetched in full.

/** Where a problem of the contest stands against Polygon. */
export type ContestSyncState = 'same' | 'local' | 'remote' | 'both' | 'unbound' | 'unreachable' | 'deleted' | 'missing';

export interface ContestSyncRow {
  blocked?: boolean;
  index: string;
  /** Local problem id. */
  problem: string;
  polygonId?: number;
  state: ContestSyncState;
  /** Items changed locally since the last sync (computed locally). */
  localChanges: number;
  /** problem.toml differs from the last sync. */
  tomlChanged?: boolean;
  syncedRevision?: number;
  remoteRevision?: number;
  /** Polygon has uncommitted changes (made in its web UI, not committed yet). */
  remoteUncommitted?: boolean;
  /** Letter of this problem in the Polygon contest, when it differs. */
  polygonIndex?: string;
  /** Bound to Polygon but not a problem of the Polygon contest. */
  notInPolygonContest?: boolean;
}

export interface ContestSyncStatus {
  /** The Polygon contest, when the contest is bound to one. */
  polygonId?: number;
  rows: ContestSyncRow[];
  /** Problems of the Polygon contest that are not in the local contest. */
  remoteOnly: { index: string; polygonId: number; name: string; localProblem?: string }[];
  warnings: string[];
}

export interface ContestPullItem {
  key: string;
  label: string;
  status: string;
  /** Checked by default (a change made only on Polygon). */
  take: boolean;
}

export interface ContestPullProblem {
  index: string;
  problem: string;
  items: ContestPullItem[];
  /** Items changed on both sides: resolved in the problem's own sync dialog. */
  conflicts: string[];
  error?: string;
}

export interface ContestPullPreview {
  problems: ContestPullProblem[];
}

export interface ContestPullRequest {
  problems: { problem: string; take: string[] }[];
}

/** Take Polygon's version of everything (conflicts too) for every bound problem of the contest. */
export interface ContestRepullRequest {
  /** Also delete local items Polygon does not have (default false). */
  deleteLocal?: boolean;
  /** Local problem ids; default: every bound problem. */
  problems?: string[];
}

export interface ContestPullResult {
  problems: { problem: string; index: string; applied: number; warnings: string[]; error?: string }[];
}
