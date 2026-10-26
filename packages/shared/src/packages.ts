import type { ProblemSummary } from './problem.js';

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
export interface PackageCandidate { entry: string; title: string; name: string }
export interface PackageImportResult {
  problem: ProblemSummary;
  tests: number;
  extras: string[];
  warnings: string[];
}
