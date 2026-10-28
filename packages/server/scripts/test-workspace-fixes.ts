import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import { GlobalStore } from '../src/global.js';
import { ProblemRegistry } from '../src/workspace/problems.js';
import { ContestRegistry } from '../src/workspace/contests.js';
import { FileService, SelfWrites } from '../src/workspace/files.js';
import { ProblemWatcher } from '../src/workspace/watcher.js';
import { Judge } from '../src/judge/index.js';
import { WsHub } from '../src/ws.js';
import { JobManager } from '../src/jobs.js';
import { buildApp } from '../src/app.js';
import {
  LANGUAGE_PRESETS,
  addLanguageSection,
  classifyFile,
  flattenFiles,
  hasLanguageSection,
  languageSectionText,
  removeLanguageSection,
} from '@taskweave/shared';

async function setup(prefix: string) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const global = new GlobalStore(home); await global.init();
  global.config.problems.roots = [path.join(home, 'problems')];
  await fs.mkdir(global.config.problems.roots[0], { recursive: true });
  const registry = new ProblemRegistry(global), contests = new ContestRegistry(registry, global);
  const hub = new WsHub(), files = new FileService(new SelfWrites()), jobs = new JobManager(hub);
  const watcher = new ProblemWatcher(registry, files, hub), judge = new Judge(global, registry, hub);
  const app = await buildApp({ global, registry, contests, hub, files, watcher, judge, jobs, token: 'test-only' });
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH', url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: { host: 'localhost', 'x-taskweave-token': 'test-only' } });
  const cleanup = async () => { await app.close(); await watcher.stop(); await fs.rm(home, { recursive: true, force: true }); };
  return { home, global, registry, contests, jobs, hub, app, call, cleanup };
}

test('choosing another checker keeps the previous checker file visible and on disk', async () => {
  const s = await setup('pf-checker-');
  try {
    const p = await s.registry.create({ name: 'chk' });
    await fs.writeFile(path.join(p.dir, 'old-chk.py'), 'print(1)\n');
    await fs.writeFile(path.join(p.dir, 'new-chk.cpp'), 'int main() {}\n');
    await fs.mkdir(path.join(p.dir, 'files'), { recursive: true });
    await fs.writeFile(path.join(p.dir, 'files/res-chk.cpp'), 'int main() {}\n');
    await s.registry.patch(p.id, { checker: 'old-chk.py' });
    await s.registry.patch(p.id, { language: { source: 'old-chk.py', lang: 'py3' } });
    let d = await s.registry.patch(p.id, { checker: 'new-chk.cpp' });
    assert.equal(d.config?.checker?.source, 'new-chk.cpp');
    // Options of the old file (its language) must not be carried over to the new checker.
    assert.equal(d.config?.checker?.lang, undefined);
    const paths = flattenFiles(d.tree).map(f => f.path);
    assert.ok(paths.includes('old-chk.py'), 'the old checker file stays on disk and in the tree');
    assert.equal(classifyFile('old-chk.py', d.config), 'other');
    assert.equal(classifyFile('new-chk.cpp', d.config), 'checker');
    // A source registered from files/ is shown under its role.
    d = await s.registry.patch(p.id, { checker: 'files/res-chk.cpp' });
    assert.equal(classifyFile('files/res-chk.cpp', d.config), 'checker');
    assert.equal(classifyFile('new-chk.cpp', d.config), 'other');
    for (const key of ['validator', 'interactor'] as const) {
      d = await s.registry.patch(p.id, { [key]: 'new-chk.cpp' });
      d = await s.registry.patch(p.id, { [key]: 'files/res-chk.cpp' });
      assert.ok(flattenFiles(d.tree).some(f => f.path === 'new-chk.cpp'));
    }
    d = await s.registry.patch(p.id, { lemonChecker: 'new-chk.cpp' });
    d = await s.registry.patch(p.id, { lemonChecker: 'files/res-chk.cpp' });
    d = await s.registry.patch(p.id, { generator: { source: 'generators/gen_random.cpp', enabled: false } });
    assert.ok(flattenFiles(d.tree).some(f => f.path === 'generators/gen_random.cpp'));
    assert.equal(classifyFile('generators/gen_random.cpp', d.config), 'generator');
    await assert.rejects(s.registry.patch(p.id, { checker: '../outside.cpp' }));
  } finally { await s.cleanup(); }
});

test('fileChanged and reads leave problem.toml alone unless a registration changes', async () => {
  const s = await setup('pf-toml-');
  try {
    const p = await s.registry.create({ name: 'quiet' });
    const file = path.join(p.dir, 'problem.toml');
    const text = '# keep me\n[problem]\nname = "quiet"\ntime_limit = 1000 # ms\nmemory_limit = 256\ninput = "stdin"\noutput = "stdout"\n\n[validator]\nsource = "validator.cpp"\n';
    await fs.writeFile(file, text);
    await s.registry.fileChanged(p.id, 'statement/zh/legend.tex');
    await s.registry.fileChanged(p.id, 'notes.txt', undefined, true);
    await s.registry.fileChanged(p.id, 'a.txt', 'b.txt');
    await s.registry.detail(p.id);
    assert.equal(await fs.readFile(file, 'utf8'), text);
    // A real change is still written (and a new solution registered).
    await s.registry.fileChanged(p.id, 'solutions/brute.cpp');
    const doc = parse(await fs.readFile(file, 'utf8')) as any;
    assert.deepEqual(JSON.parse(JSON.stringify(doc.solutions)), [{ source: 'solutions/brute.cpp', tag: 'MA' }]);
    assert.equal(doc.generators, undefined);

    // Missing input/output are filled once, even with concurrent reads.
    const legacy = '[problem] # legacy\nname = "quiet"\ntime_limit = 1000\nmemory_limit = 256\n';
    await fs.writeFile(file, legacy);
    await Promise.all([s.registry.detail(p.id), s.registry.list(), s.registry.detail(p.id), s.registry.list()]);
    const filled = await fs.readFile(file, 'utf8');
    assert.equal(filled.match(/^input = "stdin"$/gm)?.length, 1);
    assert.equal(filled.match(/^output = "stdout"$/gm)?.length, 1);
    assert.ok(filled.startsWith('[problem] # legacy\n'));
    const stat = await fs.stat(file);
    await s.registry.detail(p.id);
    assert.equal((await fs.stat(file)).mtimeMs, stat.mtimeMs, 'complete files are not rewritten on read');
  } finally { await s.cleanup(); }
});

test('deleting a contest removes its folder, allows re-creating it and respects running tasks', async () => {
  const s = await setup('pf-contest-del-');
  try {
    const p = await s.registry.create({ name: 'kept' });
    const c = await s.contests.create({ name: 'round', problems: [{ index: 'A', problem: p.id }] });
    await fs.writeFile(path.join(c.dir, 'files', 'announce.md'), 'hi');
    await fs.mkdir(path.join(c.dir, '.taskweave', 'batches'), { recursive: true });

    let release!: () => void;
    const blocker = new Promise<void>(r => (release = r));
    s.jobs.start('contest', `contest:${c.id}`, () => blocker);
    assert.equal((await s.call('DELETE', `/api/contests/${c.id}`)).statusCode, 409);
    assert.equal((await s.call('DELETE', `/api/problems/${p.id}`)).statusCode, 409, 'a contest batch works on its problems');
    release(); await new Promise(r => setTimeout(r, 20));

    const res = await s.call('DELETE', `/api/contests/${c.id}`);
    assert.equal(res.statusCode, 200);
    await assert.rejects(fs.stat(c.dir), 'the contest folder is gone');
    assert.ok((await fs.stat(path.join(p.dir, 'problem.toml'))).isFile(), 'referenced problems are untouched');
    const again = await s.contests.create({ name: 'round', problems: [{ index: 'A', problem: p.id }] });
    assert.equal(again.name, 'round');
  } finally { await s.cleanup(); }
});

test('raw files are served with nosniff and a restrictive CSP; problem.toml saves broadcast', async () => {
  const s = await setup('pf-raw-');
  try {
    const p = await s.registry.create({ name: 'raw' });
    await fs.mkdir(path.join(p.dir, 'statement/images'), { recursive: true });
    await fs.writeFile(path.join(p.dir, 'statement/images/a.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const r = await s.app.inject({ method: 'GET', url: `/api/problems/${p.id}/raw/statement/images/a.svg?token=test-only`, headers: { host: 'localhost' } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.match(String(r.headers['content-security-policy']), /default-src 'none'/);

    const events: string[] = [];
    const broadcast = s.hub.broadcast.bind(s.hub);
    s.hub.broadcast = (e) => { events.push(e.type); broadcast(e); };
    const toml = (await s.call('GET', `/api/problems/${p.id}/files/problem.toml`)).json();
    const saved = await s.call('PUT', `/api/problems/${p.id}/files/problem.toml`, { content: toml.content + '\n# edited\n', baseHash: toml.hash });
    assert.equal(saved.statusCode, 200);
    assert.ok(events.includes('problem:changed') && events.includes('problems:changed'));
  } finally { await s.cleanup(); }
});

test('language presets add and remove whole sections and keep the rest of languages.toml', async () => {
  const assets = await fs.readFile(path.join(import.meta.dirname, '../../../assets/languages.toml'), 'utf8');
  for (const id of ['cpp17', 'cpp20', 'cpp23', 'py3', 'java21']) {
    const p = LANGUAGE_PRESETS.find(x => x.id === id)!;
    assert.equal(languageSectionText(assets, id)?.replace(/\r/g, ''), p.text, `${id} preset matches the bundled languages.toml`);
  }
  const text = '# my file\r\n[cpp17]\r\nname = "mine" # custom\r\nrun = "{exe}"\r\n\r\n# about python\r\n[py3]\r\nname = "Python 3"\r\nrun = "python {src}"\r\n';
  const rust = LANGUAGE_PRESETS.find(x => x.id === 'rust')!;
  const added = addLanguageSection(text, rust);
  assert.ok(added.startsWith(text.trimEnd()));
  assert.ok(hasLanguageSection(added, 'rust'));
  assert.ok(!added.replace(/\r\n/g, '').includes('\n'), 'CRLF is kept');
  assert.equal(addLanguageSection(added, rust), added);
  assert.equal(removeLanguageSection(added, 'rust'), text);
  const noCpp = removeLanguageSection(text, 'cpp17');
  assert.equal(noCpp, '# my file\r\n\r\n# about python\r\n[py3]\r\nname = "Python 3"\r\nrun = "python {src}"\r\n');
  const parsed = parse(removeLanguageSection(text, 'py3')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), ['cpp17']);
  for (const p of LANGUAGE_PRESETS) assert.doesNotThrow(() => parse(p.text));
});

test('OI fonts that may not be redistributed come from the system or <global>/fonts, through a token-checked route', async () => {
  const s = await setup('pf-fonts-');
  try {
    await fs.mkdir(path.join(s.home, 'fonts'), { recursive: true });
    await fs.writeFile(path.join(s.home, 'fonts', 'SIMKAI.TTF'), 'fake font');
    const status = (await s.call('GET', '/api/system-fonts')).json();
    assert.equal(status.userDir, path.join(s.home, 'fonts'));
    assert.deepEqual(status.fonts.map((f: { key: string }) => f.key), ['simsun', 'simhei', 'simkai']);
    assert.equal(status.fonts.find((f: { key: string }) => f.key === 'simkai').found, true);
    const r = await s.app.inject({ method: 'GET', url: '/api/system-fonts/simkai?token=test-only', headers: { host: 'localhost' } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body, 'fake font', 'the user folder comes before the system fonts');
    assert.equal((await s.app.inject({ method: 'GET', url: '/api/system-fonts/simkai?token=wrong', headers: { host: 'localhost' } })).statusCode, 401);
    assert.equal((await s.call('GET', '/api/system-fonts/arial')).statusCode, 404);
  } finally { await s.cleanup(); }
});