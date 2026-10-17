import { setTimeout as delay } from 'node:timers/promises';
import type { JobCtx } from '../jobs.js';
import type { PolygonClient } from './client.js';

interface RemotePackage { id: number; state: string; comment?: string; revision?: number }
export async function buildAndVerify(client: PolygonClient, problemId: number, full: boolean, job: JobCtx): Promise<string[]> {
  const hint = 'Check the Polygon build log and source language/compiler architecture (for example GNU C++ 64-bit for __int128). Local compilation does not guarantee remote compatibility.';
  let before: RemotePackage[] | undefined;
  try { before = await client.call<RemotePackage[]>('problem.packages', { problemId }); }
  catch { /* Without a baseline an old package must never count as this build. */ }
  await client.call('problem.buildPackage', { problemId, full, verify: true });
  if (!before) return [`Package build was requested but its result could not be verified because the previous package list was unavailable. ${hint}`];
  const known = new Set(before.map(p => p.id));
  for (let attempt = 0; attempt < 40; attempt++) {
    job.signal.throwIfAborted();
    let packages: RemotePackage[];
    try { packages = await client.call<RemotePackage[]>('problem.packages', { problemId }); }
    catch (e) { return [`Package build was requested but its result could not be verified: ${(e as Error).message}. ${hint}`]; }
    const latest = packages.filter(p => !known.has(p.id)).sort((a, b) => b.id - a.id)[0];
    if (latest?.state === 'READY') return [];
    if (latest?.state === 'FAILED') return [`Polygon package #${latest.id} failed: ${latest.comment ?? 'See Polygon build diagnostics'}. ${hint}`];
    job.progress(0, 0, `Polygon package: ${latest?.state ?? 'waiting'}`);
    await delay(3000, undefined, { signal: job.signal });
  }
  return [`Polygon build is still pending; remote success has not been confirmed. ${hint}`];
}
