import type OpenAI from 'openai';
import type { AiTestResult } from '@taskweave/shared';
import { OpenAiProvider } from './openai.js';
import { cleanApiError, ToolInputParseError, type Block, type ChatRequest, type ChatResponse, type StopReason } from './provider.js';

/** Stateless Responses conversations: replay output items, including encrypted reasoning. */
export class ResponsesProvider extends OpenAiProvider {
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const input: OpenAI.Responses.ResponseInputItem[] = [];
    for (const m of req.messages) {
      if (m.role === 'assistant' && m.raw?.protocol === 'openai-responses' && m.raw.model === req.model) {
        input.push(...m.raw.content as OpenAI.Responses.ResponseInputItem[]);
        continue;
      }
      for (const b of m.content) {
        if (b.type === 'text') input.push({ role: m.role, content: b.text });
        if (b.type === 'tool_use') input.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
        if (b.type === 'tool_result') input.push({ type: 'function_call_output', call_id: b.tool_use_id, output: b.is_error ? `ERROR: ${b.content}` : b.content });
      }
    }
    const stream = await this.client.responses.create({
      model: req.model, instructions: req.system, input, stream: true, store: false,
      include: ['reasoning.encrypted_content'],
      tools: req.tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema, strict: false })),
    }, { signal: req.signal });
    let response: OpenAI.Responses.Response | undefined;
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') req.onText?.(event.delta);
      if (event.type === 'response.reasoning_summary_text.delta') req.onThinking?.(event.delta);
      if (event.type === 'response.completed' || event.type === 'response.incomplete') response = event.response;
      if (event.type === 'response.failed') throw new Error(event.response.error?.message ?? 'Responses request failed');
      if (event.type === 'error') throw new Error(event.message);
    }
    if (!response) throw new Error('Responses stream ended before a final response');
    const content: Block[] = [];
    let refused = false;
    for (const item of response.output) {
      if (item.type === 'message') for (const part of item.content) {
        if (part.type === 'output_text') content.push({ type: 'text', text: part.text });
        if (part.type === 'refusal') { refused = true; content.push({ type: 'text', text: part.refusal }); }
      }
      if (item.type === 'reasoning') for (const part of item.summary) content.push({ type: 'thinking', text: part.text });
      if (item.type === 'function_call') {
        let args: unknown;
        try { args = JSON.parse(item.arguments || '{}'); }
        catch { throw new ToolInputParseError(`tool ${item.name}: arguments are not valid JSON`); }
        content.push({ type: 'tool_use', id: item.call_id, name: item.name, input: args });
      }
    }
    const u = response.usage;
    const cached = u?.input_tokens_details?.cached_tokens ?? 0;
    const incomplete = response.status === 'incomplete' ? response.incomplete_details?.reason ?? 'incomplete' : undefined;
    const stopReason: StopReason = incomplete === 'max_output_tokens' ? 'max_tokens' : incomplete === 'content_filter' || refused ? 'refusal' : incomplete ? 'other' : content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
    return {
      message: { role: 'assistant', content, raw: { protocol: 'openai-responses', model: req.model, content: response.output } },
      stopReason,
      stopDetail: incomplete ?? (refused ? 'refusal' : undefined),
      usage: u ? { input: (u.input_tokens ?? 0) - cached, output: u.output_tokens ?? 0, cacheRead: cached } : undefined,
    };
  }

  async test(model: string): Promise<AiTestResult> {
    const started = Date.now();
    try {
      const r = await this.client.responses.create({ model, input: 'Reply with the single word: pong', store: false }, { timeout: 60_000, maxRetries: 0 });
      return { ok: true, ms: Date.now() - started, reply: r.output_text.slice(0, 100) };
    } catch (e) { return { ok: false, ms: Date.now() - started, error: cleanApiError(e) }; }
  }
}
