import type { ProblemSummary, ProblemToml, ProblemType } from './problem.js';
import type { ContestSummary } from './contest.js';

export interface LuoguExportOptions { time: 'sum' | 'min' | 'max'; memory: 'sum' | 'min' | 'max' }
export function luoguExportOptions(config: ProblemToml): LuoguExportOptions {
  return { time: config.exports?.luogu?.time ?? 'sum', memory: config.exports?.luogu?.memory ?? 'max' };
}
export interface ProblemExportRequest {
  format?: 'polygon' | 'hydro' | 'fps' | 'luogu' | 'joi';
  lang?: string;
  testsets?: string[];
  luogu?: LuoguExportOptions;
}

export const PACKAGE_FORMAT_ORDER = ['polygon', 'hydro', 'fps', 'luogu', 'joi'] as const;
export type ImportPackageFormat = 'auto' | 'polygon-package' | 'hydro-problem' | 'lemonlime' | 'fps' | 'data' | 'joi' | 'luogu-data' | 'hydro-data';
export type DetectedPackageFormat = Exclude<ImportPackageFormat, 'auto'>;
export interface PackageImportOptions {
  format: ImportPackageFormat;
  root?: string;
  folder?: string;
  name?: string;
  /** Selected Hydro directory inside a multi-problem archive. */
  entry?: string;
  lang?: string;
  testset?: string;
  title?: Record<string, string>;
  timeLimit?: number;
  memoryLimit?: number;
}
export interface PackageCandidate {
  entry: string; title: string; name: string;
  files?: number;
  tests?: number;
  size?: number;
  warnings?: string[];
  error?: string;
  timeLimit?: number;
  memoryLimit?: number;
  titles?: Record<string, string>;
}
/** One importable problem of an upload. Each package unit (a problem directory or one FPS file) has its own format. */
export interface PackageItem extends PackageCandidate {
  unit: string;
  format: DetectedPackageFormat;
}
export interface PackageUpload { id: string; items: PackageItem[] }
/** `unit` omitted: the whole upload. */
export interface PackageSelection extends PackageImportOptions { uploadId: string; unit?: string }
/** `rejected`: validation failed and nothing was imported. */
export interface PackageBatchResult { rejected?: boolean; items: { name: string; result?: PackageImportResult; error?: string }[] }
export interface PackageValidation { items: { error?: string }[] }

/** LemonLime packages are imported as whole contests. */
export interface LemonTaskCandidate {
  key: string;
  title: string;
  name: string;
  /** CDF sourceFileName. */
  sourceName: string;
  tests?: number;
  timeLimit?: number;
  memoryLimit?: number;
  warnings?: string[];
  error?: string;
}
export interface LemonContestCandidate {
  /** CDF path inside the upload. */
  entry: string;
  title: string;
  name: string;
  tasks: LemonTaskCandidate[];
  error?: string;
}
export interface ContestPackageUpload { id: string; contests: LemonContestCandidate[] }
export interface ContestPackageTask { key: string; include: boolean; name: string; title: string }
export interface ContestPackageImportRequest {
  uploadId: string;
  entry: string;
  name: string;
  title: Record<string, string>;
  type?: ProblemType;
  /** Contest library folder. */
  folder?: string;
  /** Problem root and library folder for the imported problems. */
  root?: string;
  problemFolder?: string;
  lang?: string;
  tasks: ContestPackageTask[];
}
export interface ContestPackageValidation { errors: string[]; tasks: Record<string, string> }
export interface ContestPackageImportResult { contest: ContestSummary; problems: ProblemSummary[]; warnings: string[] }
export interface PackageImportResult {
  problem: ProblemSummary;
  tests: number;
  extras: string[];
  warnings: string[];
}
