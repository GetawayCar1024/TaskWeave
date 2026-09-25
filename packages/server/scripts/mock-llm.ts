/**
 * Scripted mock of the Anthropic Messages API and the OpenAI Chat Completions API
 * (streaming), for testing the agent loop without a real model.
 *
 *   npx tsx scripts/mock-llm.ts <script.json> [--port 4800]
 *
 * The script is an array of turns: { text?, thinking?, tools?: [{ name, input }] }.
 * Turn N answers the request whose conversation already holds N assistant messages.
 * "{{last_result}}" in text is replaced by the last tool result the client sent.
 * The mock checks what a real API would reject: a missing system prompt, thinking
 * blocks not echoed back unchanged (Anthropic), tool results not returned.
 * GET /__requests returns every request body received.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({ options: { port: { type: 'string', default: '4800' } }, allowPositionals: true });
interface Turn {
  text?: string;
  thinking?: string;
  tools?: { name: string; input: unknown }[];
}
const script = JSON.parse(readFileSync(positionals[0], 'utf8')) as Turn[];
const requests: unknown[] = [];

const sse = (res: http.ServerResponse, event: string | null, data: unknown) => {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
};

function fill(text: string, last: string) {
  return text.replace('{{last_result}}', last.slice(0, 300));
}

function anthropic(body: any, res: http.ServerResponse) {
  const fail = (msg: string) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: msg } }));
  };
  if (!Array.isArray(body.system) || !body.system[0]?.cache_control) return fail('mock: expected a cached system prompt block');
  if (!Array.isArray(body.tools) || !body.tools.length) return fail('mock: expected tools');
  const assistants = body.messages.filter((m: any) => m.role === 'assistant');
  // Thinking blocks must come back verbatim, signature included.
  for (const [i, m] of assistants.entries()) {
    if (script[i]?.thinking && !m.content.some((b: any) => b.type === 'thinking' && b.signature === `sig-${i}` && b.thinking === script[i].thinking)) {
      return fail(`mock: thinking block of assistant turn ${i} was not echoed back unchanged`);
    }
  }
  const lastUser = body.messages[body.messages.length - 1];
  const results = (lastUser.content as any[]).filter((b) => b.type === 'tool_result');
  const prev = assistants[assistants.length - 1];
  const expected = prev ? prev.content.filter((b: any) => b.type === 'tool_use').length : 0;
  if (results.length !== expected) return fail(`mock: expected ${expected} tool_result blocks in one user message, got ${results.length}`);
  const last = results.length ? String(results[results.length - 1].content) : '';

  const turn = script[assistants.length] ?? { text: '(mock script exhausted)' };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  sse(res, 'message_start', {
    type: 'message_start',
    message: { id: `msg_${assistants.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 2000, cache_creation_input_tokens: 300 } },
  });
  let index = 0;
  if (turn.thinking) {
    sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
    sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: turn.thinking } });
    sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: `sig-${assistants.length}` } });
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: index++ });
  }
  if (turn.text) {
    const text = fill(turn.text, last);
    sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
    for (const part of text.match(/.{1,12}/gs) ?? []) sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: part } });
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: index++ });
  }
  for (const [k, t] of (turn.tools ?? []).entries()) {
    const json = JSON.stringify(t.input);
    sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_${assistants.length}_${k}`, name: t.name, input: {} } });
    for (const part of json.match(/.{1,40}/gs) ?? []) sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: part } });
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: index++ });
  }
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: turn.tools?.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 50 } });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function openai(body: any, res: http.ServerResponse) {
  const fail = (msg: string) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: msg, type: 'invalid_request_error' } }));
  };
  if (body.messages[0]?.role !== 'system') return fail('mock: expected a system message first');
  if (!Array.isArray(body.tools) || !body.tools.length) return fail('mock: expected tools');
  const assistants = body.messages.filter((m: any) => m.role === 'assistant');
  const prev = assistants[assistants.length - 1];
  const expected = prev?.tool_calls?.length ?? 0;
  const tail: any[] = [];
  for (let i = body.messages.length - 1; i >= 0 && body.messages[i].role === 'tool'; i--) tail.unshift(body.messages[i]);
  if (tail.length !== expected) return fail(`mock: expected ${expected} tool messages, got ${tail.length}`);
  const last = tail.length ? String(tail[tail.length - 1].content) : '';

  const turn = script[assistants.length] ?? { text: '(mock script exhausted)' };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta: unknown, finish: string | null = null) =>
    sse(res, null, { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] });
  chunk({ role: 'assistant' });
  if (turn.text) for (const part of fill(turn.text, last).match(/.{1,12}/gs) ?? []) chunk({ content: part });
  for (const [k, t] of (turn.tools ?? []).entries()) {
    const json = JSON.stringify(t.input);
    chunk({ tool_calls: [{ index: k, id: `call_${assistants.length}_${k}`, type: 'function', function: { name: t.name, arguments: '' } }] });
    for (const part of json.match(/.{1,40}/gs) ?? []) chunk({ tool_calls: [{ index: k, function: { arguments: part } }] });
  }
  chunk({}, turn.tools?.length ? 'tool_calls' : 'stop');
  // stream_options.include_usage: a final chunk with usage and no choices.
  if (body.stream_options?.include_usage) {
    sse(res, null, { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [], usage: { prompt_tokens: 1200, completion_tokens: 60, total_tokens: 1260, prompt_tokens_details: { cached_tokens: 1000 } } });
  }
  sse(res, null, '[DONE]');
  res.end();
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/__requests') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(requests));
    }
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model', type: 'model', created: 0, created_at: '2026-01-01T00:00:00Z', display_name: 'Mock' }], has_more: false, first_id: 'mock-model', last_id: 'mock-model' }));
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    requests.push({ path: url.pathname, body });
    if (url.pathname.endsWith('/messages')) {
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: 'msg_t', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'pong' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } }));
      }
      return anthropic(body, res);
    }
    if (url.pathname.endsWith('/chat/completions')) {
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: 'c', object: 'chat.completion', created: 0, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }] }));
      }
      return openai(body, res);
    }
    res.writeHead(404);
    res.end();
  })
  .listen(Number(values.port), '127.0.0.1', () => console.log(`[mock-llm] http://127.0.0.1:${values.port}  (${script.length} turns)`));
