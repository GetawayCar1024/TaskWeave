import { randomBytes } from 'node:crypto';
import type { JobInfo, JobKind } from '@taskweave/shared';
import { HttpError } from './util/fs.js';
import type { WsHub } from './ws.js';

export interface JobCtx {
  signal: AbortSignal;
  /** Update progress; broadcasts are throttled. */
  progress(done: number, total: number, message?: string): void;
}

/** Long-running operations (test generation, invocations…) with WS progress and cancel. */
export class JobManager {
  private jobs = new Map<string, { info: JobInfo; abort: AbortController }>();

  constructor(private hub: WsHub) {}

  start<T>(kind: JobKind, problemId: string, fn: (ctx: JobCtx) => Promise<T>): JobInfo {
    const id = randomBytes(6).toString('hex');
    const abort = new AbortController();
    const info: JobInfo = {
      id,
      kind,
      problemId,
      status: 'running',
      startedAt: new Date().toISOString(),
      progress: { done: 0, total: 0 },
    };
    this.jobs.set(id, { info, abort });
    let last = 0;
    let pending: NodeJS.Timeout | null = null;
    const emit = () => {
      pending = null;
      last = Date.now();
      this.hub.broadcast({ type: 'job:progress', job: info });
    };
    const ctx: JobCtx = {
      signal: abort.signal,
      progress(done, total, message) {
        info.progress = { done, total, message };
        if (Date.now() - last > 100) emit();
        else pending ??= setTimeout(emit, 100);
      },
    };
    this.hub.broadcast({ type: 'job:progress', job: info });
    fn(ctx)
      .then((result) => {
        info.status = abort.signal.aborted ? 'cancelled' : 'done';
        info.result = result;
      })
      .catch((e: Error) => {
        info.status = abort.signal.aborted ? 'cancelled' : 'failed';
        info.error = e.message;
      })
      .finally(() => {
        if (pending) clearTimeout(pending);
        info.finishedAt = new Date().toISOString();
        this.hub.broadcast({ type: 'job:done', job: info });
        // Keep finished jobs around briefly so clients can fetch the result.
        setTimeout(() => this.jobs.delete(id), 10 * 60_000).unref();
      });
    return info;
  }

  get(id: string): JobInfo {
    const j = this.jobs.get(id);
    if (!j) throw new HttpError(404, 'job_not_found', `Job not found: ${id}`);
    return j.info;
  }

  cancel(id: string): JobInfo {
    const j = this.jobs.get(id);
    if (!j) throw new HttpError(404, 'job_not_found', `Job not found: ${id}`);
    j.abort.abort();
    return j.info;
  }

  list(problemId?: string): JobInfo[] {
    return [...this.jobs.values()].map((j) => j.info).filter((j) => !problemId || j.problemId === problemId);
  }

  /** Is a job of this kind already running for the problem? */
  running(problemId: string, kind: JobKind): JobInfo | undefined {
    return this.list(problemId).find((j) => j.kind === kind && j.status === 'running');
  }
}
