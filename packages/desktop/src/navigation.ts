/** Compare parsed origins, never URL prefixes or arbitrary OS protocol handlers. */
export function navigationTarget(value: string, origin: string): 'internal' | 'external' | 'blocked' {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return 'blocked';
    return url.origin === origin ? 'internal' : 'external';
  } catch { return 'blocked'; }
}
