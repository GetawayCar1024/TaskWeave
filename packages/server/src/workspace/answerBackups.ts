import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse, stringify } from 'smol-toml';
import type { AnswerBackupInfo, TestsetConfig } from '@polyforge/shared';
import { atomicWrite, exists, HttpError, safeJoin, sha1, TMP_MARKER, validateFileName } from '../util/fs.js';

interface OriginalAnswer { input: string; output: string; backup: string | null; hash?: string }
interface Baseline { version: 1; origin: 'import' | 'existing'; createdAt: string; manual: string; entries: OriginalAnswer[] }
export interface AnswerPair { input: string; output: string }
const baselineDir = (dir: string, id: string) => {
  if (!/^[a-f0-9]{24}$/.test(id)) throw new HttpError(400, 'answer_backup', 'Invalid original-answer backup id.');
  return path.join(dir, '.polyforge', 'answers-original', id);
};
const targetPath = (dir: string, relative: string) => { validateFileName(relative); if (!/\.(in|out|ans)$/i.test(relative) || relative.startsWith('.polyforge/')) throw new HttpError(400, 'answer_backup', 'Invalid input/answer path.'); return safeJoin(dir, relative); };

/** Import has all bytes already: save the one immutable baseline as part of its publication. */
export function snapshotImportedAnswers(files: Map<string, Buffer>, doc: Record<string, any>) {
  const sets: [string, Record<string, any>][] = [['tests', doc.tests], ...Object.entries(doc.testsets ?? {}).filter(([name]) => name !== 'tests') as [string, Record<string, any>][]];
  for (const [name, ts] of sets) {
    if (!ts || ts.answer_baseline) continue;
    const manual = ts.manual ?? (name === 'tests' ? 'tests/manual' : `tests/${name}`);
    const inputs = [...files.keys()].filter(file => file.startsWith(manual + '/') && !file.slice(manual.length + 1).includes('/') && /\.in$/i.test(file) && !/\.statement\.in$/i.test(file));
    if (!inputs.length) continue;
    const id = randomBytes(12).toString('hex'), base = `.polyforge/answers-original/${id}`;
    const baseline: Baseline = { version: 1, origin: 'import', createdAt: new Date().toISOString(), manual, entries: inputs.map((input, i) => {
      const stem = input.replace(/\.in$/i, ''), output = files.has(stem + '.ans') ? stem + '.ans' : files.has(stem + '.out') ? stem + '.out' : stem + '.ans';
      const bytes = files.get(output), backup = bytes ? `${i + 1}.ans` : null;
      if (bytes) files.set(`${base}/${backup}`, bytes);
      return { input, output, backup, ...(bytes ? { hash: sha1(bytes) } : {}) };
    }) };
    files.set(`${base}/manifest.json`, Buffer.from(JSON.stringify(baseline)));
    ts.answer_baseline = id;
  }
}

export async function readOriginalAnswers(dir: string, ts: TestsetConfig): Promise<Baseline | null> {
  if (!ts.answerBaseline) return null;
  const base = baselineDir(dir, ts.answerBaseline);
  const result: Baseline = JSON.parse(await fs.readFile(path.join(base, 'manifest.json'), 'utf8').catch(() => { throw new HttpError(400, 'answer_backup', 'Original-answer backup is missing.'); }));
  if (result.version !== 1 || !['import', 'existing'].includes(result.origin) || result.manual !== ts.manual || !Array.isArray(result.entries)) throw new HttpError(400, 'answer_backup', 'Original-answer backup does not match this testset.');
  for (const row of result.entries) {
    targetPath(dir, row.input); targetPath(dir, row.output);
    if (!row.input.startsWith(ts.manual + '/') || !row.output.startsWith(ts.manual + '/') || row.backup !== null && !/^\d+\.ans$/.test(row.backup)) throw new HttpError(400, 'answer_backup', 'Invalid original-answer backup entry.');
  }
  return result;
}

export async function answerBackupInfo(dir: string, ts: TestsetConfig): Promise<AnswerBackupInfo> {
  const original = await readOriginalAnswers(dir, ts);
  return original ? { available: true, origin: original.origin, createdAt: original.createdAt, tests: original.entries.length } : { available: false, tests: 0 };
}

/** Older workspaces have no import-time snapshot. Capture existing answers once, explicitly labelled. */
export async function ensureOriginalAnswers(dir: string, ts: TestsetConfig, pairs: AnswerPair[]) {
  if (ts.answerBaseline) { await readOriginalAnswers(dir, ts); return; }
  const configFile = path.join(dir, 'problem.toml'), before = await fs.readFile(configFile, 'utf8');
  const doc = parse(before) as Record<string, any>, target = ts.name === 'tests' ? (doc.tests ??= {}) : ((doc.testsets ??= {})[ts.name] ??= {});
  if (target.answer_baseline) return;
  const id = randomBytes(12).toString('hex'), base = baselineDir(dir, id);
  const original: Baseline = { version: 1, origin: 'existing', createdAt: new Date().toISOString(), manual: ts.manual, entries: [] };
  await fs.mkdir(base, { recursive: true });
  try {
    for (const [i, pair] of pairs.entries()) {
      const output = targetPath(dir, pair.output), bytes = await fs.readFile(output).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      const backup = bytes ? `${i + 1}.ans` : null;
      if (bytes) await fs.writeFile(path.join(base, backup!), bytes, { flag: 'wx' });
      original.entries.push({ ...pair, backup, ...(bytes ? { hash: sha1(bytes) } : {}) });
    }
    await atomicWrite(path.join(base, 'manifest.json'), JSON.stringify(original));
    if (await fs.readFile(configFile, 'utf8') !== before) throw new HttpError(409, 'conflict', 'problem.toml changed while backing up answers.');
    target.answer_baseline = id;
    await atomicWrite(configFile, stringify(doc));
  } catch (error) { await fs.rm(base, { recursive: true, force: true }); throw error; }
}

async function copyAtomic(from: string, to: string) {
  const temporary = path.join(path.dirname(to), `${TMP_MARKER}${randomBytes(8).toString('hex')}`);
  await fs.mkdir(path.dirname(to), { recursive: true });
  try { await fs.copyFile(from, temporary); await fs.rename(temporary, to); }
  finally { await fs.rm(temporary, { force: true }); }
}

interface Journal { version: 1; committed: boolean; files: { output: string; previous: string | null }[] }
const transactions = new Map<string, Promise<void>>();
const recoveries = new Map<string, Promise<void>>();
const transactionDir = (dir: string) => path.join(dir, '.polyforge', 'answer-transaction');
async function rollback(dir: string, journal: Journal) {
  if (journal.version !== 1 || !Array.isArray(journal.files)) throw new HttpError(400, 'answer_transaction', 'Invalid answer transaction.');
  for (const row of journal.files) {
    const output = targetPath(dir, row.output);
    if (row.previous === null) await fs.rm(output, { force: true });
    else {
      if (!/^\d+\.ans$/.test(row.previous)) throw new HttpError(400, 'answer_transaction', 'Invalid answer transaction file.');
      await copyAtomic(path.join(transactionDir(dir), row.previous), output);
    }
  }
}

/** A crash during publication rolls back to the pre-operation version, not to the initial baseline. */
export async function recoverAnswerTransaction(dir: string) {
  if (transactions.has(dir)) { await transactions.get(dir); return; }
  let recovery = recoveries.get(dir);
  if (!recovery) {
    recovery = recover(dir).finally(() => recoveries.delete(dir));
    recoveries.set(dir, recovery);
  }
  await recovery;
}
async function recover(dir: string) {
  const work = transactionDir(dir);
  if (!await exists(work)) return;
  const text = await fs.readFile(path.join(work, 'journal.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (text) { const journal: Journal = JSON.parse(text); if (!journal.committed) await rollback(dir, journal); }
  await fs.rm(work, { recursive: true, force: true });
}

export async function replaceAnswerFiles(dir: string, replacements: { output: string; from: string | null }[], signal: AbortSignal) {
  await recoverAnswerTransaction(dir);
  const work = transactionDir(dir);
  let finish!: () => void;
  transactions.set(dir, new Promise<void>(resolve => finish = resolve));
  const journal: Journal = { version: 1, committed: false, files: [] };
  let published = false, clean = true;
  try {
    await fs.mkdir(work, { recursive: true });
    for (const [i, entry] of replacements.entries()) {
      signal.throwIfAborted();
      const output = targetPath(dir, entry.output), previous = await exists(output) ? `${i + 1}.ans` : null;
      if (previous) await fs.copyFile(output, path.join(work, previous));
      journal.files.push({ output: entry.output, previous });
    }
    await atomicWrite(path.join(work, 'journal.json'), JSON.stringify(journal));
    published = true;
    for (const entry of replacements) {
      signal.throwIfAborted();
      if (entry.from) await copyAtomic(entry.from, targetPath(dir, entry.output)); else await fs.rm(targetPath(dir, entry.output), { force: true });
    }
    journal.committed = true;
    await atomicWrite(path.join(work, 'journal.json'), JSON.stringify(journal));
  } catch (error) {
    if (published) try { await rollback(dir, journal); } catch (rollbackError) { clean = false; throw rollbackError; }
    throw error;
  } finally {
    try { if (clean) await fs.rm(work, { recursive: true, force: true }); }
    finally { transactions.delete(dir); finish(); }
  }
}

export async function originalReplacements(dir: string, ts: TestsetConfig, pairs: AnswerPair[]) {
  const baseline = await readOriginalAnswers(dir, ts);
  if (!baseline) throw new HttpError(400, 'answer_backup', 'No original-answer backup is available.');
  const byInput = new Map(baseline.entries.map(entry => [entry.input, entry]));
  const result: { output: string; from: string | null }[] = [];
  for (const pair of pairs) {
    const original = byInput.get(pair.input); if (!original) continue;
    const from = original.backup ? path.join(baselineDir(dir, ts.answerBaseline!), original.backup) : null;
    if (from && sha1(await fs.readFile(from)) !== original.hash) throw new HttpError(400, 'answer_backup', 'Original-answer backup checksum mismatch.');
    result.push({ output: pair.output, from });
  }
  if (!result.length) throw new HttpError(400, 'answer_backup', 'No current inputs match the original-answer backup.');
  return result;
}
