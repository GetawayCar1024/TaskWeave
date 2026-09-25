import type { AiTestResult } from '@polyforge/shared';
import type { RawAiEndpoint } from '../global.js';

/** Protocol-neutral conversation blocks stored in agent sessions. */
export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: Block[];
  /**
   * The provider's own content blocks for this assistant turn. Anthropic thinking
   * blocks must be echoed back unchanged in tool-use loops, so they are kept verbatim
   * and replayed when the next request goes to the same protocol and model.
   */
  raw?: { protocol: string; model: string; content: unknown[] };
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema of the input object. */
  input_schema: Record<string, unknown>;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface ChatRequest {
  model: string;
  system: string;
  messages: AgentMessage[];
  tools: ToolDef[];
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
}

export interface ChatResponse {
  message: AgentMessage;
  stopReason: StopReason;
  /** Human-readable detail for refusals / unusual stops. */
  stopDetail?: string;
  /** input = uncached input tokens. */
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

export interface Provider {
  chat(req: ChatRequest): Promise<ChatResponse>;
  listModels(): Promise<string[]>;
  test(model: string): Promise<AiTestResult>;
}

/** Thrown when the model returned a tool input that is not valid JSON; the turn can be re-issued. */
export class ToolInputParseError extends Error {}

export async function createProvider(ep: RawAiEndpoint): Promise<Provider> {
  if (ep.protocol === 'openai') {
    const { OpenAiProvider } = await import('./openai.js');
    return new OpenAiProvider(ep);
  }
  const { AnthropicProvider } = await import('./anthropic.js');
  return new AnthropicProvider(ep);
}

export function defaultModel(ep: RawAiEndpoint): string {
  return ep.models[0] ?? (ep.protocol === 'anthropic' ? 'claude-opus-5' : '');
}
