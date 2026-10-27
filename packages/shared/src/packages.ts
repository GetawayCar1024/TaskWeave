import type { ProblemSummary, ProblemToml } from './problem.js';

export interface LuoguExportOptions { time: 'sum' | 'min' | 'max'; memory: 'sum' | 'min' | 'max' }
export function luoguExportOptions(config: ProblemToml): LuoguExportOptions {
  return { time: config.exports?.luogu?.time ?? 'sum', memory: config.exports?.luogu?.memory ?? 'max' };
}
export interface ProblemExportRequest {
  format?: 'polygon' | 'luogu' | 'hydro';
  testsets?: string[];
  luogu?: LuoguExportOptions;
}

export type ImportPackageFormat = 'luogu-data' | 'hydro-data' | 'hydro-problem';
export interface PackageImportOptions {
  format: ImportPackageFormat;
  root?: string;
  name?: string;
  /** Selected Hydro directory inside a multi-problem archive. */
  entry?: string;
  lang?: string;
  testset?: string;
}
export interface PackageCandidate {
  entry: string; title: string; name: string;
  files?: number;
  tests?: number;
  size?: number;
  warnings?: string[];
  error?: string;
}
export interface PackageImportResult {
  problem: ProblemSummary;
  tests: number;
  extras: string[];
  warnings: string[];
}
