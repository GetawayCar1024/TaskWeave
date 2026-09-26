import type {
  ContestPullPreview,
  ContestPullRequest,
  ContestPullResult,
  ContestSyncRow,
  ContestSyncStatus,
  PolygonProblem,
} from '@polyforge/shared';
import type { JobCtx } from '../jobs.js';
import type { Judge } from '../judge/index.js';
import { HttpError } from '../util/fs.js';
import type { ContestRegistry } from '../workspace/contests.js';
import type { PolygonSync } from './sync.js';

interface Deps {
  judge: Judge;
  contests: ContestRegistry;
  sync: PolygonSync;
}

/**
 * Where every problem of a contest stands against Polygon, from one `problems.list`
 * (the current revision of every problem) and, for a bound contest, one
 * `contest.problems` (letters and membership). Local changes need no request.
 */
export async function contestSyncStatus(deps: Deps, contestId: string): Promise<ContestSyncStatus> {
  const { judge, contests, sync } = deps;
  const { config } = await contests.config(contestId);
  const detail = await contests.detail(contestId);
  const polygonContest = detail.summary.polygonId;
  const client = await sync.client();
  const warnings: string[] = [];
  const revisions = new Map<number, number | undefined>();
  const uncommitted = new Set<number>();
  for (const p of await client.call<PolygonProblem[]>('problems.list', {})) {
    revisions.set(p.id, p.revision);
    if (p.modified) uncommitted.add(p.id);
  }
  let remote: Record<string, PolygonProblem> | null = null;
  if (polygonContest !== undefined) {
    remote = await client.call<Record<string, PolygonProblem>>('contest.problems', { contestId: polygonContest }).catch((e: Error) => {
      warnings.push(`Polygon contest #${polygonContest}: ${e.message}`);
      return null;
    });
  }
  const remoteByProblem = new Map(Object.entries(remote ?? {}).map(([idx, p]) => [p.id, idx.toUpperCase()]));

  const rows: ContestSyncRow[] = [];
  for (const p of config.problems) {
    const ctx = await judge.ctx(p.problem).catch(() => null);
    if (!ctx) {
      rows.push({ index: p.index, problem: p.problem, state: 'missing', localChanges: 0 });
      continue;
    }
    const polygonId = ctx.config.polygon.id;
    const local = await sync.localStatus(ctx);
    const row: ContestSyncRow = { index: p.index, problem: p.problem, polygonId, state: 'unbound', localChanges: local.changes, tomlChanged: local.tomlChanged || undefined, syncedRevision: local.syncedRevision };
    if (polygonId !== undefined) {
      if (!revisions.has(polygonId)) row.state = 'unreachable';
      else {
        row.remoteRevision = revisions.get(polygonId);
        row.remoteUncommitted = uncommitted.has(polygonId) || undefined;
        // A new revision, uncommitted edits newer than the last sync (Polygon counts
        // revisions on commit only), or never synced.
        const newUncommitted = uncommitted.has(polygonId) && !(local.syncedUncommitted && row.remoteRevision === row.syncedRevision);
        const remoteChanged = row.syncedRevision === undefined || row.remoteRevision !== row.syncedRevision || newUncommitted;
        const localChanged = local.changes > 0;
        row.state = remoteChanged ? (localChanged ? 'both' : 'remote') : localChanged ? 'local' : 'same';
      }
      if (remote) {
        const idx = remoteByProblem.get(polygonId);
        if (idx === undefined) row.notInPolygonContest = true;
        else if (idx !== p.index.toUpperCase()) row.polygonIndex = idx;
      }
    }
    rows.push(row);
  }

  const inContest = new Set(rows.map((r) => r.polygonId).filter((x) => x !== undefined));
  const all = remote ? await judge.registry.list() : [];
  const remoteOnly = Object.entries(remote ?? {})
    .filter(([, p]) => !inContest.has(p.id))
    .map(([idx, p]) => ({ index: idx.toUpperCase(), polygonId: p.id, name: p.name, localProblem: all.find((l) => l.status.polygonId === p.id)?.id }))
    .sort((a, b) => a.index.localeCompare(b.index, 'en', { numeric: true }));
  return { polygonId: polygonContest, rows, remoteOnly, warnings };
}

/**
 * Fetch Polygon's state of the given problems (those changed there) and list what a
 * pull would take. Problems with conflicts are left to their own sync dialog: a pull
 * records Polygon's state as the base, which would hide the conflict.
 */
export async function contestPullPreview(deps: Deps, contestId: string, problems: string[], job: JobCtx): Promise<ContestPullPreview> {
  const { judge, contests, sync } = deps;
  const { config } = await contests.config(contestId);
  const list = config.problems.filter((p) => problems.includes(p.problem));
  const out: ContestPullPreview = { problems: [] };
  for (const [i, p] of list.entries()) {
    job.signal.throwIfAborted();
    job.progress(i, list.length, `${p.index} · ${p.problem}`);
    try {
      const pre = await sync.pullPreview(await judge.ctx(p.problem));
      out.problems.push({
        index: p.index,
        problem: p.problem,
        items: pre.items
          .filter((it) => it.kind !== 'toml' && (it.status === 'remote' || it.status === 'remote-only' || it.status === 'local-only'))
          .map((it) => ({ key: it.key, label: it.label, status: it.status, take: it.takeRemote })),
        conflicts: pre.items.filter((it) => it.status === 'conflict').map((it) => it.label),
      });
    } catch (e) {
      if (job.signal.aborted) throw e;
      out.problems.push({ index: p.index, problem: p.problem, items: [], conflicts: [], error: (e as Error).message.split('\n')[0] });
    }
  }
  job.progress(list.length, list.length, 'done');
  return out;
}

/** Apply the confirmed items, problem by problem (after contestPullPreview). */
export async function contestPull(deps: Deps, contestId: string, req: ContestPullRequest, job: JobCtx): Promise<ContestPullResult> {
  const { judge, contests, sync } = deps;
  const { config } = await contests.config(contestId);
  const out: ContestPullResult = { problems: [] };
  const todo = req.problems.filter((x) => config.problems.some((p) => p.problem === x.problem));
  if (!todo.length) throw new HttpError(400, 'bad_request', 'No problems of this contest to pull');
  for (const [i, x] of todo.entries()) {
    job.signal.throwIfAborted();
    const index = config.problems.find((p) => p.problem === x.problem)!.index;
    job.progress(i, todo.length, `${index} · ${x.problem}`);
    try {
      const ctx = await judge.ctx(x.problem);
      const r = await sync.pull(ctx, { take: x.take });
      out.problems.push({ problem: x.problem, index, applied: r.applied.length + r.merged.length, warnings: r.warnings });
    } catch (e) {
      if (job.signal.aborted) throw e;
      out.problems.push({ problem: x.problem, index, applied: 0, warnings: [], error: (e as Error).message.split('\n')[0] });
    }
  }
  job.progress(todo.length, todo.length, 'done');
  return out;
}
