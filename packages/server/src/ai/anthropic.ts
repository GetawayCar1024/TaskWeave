import Anthropic from '@anthropic-ai/sdk';
import type { AiTestResult } from '@polyforge/shared';
import type { RawAiEndpoint } from '../global.js';
import type { AgentMessage, Block, ChatRequest, ChatResponse, Provider, StopReason } from './provider.js';
import { cleanApiError, ToolInputParseError } from './provider.js';

const OFFICIAL_HOSTS = new Set(['api.anthropic.com']);

/** Models that take `thinking: {type: "adaptive"}`. */
const ADAPTIVE = /^claude-(opus-(4-[678]|5)|sonnet-(4-6|5)|fable-5|mythos-5)/;
/** Models that support server-side refusal fallbacks (`fallbacks: "default"`). */
const FALLBACKS = /^claude-(opus-5|fable-5)/;

/**
 * Anthropic Messages API provider. Works against the official API and against
 * proxies that speak the Anthropic protocol (custom base URL). Features a proxy is
 * likely to reject (beta headers, eager input streaming, top-level cache_control)
 * are only used against the official host.
 */
export class AnthropicProvider implements Provider {
  private client: Anthropic;
  private official: boolean;
  private baseURL?: string;
  private apiKey: string;

  constructor(ep: RawAiEndpoint) {
    // The SDK adds /v1 itself; proxies are often given as https://host/v1.
    const baseURL = ep.baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '') || undefined;
    this.baseURL = baseURL;
    this.apiKey = ep.apiKey;
    this.official = !baseURL || OFFICIAL_HOSTS.has(new URL(baseURL).hostname);
    this.client = new Anthropic({ apiKey: ep.apiKey, baseURL, maxRetries: 3 });
  }

  private toParams(messages: AgentMessage[], model: string): Anthropic.MessageParam[] {
    return messages.map((m): Anthropic.MessageParam => {
      if (m.role === 'assistant') {
        // Replay the exact blocks (incl. thinking signatures) when continuing on the same model.
        if (m.raw?.protocol === 'anthropic' && m.raw.model === model) {
          return { role: 'assistant', content: m.raw.content as Anthropic.ContentBlockParam[] };
        }
        const content: Anthropic.ContentBlockParam[] = [];
        for (const b of m.content) {
          if (b.type === 'text' && b.text) content.push({ type: 'text', text: b.text });
          else if (b.type === 'tool_use') content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input as Record<string, unknown> });
        }
        return { role: 'assistant', content: content.length ? content : [{ type: 'text', text: '(no content)' }] };
      }
      const content: Anthropic.ContentBlockParam[] = m.content.flatMap((b): Anthropic.ContentBlockParam[] => {
        if (b.type === 'text') return [{ type: 'text', text: b.text }];
        if (b.type === 'tool_result') return [{ type: 'tool_result', tool_use_id: b.tool_use_id, content: b.content, is_error: b.is_error }];
        return [];
      });
      return { role: 'user', content };
    });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const tools: Anthropic.Tool[] = req.tools.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool.InputSchema,
      // Large inputs (whole files) stream as generated; inputs are validated by the caller.
      ...(this.official ? { eager_input_streaming: true } : {}),
      // Cache breakpoint after the (stable) tool list.
      ...(i === req.tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
    }));
    const params = {
      model: req.model,
      max_tokens: 64000,
      system: [{ type: 'text' as const, text: req.system, cache_control: { type: 'ephemeral' as const } }],
      tools,
      messages: this.toParams(req.messages, req.model),
      ...(ADAPTIVE.test(req.model) ? { thinking: { type: 'adaptive' as const, display: 'summarized' as const } } : {}),
      // Automatic caching of the growing conversation (official API only).
      ...(this.official ? { cache_control: { type: 'ephemeral' as const } } : {}),
    };

    const onText = (delta: string) => req.onText?.(delta);
    const onThinking = (delta: string) => req.onThinking?.(delta);
    const run = async (): Promise<Anthropic.Message> => {
      if (this.official && FALLBACKS.test(req.model)) {
        // Server-side refusal fallbacks: a declined turn is re-run on a fallback model.
        const s = this.client.beta.messages.stream(
          { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } as unknown as Anthropic.Beta.Messages.MessageCreateParamsStreaming,
          { signal: req.signal },
        );
        s.on('text', onText);
        s.on('thinking', onThinking);
        return (await s.finalMessage()) as unknown as Anthropic.Message;
      }
      const s = this.client.messages.stream(params, { signal: req.signal });
      s.on('text', onText);
      s.on('thinking', onThinking);
      return s.finalMessage();
    };

    let message: Anthropic.Message;
    try {
      message = await run();
    } catch (err) {
      // With eager input streaming, an unparseable tool input rejects the stream; the
      // caller re-issues the turn. API errors (typed) propagate unchanged.
      if (err instanceof Anthropic.APIError || req.signal?.aborted) throw err;
      if (err instanceof SyntaxError || /JSON/i.test(String((err as Error).message))) throw new ToolInputParseError((err as Error).message);
      throw err;
    }

    const content: Block[] = [];
    for (const b of message.content) {
      if (b.type === 'text') content.push({ type: 'text', text: b.text });
      else if (b.type === 'thinking' && b.thinking) content.push({ type: 'thinking', text: b.thinking });
      else if (b.type === 'tool_use') content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
    }
    const sr = message.stop_reason;
    const stopReason: StopReason = sr === 'end_turn' || sr === 'tool_use' || sr === 'max_tokens' || sr === 'refusal' ? sr : sr === 'stop_sequence' ? 'end_turn' : 'other';
    const details = (message as { stop_details?: { category?: string | null; explanation?: string | null } | null }).stop_details;
    return {
      message: { role: 'assistant', content, raw: { protocol: 'anthropic', model: req.model, content: message.content } },
      stopReason,
      stopDetail: stopReason === 'refusal' ? [details?.category, details?.explanation].filter(Boolean).join(': ') || 'refused' : sr ?? undefined,
      usage: {
        input: message.usage.input_tokens,
        output: message.usage.output_tokens,
        cacheRead: message.usage.cache_read_input_tokens ?? 0,
        cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }

  async listModels(): Promise<string[]> {
    try {
      const ids: string[] = [];
      for await (const m of this.client.models.list({}, { timeout: 20_000, maxRetries: 0 })) ids.push(m.id);
      return ids;
    } catch (e) {
      // Many proxies implement /v1/messages but not the models API, or only an
      // OpenAI-style one: try the usual alternatives before giving up.
      const found = await this.listModelsFallback();
      if (found) return found;
      throw new Error(cleanApiError(e));
    }
  }

  private async listModelsFallback(): Promise<string[] | null> {
    const base = (this.baseURL ?? 'https://api.anthropic.com').replace(/\/+$/, '');
    const headers: Record<string, string>[] = [{ 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' }, { authorization: `Bearer ${this.apiKey}` }];
    for (const url of [`${base}/v1/models`, `${base}/models`]) {
      for (const h of headers) {
        try {
          const res = await fetch(url, { headers: h, signal: AbortSignal.timeout(10_000) });
          if (!res.ok) continue;
          const j = (await res.json()) as { data?: { id?: string }[] };
          const ids = (j.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === 'string');
          if (ids.length) return ids;
        } catch {
          /* try the next form */
        }
      }
    }
    return null;
  }

  async test(model: string): Promise<AiTestResult> {
    const t0 = Date.now();
    try {
      const r = await this.client.messages.create({ model, max_tokens: 64, messages: [{ role: 'user', content: 'Reply with the single word: pong' }] }, { timeout: 60_000, maxRetries: 0 });
      const text = r.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
      return { ok: true, ms: Date.now() - t0, reply: text.trim().slice(0, 100) };
    } catch (e) {
      return { ok: false, ms: Date.now() - t0, error: cleanApiError(e) };
    }
  }
}
