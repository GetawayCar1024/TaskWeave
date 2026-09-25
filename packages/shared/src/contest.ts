import { z } from 'zod';
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
  action: ContestAction;
  /** Limit to these indices; all problems when omitted. */
  indices?: string[];
  /** polygon-push: commit message. */
  message?: string;
}

export interface ContestBatchItem {
  index: string;
  problem: string;
  ok: boolean;
  /** One-line result, e.g. "24 tests", "3 errors, 1 warning", "pushed 5 items". */
  message: string;
  details?: string[];
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
  samples: { input: string; output: string }[];
}
