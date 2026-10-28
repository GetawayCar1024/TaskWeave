import { z } from 'zod';
import type { AiEvent } from './ai.js';
import type { CompileResult, JobInfo } from './judge.js';

export const UI_LOCALES = ['zh-CN', 'en'] as const;
export type UiLocale = (typeof UI_LOCALES)[number];

/** Header carrying the per-launch access token (see DESIGN §8). */
export const TOKEN_HEADER = 'x-taskweave-token';

/** Non-redistributable OI template fonts, loaded from the user's system (GET /api/system-fonts). */
export interface SystemFontStatus {
  fonts: { key: string; family: string; label: string; found: boolean }[];
  /** Folder searched first; users without the fonts can put the files there. */
  userDir: string;
}

export const globalConfigSchema = z
  .object({
    ui: z
      .object({
        locale: z.enum(UI_LOCALES).default('zh-CN'),
        theme: z.enum(['dark', 'light']).default('dark'),
      })
      .loose()
      .default({ locale: 'zh-CN', theme: 'dark' }),
    problems: z
      .object({
        /** Absolute paths of problem root directories. */
        roots: z.array(z.string()).default([]),
      })
      .loose()
      .default({ roots: [] }),
    /** Where contests are stored (separately from problems); empty = <global dir>/contests. */
    contests: z
      .object({ dir: z.string().optional() })
      .loose()
      .default({}),
    /** Default AI endpoint (name from secrets.toml) and model. */
    ai: z
      .object({ endpoint: z.string().optional(), model: z.string().optional() })
      .loose()
      .default({}),
    editor: z
      .object({
        font_size: z.number().int().min(8).max(40).default(14),
        tab_size: z.number().int().min(1).max(8).default(4),
        word_wrap: z.boolean().default(false),
        minimap: z.boolean().default(false),
      })
      .loose()
      .default({ font_size: 14, tab_size: 4, word_wrap: false, minimap: false }),
    /**
     * Judging: how many programs may run at once (tests, solutions, checkers); 0 = half
     * the CPU cores. Compilations use half as many slots.
     */
    judge: z
      .object({ parallel: z.number().int().min(0).max(256).default(0) })
      .loose()
      .default({ parallel: 0 }),
  })
  .loose();

export type GlobalConfig = z.infer<typeof globalConfigSchema>;

export const languageSchema = z
  .object({
    name: z.string(),
    extensions: z.array(z.string()).default([]),
    compile: z.string().optional(),
    run: z.string(),
    polygon: z.string().optional(),
  })
  .loose();

export type Language = z.infer<typeof languageSchema>;
export type LanguagesConfig = Record<string, Language>;

export interface SettingsResponse {
  config: GlobalConfig;
  /** Absolute path of the global directory (~/.taskweave or an existing legacy directory). */
  globalDir: string;
  /** Logical CPUs and the default number of parallel runs (judge.parallel = 0). */
  cpus?: number;
  defaultParallel?: number;
}

export interface LanguagesResponse {
  /** Raw languages.toml text, for editing. */
  text: string;
  languages: LanguagesConfig;
  error?: string;
}

export interface ToolProbe {
  tool: string;
  found: boolean;
  path?: string;
  version?: string;
  /** Result of compiling + running a hello world, where applicable. */
  helloWorld?: 'ok' | 'failed' | 'skipped';
  error?: string;
}

export interface SharedFileEntry {
  /** Reference usable in problem.toml, e.g. `std:ncmp`. Only set for checkers. */
  ref?: string;
  path: string;
  name: string;
  description?: string;
}

export interface SharedListResponse {
  checkers: SharedFileEntry[];
  lemonCheckers: SharedFileEntry[];
  validators: SharedFileEntry[];
  generators: SharedFileEntry[];
}

export interface FileContent {
  path: string;
  content: string;
  /** sha1 of the content on disk. */
  hash: string;
  /** True when the file looked binary and content is empty. */
  binary?: boolean;
  /** True when only the first part of a large file was returned. */
  truncated?: boolean;
  size: number;
}

export interface WriteFileRequest {
  content: string;
  /** If given, the write fails with 409 when the disk hash differs (external change). */
  baseHash?: string;
}

export interface WriteFileResponse {
  hash: string;
}

export interface MoveFileRequest {
  from: string;
  to: string;
}

export type WsEvent =
  | {
      type: 'file:changed';
      problemId: string;
      path: string;
      kind: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
      hash?: string;
    }
  | { type: 'problems:changed' }
  | { type: 'contests:changed' }
  | { type: 'trash:changed' }
  | { type: 'problem:changed'; problemId: string }
  | { type: 'settings:changed' }
  | { type: 'job:progress'; job: JobInfo }
  | { type: 'job:done'; job: JobInfo }
  | { type: 'build:done'; problemId: string; result: CompileResult }
  | { type: 'ai:event'; problemId: string; sessionId: string; event: AiEvent };

export interface ApiError {
  error: string;
  message: string;
}
