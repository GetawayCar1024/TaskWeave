import type { JobInfo } from '@polyforge/shared';
import { api } from './api';
import { onWs } from './ws';

/** Wait for a job to finish, reporting progress. Resolves with the final JobInfo. */
export function waitJob(job: JobInfo, onProgress?: (j: JobInfo) => void, signal?: AbortSignal): Promise<JobInfo> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (job.status !== 'running') return Promise.resolve(job);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => { off(); clearInterval(poll); signal?.removeEventListener('abort', abort); };
    const abort = () => { if (settled) return; settled = true; cleanup(); reject(signal?.reason); };
    const finish = (j: JobInfo) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(j);
    };
    const off = onWs((e) => {
      if ((e.type === 'job:progress' || e.type === 'job:done') && e.job.id === job.id) {
        onProgress?.(e.job);
        if (e.type === 'job:done') finish(e.job);
      }
    });
    // The job may finish before the WS subscription sees it; poll as a fallback.
    const poll = setInterval(async () => {
      const j = await api.job(job.id).catch(() => null);
      if (j && j.status !== 'running') finish(j);
    }, 1500);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
