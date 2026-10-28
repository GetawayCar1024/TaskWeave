import type { ProblemSummary, ProblemToml } from './problem.js';

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
export interface PackageUpload { id: string; format: DetectedPackageFormat; candidates: PackageCandidate[] }
export interface PackageSelection extends PackageImportOptions { uploadId: string }
export interface PackageBatchResult { items: { name: string; result?: PackageImportResult; error?: string }[] }
export interface PackageImportResult {
  problem: ProblemSummary;
  tests: number;
  extras: string[];
  warnings: string[];
}
