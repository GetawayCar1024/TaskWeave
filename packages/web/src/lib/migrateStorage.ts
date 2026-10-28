import { LEGACY_ID } from '@taskweave/shared';

// Run before API/settings modules read keys, retaining editor tabs, drafts and preferences.
for (const storage of [localStorage, sessionStorage]) {
  for (const key of Object.keys(storage)) {
    if (!key.startsWith(LEGACY_ID)) continue;
    const next = 'taskweave' + key.slice(LEGACY_ID.length);
    if (storage.getItem(next) === null) storage.setItem(next, storage.getItem(key)!);
  }
}
