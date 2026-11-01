import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GlobalStore } from '../src/global.js';
import { ProblemRegistry } from '../src/workspace/problems.js';
import { ContestRegistry } from '../src/workspace/contests.js';
import { FileService, SelfWrites } from '../src/workspace/files.js';
import { ProblemWatcher } from '../src/workspace/watcher.js';
import { JobManager } from '../src/jobs.js';
import { Judge } from '../src/judge/index.js';
import { WsHub } from '../src/ws.js';
import { buildApp } from '../src/app.js';
import { PolygonSync } from '../src/polygon/sync.js';
import { lemonHost } from '../src/judge/lemonlime.js';
import { pushContestToLemonServer } from '../src/lemonserver/push.js';
import { readZip, ZipWriter } from '../src/util/zip.js';

const zip = (files: Record<string, string | Buffer>) => { const w = new ZipWriter(); for (const [name, bytes] of Object.entries(files)) w.add(name, bytes); return w.finish(); };
const job = () => ({ signal: new AbortController().signal, progress() {} });
const body = (req: IncomingMessage) => new Promise<Buffer>((resolve) => { const chunks: Buffer[] = []; req.on('data', c => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); });

/** A LemonServer stand-in: API key "llk_test" or access token "123456" (exchanged for a session). */
async function mockLemonServer(platform: string) {
  const contests = new Map<string, Map<string, Buffer>>();
  const calls: { method: string; path: string; raw: string; query: Record<string, string>; json?: any }[] = [];
  const valid = new Set(['llk_test']);
  const state = { failCompile: false, busy: new Set<string>() };
  const props = new Map<string, { startTime?: number | null; endTime?: number | null; down?: Buffer }>();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x'), data = await body(req);
    const query = Object.fromEntries(url.searchParams);
    const json = req.headers['content-type']?.includes('json') && data.length ? JSON.parse(data.toString()) : undefined;
    calls.push({ method: req.method!, path: url.pathname, raw: req.url!, query, json });
    const send = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    const auth = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (url.pathname === '/api/auth/status') return send(200, { authenticated: valid.has(auth), version: '2.3', lemonlimeVersion: '0.3.7', platform, setupRequired: false });
    if (url.pathname === '/api/auth/login') { if (json?.token !== '123456') return send(401, { error: 'Wrong token' }); valid.add('session-1'); return send(200, { session: 'session-1' }); }
    if (!valid.has(auth)) return send(401, { error: 'Not authenticated' });
    if (url.pathname === '/api/contests' && req.method === 'GET') return send(200, { contestRoot: '/srv/c', current: '', judging: false, contests: [...contests.keys()].map(name => ({ name, judging: false, busy: state.busy.has(name), queuedJobs: state.busy.has(name) ? 1 : 0 })) });
    if (url.pathname === '/api/import-contest') {
      const name = query.name;
      if (contests.has(name) && query.overwrite !== '1') return send(400, { error: `Contest ${name} already exists` });
      contests.set(name, readZip(data)); props.delete(name);
      return send(201, { ok: true, name });
    }
    const m = url.pathname.match(/^\/api\/contests\/([^/]+)(\/.*)?$/);
    const files = m && contests.get(decodeURIComponent(m[1]));
    if (!m || !files) return send(404, { error: 'no such contest' });
    const rest = m[2] ?? '';
    const key = decodeURIComponent(m[1]), p = props.get(key) ?? {};
    if (!rest && req.method === 'PUT') { props.set(key, { ...p, startTime: json.startTime, endTime: json.endTime }); return send(200, { ok: true }); }
    if (!rest) return send(200, { name: key, directory: `/srv/c/${key}`, startTime: p.startTime ?? null, endTime: p.endTime ?? null, downZip: p.down ? { path: 'down.zip', exists: true } : null });
    if (rest === '/down-zip' && req.method === 'GET') { if (!p.down) return send(404, { error: 'This contest has no down.zip' }); res.writeHead(200, { 'content-type': 'application/zip' }); return res.end(p.down); }
    if (rest === '/down-zip') { if (!data.subarray(0, 2).equals(Buffer.from('PK'))) return send(400, { error: 'Not a valid zip archive' }); props.set(key, { ...p, down: data }); return send(200, { downZip: { path: 'down.zip' } }); }
    if (rest === '/files/download') {
      const w = new ZipWriter();
      for (const [f, b] of files) if (f.startsWith(`${query.root}/`) && !f.endsWith('/')) w.add(f.slice(query.root.length + 1), b);
      res.writeHead(200, { 'content-type': 'application/zip' }); return res.end(w.finish());
    }
    if (rest === '/files/unzip') { for (const [f, b] of readZip(data)) files.set(`${query.root}/${f}`, b); return send(200, { ok: true }); }
    if (rest === '/refresh') return send(200, { ok: true });
    if (rest === '/files/compile') {
      const ok = !state.failCompile && files.has(`data/${json.path}`);
      if (ok) files.set(`data/${json.output}${/windows/i.test(platform) ? '.exe' : ''}`, Buffer.from('binary'));
      return send(200, { ok, output: ok ? '' : 'error: no such source', executable: json.output });
    }
    return send(404, { error: 'no such API endpoint' });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, contests, props, calls, state, close: () => new Promise(r => server.close(r)) };
}

async function fixture(run: (f: { global: GlobalStore; registry: ProblemRegistry; judge: Judge; contests: ContestRegistry; call: (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object | Buffer) => Promise<{ statusCode: number; body: string; json: () => any }> }) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-lemonserver-'));
  const global = new GlobalStore(dir); await global.init(); global.config.problems.roots = [path.join(dir, 'problems')];
  const registry = new ProblemRegistry(global), contests = new ContestRegistry(registry, global), hub = new WsHub();
  const judge = new Judge(global, registry, hub), files = new FileService(new SelfWrites()), watcher = new ProblemWatcher(registry, files, hub);
  const app = await buildApp({ global, registry, contests, hub, judge, files, watcher, jobs: new JobManager(hub), token: 'test-only' });
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object | Buffer) => app.inject({ method, url, payload, headers: { host: 'localhost', 'x-taskweave-token': 'test-only', ...(Buffer.isBuffer(payload) ? { 'content-type': 'application/zip' } : {}) } });
  try { await run({ global, registry, judge, contests, call }); }
  finally { await app.close(); await watcher.stop(); await fs.rm(dir, { recursive: true, force: true }); }
}

async function dataContest(f: Parameters<Parameters<typeof fixture>[0]>[0]) {
  const response = await f.call('POST', '/api/problems/import/package?format=luogu-data&name=push-data', zip({ '1.in': 'x\n', '1.out': 'y\n', 'config.yml': '1.in: { score: 100 }' }));
  assert.equal(response.statusCode, 200, response.body);
  const p = response.json().problem;
  return { problem: p.id as string, contest: await f.contests.create({ name: 'push-round', problems: [{ index: 'A', problem: p.id }] }) };
}

test('LemonServer settings: masked key, address validation, test with an API key or an access token', async () => fixture(async ({ global, call }) => {
  const mock = await mockLemonServer('Windows 11 Version 24H2');
  try {
    let r = await call('POST', '/api/lemonserver/test');
    assert.equal(r.statusCode, 400); assert.equal(r.json().error, 'no_lemonserver');
    r = await call('PUT', '/api/secrets', { lemonServer: { url: 'ftp://x' } });
    assert.equal(r.statusCode, 400);
    r = await call('PUT', '/api/secrets', { lemonServer: { url: `${mock.url}/`, key: 'llk_test_not_valid' } });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json().lemonServer, { url: mock.url, key: 'llk_…id', hasKey: true });
    r = await call('POST', '/api/lemonserver/test');
    // A rejected LemonServer credential must never be a 401: the UI reads that as "TaskWeave's token is wrong".
    assert.equal(r.statusCode, 400, r.body); assert.equal(r.json().error, 'lemonserver_auth');
    assert.match(r.json().message, /rejected the API key/);
    assert.ok(!mock.calls.some(c => c.path === '/api/auth/login'), 'an API key is not tried as an access token');
    await call('PUT', '/api/secrets', { lemonServer: { key: 'not-the-token' } });
    r = await call('POST', '/api/lemonserver/test');
    assert.equal(r.statusCode, 400, r.body); assert.equal(r.json().error, 'lemonserver_auth');
    await call('PUT', '/api/secrets', { lemonServer: { key: '123456' } });
    r = await call('POST', '/api/lemonserver/test');
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().target, 'windows'); assert.equal(r.json().version, 'LemonServer 2.3');
    // Saving the Polygon tab keeps the LemonServer settings and vice versa.
    await call('PUT', '/api/secrets', { polygon: { key: 'pk', secret: 'ps' } });
    assert.equal((await global.lemonServerCredentials()).key, '123456');
    await call('PUT', '/api/secrets', { lemonServer: { clearKey: true } });
    assert.equal((await global.lemonServerCredentials()).key, '');
    assert.equal((await global.polygonCredentials()).key, 'pk');
  } finally { await mock.close(); }
}));

test('pushing a contest imports the package built for the server system, refuses to replace silently and keeps contestant programs', async () => fixture(async (f) => {
  const other = lemonHost() === 'windows' ? 'Ubuntu 24.04 LTS' : 'Windows 11 Version 24H2';
  const mock = await mockLemonServer(other);
  try {
    await f.global.saveSecrets({ lemonServer: { url: mock.url, key: 'llk_test' } });
    const { contest } = await dataContest(f);
    const deps = { judge: f.judge, contests: f.contests, sync: new PolygonSync(f.judge) };
    const r = await pushContestToLemonServer(deps, contest.id, { action: 'lemon-push', lemonServer: { name: 'Round 1' } }, job());
    assert.equal(r.action, 'lemon-push'); assert.equal(r.file, undefined);
    assert.equal(r.lemonServer?.name, 'Round 1');
    // Qt reads the query literally: a space must be %20, never '+'.
    assert.ok(mock.calls.some(c => c.raw.includes('name=Round%201')) && !mock.calls.some(c => c.raw.includes('Round+1')));
    const files = mock.contests.get('Round 1')!;
    assert.ok(files.has('push-round.cdf') && files.has('data/push-data/push-data1.in'));
    assert.deepEqual(await fs.readdir(path.join(contest.dir, '.taskweave/export')), [], 'the uploaded package is not kept');

    await assert.rejects(pushContestToLemonServer(deps, contest.id, { action: 'lemon-push', lemonServer: { name: 'Round 1' } }, job()), /already exists/);
    files.set('source/alice/push-data.cpp', Buffer.from('int main(){}'));
    const again = await pushContestToLemonServer(deps, contest.id, { action: 'lemon-push', lemonServer: { name: 'Round 1', overwrite: true, keepSources: true } }, job());
    assert.equal(again.lemonServer?.keptSources, 1);
    assert.equal(mock.contests.get('Round 1')!.get('source/alice/push-data.cpp')?.toString(), 'int main(){}');
    assert.ok(mock.calls.some(c => c.path.endsWith('/refresh')));
    await assert.rejects(pushContestToLemonServer(deps, contest.id, { action: 'lemon-push', lemonServer: { name: 'bad/name' } }, job()), /Invalid LemonServer contest name/);
    // LemonServer 0.1.3+: a contest that is judged or queued for judging cannot be replaced.
    mock.state.busy.add('Round 1');
    await assert.rejects(pushContestToLemonServer(deps, contest.id, { action: 'lemon-push', lemonServer: { name: 'Round 1', overwrite: true } }, job()), /queued for judging/);
  } finally { await mock.close(); }
}));

test('custom Lemon checkers for another system are compiled on the server with the shipped headers', async () => fixture(async (f) => {
  const other = lemonHost() === 'windows' ? 'Ubuntu 24.04 LTS' : 'Windows 11 Version 24H2';
  const mock = await mockLemonServer(other);
  try {
    await f.global.saveSecrets({ lemonServer: { url: mock.url, key: 'llk_test' } });
    const { problem, contest } = await dataContest(f);
    const dir = (await f.registry.get(problem)).dir;
    await fs.writeFile(path.join(dir, 'chk.cpp'), '#include "lemon/testlib.h"\nint main(int argc, char *argv[]) { registerLemonChecker(argc, argv); quitf(_ok, "ok"); }\n');
    await f.registry.patch(problem, { lemonChecker: 'chk.cpp' });
    const r = await pushContestToLemonServer({ judge: f.judge, contests: f.contests, sync: new PolygonSync(f.judge) }, contest.id, { action: 'lemon-push' }, job());
    assert.equal(r.lemonServer?.compiled, 1, JSON.stringify(r.items));
    const compile = mock.calls.find(c => c.path.endsWith('/files/compile'))!;
    assert.equal(compile.json.root, 'data'); assert.equal(compile.json.bundledTestlib, false);
    assert.equal(compile.json.path, 'push-data/checker-sources/problem/chk.cpp');
    assert.equal(compile.json.output, 'push-data/checker');
    assert.match(compile.json.arguments, /-I "\/srv\/c\/push-round\/data\/push-data\/checker-sources\/shared"/);
    const cdf = JSON.parse(mock.contests.get('push-round')!.get('push-round.cdf')!.toString());
    assert.equal(cdf.tasks[0].specialJudge, `push-data/checker${other.startsWith('Windows') ? '.exe' : ''}`);
  } finally { await mock.close(); }
}));

test('on the same system the server still compiles checkers after the push, and a failed build keeps the uploaded one', async () => fixture(async (f) => {
  const same = lemonHost() === 'windows' ? 'Windows 11 Version 24H2' : 'Ubuntu 24.04 LTS';
  const mock = await mockLemonServer(same);
  try {
    await f.global.saveSecrets({ lemonServer: { url: mock.url, key: 'llk_test' } });
    const { problem, contest } = await dataContest(f);
    await fs.writeFile(path.join((await f.registry.get(problem)).dir, 'chk.cpp'), '#include "lemon/testlib.h"\nint main(int argc, char *argv[]) { registerLemonChecker(argc, argv); if (ouf.readWord() == ans.readWord()) quitf(_ok, "ok"); quitf(_wa, "wrong"); }\n');
    await f.registry.patch(problem, { lemonChecker: 'chk.cpp' });
    const deps = { judge: f.judge, contests: f.contests, sync: new PolygonSync(f.judge) };
    let r = await pushContestToLemonServer(deps, contest.id, { action: 'lemon-push' }, job());
    assert.equal(r.lemonServer?.compiled, 1, JSON.stringify(r.items));
    assert.ok(mock.contests.get('push-round')!.has(`data/push-data/checker${same.startsWith('Windows') ? '.exe' : ''}`));
    // the server cannot build it (e.g. no C++ compiler): the checker built here stays
    mock.state.failCompile = true;
    r = await pushContestToLemonServer(deps, contest.id, { action: 'lemon-push', lemonServer: { overwrite: true } }, job());
    assert.equal(r.items[0].ok, true); assert.equal(r.lemonServer?.compiled, 0);
    assert.ok(r.items[0].details?.some(d => d.includes('the checker built by TaskWeave is used')));
    assert.ok(mock.contests.get('push-round')!.has(`data/push-data/checker${same.startsWith('Windows') ? '.exe' : ''}`));
    const before = mock.calls.length;
    r = await pushContestToLemonServer(deps, contest.id, { action: 'lemon-push', lemonServer: { overwrite: true, compileOnServer: false } }, job());
    assert.ok(!mock.calls.slice(before).some(c => c.path.endsWith('/files/compile')), 'compiling can be turned off on the same system');
    assert.equal(r.items[0].ok, true);
  } finally { await mock.close(); }
}));
test('down.zip goes along with the push, the contest time and the previous down.zip survive a replacement', async () => fixture(async (f) => {
  const mock = await mockLemonServer('Windows 11 Version 24H2');
  try {
    await f.global.saveSecrets({ lemonServer: { url: mock.url, key: 'llk_test' } });
    const { problem, contest } = await dataContest(f);
    await f.registry.patch(problem, { samples: '1' });
    const deps = { judge: f.judge, contests: f.contests, sync: new PolygonSync(f.judge) };
    let r = await pushContestToLemonServer(deps, contest.id, { action: 'lemon-push', lemonServer: { down: { mode: 'samples', lang: 'en' } } }, job());
    assert.equal(r.lemonServer?.downZip, 'uploaded');
    const down = readZip(mock.props.get('push-round')!.down!);
    assert.equal(down.get('push-data/push-data1.in')?.toString(), 'x\n');
    mock.props.set('push-round', { ...mock.props.get('push-round'), startTime: 1_800_000_000_000, endTime: 1_800_010_000_000 });
    r = await pushContestToLemonServer(deps, contest.id, { action: 'lemon-push', lemonServer: { overwrite: true } }, job());
    assert.equal(r.lemonServer?.downZip, 'kept'); assert.equal(r.lemonServer?.keptTime, true);
    assert.equal(mock.props.get('push-round')?.startTime, 1_800_000_000_000);
    assert.ok(mock.props.get('push-round')?.down);
    // A PDF must come with the statement snapshot it was rendered from.
    await assert.rejects(pushContestToLemonServer(deps, contest.id, { action: 'lemon-push', lemonServer: { overwrite: true, down: { mode: 'pdf', lang: 'en', pdf: Buffer.from('%PDF-1.7').toString('base64'), statements: [], notes: '' } } }, job()), /changed|statement/i);
  } finally { await mock.close(); }
}));