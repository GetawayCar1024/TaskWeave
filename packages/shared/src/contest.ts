import { z } from 'zod';
import type { LocalCheck } from './ai.js';
import type { ProblemSummary } from './problem.js';

/**
 * A contest is a folder in a problem root holding `contest.toml`: a title and an
 * ordered list of problems (by problem id, i.e. folder name). Problems stay in their
 * own folders and can belong to several contests.
 */
export const CONTEST_FILE = 'contest.toml';

/** Problem letters: A, B, …, A1, A2. */
export const CONTEST_INDEX_RE = /^[A-Z][A-Z0-9]{0,3}$/;

export const contestTomlSchema = z.object({
  contest: z
    .object({
      name: z.string(),
      title: z.record(z.string(), z.string()).default({}),
    })
    .loose(),
  polygon: z.object({ id: z.number().int().optional() }).loose().default({}),
  problems: z.array(z.object({ index: z.string().regex(CONTEST_INDEX_RE), problem: z.string() }).loose()).default([]),
});
export type ContestToml = z.infer<typeof contestTomlSchema>;

export interface ContestProblemRef {
  index: string;
  problem: string;
}

export interface ContestSummary {
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

export interface CreateContestRequest {
  name: string;
  title?: Record<string, string>;
  root?: string;
  problems?: ContestProblemRef[];
}

export interface UpdateContestRequest {
  title?: Record<string, string>;
  problems?: ContestProblemRef[];
  polygonId?: number | null;
}

/** Actions run over every problem of a contest, one after another. */
export const CONTEST_ACTIONS = ['generate', 'invocation', 'checks', 'export', 'polygon-push'] as const;
export type ContestAction = (typeof CONTEST_ACTIONS)[number];

export interface ContestBatchRequest {
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
  contestId: number;
  name: string;
  root?: string;
}

/** Statement sources of one problem for the combined contest view. */
export interface ContestStatement {
  index: string;
  problem: string;
  title: string;
  timeLimit: number;
  memoryLimit: number;
  interactive: boolean;
  input: string;
  output: string;
  /** Raw LaTeX per section (empty sections omitted). */
  sections: Record<string, string>;
  samples: { input: string; output: string; inputCases?: number[] }[];
}

// ---------------------------------------------------------------------------
// Contest ⇄ Polygon sync: status from one or two requests, then only the problems
// that changed on Polygon are fetched in full.

/** Where a problem of the contest stands against Polygon. */
export type ContestSyncState = 'same' | 'local' | 'remote' | 'both' | 'unbound' | 'unreachable' | 'missing';

export interface ContestSyncRow {
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

export interface ContestPullResult {
  problems: { problem: string; index: string; applied: number; warnings: string[]; error?: string }[];
}
