import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type { WsHub } from '../ws.js';
import { CONTEST_FILE } from '@polyforge/shared';
import { TMP_MARKER } from '../util/fs.js';
import { HIDDEN_DIRS, type FileService } from './files.js';
import { PROBLEM_FILE, type ProblemRegistry } from './problems.js';

type Kind = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

/**
 * Watches all problem roots and pushes `file:changed` over WebSocket, so edits made
 * in external editors show up in the browser immediately.
 */
export class ProblemWatcher {
  private watcher: FSWatcher | null = null;
  private rescanTimer: NodeJS.Timeout | null = null;

  constructor(
    private registry: ProblemRegistry,
    private files: FileService,
    private hub: WsHub,
  ) {}

  async start(): Promise<void> {
    await this.stop();
    const roots = this.registry.roots;
    if (roots.length === 0) return;
    await this.registry.scan();
    this.watcher = watch(roots, {
      ignoreInitial: true,
      // root/problem/.polyforge/... etc.
      ignored: (p) => {
        const base = path.basename(p);
        if (base.startsWith(TMP_MARKER)) return true;
        return p.split(/[\\/]/).some((seg) => HIDDEN_DIRS.has(seg));
      },
      awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 },
      ignorePermissionErrors: true,
    });
    this.watcher.on('all', (kind, p) => void this.onEvent(kind as Kind, p));
    // On Windows, deleting or moving a watched folder makes fs.watch report EPERM; the
    // watcher drops that folder by itself, so this is not worth a warning.
    this.watcher.on('error', (e) => {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') return;
      console.warn('[polyforge] watcher error:', e);
    });
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    this.watcher = null;
  }

  private async onEvent(kind: Kind, abs: string) {
    const isRootChild = this.registry.roots.some((r) => path.resolve(path.dirname(abs)) === path.resolve(r));
    if (isRootChild && (kind === 'addDir' || kind === 'unlinkDir')) return this.scheduleRescan();

    if (path.basename(abs) === CONTEST_FILE && isRootChild === false && this.registry.roots.some((r) => path.resolve(path.dirname(path.dirname(abs))) === path.resolve(r))) {
      return this.scheduleRescan();
    }
    let loc = this.registry.locate(abs);
    // A problem.toml appearing in a new folder creates a new problem.
    if (path.basename(abs) === PROBLEM_FILE && (kind === 'add' || kind === 'unlink')) {
      this.scheduleRescan();
      if (!loc && kind === 'add') {
        await this.registry.scan();
        loc = this.registry.locate(abs);
      }
    }
    if (!loc || !loc.rel) return;

    let hash: string | undefined;
    if (kind === 'add' || kind === 'change') {
      hash = await this.files.hashOf(abs);
      if (kind === 'change' && this.files.selfWrites.consume(abs, hash)) return;
    }
    this.hub.broadcast({ type: 'file:changed', problemId: loc.ref.id, path: loc.rel, kind, hash });
    if (loc.rel === PROBLEM_FILE) this.hub.broadcast({ type: 'problem:changed', problemId: loc.ref.id });
  }

  private scheduleRescan() {
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(async () => {
      this.rescanTimer = null;
      await this.registry.scan();
      this.hub.broadcast({ type: 'problems:changed' });
      this.hub.broadcast({ type: 'contests:changed' });
    }, 150);
  }
}
