import { promises as fsp } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  LANG_TO_POLYGON,
  contestTomlSchema,
  groupLayout,
  judgeMode,
  OI_SECTIONS,
  parseIndexList,
  PROBLEM_NAME_RE,
  sourceName,
  STATEMENT_SECTIONS,
  testsetsOf,
  type ProblemToml,
  type ContestBatchItem,
  type ContestBatchRequest,
  type ContestBatchResult,
  type ContestImportRequest,
  type ContestStatement,
  type ContestSummary,
  type PolygonProblem,
  type ContestDetail,
} from '@taskweave/shared';
import type { JobCtx } from '../jobs.js';
import type { PolygonSync } from '../polygon/sync.js';
import { atomicWrite, exists, safeJoin, HttpError } from '../util/fs.js';
import { ZipWriter } from '../util/zip.js';
import type { ContestRegistry, ContestRef } from '../workspace/contests.js';
import { localChecks } from './checks.js';
import { requireFullProblem, type Judge, type ProblemCtx } from './index.js';
import { readInvocation, runInvocation } from './invocation.js';
import { exportPackage } from './package.js';
import { readSamples } from './samples.js';
import { addLemonBuildScripts, addLemonProblem, exportTestsets, lemonHost, lemonReadme, preflightLemonChecker, type LemonCheckerBuild } from './lemonlime.js';
import { luoguContestReadme } from './luogu.js';
import { buildProblemDataPackage, requireLuoguOptions } from './problemExport.js';
import { fpsDocument, fpsItem } from './fps.js';
import { generateTests, readManifest } from './tests.js';
import { readStatementSections } from '../workspace/statements.js';

export const contestExportDir = (ref: ContestRef) => path.join(ref.dir, '.taskweave', 'export');

const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export interface ContestDeps {
  judge: Judge;
  contests: ContestRegistry;
  sync: PolygonSync;
  afterImport?: () => Promise<void>;
}

/** Run one action over the contest's problems, one after another; failures are per problem. */
export async function runContestBatch(deps: ContestDeps, contestId: string, req: ContestBatchRequest, job: JobCtx): Promise<ContestBatchResult> {
  const { judge, contests, sync } = deps;
  const { ref, config } = await contests.config(contestId);
  if (req.exportFormat && !['polygon', 'hydro', 'fps', 'luogu', 'joi', 'lemonlime'].includes(req.exportFormat)) throw new HttpError(400, 'bad_request', 'Unknown export format');
  const lemon = req.action === 'export' && req.exportFormat === 'lemonlime';
  const lemonTarget = req.lemon?.target ?? lemonHost();
  if (!['windows', 'linux'].includes(lemonTarget)) throw new HttpError(400, 'bad_request', 'Lemon target must be windows or linux.');
  const luogu = req.action === 'export' && req.exportFormat === 'luogu';
  const hydro = req.action === 'export' && req.exportFormat === 'hydro';
  const fps = req.action === 'export' && req.exportFormat === 'fps';
  const fpsItems: string[] = [];
  const joi = req.action === 'export' && req.exportFormat === 'joi';
  if (luogu) {
    if (req.luogu) requireLuoguOptions(req.luogu);
    if (req.luoguByProblem !== undefined && (!req.luoguByProblem || typeof req.luoguByProblem !== 'object' || Array.isArray(req.luoguByProblem))) throw new HttpError(400, 'bad_request', 'Invalid per-problem Luogu options');
    for (const value of Object.values(req.luoguByProblem ?? {})) requireLuoguOptions(value);
  }
  if (req.testsets !== undefined && (typeof req.testsets !== 'object' || Object.values(req.testsets).some(v => !Array.isArray(v) || v.some(s => typeof s !== 'string')))) throw new HttpError(400, 'bad_request', 'testsets must map problem ids to testset names');
  if (luogu && !PROBLEM_NAME_RE.test(config.contest.name)) throw new HttpError(400, 'invalid_name', 'Invalid contest name.');
  if (lemon && !PROBLEM_NAME_RE.test(config.contest.name)) throw new HttpError(400, 'invalid_name', 'Invalid contest name.');
  const want = req.indices?.length ? new Set(req.indices) : null;
  const list = config.problems.filter((p) => !want || want.has(p.index));
  const items: ContestBatchItem[] = [];
  const zip = req.action === 'export' ? new ZipWriter({ async: true }) : null;
  const exported: { index: string; name: string }[] = [];
  const lemonTasks: Awaited<ReturnType<typeof addLemonProblem>>['task'][] = [];
  const lemonBuilds: LemonCheckerBuild[] = [];
  if ((lemon || luogu || hydro || joi || fps) && !list.length) throw new HttpError(400, 'empty_contest', 'No problems to export.');
  if (luogu || hydro || joi) {
    const names = new Set<string>();
    for (const p of list) {
      const ctx = await judge.ctx(p.problem);
      const name = ctx.config.problem.name.toLowerCase();
      if (names.has(name)) throw new HttpError(400, 'luogu_export', `${p.index}: duplicate problem English name: ${name}`);
      names.add(name);
      exportTestsets(ctx, p.index, req.testsets?.[p.problem]);
    }
  }
  if (lemon) {
    const errors: string[] = [], names = new Set<string>();
    for (const p of list) {
      job.signal.throwIfAborted();
      job.progress(0, list.length, `${p.index} · checking Lemon checker`);
      try {
        const ctx = await judge.ctx(p.problem);
        // Data folders and contestant files are case-insensitive on Windows.
        const name = sourceName(ctx.config.problem);
        if (names.has(name.toLowerCase())) throw new Error(`${p.index}: duplicate source file name: ${name}`);
        names.add(name.toLowerCase());
        exportTestsets(ctx, p.index, req.testsets?.[p.problem]);
        await preflightLemonChecker(judge, ctx, p.index, lemonTarget);
      } catch (e) { errors.push((e as Error).message); }
    }
    if (errors.length) throw new HttpError(400, 'lemonlime_export', `LemonLime preflight failed; no tests were generated.\n${errors.join('\n')}`);
  }

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
          requireFullProblem(ctx);
          const sources = ctx.config.solutions.filter((s) => s.tag !== 'NR').map((s) => s.source);
          if (!sources.length) {
            item.message = 'no solutions';
            break;
          }
          const id = await runInvocation(judge, ctx, sources, undefined, sub, () => {});
          const inv = await readInvocation(ctx, id);
          item.invocationId = id;
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
          item.checks = checks.filter((c) => c.level !== 'info');
          item.details = checks.filter((c) => c.level !== 'info').map((c) => `${c.level}: ${c.message}${c.file ? ` (${c.file})` : ''}`);
          break;
        }
        case 'export': {
          if (fps) {
            const result = await fpsItem(judge, ctx, sub, { testsets: req.testsets?.[p.problem], lang: req.lang });
            fpsItems.push(result.xml); item.ok = true; item.message = plural(result.tests, 'test'); item.details = result.warnings;
            break;
          }
          if (lemon) {
            const r = await addLemonProblem(judge, ctx, p.index, zip!, sub, exportTestsets(ctx, p.index, req.testsets?.[p.problem]), req.lemon?.subfolders === true, lemonTarget);
            lemonTasks.push(r.task);
            if (r.checkerBuild) lemonBuilds.push(r.checkerBuild);
            item.ok = true;
            item.message = plural(r.tests, 'test');
            break;
          }
          if (luogu || hydro || joi) {
            const r = await buildProblemDataPackage(judge, ctx, luogu ? 'luogu' : hydro ? 'hydro' : 'joi', sub, { testsets: req.testsets?.[p.problem], luogu: req.luoguByProblem?.[p.problem] ?? req.luogu });
            zip!.add(`${ctx.config.problem.name}/${r.filename}`, r.data);
            if (r.readme) zip!.add(`${ctx.config.problem.name}/README.txt`, r.readme);
            item.ok = true;
            item.message = plural(r.tests, 'test');
            item.details = r.warnings;
            break;
          }
          const name = ctx.config.problem.name;
          const r = await exportPackage(judge, ctx, sub, { zip: zip!, prefix: `problems/${name}/` }, req.exportFormat === 'polygon');
          exported.push({ index: p.index, name });
          item.ok = true;
          item.message = plural(r.tests, 'test');
          item.details = r.warnings;
          break;
        }
        case 'polygon-push': {
          const preview = await sync.pushPreview(ctx);
          if (preview.blocked) { item.message = preview.warnings.join('\n'); item.details = preview.warnings; break; }
          if (preview.syncedRevision !== undefined && preview.remoteRevision !== undefined && preview.remoteRevision !== preview.syncedRevision) {
            item.message = `changed on Polygon (revision ${preview.remoteRevision}); pull it first`;
            break;
          }
          const keys = preview.items.filter((it) => it.status !== 'unchanged' && it.kind !== 'toml').map((it) => it.key);
          if (!keys.length && preview.polygonId !== undefined && !req.buildPackage) {
            item.ok = true;
            item.message = 'up to date';
            break;
          }
          const r = await sync.push(ctx, { keys, commit: req.commit !== false, message: req.message, buildPackage: !!req.buildPackage, packageType: req.packageType }, sub);
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
      item.details = (e as Error).message.split('\n').slice(1);
    }
  }

  const result: ContestBatchResult = { action: req.action, items };
  if (zip) {
    const failed = () => items.filter(item => !item.ok).map(item => `${item.index}: ${item.message}\n${(item.details ?? []).join('\n')}`).join('\n');
    if (lemon && items.some(item => !item.ok)) throw new HttpError(400, 'lemonlime_export', `LemonLime export failed; no incomplete archive was produced.\n${failed()}`);
    if (luogu && items.some(item => !item.ok)) throw new HttpError(400, 'luogu_export', `Luogu export failed; no incomplete archive was produced.\n${failed()}`);
    if (joi && items.some(item => !item.ok)) throw new HttpError(400, 'joi_export', `JOI / AtCoder export failed.\n${failed()}`);
    if (hydro && items.some(item => !item.ok)) throw new HttpError(400, 'hydro_export', `Hydro export failed; no incomplete archive was produced.\n${failed()}`);
    if (fps) {
      if (items.some(item => !item.ok)) throw new HttpError(400, 'fps_export', `FPS export failed.\n${failed()}`);
      const data = fpsDocument(fpsItems), file = `${config.contest.name}-fps-${Date.now()}.xml`;
      await atomicWrite(path.join(contestExportDir(ref), file), data);
      return { ...result, file, size: data.length };
    }
    job.progress(list.length, list.length, 'writing');
    if (luogu) zip.add('README.txt', luoguContestReadme(config.contest.title.zh || config.contest.title.en || config.contest.name, list.map(p => p.index)));
    else if (hydro) zip.add('README.txt', 'Each problem folder contains one standalone Hydro problem ZIP. Import those ZIPs individually in Hydro.\n每个题目目录内有一个独立 Hydro 整题 ZIP，请逐题导入 Hydro。\n');
    else if (lemon) {
      zip.add(`${config.contest.name}.cdf`, JSON.stringify({ version: '1.0', contestTitle: config.contest.title.zh || config.contest.title.en || config.contest.name, tasks: lemonTasks, contestants: [] }, null, 2));
      zip.add('source/', '');
      addLemonBuildScripts(zip, lemonBuilds);
      zip.add('README.txt', lemonReadme(lemonTarget, req.lemon?.subfolders === true));
    }
    else if (joi) zip.add('README.txt', 'Each problem folder contains an in/out ZIP. taskweave.yaml is an optional TaskWeave companion for scoring and limits.\n');
    else zip.add('contest.xml', contestXml(config.contest.title, config.contest.name, exported));
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
    const file = `${config.contest.name}${lemon ? '-lemonlime' : luogu ? '-luogu' : hydro ? '-hydro' : joi ? '-joi' : ''}-${stamp}-${randomBytes(4).toString('hex')}.zip`;
    const data = await zip.finishAsync();
    await atomicWrite(path.join(contestExportDir(ref), file), data);
    result.file = file;
    result.size = data.length;
  }
  job.progress(list.length, list.length, 'done');
  const history = path.join(ref.dir, '.taskweave', 'batches');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await atomicWrite(path.join(history, `${stamp}-${req.action}.json`), JSON.stringify(result, null, 2));
  await atomicWrite(path.join(history, 'latest.json'), JSON.stringify(result, null, 2));
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

/**
 * "测试点是否等分": compare the actual member scores, including uniform sums and bundles.
 */
export function equalTestPoints(config: ProblemToml, tests: number[]): boolean {
  const ts = testsetsOf(config)[0];
  if (!tests.length) return true;
  if (!config.tests.points || !ts.groups) return config.tests.points ? true : 100 % tests.length === 0;
  const present = new Set(tests);
  const values: number[] = [];
  const grouped = new Set<number>();
  const layout = groupLayout(ts, true);
  for (const g of ts.group) {
    const idx = [...new Set(parseIndexList(g.tests ?? ''))].filter(i => present.has(i));
    if (!idx.length) continue;
    idx.forEach(i => grouped.add(i));
    values.push(...idx.map(index => layout.byGroup[g.name][index] ?? 0));
  }
  if (tests.some(i => !grouped.has(i))) values.push(0);
  return values.every(v => Math.abs(v - values[0]) < 1e-9);
}

/** Statement sources of every problem in one language, for the combined / print view. */
export async function singleProblemDocument(judge: Judge, id: string) {
  const ref = await judge.registry.get(id), summary = await judge.registry.summary(ref);
  const config = contestTomlSchema.parse({ contest: { name: summary.name, title: summary.title, type: summary.type }, problems: [{ index: 'A', problem: id }] });
  const detail: ContestDetail = { summary: { ...ref, name: summary.name, title: summary.title, type: summary.type, statement: config.statement, problems: [{ index: 'A', problem: id, found: true }] }, problems: [{ index: 'A', problem: id, summary }] };
  return { ref, config, detail };
}

export async function contestStatements(judge: Judge, contests: ContestRegistry, contestId: string, lang: string, single = false): Promise<ContestStatement[]> {
  const { config } = single ? await singleProblemDocument(judge, contestId) : await contests.config(contestId);
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
    const sections = await readStatementSections(ctx.ref.dir, lang);
    const manifest = await readManifest(ctx);
    const samples = (await readSamples(ctx, false, lang)).map(row => row.sample);
    const body = await fsp.readFile(safeJoin(ctx.ref.dir, `statement/${lang}/statement.tex`), 'utf8').catch(() => undefined);
    out.push({
      ...(await exists(path.join(ctx.ref.dir, 'statement', lang, 'statement.tex')) ? { statementMode: 'whole' as const } : {}),
      index: p.index,
      problem: p.problem,
      title: c.problem.title[lang] || c.problem.title.en || c.problem.name,
      // OI directory, executable and source file names.
      name: sourceName(c.problem),
      testCount: manifest?.tests.length,
      equalPoints: manifest?.tests.length ? equalTestPoints(c, manifest.tests.map(t => t.index)) : undefined,
      timeLimit: c.problem.time_limit,
      memoryLimit: c.problem.memory_limit,
      interactive: judgeMode(c.problem) !== 'batch',
      input: c.problem.input,
      output: c.problem.output,
      type: c.problem.type,
      body,
      sections,
      // A statement.tex document prints its own samples; the section files get the generated ones.
      samples: body && /\\(?:section|subsection)\*?\{[^}]*(?:样例[^}]*输入|Sample[^}]*Input)|\\begin\{example\}/i.test(body) ? [] : samples,
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
  judge.registry.requireRoot();
  await contests.checkNew(name, req.folder);
  const client = await sync.client();
  job.progress(0, 0, 'contest.problems');
  const map = await client.call<Record<string, PolygonProblem>>('contest.problems', { contestId: req.contestId });
  const entries = Object.entries(map).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }));
  const root = await judge.registry.ensureRoot(req.root ?? judge.registry.roots[0] ?? '');
  const local = await judge.registry.list();
  const warnings: string[] = [];
  const problems: { index: string; problem: string }[] = [];
  for (const [i, [index, p]] of entries.entries()) {
    job.signal.throwIfAborted();
    const letter = index.toUpperCase();
    job.progress(i, entries.length, `${letter} · ${p.name}`);
    const bound = local.find((l) => l.status.polygonId === p.id && path.resolve(l.root).toLowerCase() === root.toLowerCase());
    if (bound) {
      problems.push({ index: letter, problem: bound.id });
      continue;
    }
    try {
      const sub: JobCtx = { signal: job.signal, progress: (_d, _t, m) => job.progress(i, entries.length, `${letter} · ${p.name}${m ? ` · ${m}` : ''}`) };
      const stem = (p.name || `problem-${p.id}`).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || `problem-${p.id}`;
      let localName = stem;
      for (let n = 0; await exists(path.join(root, localName)); n++) localName = `${stem}-${p.id}${n ? `-${n}` : ''}`;
      const s = await sync.importProblem({ polygonId: p.id, root, name: localName }, sub, p);
      local.push(s);
      problems.push({ index: letter, problem: s.id });
    } catch (e) {
      if (job.signal.aborted) throw e;
      warnings.push(`${letter} (${p.name}, #${p.id}): ${(e as Error).message}`);
    }
  }
  if (warnings.length) throw new HttpError(502, 'incomplete_import', `Imported ${problems.length}/${entries.length} problems. The contest was not created. Retry to reuse successful imports.\n${warnings.join('\n')}`);
  const contest = await contests.create({ name, problems, folder: req.folder, type: req.type });
  await contests.update(contest.id, { polygonId: req.contestId });
  job.progress(entries.length, entries.length, 'done');
  return { contest: { ...contest, polygonId: req.contestId }, warnings };
}
