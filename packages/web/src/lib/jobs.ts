import type { JobInfo } from '@polyforge/shared';
import { api } from './api';
import { onWs } from './ws';

/** Wait for a job to finish, reporting progress. Resolves with the final JobInfo. */
export function waitJob(job: JobInfo, onProgress?: (j: JobInfo) => void): Promise<JobInfo> {
  if (job.status !== 'running') return Promise.resolve(job);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (j: JobInfo) => {
      if (settled) return;
      settled = true;
      off();
      clearInterval(poll);
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
  });
}
