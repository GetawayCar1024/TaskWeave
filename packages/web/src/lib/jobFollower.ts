import type { JobInfo } from '@taskweave/shared';

type WaitJob = (job: JobInfo, progress: (job: JobInfo) => void, signal: AbortSignal) => Promise<JobInfo>;

/** One observer and one completion per job for the lifetime of a mounted workspace. */
export function createJobFollower(wait: WaitJob, progress: (job: JobInfo) => void, complete: (job: JobInfo) => void | Promise<void>) {
  const controller = new AbortController();
  const following = new Map<string, Promise<void>>();
  const completed = new Set<string>();
  const update = (job: JobInfo) => { if (!controller.signal.aborted) progress(job); };
  return {
    follow(job: JobInfo): Promise<void> {
      if (controller.signal.aborted || completed.has(job.id)) return Promise.resolve();
      const existing = following.get(job.id);
      if (existing) return existing;
      update(job);
      const pending = wait(job, update, controller.signal).then(async done => {
        if (controller.signal.aborted || completed.has(done.id)) return;
        completed.add(done.id);
        update(done);
        await complete(done);
      }).catch(error => {
        if (!controller.signal.aborted) throw error;
      }).finally(() => following.delete(job.id));
      following.set(job.id, pending);
      return pending;
    },
    dispose() { controller.abort(); },
  };
}
