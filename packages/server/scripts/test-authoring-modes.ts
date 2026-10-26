import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GlobalStore } from '../src/global.js';
import { ProblemRegistry } from '../src/workspace/problems.js';
import { Judge } from '../src/judge/index.js';
import { WsHub } from '../src/ws.js';
import { atomicWrite, exists } from '../src/util/fs.js';
import { convertStatementMode, readStatementSections } from '../src/workspace/statements.js';
import { contestNotes, ensureContestFiles } from '../src/workspace/contestFiles.js';
import { answerPath, readManifest } from '../src/judge/tests.js';
import { readSamples } from '../src/judge/samples.js';
import { addLemonProblem } from '../src/judge/lemonlime.js';
import { ZipWriter, readZip } from '../src/util/zip.js';
import { localItems } from '../src/polygon/items.js';

const job = () => ({ signal: new AbortController().signal, progress() {} });
async function fixture(run: (f: { dir: string; registry: ProblemRegistry; judge: Judge }) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-authoring-'));
  try {
    const global = new GlobalStore(dir); await global.init();
    global.config.problems.roots = [path.join(dir, 'problems')];
    const registry = new ProblemRegistry(global), judge = new Judge(global, registry, new WsHub());
    await run({ dir, registry, judge });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test('whole statements preserve text and tutorials, preview/export/sync share legend, and splitting never guesses headings', async () => fixture(async ({ registry, judge }) => {
  const p = await registry.create({ name: 'whole' });
  await atomicWrite(path.join(p.dir, 'statement/en/legend.tex'), '**Description** $n$');
  await atomicWrite(path.join(p.dir, 'statement/en/input.tex'), 'Read n.');
  await atomicWrite(path.join(p.dir, 'statement/en/output.tex'), 'Print n.');
  await atomicWrite(path.join(p.dir, 'statement/en/tutorial.tex'), 'Explanation');
  await convertStatementMode(p.dir, 'en', 'whole');
  const text = await fs.readFile(path.join(p.dir, 'statement/en/statement.tex'), 'utf8');
  assert.match(text, /Description/); assert.match(text, /Read n/); assert.match(text, /Print n/);
  assert.equal(await exists(path.join(p.dir, 'statement/en/input.tex')), false);
  const sections = await readStatementSections(p.dir, 'en');
  assert.equal(sections.legend, text); assert.equal(sections.input, undefined); assert.equal(sections.tutorial, 'Explanation');
  const items = await localItems(judge, await judge.ctx(p.id));
  assert.ok(items.warnings.some(w => w.includes('Whole statements')));
  assert.ok(items.items.find(i => i.key === 'statement:english:legend')?.text?.includes('Read n'));
  assert.ok(!items.items.some(i => i.key === 'statement:english:input'));
  await convertStatementMode(p.dir, 'en', 'sections');
  assert.equal(await fs.readFile(path.join(p.dir, 'statement/en/legend.tex'), 'utf8'), text);
  assert.equal(await fs.readFile(path.join(p.dir, 'statement/en/input.tex'), 'utf8'), '');
  assert.equal(await exists(path.join(p.dir, 'statement/en/statement.tex')), false);
  await convertStatementMode(p.dir, 'en', 'whole');
  await atomicWrite(path.join(p.dir, 'statement/en/input.tex'), 'external edit');
  await assert.rejects(convertStatementMode(p.dir, 'en', 'sections'), /Both statement.tex and input.tex/);
  assert.equal(await fs.readFile(path.join(p.dir, 'statement/en/input.tex'), 'utf8'), 'external edit');
}));

test('notes select the requested language, use the legacy fallback, and honor empty translations', async () => fixture(async ({ dir }) => {
  await ensureContestFiles(dir);
  await atomicWrite(path.join(dir, 'files/notes.tex'), 'legacy');
  await atomicWrite(path.join(dir, 'files/notes.zh.tex'), '中文');
  await atomicWrite(path.join(dir, 'files/notes.en.tex'), 'English');
  assert.equal(await contestNotes(dir, 'zh'), '中文');
  assert.equal(await contestNotes(dir, 'en'), 'English');
  assert.equal(await contestNotes(dir, 'fr'), 'legacy');
  await atomicWrite(path.join(dir, 'files/notes.en.tex'), '');
  assert.equal(await contestNotes(dir, 'en'), '');
  await assert.rejects(contestNotes(dir, '../other'));
}));

test('data-only workspaces retain answers across cache deletion and export LemonLime without compiling', async () => fixture(async ({ registry, judge }) => {
  const p = await registry.create({ name: 'data-only', dataOnly: true });
  assert.equal(p.dataOnly, true); assert.equal(p.status.statement, false); assert.equal(p.status.std, false);
  await atomicWrite(path.join(p.dir, 'tests/manual/1.in'), '2\r\n');
  await atomicWrite(path.join(p.dir, 'tests/manual/1.out'), '4\r\n');
  await atomicWrite(path.join(p.dir, 'tests/manual/2.in'), '3\n');
  await atomicWrite(path.join(p.dir, 'tests/manual/2.ans'), '9\n');
  await registry.patch(p.id, { samples: '1', testsets: { tests: { groups: true, group: [{ name: 'all', tests: '1-2', points: 100, policy: 'EACH_TEST' }] } } });
  const ctx = await judge.ctx(p.id);
  await assert.rejects(judge.compile(ctx, 'checker.cpp'), /requires full authoring/);
  await assert.rejects(registry.patch(p.id, { dataOnly: false }), /Complete these files/);
  assert.equal((await readManifest(ctx))?.ok, true);
  assert.equal((await readSamples(ctx, true))[0].sample.output, '4\r\n');
  await fs.rm(path.join(ctx.work, 'tests'), { recursive: true, force: true });
  assert.equal((await readManifest(ctx))?.tests.length, 2);
  assert.equal(await fs.readFile(answerPath(ctx, 1), 'utf8'), '4\r\n');
  const zip = new ZipWriter();
  const r = await addLemonProblem(judge, ctx, 'A', zip, job());
  assert.equal(r.tests, 2); assert.equal(r.task.comparisonMode, 1); assert.equal(r.task.specialJudge, '');
  assert.equal(readZip(zip.finish()).get('data/data-only/2.ans')?.toString(), '9\n');
  await fs.unlink(path.join(p.dir, 'tests/manual/1.out'));
  assert.equal((await readManifest(ctx))?.ok, false);
  await assert.rejects(addLemonProblem(judge, ctx, 'A', new ZipWriter(), job()), /missing|Missing/);
  await atomicWrite(path.join(p.dir, 'statement/en/legend.tex'), 'A complete statement');
  await atomicWrite(path.join(p.dir, 'validator.cpp'), 'int main() {}');
  await atomicWrite(path.join(p.dir, 'solutions/std.cpp'), 'int main() {}');
  await registry.patch(p.id, { validator: 'validator.cpp', checker: 'std:ncmp', solution: { source: 'solutions/std.cpp', tag: 'MA' } });
  assert.equal((await registry.patch(p.id, { dataOnly: false })).summary.dataOnly, false);
}));

test('ZIP import rejects ambiguous or escaping paths before extraction and verifies checksums', () => {
  for (const files of [['../escape.in'], ['a.in', 'A.in'], ['dir', 'dir/test.in']]) {
    const zip = new ZipWriter(); files.forEach(f => zip.add(f, 'test'));
    assert.throws(() => readZip(zip.finish()));
  }
  const zip = new ZipWriter(); zip.add('data/中文.in', '123');
  assert.equal(readZip(zip.finish()).get('data/中文.in')?.toString(), '123');
  const corrupt = zip.finish(); corrupt[30 + Buffer.byteLength('data/中文.in')] ^= 1;
  assert.throws(() => readZip(corrupt), /checksum/);
});
