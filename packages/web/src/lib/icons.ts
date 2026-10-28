import type { Component } from 'vue';
import {
  BookOpen,
  ChartColumn,
  FileText,
  FlaskConical,
  Folder,
  Hammer,
  Library,
  Lightbulb,
  ListChecks,
  Package,
  Pencil,
  Play,
  Puzzle,
  Repeat,
  Scale,
  Search,
  Settings,
  ShieldCheck,
  TestTubeDiagonal,
  Trash2,
  Wrench,
} from 'lucide-vue-next';
import type { FileRole } from '@taskweave/shared';

/** One icon per file role (sidebar groups). */
export const ROLE_ICONS: Record<FileRole, Component> = {
  config: Settings,
  statement: FileText,
  tutorial: BookOpen,
  validator: ShieldCheck,
  checker: Scale,
  interactor: Repeat,
  generator: Puzzle,
  solution: Lightbulb,
  test: FlaskConical,
  'validator-test': TestTubeDiagonal,
  'checker-test': TestTubeDiagonal,
  resource: Package,
  other: Folder,
};

/** Icons for agent tool calls. */
export const TOOL_ICONS: Record<string, Component> = {
  list_files: Folder,
  read_file: BookOpen,
  write_file: Pencil,
  edit_file: Pencil,
  delete_file: Trash2,
  list_shared: Library,
  read_shared: Library,
  compile: Hammer,
  run: Play,
  generate_tests: FlaskConical,
  view_test: Search,
  run_invocation: ChartColumn,
  run_validator_tests: ShieldCheck,
  run_checker_tests: Scale,
  update_plan: ListChecks,
  report_issue: Search,
};

export const FALLBACK_TOOL_ICON = Wrench;
