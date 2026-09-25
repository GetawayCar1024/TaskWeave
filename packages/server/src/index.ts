import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import open from 'open';
import { buildApp } from './app.js';
import { GlobalStore, defaultGlobalDir } from './global.js';
import { WEB_DIST } from './paths.js';
import { JobManager } from './jobs.js';
import { Judge } from './judge/index.js';
import { exists } from './util/fs.js';
import { FileService, SelfWrites } from './workspace/files.js';
import { ProblemRegistry } from './workspace/problems.js';
import { ContestRegistry } from './workspace/contests.js';
import { ProblemWatcher } from './workspace/watcher.js';
import { WsHub } from './ws.js';

const { values: args } = parseArgs({
  options: {
    dev: { type: 'boolean', default: false },
    port: { type: 'string' },
    home: { type: 'string' },
    'no-open': { type: 'boolean', default: false },
  },
});

const DEFAULT_PORT = 4523;
const DEV_WEB_PORT = 5173;

async function main() {
  const global = new GlobalStore(args.home ? path.resolve(args.home) : defaultGlobalDir());
  await global.init();

  const token = await loadToken(global, args.dev);
  const hub = new WsHub();
  const files = new FileService(new SelfWrites());
  const registry = new ProblemRegistry(global);
  const watcher = new ProblemWatcher(registry, files, hub);
  await watcher.start();

  const webDist = WEB_DIST;
  const hasDist = !args.dev && (await exists(path.join(webDist, 'index.html')));
  if (!args.dev && !hasDist) console.warn('[polyforge] web build not found; run `pnpm build` first.');

  const judge = new Judge(global, registry, hub);
  const jobs = new JobManager(hub);
  // Build the runner in the background so the first run does not wait for g++.
  judge.runner.ensure().catch((e) => console.warn(`[polyforge] runner unavailable: ${e.message}`));

  const contests = new ContestRegistry(registry, global);
  for (const m of await contests.migrateFromProblemRoots()) console.log(`[polyforge] moved contest ${m.from} -> ${m.to}`);
  const app = await buildApp({ global, registry, contests, files, watcher, hub, judge, jobs, token, webDist: hasDist ? webDist : undefined });

  // Dev uses a fixed port so the Vite proxy can find it.
  const port = await listenOnFreePort(app, args.port ? Number(args.port) : DEFAULT_PORT, !args.port && !args.dev);
  const webPort = args.dev ? DEV_WEB_PORT : port;
  const url = `http://127.0.0.1:${webPort}/?token=${token}`;
  console.log(`[polyforge] global dir: ${global.dir}`);
  console.log(`[polyforge] API listening on http://127.0.0.1:${port}`);
  console.log(`[polyforge] open ${url}`);

  // In dev, tsx watch restarts the server on every change, so we do not open a tab each time.
  if (!args['no-open'] && !args.dev) open(url).catch(() => {});

  const shutdown = async () => {
    await watcher.stop();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * A fresh random token per launch. In dev it is persisted so that server restarts
 * (tsx watch) do not invalidate the already-open browser tab.
 */
async function loadToken(global: GlobalStore, dev: boolean): Promise<string> {
  if (process.env.POLYFORGE_TOKEN) return process.env.POLYFORGE_TOKEN;
  if (!dev) return randomBytes(24).toString('hex');
  const file = path.join(global.cacheDir, 'dev-token');
  try {
    const t = (await fsp.readFile(file, 'utf8')).trim();
    if (t) return t;
  } catch {
    /* first dev run */
  }
  const t = randomBytes(24).toString('hex');
  await fsp.writeFile(file, t);
  return t;
}

async function listenOnFreePort(app: Awaited<ReturnType<typeof buildApp>>, start: number, fallback: boolean) {
  for (let port = start; port < start + 20; port++) {
    try {
      await app.listen({ host: '127.0.0.1', port });
      return port;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || !fallback) throw e;
    }
  }
  throw new Error('No free port found');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
