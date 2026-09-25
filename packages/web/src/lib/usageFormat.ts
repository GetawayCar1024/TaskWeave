const SYMBOL: Record<string, string> = { USD: '$', CNY: '¥' };

export const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

export function fmtMoney(v: number, currency = 'USD'): string {
  return `${SYMBOL[currency] ?? currency + ' '}${v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`;
}
