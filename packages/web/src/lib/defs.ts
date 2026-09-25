import { api } from './api';
import type { DefsToml } from './latex';

/** defs.toml is global and rarely changes: fetch once per page load. */
let defs: Promise<DefsToml | null> | null = null;

export function getDefs(): Promise<DefsToml | null> {
  defs ??= api.defs().catch(() => null);
  return defs;
}
