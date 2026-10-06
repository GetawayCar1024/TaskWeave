import type { SolutionTag } from './problem.js';

/** Local tag → Polygon tag. `FL` has no Polygon counterpart and is sent as RJ. */
export const TAG_TO_POLYGON: Record<SolutionTag, string> = {
  MA: 'MA',
  OK: 'OK',
  WA: 'WA',
  TL: 'TL',
  'TL-OR-OK': 'TO',
  TM: 'TM',
  ML: 'ML',
  RE: 'RE',
  PE: 'PE',
  RJ: 'RJ',
  NR: 'NR',
  FL: 'RJ',
};

export const TAG_FROM_POLYGON: Record<string, SolutionTag> = {
  MA: 'MA',
  OK: 'OK',
  WA: 'WA',
  TL: 'TL',
  TO: 'TL-OR-OK',
  TM: 'TM',
  ML: 'ML',
  RE: 'RE',
  PE: 'PE',
  RJ: 'RJ',
  NR: 'NR',
};

/** Statement language directory ↔ Polygon language name (DESIGN §4.5). */
export const LANG_TO_POLYGON: Record<string, string> = { zh: 'chinese', en: 'english', ru: 'russian' };
export const LANG_FROM_POLYGON: Record<string, string> = { chinese: 'zh', english: 'en', russian: 'ru' };

export type SyncItemKind =
  | 'info'
  | 'config'
  | 'groups'
  | 'resource'
  | 'source'
  | 'solution'
  | 'statement'
  | 'statementResource'
  | 'script'
  | 'test'
  | 'sample'
  | 'validatorTest'
  | 'checkerTest'
  | 'testset'
  /** A local file no other item accounts for (pull only: taking it deletes the file). */
  | 'file'
  /** problem.toml as a whole vs. the last sync (information: its fields sync through the other items). */
  | 'toml';

/** Push view: local state vs. what was last synced. */
export type PushStatus = 'new' | 'modified' | 'unchanged' | 'deleted';

/**
 * Pull view (three-way against the last sync):
 * `same` both sides equal · `remote` only Polygon changed · `local` only local changed ·
 * `conflict` both changed · `remote-only`/`local-only` exists on one side only.
 */
export type PullStatus = 'same' | 'remote' | 'local' | 'conflict' | 'remote-only' | 'local-only';

export interface SyncItem {
  key: string;
  kind: SyncItemKind;
  label: string;
  /** Local file (problem-relative) the item corresponds to, if any. */
  path?: string;
  binary?: boolean;
}

export interface PushItem extends SyncItem {
  status: PushStatus;
}

export interface PushPreview {
  polygonId?: number;
  name: string;
  items: PushItem[];
  warnings: string[];
  lastSync?: string;
  /** Polygon revision recorded at the last sync, and the current one. */
  syncedRevision?: number;
  remoteRevision?: number;
}

export interface PushRequest {
  keys: string[];
  commit: boolean;
  message?: string;
  buildPackage: boolean;
  packageType?: 'standard' | 'full';
}

export interface PullItem extends SyncItem {
  status: PullStatus;
  /** Suggested choice: take the Polygon version? */
  takeRemote: boolean;
  /** A three-way merge is possible (text item with a recorded base). */
  mergeable?: boolean;
  /** Conflicting regions a merge would leave (0 = merges cleanly). */
  mergeConflicts?: number;
}

export interface PullPreview {
  polygonId: number;
  items: PullItem[];
  warnings: string[];
}

export interface PullRequest {
  /** Keys whose Polygon version should overwrite the local one. */
  take: string[];
  /** Keys to three-way merge (local + Polygon changes against the last sync). */
  merge?: string[];
}

export interface ItemContent {
  key: string;
  local: string | null;
  remote: string | null;
  binary?: boolean;
  /** Three-way merge result, when a base is known. */
  merged?: string;
  mergeConflicts?: number;
  /** `remote` is the version of the last sync, not Polygon's (the problem.toml row). */
  remoteIsLastSync?: boolean;
}

export interface ImportRequest {
  polygonId: number;
  /** Local folder name; defaults to the Polygon short name. */
  name?: string;
  root?: string;
}

export interface PolygonProblem {
  id: number;
  name: string;
  owner: string;
  accessType?: string;
  revision?: number;
  modified?: boolean;
}

export interface SecretsResponse {
  polygon: {
    /** Masked key, e.g. "ab12…ef". */
    key: string;
    hasKey: boolean;
    hasSecret: boolean;
    apiUrl: string;
  };
}

export interface SaveSecretsRequest {
  polygon: {
    /** Omitted or empty keeps the stored value. */
    key?: string;
    secret?: string;
    apiUrl?: string;
  };
}
