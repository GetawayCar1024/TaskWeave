import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
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

const DEFAULT_PORT = 4523;
const DEV_WEB_PORT = 5173;

export interface ServerOptions {
  /** Global directory (new installs: ~/.taskweave; existing ~/.polyforge is reused). */
  home?: string;
  /** Fixed port; otherwise the first free one from 4523. */
  port?: number;
  /** Dev mode: the web UI is served by Vite on :5173. */
  dev?: boolean;
}

export interface RunningServer {
  /** The UI address, with the access token. */
  url: string;
  port: number;
  global: GlobalStore;
  close: () => Promise<void>;
}

/** Start Taskweave (API + web UI) on 127.0.0.1; used by the CLI and the desktop app. */
export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const dev = !!opts.dev;
  const global = new GlobalStore(opts.home ? path.resolve(opts.home) : defaultGlobalDir());
  await global.init();

  const token = await loadToken(global, dev);
  const hub = new WsHub();
  const files = new FileService(new SelfWrites());
  const registry = new ProblemRegistry(global);
  const watcher = new ProblemWatcher(registry, files, hub);
  await watcher.start();

  const webDist = WEB_DIST;
  const hasDist = !dev && (await exists(path.join(webDist, 'index.html')));
  if (!dev && !hasDist) console.warn('[taskweave] web build not found; run `pnpm build` first.');

  const judge = new Judge(global, registry, hub);
  const jobs = new JobManager(hub);
  // Build the runner in the background so the first run does not wait for g++.
  judge.runner.ensure().catch((e) => console.warn(`[taskweave] runner unavailable: ${e.message}`));

  const contests = new ContestRegistry(registry, global);
  for (const m of await contests.migrateFromProblemRoots()) console.log(`[taskweave] moved contest ${m.from} -> ${m.to}`);
  const app = await buildApp({ global, registry, contests, files, watcher, hub, judge, jobs, token, webDist: hasDist ? webDist : undefined });

  // Dev uses a fixed port so the Vite proxy can find it.
  const port = await listenOnFreePort(app, opts.port ?? DEFAULT_PORT, opts.port === undefined && !dev);
  const webPort = dev ? DEV_WEB_PORT : port;
  const url = `http://127.0.0.1:${webPort}/?token=${token}`;
  console.log(`[taskweave] global dir: ${global.dir}`);
  console.log(`[taskweave] API listening on http://127.0.0.1:${port}`);

  return {
    url,
    port,
    global,
    close: async () => {
      await watcher.stop();
      await app.close();
    },
  };
}

/**
 * A fresh random token per launch. In dev it is persisted so that server restarts
 * (tsx watch) do not invalidate the already-open browser tab.
 */
async function loadToken(global: GlobalStore, dev: boolean): Promise<string> {
  const override = process.env.TASKWEAVE_TOKEN || process.env.POLYFORGE_TOKEN;
  if (override) return override;
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
