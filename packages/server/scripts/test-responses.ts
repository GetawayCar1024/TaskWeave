import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ResponsesProvider } from '../src/ai/responses.js';
import type { AgentMessage } from '../src/ai/provider.js';

test('Responses streams text, replays reasoning and call IDs, and accounts for cached tokens', async () => {
  const requests: any[] = [];
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    requests.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (event: object) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    emit({ type: 'response.output_text.delta', delta: 'Working' });
    emit({ type: 'response.completed', response: {
      id: 'resp_test', object: 'response', status: 'completed',
      output: requests.length === 1 ? [
        { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Checking' }], encrypted_content: 'opaque-reasoning' },
        { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{"path":"problem.toml"}' },
      ] : [{ type: 'message', role: 'assistant', id: 'msg_1', status: 'completed', content: [{ type: 'output_text', text: 'Done', annotations: [] }] }],
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 10 } },
    } });
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as import('node:net').AddressInfo).port;
    const provider = new ResponsesProvider({ name: 'mock', protocol: 'openai-responses', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test-only', models: ['mock-model'] });
    const messages: AgentMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'Read the problem' }] }];
    let streamed = '';
    const first = await provider.chat({ model: 'mock-model', system: 'Test', tools: [], messages, onText: delta => streamed += delta });
    assert.equal(streamed, 'Working');
    assert.equal(first.stopReason, 'tool_use');
    assert.deepEqual(first.usage, { input: 60, output: 20, cacheRead: 40 });
    messages.push(first.message, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'problem data' }] });
    const second = await provider.chat({ model: 'mock-model', system: 'Test', tools: [], messages });
    assert.equal(second.stopReason, 'end_turn');
    assert.equal(requests[1].store, false);
    assert.ok(requests[1].input.some((i: any) => i.encrypted_content === 'opaque-reasoning'));
    assert.ok(requests[1].input.some((i: any) => i.type === 'function_call_output' && i.call_id === 'call_1' && i.output === 'problem data'));
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});

test('Responses maps incomplete reasons and tolerates usage without token details', async () => {
  const reasons = ['max_output_tokens', 'content_filter'];
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ type: 'response.incomplete', response: {
      id: 'resp_inc', object: 'response', status: 'incomplete', incomplete_details: { reason: reasons.shift() },
      output: [{ type: 'message', role: 'assistant', id: 'msg_1', status: 'incomplete', content: [{ type: 'output_text', text: 'Partial', annotations: [] }] }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    } })}\n\n`);
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as import('node:net').AddressInfo).port;
    const provider = new ResponsesProvider({ name: 'mock', protocol: 'openai-responses', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test-only', models: ['mock-model'] });
    const messages: AgentMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }];
    const cut = await provider.chat({ model: 'mock-model', system: 'Test', tools: [], messages });
    assert.equal(cut.stopReason, 'max_tokens');
    assert.deepEqual(cut.usage, { input: 10, output: 5, cacheRead: 0 });
    const filtered = await provider.chat({ model: 'mock-model', system: 'Test', tools: [], messages });
    assert.equal(filtered.stopReason, 'refusal');
    assert.equal(filtered.stopDetail, 'content_filter');
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});
