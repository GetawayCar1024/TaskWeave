/** Token counts of one or more model requests. */
export interface AiUsage {
  requests: number;
  /** Uncached input tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const emptyUsage = (): AiUsage => ({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export function addUsage(a: AiUsage, b: Partial<AiUsage>): AiUsage {
  return {
    requests: a.requests + (b.requests ?? 0),
    input: a.input + (b.input ?? 0),
    output: a.output + (b.output ?? 0),
    cacheRead: a.cacheRead + (b.cacheRead ?? 0),
    cacheWrite: a.cacheWrite + (b.cacheWrite ?? 0),
  };
}

/**
 * Price of a model, per million tokens, in the endpoint's currency. Cache prices are
 * optional: Anthropic bills cache reads at 0.1× and 5-minute cache writes at 1.25× the
 * input price; other protocols default to the input price.
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export const CURRENCIES = ['USD', 'CNY'] as const;
export type Currency = (typeof CURRENCIES)[number];

export interface EndpointPricing {
  currency: Currency;
  /** By model id; the key "*" applies to models without their own entry. */
  prices: Record<string, ModelPrice>;
}

export function priceFor(pricing: EndpointPricing | undefined, model: string): ModelPrice | undefined {
  return pricing?.prices[model] ?? pricing?.prices['*'];
}

/** Cost of the usage, or undefined when no price is configured. */
export function usageCost(u: AiUsage, price: ModelPrice | undefined, protocol: string): number | undefined {
  if (!price) return undefined;
  const anthropic = protocol === 'anthropic';
  const read = price.cacheRead ?? (anthropic ? price.input * 0.1 : price.input);
  const write = price.cacheWrite ?? (anthropic ? price.input * 1.25 : price.input);
  return (u.input * price.input + u.output * price.output + u.cacheRead * read + u.cacheWrite * write) / 1e6;
}

/** One line of the usage log (one model request). */
export interface UsageRecord {
  at: string;
  endpoint: string;
  protocol: string;
  model: string;
  problem: string;
  session: string;
  usage: AiUsage;
}

export interface UsageGroup {
  key: string;
  usage: AiUsage;
  /** By currency; empty when no price applies. */
  cost: Partial<Record<Currency, number>>;
  /** Some requests had no price. */
  unpriced: boolean;
}

export interface UsageStats {
  today: UsageGroup;
  month: UsageGroup;
  all: UsageGroup;
  byModel: UsageGroup[];
  byProblem: UsageGroup[];
}
