import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GlobalStore } from '../src/global.js';
import { ProblemRegistry } from '../src/workspace/problems.js';
import { Judge } from '../src/judge/index.js';
import { WsHub } from '../src/ws.js';
import { Sandbox } from '../src/ai/sandbox.js';
import { AgentService } from '../src/ai/agent.js';
import { runTool, toolsFor } from '../src/ai/tools.js';

test('compatibility AI offers file/data tools and rejects judging or a mode escape in its sandbox', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-compat-ai-'));
  try {
    const global = new GlobalStore(home); await global.init(); global.config.problems.roots = [path.join(home, 'problems')];
    const registry = new ProblemRegistry(global), judge = new Judge(global, registry, new WsHub());
    const p = await registry.create({ name: 'compat', dataOnly: true });
    const sandbox = new Sandbox(p.dir, path.join(home, 'work'), new Set()); await sandbox.sync();
    const ctx = await judge.ctx(p.id);
    let contextReads = 0;
    const env = { judge, sandbox, ctx: async () => { contextReads++; return { ...ctx, ref: { ...ctx.ref, dir: sandbox.dir } }; }, authoring: async () => false,
      signal: new AbortController().signal, setPlan() {}, changed() {} };
    const definition = toolsFor('agent', true).map(tool => tool.name);
    assert.ok(definition.includes('write_file')); assert.ok(definition.includes('generate_tests'));
    assert.ok(!definition.includes('run_invocation')); assert.ok(!definition.includes('compile'));
    const denied = await runTool('run_invocation', {}, env);
    assert.equal(denied.isError, true); assert.match(denied.content, /compatibility/i); assert.equal(contextReads, 0);
    const before = await sandbox.read('problem.toml');
    const escaped = await runTool('write_file', { path: 'problem.toml', content: before.toString().replace('data_only = true', 'data_only = false') }, env);
    assert.equal(escaped.isError, true); assert.deepEqual(await sandbox.read('problem.toml'), before);
    const wrote = await runTool('write_file', { path: 'statement/en/legend.tex', content: 'Editable in compatibility mode.' }, env);
    assert.equal(wrote.isError, false);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('switching to full authoring retains the same AI session history', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-ai-upgrade-'));
  try {
    const global = new GlobalStore(home); await global.init(); global.config.problems.roots = [path.join(home, 'problems')];
    await global.saveAiEndpoints([{ name: 'fixture', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:9', apiKey: 'fixture-only', models: ['fixture'] }]);
    const registry = new ProblemRegistry(global), hub = new WsHub(), judge = new Judge(global, registry, hub), agent = new AgentService(judge, hub);
    const p = await registry.create({ name: 'upgradable' }); await registry.patch(p.id, { dataOnly: true });
    const session = await agent.create(p.id, { title: 'Keep this session', endpoint: 'fixture' });
    await registry.patch(p.id, { dataOnly: false });
    assert.equal((await agent.get(p.id, session.id)).title, 'Keep this session');
    assert.equal((await agent.list(p.id))[0].id, session.id);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
