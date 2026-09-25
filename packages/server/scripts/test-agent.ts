/**
 * End-to-end check of the AI agent against scripts/mock-llm.ts, for both protocols.
 * Needs: `npx tsx scripts/mock-llm.ts scripts/mock-llm-demo.json` on :4800 and a
 * PolyForge server on :4600 (POLYFORGE_TOKEN=tok, problem root <home>/probs).
 *   npx tsx scripts/test-agent.ts <home>
 */
import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';

const HOME = process.argv[2];
const H = { 'x-polyforge-token': 'tok', 'content-type': 'application/json' };
const api = async (method: string, p: string, body?: unknown): Promise<any> => {
  const res = await fetch(`http://127.0.0.1:4600/api${p}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${p}: ${JSON.stringify(data)}`);
  return data;
};
const check = (cond: boolean, msg: string) => {
  console.log(cond ? '  ✓' : '  ✗', msg);
  if (!cond) process.exitCode = 1;
};

await api('PUT', '/ai/endpoints', [
  { name: 'mock-anthropic', protocol: 'anthropic', baseUrl: 'http://127.0.0.1:4800', apiKey: 'test-key-anthropic', models: ['claude-opus-5'] },
  { name: 'mock-openai', protocol: 'openai', baseUrl: 'http://127.0.0.1:4800/v1', apiKey: 'test-key-openai', models: ['gpt-mock'] },
]);
const eps = await api('GET', '/ai/endpoints');
check(eps.length === 2 && eps.every((e: any) => e.hasKey && !e.apiKey.includes('test-key')), 'endpoints saved, keys masked');
for (const name of ['mock-anthropic', 'mock-openai']) {
  const t = await api('POST', '/ai/endpoints/test', { name });
  check(t.ok && t.reply === 'pong', `${name}: test connection (${t.ms} ms)`);
  const models = await api('POST', '/ai/endpoints/models', { name });
  check(models.includes('mock-model'), `${name}: list models`);
}

for (const [endpoint, problem] of [
  ['mock-anthropic', 'agent-anthropic'],
  ['mock-openai', 'agent-openai'],
] as const) {
  console.log(`\n== ${endpoint}`);
  await api('POST', '/problems', { name: problem, title: { en: 'A+B' } });
  const real = path.join(HOME, 'probs', problem);
  const notesBefore = await fsp.readFile(path.join(real, 'statement/en/notes.tex'), 'utf8');
  const s = await api('POST', `/problems/${problem}/ai/sessions`, { endpoint });
  await api('POST', `/problems/${problem}/ai/sessions/${s.id}/messages`, { text: 'Add a brute-force solution and verify the problem.' });
  let d: any;
  for (let i = 0; i < 300; i++) {
    await new Promise((r) => setTimeout(r, 300));
    d = await api('GET', `/problems/${problem}/ai/sessions/${s.id}`);
    if (d.state !== 'running') break;
  }
  check(d.state === 'idle', `agent finished (state ${d.state}${d.error ? `: ${d.error}` : ''})`);
  const tools = d.transcript.filter((x: any) => x.kind === 'tool');
  check(tools.length === 14, `14 tool calls made (${tools.map((t: any) => t.name).join(', ')})`);
  check(tools.every((t: any) => t.result !== undefined), 'every tool call has a result');
  const bad = tools.filter((t: any) => t.isError).map((t: any) => t.name);
  check(bad.length === 2 && bad.includes('edit_file') && bad.includes('run'), `invalid problem.toml edit and malformed run input were rejected (${bad})`);
  const final = d.transcript.filter((x: any) => x.kind === 'assistant').pop()?.text ?? '';
  check(/brute\.cpp \[TL-OR-OK\] matches tag/.test(final), `final answer quotes the invocation result: "${final.slice(0, 120)}…"`);
  check(d.plan.length === 3 && d.plan.every((p: any) => p.status === 'done'), 'plan checklist updated');
  if (endpoint === 'mock-anthropic') check(d.transcript.some((x: any) => x.kind === 'thinking'), 'thinking summary shown');

  const changes = await api('GET', `/problems/${problem}/ai/sessions/${s.id}/changes`);
  const summary = changes.map((c: any) => `${c.status}:${c.path}`).sort();
  check(
    summary.join() === ['added:solutions/brute.cpp', 'added:validator-tests/01.invalid.in', 'modified:problem.toml', 'modified:statement/en/notes.tex'].join(),
    `change set spans 4 files: ${summary.join(', ')}`,
  );
  check(!existsSync(path.join(real, 'solutions/brute.cpp')), 'real problem untouched before review');
  const c = await api('GET', `/problems/${problem}/ai/sessions/${s.id}/changes/content?path=problem.toml`);
  check(c.modified.includes('brute.cpp') && !c.original.includes('brute.cpp'), 'diff content for problem.toml');

  await api('POST', `/problems/${problem}/ai/sessions/${s.id}/changes/accept`, { paths: ['solutions/brute.cpp', 'problem.toml', 'validator-tests/01.invalid.in'] });
  const left = await api('POST', `/problems/${problem}/ai/sessions/${s.id}/changes/reject`, { paths: ['statement/en/notes.tex'] });
  check(left.length === 0, 'all changes reviewed');
  check(existsSync(path.join(real, 'solutions/brute.cpp')), 'accepted file written to the real problem');
  check((await fsp.readFile(path.join(real, 'problem.toml'), 'utf8')).includes('solutions/brute.cpp'), 'accepted problem.toml change applied');
  check((await fsp.readFile(path.join(real, 'statement/en/notes.tex'), 'utf8')) === notesBefore, 'rejected file left as it was');
  const detail = await api('GET', `/problems/${problem}`);
  check(detail.config.solutions.some((x: any) => x.source === 'solutions/brute.cpp' && x.tag === 'TL-OR-OK'), 'problem now lists brute.cpp as TL-OR-OK');
}
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
