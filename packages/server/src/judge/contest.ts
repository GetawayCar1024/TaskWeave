import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  LANG_TO_POLYGON,
  STATEMENT_SECTIONS,
  testsetsOf,
  type ContestBatchItem,
  type ContestBatchRequest,
  type ContestBatchResult,
  type ContestImportRequest,
  type ContestStatement,
  type ContestSummary,
  type PolygonProblem,
} from '@polyforge/shared';
import type { JobCtx } from '../jobs.js';
import type { PolygonSync } from '../polygon/sync.js';
import { atomicWrite } from '../util/fs.js';
import { ZipWriter } from '../util/zip.js';
import type { ContestRegistry, ContestRef } from '../workspace/contests.js';
import { localChecks } from './checks.js';
import type { Judge, ProblemCtx } from './index.js';
import { readInvocation, runInvocation } from './invocation.js';
import { exportPackage } from './package.js';
import { answerPath, generateTests, inputPath, readManifest } from './tests.js';

export const contestExportDir = (ref: ContestRef) => path.join(ref.dir, '.polyforge', 'export');

const SAMPLE_LIMIT = 64 * 1024;
const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export interface ContestDeps {
  judge: Judge;
  contests: ContestRegistry;
  sync: PolygonSync;
}

/** Run one action over the contest's problems, one after another; failures are per problem. */
export async function runContestBatch(deps: ContestDeps, contestId: string, req: ContestBatchRequest, job: JobCtx): Promise<ContestBatchResult> {
  const { judge, contests, sync } = deps;
  const { ref, config } = await contests.config(contestId);
  const want = req.indices?.length ? new Set(req.indices) : null;
  const list = config.problems.filter((p) => !want || want.has(p.index));
  const items: ContestBatchItem[] = [];
  const zip = req.action === 'export' ? new ZipWriter() : null;
  const exported: { index: string; name: string }[] = [];

  for (const [i, p] of list.entries()) {
    job.signal.throwIfAborted();
    const sub: JobCtx = {
      signal: job.signal,
      progress: (_d, _t, m) => job.progress(i, list.length, `${p.index} · ${p.problem}${m ? ` · ${m}` : ''}`),
    };
    sub.progress(0, 0);
    const item: ContestBatchItem = { index: p.index, problem: p.problem, ok: false, message: '' };
    items.push(item);
    let ctx: ProblemCtx;
    try {
      ctx = await judge.ctx(p.problem);
    } catch (e) {
      item.message = (e as Error).message;
      continue;
    }
    try {
      switch (req.action) {
        case 'generate': {
          const sets = testsetsOf(ctx.config);
          const label = (ts: string, s: string) => (sets.length > 1 ? `${ts}: ${s}` : s);
          const parts: string[] = [];
          item.ok = true;
          item.details = [];
          for (const ts of sets) {
            const m = await generateTests(judge, ctx, sub, ts.name);
            item.ok &&= m.ok && m.tests.length > 0;
            parts.push(label(ts.name, plural(m.tests.length, 'test') + (m.errors.length ? `, ${plural(m.errors.length, 'error')}` : '')));
            item.details.push(...m.errors.slice(0, 20).map((e) => label(ts.name, e)));
          }
          item.message = parts.join('; ');
          break;
        }
        case 'invocation': {
          const sources = ctx.config.solutions.filter((s) => s.tag !== 'NR').map((s) => s.source);
          if (!sources.length) {
            item.message = 'no solutions';
            break;
          }
          const id = await runInvocation(judge, ctx, sources, undefined, sub, () => {});
          const inv = await readInvocation(ctx, id);
          const bad = inv.solutions.filter((s) => s.compile?.ok === false || s.expectation?.ok === false);
          item.ok = !bad.length && !inv.error && inv.status === 'done';
          item.message = item.ok ? `${sources.length} × ${plural(inv.tests.length, 'test')}` : inv.error ? inv.error.split('\n')[0] : `${plural(bad.length, 'solution')} not as tagged`;
          item.details = bad.map((s) => {
            const name = path.posix.basename(s.source);
            if (s.compile?.ok === false) return `${name}: compilation error`;
            const e = s.expectation!;
            const parts = [e.unexpected.length ? `unexpected on tests ${e.unexpected.map((t) => inv.tests[t]).slice(0, 10).join(', ')}` : '', e.missing?.length ? `never got ${e.missing.join('/')}` : ''];
            return `${name} [${s.tag}]: ${parts.filter(Boolean).join('; ')}`;
          });
          break;
        }
        case 'checks': {
          const checks = await localChecks(judge, ctx);
          const errors = checks.filter((c) => c.level === 'error').length;
          const warnings = checks.filter((c) => c.level === 'warning').length;
          item.ok = errors === 0;
          item.message = errors || warnings ? [errors && plural(errors, 'error'), warnings && plural(warnings, 'warning')].filter(Boolean).join(', ') : 'no issues';
          item.details = checks.filter((c) => c.level !== 'info').map((c) => `${c.level}: ${c.message}${c.file ? ` (${c.file})` : ''}`);
          break;
        }
        case 'export': {
          const name = ctx.config.problem.name;
          const r = await exportPackage(judge, ctx, sub, { zip: zip!, prefix: `problems/${name}/` });
          exported.push({ index: p.index, name });
          item.ok = true;
          item.message = plural(r.tests, 'test');
          item.details = r.warnings;
          break;
        }
        case 'polygon-push': {
          const preview = await sync.pushPreview(ctx);
          if (preview.syncedRevision !== undefined && preview.remoteRevision !== undefined && preview.remoteRevision !== preview.syncedRevision) {
            item.message = `changed on Polygon (revision ${preview.remoteRevision}); pull it first`;
            break;
          }
          const keys = preview.items.filter((it) => it.status !== 'unchanged').map((it) => it.key);
          if (!keys.length && preview.polygonId !== undefined) {
            item.ok = true;
            item.message = 'up to date';
            break;
          }
          const r = await sync.push(ctx, { keys, commit: true, message: req.message, buildPackage: false }, sub);
          item.ok = true;
          item.message = `${plural(r.pushed.length, 'item')} → #${r.polygonId}${r.revision !== undefined ? ` r${r.revision}` : ''}`;
          item.details = r.warnings;
          break;
        }
      }
    } catch (e) {
      if (job.signal.aborted) throw e;
      item.ok = false;
      item.message = (e as Error).message.split('\n')[0];
    }
  }

  const result: ContestBatchResult = { action: req.action, items };
  if (zip) {
    job.progress(list.length, list.length, 'writing');
    zip.add('contest.xml', contestXml(config.contest.title, config.contest.name, exported));
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
    const file = `${config.contest.name}-${stamp}.zip`;
    const data = zip.finish();
    await atomicWrite(path.join(contestExportDir(ref), file), data);
    result.file = file;
    result.size = data.length;
  }
  job.progress(list.length, list.length, 'done');
  return result;
}

function contestXml(title: Record<string, string>, name: string, problems: { index: string; name: string }[]): string {
  const names = Object.entries(title)
    .filter(([, v]) => v)
    .map(([lang, v]) => `<name language="${x(LANG_TO_POLYGON[lang] ?? lang)}" value="${x(v)}"/>`);
  if (!names.length) names.push(`<name language="english" value="${x(name)}"/>`);
  return `<?xml version="1.0" encoding="utf-8" standalone="no"?>
<contest>
  <names>${names.join('')}</names>
  <problems>${problems.map((p) => `<problem index="${x(p.index.toLowerCase())}" path="problems/${x(p.name)}"/>`).join('')}</problems>
</contest>
`;
}

/** Statement sources of every problem in one language, for the combined / print view. */
export async function contestStatements(judge: Judge, contests: ContestRegistry, contestId: string, lang: string): Promise<ContestStatement[]> {
  const { config } = await contests.config(contestId);
  const out: ContestStatement[] = [];
  for (const p of config.problems) {
    let ctx: ProblemCtx;
    try {
      ctx = await judge.ctx(p.problem);
    } catch {
      out.push({ index: p.index, problem: p.problem, title: p.problem, timeLimit: 0, memoryLimit: 0, interactive: false, input: 'stdin', output: 'stdout', sections: {}, samples: [] });
      continue;
    }
    const c = ctx.config;
    const sections: Record<string, string> = {};
    for (const s of STATEMENT_SECTIONS) {
      const text = await fsp.readFile(path.join(ctx.ref.dir, 'statement', lang, `${s}.tex`), 'utf8').catch(() => '');
      if (text.trim()) sections[s] = text;
    }
    const manifest = await readManifest(ctx);
    const samples: ContestStatement['samples'] = [];
    for (const t of manifest?.tests.filter((t) => t.sample) ?? []) {
      const read = (f: string) =>
        fsp
          .readFile(f)
          .then((b) => b.subarray(0, SAMPLE_LIMIT).toString('utf8'))
          .catch(() => '');
      samples.push({ input: await read(inputPath(ctx, t.index)), output: await read(answerPath(ctx, t.index)) });
    }
    out.push({
      index: p.index,
      problem: p.problem,
      title: c.problem.title[lang] || c.problem.title.en || c.problem.name,
      timeLimit: c.problem.time_limit,
      memoryLimit: c.problem.memory_limit,
      interactive: c.problem.interactive,
      input: c.problem.input,
      output: c.problem.output,
      sections,
      samples,
    });
  }
  return out;
}

/**
 * Import a Polygon contest: each problem is imported (or reused when a local problem is
 * already bound to it), then contest.toml is written with the Polygon letters.
 */
export async function importContest(deps: ContestDeps, req: ContestImportRequest, job: JobCtx): Promise<{ contest: ContestSummary; warnings: string[] }> {
  const { judge, contests, sync } = deps;
  const name = req.name?.trim() ?? '';
  await contests.checkNew(name, req.root);
  const client = await sync.client();
  job.progress(0, 0, 'contest.problems');
  const map = await client.call<Record<string, PolygonProblem>>('contest.problems', { contestId: req.contestId });
  const entries = Object.entries(map).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }));
  const local = await judge.registry.list();
  const warnings: string[] = [];
  const problems: { index: string; problem: string }[] = [];
  for (const [i, [index, p]] of entries.entries()) {
    job.signal.throwIfAborted();
    const letter = index.toUpperCase();
    job.progress(i, entries.length, `${letter} · ${p.name}`);
    const bound = local.find((l) => l.status.polygonId === p.id);
    if (bound) {
      problems.push({ index: letter, problem: bound.id });
      continue;
    }
    try {
      const sub: JobCtx = { signal: job.signal, progress: (_d, _t, m) => job.progress(i, entries.length, `${letter} · ${p.name}${m ? ` · ${m}` : ''}`) };
      const s = await sync.importProblem({ polygonId: p.id, root: req.root }, sub);
      problems.push({ index: letter, problem: s.id });
    } catch (e) {
      if (job.signal.aborted) throw e;
      warnings.push(`${letter} (${p.name}, #${p.id}): ${(e as Error).message}`);
    }
  }
  const contest = await contests.create({ name, root: req.root, problems });
  await contests.update(contest.id, { polygonId: req.contestId });
  job.progress(entries.length, entries.length, 'done');
  return { contest: { ...contest, polygonId: req.contestId }, warnings };
}
