import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface BuildIdentity { dir: string; hash: string }
type Mode = 'read' | 'write';
interface Lock { readers: number; writer: boolean; queue: { mode: Mode; enter: () => void }[] }
const locks = new Map<string, Lock>();

function pump(lock: Lock) {
  if (lock.writer) return;
  while (lock.queue.length) {
    const next = lock.queue[0];
    if (next.mode === 'write') {
      if (lock.readers) return;
      lock.writer = true;
      lock.queue.shift()!.enter();
      return;
    }
    lock.readers++;
    lock.queue.shift()!.enter();
  }
}

/** Compiling and executing a cache slot must never overlap (Windows locks running exes). */
export async function withBuildLocks<T>(dirs: string[], fn: () => Promise<T>, mode: Mode = 'write'): Promise<T> {
  const keys = [...new Set(dirs.map(dir => process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir)))].sort();
  const enter = async (i: number): Promise<T> => {
    if (i === keys.length) return fn();
    const key = keys[i];
    const lock = locks.get(key) ?? { readers: 0, writer: false, queue: [] };
    locks.set(key, lock);
    await new Promise<void>(resolve => {
      lock.queue.push({ mode, enter: resolve });
      pump(lock);
    });
    try { return await enter(i + 1); }
    finally {
      if (mode === 'write') lock.writer = false;
      else lock.readers--;
      pump(lock);
      if (!lock.writer && !lock.readers && !lock.queue.length) locks.delete(key);
    }
  };
  return enter(0);
}

/** A queued job must not silently run an executable rebuilt from different source. */
export async function verifyBuild(build?: BuildIdentity): Promise<void> {
  if (!build) return;
  const record = await fs.readFile(path.join(build.dir, 'compile.json'), 'utf8').then(JSON.parse).catch(() => null);
  if (!record?.ok || record.hash !== build.hash) throw new Error('Compiled source changed; restart this run to use the latest version.');
}
