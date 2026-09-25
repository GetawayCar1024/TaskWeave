import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { addUsage, emptyUsage, priceFor, usageCost, type Currency, type UsageGroup, type UsageRecord, type UsageStats } from '@polyforge/shared';
import type { GlobalStore, RawAiEndpoint } from '../global.js';

/**
 * Token usage of every model request, one JSON line each, in the global cache. Costs
 * are computed when read, from the prices currently configured for each endpoint, so
 * fixing a price also fixes the history.
 */
export class UsageLog {
  private file: string;
  private writing: Promise<void> = Promise.resolve();

  constructor(private global: GlobalStore) {
    this.file = path.join(global.cacheDir, 'ai-usage.jsonl');
  }

  append(r: UsageRecord): Promise<void> {
    this.writing = this.writing.then(async () => {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      await fsp.appendFile(this.file, JSON.stringify(r) + '\n');
    });
    return this.writing;
  }

  async records(): Promise<UsageRecord[]> {
    const text = await fsp.readFile(this.file, 'utf8').catch(() => '');
    const out: UsageRecord[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as UsageRecord);
      } catch {
        /* skip a torn line */
      }
    }
    return out;
  }

  async clear(): Promise<void> {
    await this.writing;
    await fsp.rm(this.file, { force: true });
  }

  async stats(now = new Date()): Promise<UsageStats> {
    const [records, endpoints] = await Promise.all([this.records(), this.global.aiEndpointsRaw()]);
    const byName = new Map(endpoints.map((e) => [e.name, e]));
    const group = (key: string): UsageGroup => ({ key, usage: emptyUsage(), cost: {}, unpriced: false });
    const add = (g: UsageGroup, r: UsageRecord) => {
      g.usage = addUsage(g.usage, r.usage);
      const c = recordCost(r, byName.get(r.endpoint));
      if (c) g.cost[c.currency] = (g.cost[c.currency] ?? 0) + c.cost;
      else g.unpriced = true;
    };
    const day = localDay(now);
    const month = day.slice(0, 7);
    const today = group('today');
    const thisMonth = group('month');
    const all = group('all');
    const byModel = new Map<string, UsageGroup>();
    const byProblem = new Map<string, UsageGroup>();
    for (const r of records) {
      const d = localDay(new Date(r.at));
      add(all, r);
      if (d.startsWith(month)) add(thisMonth, r);
      if (d === day) add(today, r);
      const mk = `${r.endpoint} · ${r.model}`;
      if (!byModel.has(mk)) byModel.set(mk, group(mk));
      add(byModel.get(mk)!, r);
      if (!byProblem.has(r.problem)) byProblem.set(r.problem, group(r.problem));
      add(byProblem.get(r.problem)!, r);
    }
    const sorted = (m: Map<string, UsageGroup>) => [...m.values()].sort((a, b) => b.usage.requests - a.usage.requests);
    return { today, month: thisMonth, all, byModel: sorted(byModel), byProblem: sorted(byProblem) };
  }
}

export function recordCost(r: Pick<UsageRecord, 'usage' | 'model' | 'protocol'>, ep: RawAiEndpoint | undefined): { cost: number; currency: Currency } | undefined {
  const price = priceFor(ep?.pricing, r.model);
  const cost = usageCost(r.usage, price, r.protocol);
  return cost === undefined ? undefined : { cost, currency: ep!.pricing!.currency };
}

const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
