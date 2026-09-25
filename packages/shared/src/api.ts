import { z } from 'zod';

export const UI_LOCALES = ['zh-CN', 'en'] as const;
export type UiLocale = (typeof UI_LOCALES)[number];

/** Header carrying the per-launch access token (see DESIGN §8). */
export const TOKEN_HEADER = 'x-polyforge-token';

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
    editor: z
      .object({
        font_size: z.number().int().min(8).max(40).default(14),
        tab_size: z.number().int().min(1).max(8).default(4),
        word_wrap: z.boolean().default(false),
        minimap: z.boolean().default(false),
      })
      .loose()
      .default({ font_size: 14, tab_size: 4, word_wrap: false, minimap: false }),
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
  /** Absolute path of the global directory (~/.polyforge). */
  globalDir: string;
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
  | { type: 'problem:changed'; problemId: string }
  | { type: 'settings:changed' };

export interface ApiError {
  error: string;
  message: string;
}
