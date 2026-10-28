/** Previous on-disk/protocol names are confined here for one-way upgrade readers. */
export const LEGACY_ID = 'polyforge';
export const LEGACY_NAME = 'PolyForge';
export const LEGACY_STATE = `.${LEGACY_ID}`;
export const legacyEnv = (name: string) => `${LEGACY_ID.toUpperCase()}_${name}`;
export const packageFormatIs = (value: unknown, kind: string) => value === `taskweave-${kind}` || value === `${LEGACY_ID}-${kind}`;
