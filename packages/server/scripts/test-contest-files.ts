import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GlobalStore } from '../src/global.js';
import { ProblemRegistry } from '../src/workspace/problems.js';
import { ContestRegistry } from '../src/workspace/contests.js';
import { contestFile, ensureContestFiles } from '../src/workspace/contestFiles.js';
import { FileService, SelfWrites } from '../src/workspace/files.js';
import { ProblemWatcher } from '../src/workspace/watcher.js';
import { Judge } from '../src/judge/index.js';
import { WsHub } from '../src/ws.js';
import { JobManager } from '../src/jobs.js';
import { buildApp } from '../src/app.js';
import { ContestSandbox, type ContestPart } from '../src/ai/sandbox.js';
import { runContestTool, type ContestToolEnv } from '../src/ai/tools.js';
import { renderLatex } from '../../web/src/lib/latex.js';
import { commonContestLanguages } from '@polyforge/shared';

test('contest files migrate without overwrites, protect paths and reject linked folders', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-contest-files-'));
  try {
    await ensureContestFiles(home);
    assert.equal(await fs.readFile(path.join(home, 'files/notes.tex'), 'utf8'), '');
    await fs.writeFile(path.join(home, 'files/notes.tex'), 'keep');
    await ensureContestFiles(home);
    assert.equal(await fs.readFile(path.join(home, 'files/notes.tex'), 'utf8'), 'keep');
    for (const rel of ['../contest.toml', 'C:/escape', 'nested/../../escape', 'notes.tex:ads', 'CON.txt']) await assert.rejects(contestFile(home, rel));
    const outside = path.join(home, 'outside'); await fs.mkdir(outside);
    await fs.symlink(outside, path.join(home, 'files/link'), 'junction');
    await assert.rejects(contestFile(home, 'link/a.tex'), /symbolic links/);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('contest file API, snapshots, notes exports, authenticated images and save conflicts', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-contest-api-'));
  const global = new GlobalStore(home); await global.init();
  global.config.problems.roots = [path.join(home, 'problems')];
  const registry = new ProblemRegistry(global), contests = new ContestRegistry(registry, global);
  const hub = new WsHub(), files = new FileService(new SelfWrites());
  const watcher = new ProblemWatcher(registry, files, hub), judge = new Judge(global, registry, hub);
  const app = await buildApp({ global, registry, contests, hub, files, watcher, judge, jobs: new JobManager(hub), token: 'test-only' });
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, payload, headers: { host: 'localhost', 'x-polyforge-token': 'test-only' } });
  try {
    const p = await registry.create({ name: 'test-a', title: { zh: '加法' } });
    await fs.writeFile(path.join(p.dir, 'statement/zh/legend.tex'), '**原题面** $a+b$\n\n\\includegraphics{test.png}');
    await fs.writeFile(path.join(p.dir, 'statement/zh/tutorial.tex'), '只有题解内容');
    await fs.mkdir(path.join(p.dir, 'statement/images'), { recursive: true });
    await fs.writeFile(path.join(p.dir, 'statement/images/test.png'), 'image');
    const c = await contests.create({ name: 'round', problems: [{ index: 'B', problem: p.id }] });
    const base = `/api/contests/${c.id}`;
    assert.equal(await fs.readFile(path.join(c.dir, 'files/notes.tex'), 'utf8'), '');
    const initial = (await call('GET', base + '/file?path=notes.tex')).json();
    const saved = await call('PUT', base + '/file?path=notes.tex', { content: '请仔细阅读 $n$。', hash: initial.hash });
    assert.equal(saved.statusCode, 200); assert.equal(typeof saved.json().hash, 'string');
    assert.equal((await call('PUT', base + '/file?path=notes.tex', { content: 'stale', hash: initial.hash })).statusCode, 409);
    assert.equal((await call('PUT', base + '/file?path=../contest.toml', { content: 'escape' })).statusCode, 400);
    const uploaded = await call('POST', base + '/file?path=announcement.pdf', { base64: Buffer.from('%PDF-QA').toString('base64') });
    assert.equal(uploaded.statusCode, 200);
    assert.equal((await call('POST', base + '/file?path=announcement.pdf', { base64: '' })).statusCode, 409);
    const raw = await app.inject({ method: 'GET', url: base + '/file/raw?path=announcement.pdf&token=test-only', headers: { host: 'localhost' } });
    assert.equal(raw.statusCode, 200); assert.equal(raw.body, '%PDF-QA');
    assert.equal((await app.inject({ method: 'GET', url: base + '/file/raw?path=announcement.pdf', headers: { host: 'localhost' } })).statusCode, 401);
    const tex = await call('GET', base + '/tex?lang=zh&doc=tutorials&toc=1');
    assert.ok(tex.body.indexOf('请仔细阅读') < tex.body.indexOf('只有题解内容'));
    assert.ok(tex.body.includes('\\pfsection{注意事项}'));
    const noToc = await call('GET', base + '/tex?lang=zh&doc=tutorials&toc=0');
    assert.ok(!noToc.body.includes('请仔细阅读'));
    const paths: string[] = [];
    for (const doc of ['statements', 'statements', 'tutorials']) {
      const r = await call('POST', base + '/generate-document', { doc, lang: 'zh' });
      assert.equal(r.statusCode, 200, r.body);
      const rel = r.json().path; paths.push(rel);
      const source = await fs.readFile(path.join(c.dir, 'files', rel), 'utf8');
      assert.ok(source.startsWith('% polyforge-language: zh\n'));
      const rendered = renderLatex(source, { macros: new Map(), imageUrl: n => n });
      assert.deepEqual(rendered.unknown, []);
      assert.ok(source.includes('请仔细阅读'));
      if (doc === 'statements') {
        assert.ok(source.includes('原题面') && source.includes('时间限制'));
        assert.equal(await fs.readFile(path.join(c.dir, 'files', path.dirname(rel), 'images', p.id, 'test.png'), 'utf8'), 'image');
        assert.ok(!source.includes('只有题解内容'));
      } else assert.ok(source.includes('只有题解内容') && !source.includes('原题面'));
    }
    assert.equal(new Set(paths).size, 3);
    assert.ok((await fs.readFile(path.join(p.dir, 'statement/zh/legend.tex'), 'utf8')).startsWith('**原题面**'));
    const md = await call('POST', '/api/export/markdown', { markdown: '![test](images/image-1.pdf)', images: [{ problem: 'contest:' + c.id, path: 'announcement.pdf', name: 'image-1.pdf' }] });
    assert.equal(md.statusCode, 200);
    await call('DELETE', base + '/file?path=notes.tex');
    assert.equal((await call('GET', base + '/notes')).json().content, '');
    const p2 = await registry.create({ name: 'test-b' });
    for (const file of await fs.readdir(path.join(p2.dir, 'statement/en'))) await fs.writeFile(path.join(p2.dir, 'statement/en', file), '  \n');
    await contests.update(c.id, { problems: [{ index: 'A', problem: p.id }, { index: 'B', problem: p2.id }] });
    let detail = await contests.detail(c.id);
    assert.deepEqual(commonContestLanguages(detail.problems, 'statements'), ['zh']);
    assert.deepEqual(commonContestLanguages(detail.problems, 'tutorials'), []);
    const before = await fs.readdir(path.join(c.dir, 'files'));
    for (const [doc, lang] of [['statements', 'en'], ['tutorials', 'zh']]) {
      const rejected = await call('POST', base + '/generate-document', { doc, lang });
      assert.equal(rejected.statusCode, 400);
      assert.equal(rejected.json().error, 'incomplete_document_language');
    }
    assert.deepEqual(await fs.readdir(path.join(c.dir, 'files')), before);
    await fs.writeFile(path.join(p2.dir, 'statement/zh/tutorial.tex'), '第二题的题解');
    detail = await contests.detail(c.id);
    assert.deepEqual(commonContestLanguages(detail.problems, 'tutorials'), ['zh']);
    assert.equal((await call('POST', base + '/generate-document', { doc: 'tutorials', lang: 'zh' })).statusCode, 200);
    assert.deepEqual(commonContestLanguages([], 'statements'), []);
    assert.deepEqual(commonContestLanguages([...detail.problems, { index: 'C', problem: 'missing', summary: null }], 'statements'), []);
  } finally { await app.close(); await watcher.stop(); await fs.rm(home, { recursive: true, force: true }); }
});

test('contest AI can read, edit, review, accept and reject files without a judge context', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-contest-ai-'));
  try {
    await ensureContestFiles(home);
    const part: ContestPart = { id: 'files', index: 'files', kind: 'files', realDir: path.join(home, 'files'), listed: true };
    const work = path.join(home, 'work');
    let sandbox = new ContestSandbox(work, [], async () => [part]); await sandbox.sync();
    const env: ContestToolEnv = { sandbox, session: { signal: new AbortController().signal, judge: {} as Judge, changed() {}, setPlan() {} }, forProblem: (_p, s) => ({ ...env.session, sandbox: s, ctx: async () => { throw new Error('Contest files have no problem context'); } }) };
    assert.ok((await runContestTool('list_files', {}, env)).content.includes('files/notes.tex'));
    assert.equal((await runContestTool('write_file', { path: 'files/notes.tex', content: 'AI draft' }, env)).isError, false);
    assert.equal(await fs.readFile(path.join(home, 'files/notes.tex'), 'utf8'), '');
    assert.equal((await sandbox.content('files/notes.tex')).modified, 'AI draft');
    sandbox = new ContestSandbox(work, [...sandbox.touched], async () => [part]); await sandbox.sync();
    await sandbox.accept(['files/notes.tex']);
    assert.equal(await fs.readFile(path.join(home, 'files/notes.tex'), 'utf8'), 'AI draft');
    env.sandbox = sandbox;
    await runContestTool('delete_file', { path: 'files/notes.tex' }, env);
    assert.equal((await sandbox.changes())[0].status, 'deleted');
    await sandbox.reject(['files/notes.tex']); assert.equal((await sandbox.changes()).length, 0);
    assert.equal((await runContestTool('write_file', { path: 'files/../../escape', content: 'bad' }, env)).isError, true);
    assert.equal((await runContestTool('read_file', { path: 'files/notes.tex' }, env)).content, 'AI draft');
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
