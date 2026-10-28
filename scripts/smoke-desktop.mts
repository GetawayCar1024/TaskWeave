import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ZipWriter, readZip } from '../packages/server/src/util/zip.js';
import { TOKEN_HEADER } from '../packages/shared/src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'taskweave-desktop-smoke-')));
const exe = process.argv[2] || path.join(root, 'packages/desktop/dist', process.platform === 'linux' ? 'linux-unpacked/taskweave' : 'win-unpacked/TaskWeave.exe');
const token = 'isolated-desktop-smoke';
const env = { ...process.env, TASKWEAVE_HOME: home, TASKWEAVE_TOKEN: token }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(exe, process.env.CI && process.platform === 'linux' ? ['--no-sandbox'] : [], { env, stdio: ['ignore', 'ignore', 'pipe'] });
let log = ''; child.stderr.on('data', bytes => { log += bytes; });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
try {
  let base = '';
  for (let i = 0; i < 180 && !base; i++) {
    for (let port = 4523; port < 4530; port++) try {
      const candidate = `http://127.0.0.1:${port}`, response = await fetch(candidate + '/api/settings', { headers: { [TOKEN_HEADER]: token }, signal: AbortSignal.timeout(500) });
      if (response.ok && path.resolve((await response.json()).globalDir) === home) { base = candidate; break; }
    } catch { /* app is starting */ }
    if (!base) await pause(200);
  }
  assert.ok(base, `Packaged desktop did not start: ${log}`);
  const api = async (method: string, url: string, body?: unknown) => {
    const response = await fetch(base + '/api' + url, { method, headers: { [TOKEN_HEADER]: token, 'content-type': Buffer.isBuffer(body) ? 'application/zip' : 'application/json' }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body) });
    assert.ok(response.ok, `${url}: ${await response.clone().text()}`); return response;
  };
  const json = async (method: string, url: string, body?: unknown) => (await api(method, url, body)).json();
  const finish = async (job: any) => {
    for (let i = 0; i < 1800 && job.status === 'running'; i++) { await pause(100); job = await json('GET', '/jobs/' + job.id); }
    assert.equal(job.status, 'done', job.error ?? JSON.stringify(job)); return job.result;
  };
  assert.match(await (await fetch(base)).text(), /<title>TaskWeave<\/title>/);
  const config = (await json('GET', '/settings')).config; config.problems.roots = [path.join(home, 'problems')]; await json('PUT', '/settings', config);
  await json('POST', '/library/folders', { kind: 'problems', root: config.problems.roots[0], name: 'Training' });
  const full = await json('POST', '/problems', { name: 'native-smoke', folder: 'Training' });
  const generated = await finish(await json('POST', `/problems/${full.id}/tests/generate`, {}));
  assert.ok(generated.ok, JSON.stringify(generated.errors)); assert.ok(generated.tests.length);
  await fs.access(path.join(full.dir, '.taskweave/identity'));

  const zip = new ZipWriter(); zip.add('data/01.IN', '7\n'); zip.add('data/01.out', '700\r\n');
  zip.add('contest.cdf', JSON.stringify({ tasks: [{ sourceFileName: 'imported', problemTitle: 'Packaged CDF', comparisonMode: 3, realPrecision: 18, taskType: 0, testCases: [{ fullScore: 100, timeLimit: 1000, memoryLimit: 256, inputFiles: ['01.in'], outputFiles: ['01.ans'] }] }] }));
  const uploaded = await json('POST', '/packages/uploads?format=auto', zip.finish()); assert.equal(uploaded.format, 'lemonlime');
  const batch = await json('POST', '/packages/import', { items: [{ uploadId: uploaded.id, format: uploaded.format, name: 'imported', folder: 'Training' }] });
  assert.ok(batch.items[0].result, JSON.stringify(batch)); const p = batch.items[0].result.problem;
  assert.equal(p.folder, 'Training'); assert.equal(JSON.parse(await fs.readFile(path.join(p.dir, '.taskweave/tests/manifest.json'), 'utf8')).tests.length, 1);
  const contest = await json('POST', '/contests', { name: 'smoke-round', problems: [{ index: 'A', problem: p.id }] });
  const lemon = await finish(await json('POST', `/contests/${contest.id}/batch`, { action: 'export', exportFormat: 'lemonlime' }));
  const packed = readZip(Buffer.from(await (await api('GET', `/contests/${contest.id}/export/${lemon.file}`)).arrayBuffer()));
  const task = JSON.parse(packed.get('smoke-round.cdf')!.toString()).tasks[0]; assert.equal(task.comparisonMode, 3); assert.equal(task.realPrecision, 18);
  const fps = await finish(await json('POST', `/problems/${p.id}/export`, { format: 'fps' }));
  assert.match(await (await api('GET', `/problems/${p.id}/export/${fps.file}`)).text(), /<fps version=/);
  await json('PUT', `/problems/${p.id}/files/solutions/std.cpp`, { content: '#include <iostream>\nint main(){int n;std::cin>>n;std::cout<<n*3<<"\\n";}' });
  await finish(await json('POST', `/problems/${p.id}/answers/regenerate`, { source: 'solutions/std.cpp' }));
  assert.equal((await json('GET', `/problems/${p.id}/files/tests/manual/1.ans`)).content.trim(), '21');
  await finish(await json('POST', `/problems/${p.id}/answers/restore`, {}));
  assert.equal((await json('GET', `/problems/${p.id}/files/tests/manual/1.ans`)).content, '700\r\n');
  console.log('PASS packaged desktop: TaskWeave UI, native judging, nested library, CDF/FPS exports and exact answer restoration');
} finally {
  if (child.exitCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else { child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(5000)]); }
  }
  await pause(500); await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
