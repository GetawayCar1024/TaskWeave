import type { ProblemSummary, ProblemToml } from './problem.js';

export interface LuoguExportOptions { time: 'sum' | 'min' | 'max'; memory: 'sum' | 'min' | 'max' }
export function luoguExportOptions(config: ProblemToml): LuoguExportOptions {
  return { time: config.exports?.luogu?.time ?? 'sum', memory: config.exports?.luogu?.memory ?? 'max' };
}
export interface ProblemExportRequest {
  format?: 'polygon' | 'hydro' | 'luogu' | 'joi';
  testsets?: string[];
  luogu?: LuoguExportOptions;
}

export const PACKAGE_FORMAT_ORDER = ['polygon', 'hydro', 'luogu', 'joi'] as const;
export type ImportPackageFormat = 'polygon-package' | 'hydro-problem' | 'data' | 'joi' | 'luogu-data' | 'hydro-data';
export interface PackageImportOptions {
  format: ImportPackageFormat;
  root?: string;
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
export interface PackageUpload { id: string; candidates: PackageCandidate[] }
export interface PackageSelection extends PackageImportOptions { uploadId: string }
export interface PackageBatchResult { items: { name: string; result?: PackageImportResult; error?: string }[] }
export interface PackageImportResult {
  problem: ProblemSummary;
  tests: number;
  extras: string[];
  warnings: string[];
}
