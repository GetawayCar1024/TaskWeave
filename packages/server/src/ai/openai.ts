import OpenAI from 'openai';
import type { AiTestResult } from '@polyforge/shared';
import type { RawAiEndpoint } from '../global.js';
import type { AgentMessage, Block, ChatRequest, ChatResponse, Provider, StopReason } from './provider.js';
import { cleanApiError, ToolInputParseError } from './provider.js';

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/**
 * OpenAI Chat Completions protocol, used for OpenAI-compatible endpoints and proxies
 * (DESIGN §4.4). Tool calls are streamed and reassembled from their deltas.
 */
export class OpenAiProvider implements Provider {
  private client: OpenAI;

  constructor(ep: RawAiEndpoint) {
    this.client = new OpenAI({ apiKey: ep.apiKey || 'none', baseURL: ep.baseUrl || undefined, maxRetries: 3 });
  }

  private toParams(system: string, messages: AgentMessage[]): Msg[] {
    const out: Msg[] = [{ role: 'system', content: system }];
    for (const m of messages) {
      if (m.role === 'assistant') {
        const text = m.content.filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('');
        const calls = m.content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
        out.push({
          role: 'assistant',
          content: text || null,
          ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) } : {}),
        });
      } else {
        for (const b of m.content) {
          if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? `ERROR: ${b.content}` : b.content });
        }
        const text = m.content.filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('\n\n');
        if (text) out.push({ role: 'user', content: text });
      }
    }
    return out;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const stream = await this.client.chat.completions.create(
      {
        model: req.model,
        stream: true,
        stream_options: { include_usage: true },
        messages: this.toParams(req.system, req.messages),
        tools: req.tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.input_schema } })),
      },
      { signal: req.signal },
    );
    let text = '';
    let finish: string | null = null;
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let usage: ChatResponse['usage'];
    for await (const chunk of stream) {
      if (chunk.usage) {
        // prompt_tokens includes the cached part.
        const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
        usage = { input: chunk.usage.prompt_tokens - cached, output: chunk.usage.completion_tokens, cacheRead: cached, cacheWrite: 0 };
      }
      const choice = chunk.choices[0];
      if (!choice) continue;
      const d = choice.delta;
      if (d?.content) {
        text += d.content;
        req.onText?.(d.content);
      }
      // Some compatible servers stream reasoning separately.
      const reasoning = (d as { reasoning_content?: string } | undefined)?.reasoning_content;
      if (reasoning) req.onThinking?.(reasoning);
      for (const tc of d?.tool_calls ?? []) {
        const cur = calls.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(tc.index, cur);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }

    const content: Block[] = [];
    if (text) content.push({ type: 'text', text });
    for (const [i, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      let input: unknown;
      try {
        input = c.args.trim() ? JSON.parse(c.args) : {};
      } catch {
        throw new ToolInputParseError(`tool ${c.name}: arguments are not valid JSON`);
      }
      content.push({ type: 'tool_use', id: c.id || `call_${i}`, name: c.name, input });
    }
    const stopReason: StopReason =
      calls.size > 0 ? 'tool_use' : finish === 'stop' ? 'end_turn' : finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'refusal' : finish ? 'other' : 'end_turn';
    return { message: { role: 'assistant', content }, stopReason, stopDetail: finish ?? undefined, usage };
  }

  async listModels(): Promise<string[]> {
    const ids: string[] = [];
    try {
      for await (const m of this.client.models.list({ timeout: 20_000, maxRetries: 0 })) ids.push(m.id);
    } catch (e) {
      throw new Error(cleanApiError(e));
    }
    return ids;
  }

  async test(model: string): Promise<AiTestResult> {
    const t0 = Date.now();
    try {
      const r = await this.client.chat.completions.create({ model, messages: [{ role: 'user', content: 'Reply with the single word: pong' }] }, { timeout: 60_000, maxRetries: 0 });
      return { ok: true, ms: Date.now() - t0, reply: (r.choices[0]?.message.content ?? '').trim().slice(0, 100) };
    } catch (e) {
      return { ok: false, ms: Date.now() - t0, error: cleanApiError(e) };
    }
  }
}
