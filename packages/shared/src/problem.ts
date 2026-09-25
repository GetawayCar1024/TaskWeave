import { z } from 'zod';

export const SOLUTION_TAGS = ['MA', 'OK', 'WA', 'TL', 'TL-OR-OK', 'TM', 'ML', 'RE', 'PE', 'RJ', 'NR', 'FL'] as const;
export type SolutionTag = (typeof SOLUTION_TAGS)[number];

export const STATEMENT_LANGS = ['zh', 'en'] as const;
export type StatementLang = (typeof STATEMENT_LANGS)[number];

export const STATEMENT_SECTIONS = ['legend', 'input', 'output', 'interaction', 'scoring', 'notes', 'tutorial'] as const;
export type StatementSection = (typeof STATEMENT_SECTIONS)[number];

/** Prefix for references to files in the global `shared/` directory, e.g. `std:ncmp`. */
export const STD_PREFIX = 'std:';

/** Polygon problem names: lowercase latin letters, digits and dashes. */
export const PROBLEM_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const localized = z.record(z.string(), z.string());

/** A program referenced from problem.toml; `lang` overrides the extension-based language. */
const sourceEntry = z.object({ source: z.string(), lang: z.string().optional() }).loose();

export const problemTomlSchema = z.object({
  problem: z
    .object({
      name: z.string(),
      title: localized.default({}),
      time_limit: z.number().int().positive().default(1000),
      memory_limit: z.number().int().positive().default(256),
      input: z.string().default('stdin'),
      output: z.string().default('stdout'),
      interactive: z.boolean().default(false),
    })
    .loose(),
  polygon: z.object({ id: z.number().int().optional() }).loose().default({}),
  checker: sourceEntry.optional(),
  validator: sourceEntry.optional(),
  interactor: sourceEntry.optional(),
  solutions: z.array(sourceEntry.extend({ tag: z.enum(SOLUTION_TAGS) })).default([]),
  generators: z.array(sourceEntry).default([]),
  tests: z
    .object({
      script: z.string().optional(),
      /** Tests shown as examples in the statement, e.g. "1-2". */
      samples: z.string().optional(),
      groups: z.boolean().optional(),
      points: z.boolean().optional(),
      group: z
        .array(
          z
            .object({
              name: z.string(),
              points: z.number().optional(),
              policy: z.enum(['COMPLETE_GROUP', 'EACH_TEST']).optional(),
              dependencies: z.array(z.string()).optional(),
              tests: z.string().optional(),
            })
            .loose(),
        )
        .optional(),
    })
    .loose()
    .default({}),
}).loose();

export type ProblemToml = z.infer<typeof problemTomlSchema>;

export interface ProblemStatus {
  statement: boolean;
  validator: boolean;
  checker: boolean;
  std: boolean;
  manualTests: number;
  hasScript: boolean;
  polygonId?: number;
}

export interface ProblemSummary {
  /** URL-safe identifier (folder name, disambiguated across roots). */
  id: string;
  name: string;
  title: Record<string, string>;
  dir: string;
  root: string;
  timeLimit: number;
  memoryLimit: number;
  interactive: boolean;
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
  name: string;
  root?: string;
  title?: Record<string, string>;
  timeLimit?: number;
  memoryLimit?: number;
  interactive?: boolean;
}

/** Partial update of problem.toml. `null` removes the section. */
export interface PatchProblemRequest {
  title?: Record<string, string>;
  timeLimit?: number;
  memoryLimit?: number;
  interactive?: boolean;
  input?: string;
  output?: string;
  checker?: string | null;
  validator?: string | null;
  interactor?: string | null;
  /** Set (or with tag null, remove) the tag of one solution. */
  solution?: { source: string; tag: SolutionTag | null };
  /** Register (true) or unregister (false) a generator. */
  generator?: { source: string; enabled: boolean };
  /** tests.samples, e.g. "1-2"; empty string removes it. */
  samples?: string;
  /** Bind to a Polygon problem id; null unbinds. */
  polygonId?: number | null;
}
