import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { ContestBatchRequest, ContestBatchResult } from '@taskweave/shared';
import type { JobCtx } from '../jobs.js';
import { contestExportDir, runContestBatch, type ContestDeps } from '../judge/contest.js';
import { lemonHost } from '../judge/lemonlime.js';
import { contestDown } from '../judge/down.js';
import { atomicWrite, HttpError } from '../util/fs.js';
import { readZip } from '../util/zip.js';
import { contestPath, LemonServerClient, LemonServerError, query, validLemonContestName } from './client.js';

/**
 * Push a contest to LemonLime Server: build the LemonLime package for the server's system,
 * import it there (optionally replacing a contest of the same name and keeping its contestant
 * programs), and compile custom checkers on the server when they could not be built here.
 */
export async function pushContestToLemonServer(deps: ContestDeps, contestId: string, req: ContestBatchRequest, job: JobCtx): Promise<ContestBatchResult> {
  const { ref, config } = await deps.contests.config(contestId);
  const options = req.lemonServer ?? {};
  const name = (options.name ?? '').trim() || config.contest.name;
  if (!validLemonContestName(name)) throw new HttpError(400, 'invalid_name', `Invalid LemonLime Server contest name: ${name}`);

  job.progress(0, 0, 'connecting to LemonLime Server');
  const client = await LemonServerClient.fromSettings(deps.judge.global, job.signal);
  await client.login();
  if (client.status!.setupRequired) throw new HttpError(409, 'lemonserver_setup', 'The default contest folder of LemonLime Server is not set. Set it in the server web page first.');
  const target = client.target;
  const same = (a: string, b: string) => (target === 'windows' ? a.toLowerCase() === b.toLowerCase() : a === b);
  const list = await client.contests();
  const existing = list.contests.find(c => same(c.name, name))?.name;
  if (existing && !options.overwrite) throw new HttpError(409, 'lemonserver_exists', `Contest ${existing} already exists on LemonLime Server. Choose to replace it, or use another name.`);
  const entry = list.contests.find(c => c.name === existing);
  const busy = entry?.busy ?? (entry?.judging || (list.judging && same(list.judgingContest ?? list.current ?? '', existing ?? '')));
  if (existing && busy) throw new HttpError(409, 'lemonserver_judging', `LemonLime Server is judging ${existing} or has it queued for judging. Wait until it finishes, or remove its judging jobs on the server.`);

  // Contestant programs survive a replacement only if they are saved first.
  let sources: Buffer | undefined, keptSources = 0;
  if (existing && options.keepSources) {
    job.progress(0, 0, 'saving contestant programs on LemonLime Server');
    sources = await client.download(contestPath(existing, `/files/download${query({ root: 'source', path: '' })}`)).catch((e: unknown) => {
      // A contest without a source/ folder has nothing to keep.
      if (e instanceof LemonServerError && [400, 404].includes(e.status)) return undefined;
      throw e;
    });
    keptSources = sources ? [...readZip(sources).keys()].filter(f => !f.endsWith('/')).length : 0;
    if (!keptSources) sources = undefined;
  }

  // The contest properties (start / end time, down.zip) live in its folder and go with a replacement.
  type Props = { startTime?: number | null; endTime?: number | null; downZip?: { path: string; exists: boolean } | null };
  let previous: Props | undefined, previousDown: Buffer | undefined;
  if (existing) {
    previous = await client.call<Props>('GET', contestPath(existing));
    if (!options.down && previous.downZip?.exists) previousDown = await client.download(contestPath(existing, '/down-zip'));
  }

  // down.zip is built before anything is uploaded: a stale statement snapshot stops the push here.
  let down: Buffer | undefined;
  if (options.down) {
    const d = options.down;
    if (!['samples', 'pdf'].includes(d.mode)) throw new HttpError(400, 'bad_request', 'down.zip mode must be samples or pdf');
    job.progress(0, 0, 'building down.zip');
    down = await contestDown(deps.judge, deps.contests, ref.id, d.mode === 'samples' ? { lang: d.lang, samplesOnly: true } : { lang: d.lang, pdf: d.pdf, statements: d.statements, notes: d.notes });
  }

  const exported = await runContestBatch(deps, ref.id, { ...req, action: 'export', exportFormat: 'lemonlime', lemon: { ...req.lemon, target } }, job);
  const file = path.join(contestExportDir(ref), exported.file!);
  try {
    const data = await fsp.readFile(file);
    job.progress(0, 0, `uploading to LemonLime Server (${(data.length / 1048576).toFixed(1)} MiB)`);
    const imported = await client.call<{ name: string }>('POST', `/api/import-contest${query({ name, overwrite: existing ? 1 : undefined })}`, data);
    const remote = imported.name || name;

    if (sources) {
      job.progress(0, 0, 'restoring contestant programs on LemonLime Server');
      await client.call('POST', contestPath(remote, `/files/unzip${query({ root: 'source', path: '' })}`), sources);
      await client.call('POST', contestPath(remote, '/refresh'));
    }

    let downZip: 'uploaded' | 'kept' | undefined, keptTime = false;
    if (down ?? previousDown) {
      job.progress(0, 0, down ? 'uploading down.zip to LemonLime Server' : 'restoring down.zip on LemonLime Server');
      await client.call('PUT', contestPath(remote, '/down-zip'), down ?? previousDown);
      downZip = down ? 'uploaded' : 'kept';
    }
    if (previous?.startTime || previous?.endTime) {
      await client.call('PUT', contestPath(remote), { startTime: previous.startTime ?? null, endTime: previous.endTime ?? null });
      keptTime = true;
    }

    // After the import the server compiles every custom checker with its own g++, so the
    // executable matches the judging machine. A checker prebuilt here (same system) is only
    // replaced when that build succeeds; across systems the server build is the only one.
    let compiled = 0;
    const prebuilt = target === lemonHost();
    const builds = options.compileOnServer === false && prebuilt ? [] : exported.lemonCheckers ?? [];
    if (builds.length) {
      const dir = String((await client.call<{ directory: string }>('GET', contestPath(remote))).directory).replace(/[\\/]+$/, '');
      for (const [i, build] of builds.entries()) {
        job.signal.throwIfAborted();
        job.progress(i, builds.length, `${build.index} · compiling the checker on LemonLime Server`);
        const inside = (p: string) => p.replace(/^data\//, '');
        const include = (sub: string) => `"${dir}/${build.include}/${sub}"`;
        const r = await client.call<{ ok: boolean; output: string }>('POST', contestPath(remote, '/files/compile'), {
          root: 'data', path: inside(build.source), output: inside(build.output), bundledTestlib: false,
          arguments: `-O2 -std=${build.standard} -DONLINE_JUDGE -I ${include('shared')} -I ${include('problem')}`,
        }).catch((e: unknown) => {
          // e.g. no C++ compiler configured on the server
          if (e instanceof LemonServerError) return { ok: false, output: e.remote };
          throw e;
        });
        if (r.ok) { compiled++; continue; }
        const item = exported.items.find(x => x.index === build.index);
        if (!item) continue;
        const output = String(r.output ?? '').split(/\r?\n/).filter(Boolean).slice(0, 40);
        if (prebuilt) item.details = [...(item.details ?? []), 'checker compilation failed on LemonLime Server; the checker built by TaskWeave is used', ...output];
        else { item.ok = false; item.message = 'checker compilation failed on LemonLime Server'; item.details = output; }
      }
    }

    const result: ContestBatchResult = { action: 'lemon-push', items: exported.items, lemonServer: { url: client.url, name: remote, platform: client.status!.platform, compiled, keptSources: sources ? keptSources : 0, downZip, keptTime } };
    job.progress(1, 1, 'done');
    const history = path.join(ref.dir, '.taskweave', 'batches');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await atomicWrite(path.join(history, `${stamp}-lemon-push.json`), JSON.stringify(result, null, 2));
    await atomicWrite(path.join(history, 'latest.json'), JSON.stringify(result, null, 2));
    return result;
  } finally {
    // The package was only needed for the upload.
    await fsp.rm(file, { force: true });
  }
}
