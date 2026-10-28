import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GlobalStore } from '../src/global.js';
import { ProblemRegistry } from '../src/workspace/problems.js';
import { ContestRegistry } from '../src/workspace/contests.js';
import { LibraryFolders } from '../src/workspace/library.js';
import { moveProblem } from '../src/workspace/move.js';
import { TrashStore } from '../src/workspace/trash.js';

async function fixture(run: (ctx: { home: string; registry: ProblemRegistry; contests: ContestRegistry; folders: LibraryFolders; trash: TrashStore }) => Promise<void>) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tw-workspaces-')));
  const global = new GlobalStore(home); await global.init(); global.config.problems.roots = [path.join(home, 'problems')];
  const registry = new ProblemRegistry(global), contests = new ContestRegistry(registry, global);
  try { await run({ home, registry, contests, folders: new LibraryFolders(registry, global), trash: new TrashStore(global, registry, contests) }); }
  finally { await fs.rm(home, { recursive: true, force: true }); }
}

test('legacy CF/OI workspaces can share any contest without copies or hidden problems', async () => fixture(async ({ registry, contests }) => {
  const cf = await registry.create({ name: 'cf-legacy', dataOnly: true }), oi = await registry.create({ name: 'oi-legacy', type: 'oi', dataOnly: true });
  const mixed = await contests.create({ name: 'mixed', problems: [{ index: 'A', problem: cf.id }, { index: 'B', problem: oi.id }] });
  assert.deepEqual(mixed.problems.map(p => p.problem), [cf.id, oi.id]);
  const oldOi = await contests.create({ name: 'old-oi-contest', type: 'oi', problems: [{ index: 'A', problem: cf.id }] });
  assert.equal(oldOi.problems[0].problem, cf.id); assert.equal((await registry.list()).length, 2);
  const bound = await registry.patch(oi.id, { polygonId: 123 }); assert.equal(bound.config?.polygon.id, 123);
}));

test('nested library folders retain identities through create, rename, move and recycle restore', async () => fixture(async ({ registry, contests, folders, trash }) => {
  await folders.create({ kind: 'problems', name: '训练题' });
  await folders.create({ kind: 'problems', folder: '训练题', name: 'Graphs' });
  await folders.create({ kind: 'contests', name: 'Rounds' });
  const problem = await registry.create({ name: 'road', folder: '训练题/Graphs', dataOnly: true });
  const contest = await contests.create({ name: 'round', folder: 'Rounds', problems: [{ index: 'A', problem: problem.id }] });
  assert.equal(problem.folder, '训练题/Graphs'); assert.equal(contest.folder, 'Rounds');
  const renamed = await registry.patch(problem.id, { name: 'road-new' });
  assert.equal(renamed.summary.folder, '训练题/Graphs'); assert.equal(renamed.summary.id, problem.id);
  await moveProblem(registry, problem.id, problem.root, '训练题');
  assert.equal((await registry.detail(problem.id)).summary.folder, '训练题');
  await contests.move(contest.id, '');
  assert.equal((await contests.detail(contest.id)).problems[0].summary?.name, 'road-new');
  const entry = await trash.recycleProblem(problem.id); await trash.restore(entry.key);
  assert.equal((await registry.detail(problem.id)).summary.folder, '训练题');
  assert.equal((await contests.detail(contest.id)).problems[0].summary?.id, problem.id);
  assert.equal((await folders.list({ kind: 'problems', recursive: true })).folders.some(folder => folder.path.includes('road-new')), false);
  await assert.rejects(folders.create({ kind: 'problems', folder: '训练题/road-new', name: 'nested-problem' }), /outside problem/);
  await assert.rejects(folders.create({ kind: 'problems', name: '../outside' }));
}));
