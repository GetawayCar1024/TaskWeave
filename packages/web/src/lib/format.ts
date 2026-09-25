/** Pick the title matching the UI locale, falling back to any non-empty one. */
export function problemTitle(title: Record<string, string>, locale: string): string {
  const pref = locale.startsWith('zh') ? ['zh', 'en'] : ['en', 'zh'];
  for (const k of pref) if (title[k]) return title[k];
  return Object.values(title).find(Boolean) ?? '';
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
