export interface TrashEntry {
  key: string;
  kind: 'problem' | 'contest';
  name: string;
  title: Record<string, string>;
  deletedAt: string;
  originalDir?: string;
  originalRoot?: string;
  originalId?: string;
  size: number;
  /** Older entries have no recorded original root; choose a configured root on restore. */
  legacy?: boolean;
  error?: string;
}

export interface RestoreTrashRequest { root?: string }
