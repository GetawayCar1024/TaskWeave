import type { CheckCode, CheckParams } from './checks.js';
import type { AiUsage, EndpointPricing } from './usage.js';
export const AI_PROTOCOLS = ['anthropic', 'openai'] as const;
export type AiProtocol = (typeof AI_PROTOCOLS)[number];

/** An AI endpoint as returned to the client (key masked). DESIGN §4.4. */
export interface AiEndpoint {
  name: string;
  protocol: AiProtocol;
  baseUrl: string;
  /** Masked key, e.g. "sk-a…9f". */
  apiKey: string;
  hasKey: boolean;
  models: string[];
  pricing?: EndpointPricing;
}

export interface SaveAiEndpoint {
  name: string;
  protocol: AiProtocol;
  baseUrl?: string;
  /** Empty keeps the stored key (matched by `previousName ?? name`). */
  apiKey?: string;
  models: string[];
  pricing?: EndpointPricing;
  /** Set when renaming an endpoint, to carry over its stored key. */
  previousName?: string;
}

export interface AiTestResult {
  ok: boolean;
  ms: number;
  reply?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Agent sessions

export type AiRunState = 'idle' | 'running' | 'error';

export interface AiSessionSummary {
  id: string;
  mode: AiSessionMode;
  /** Review mode: number of findings. */
  findings: number;
  title: string;
  createdAt: string;
  updatedAt: string;
  endpoint: string;
  model: string;
  state: AiRunState;
  changes: number;
  usage?: AiUsage;
  /** Cost in the endpoint currency, when a price is configured. */
  cost?: number;
  currency?: string;
}

/** Transcript entry for the UI, derived from the stored conversation. */
export type AiTranscriptItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; name: string; input: unknown; result?: string; isError?: boolean }
  | { kind: 'notice'; level: 'info' | 'warning' | 'error'; text: string };

export interface AiPlanStep {
  title: string;
  status: 'pending' | 'in_progress' | 'done' | 'skipped';
}

export interface AiSessionDetail extends AiSessionSummary {
  transcript: AiTranscriptItem[];
  findingList: AiFinding[];
  plan: AiPlanStep[];
  error?: string;
}

export interface AiChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  binary?: boolean;
}

export interface AiChangeContent {
  path: string;
  original: string | null;
  modified: string | null;
  binary?: boolean;
}

export interface CreateAiSessionRequest {
  mode?: AiSessionMode;
  endpoint?: string;
  model?: string;
  title?: string;
}

/** Streamed over WebSocket as `ai:event`. */
export type AiEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; result: string; isError: boolean }
  | { type: 'plan'; plan: AiPlanStep[] }
  | { type: 'finding'; finding: AiFinding }
  | { type: 'changes'; changes: AiChange[] }
  | { type: 'state'; state: AiRunState; error?: string }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; text: string }
  | { type: 'usage'; usage: AiUsage; cost?: number; currency?: string };

export type AiSessionMode = 'agent' | 'review';

export const FINDING_CATEGORIES = ['statement', 'tutorial', 'validator', 'checker', 'interactor', 'solutions', 'tests', 'config', 'other'] as const;

/** One result of an AI check (review mode). */
export interface AiFinding {
  id: string;
  severity: 'error' | 'warning' | 'info';
  category: (typeof FINDING_CATEGORIES)[number];
  title: string;
  detail: string;
  file?: string;
  line?: number;
  suggestion?: string;
}

/** A deterministic (non-AI) check result. */
export interface LocalCheck {
  level: 'error' | 'warning' | 'info';
  category: AiFinding['category'];
  /** English text (for the AI); the UI translates `code` with `params`. */
  message: string;
  code?: CheckCode;
  params?: CheckParams;
  file?: string;
  line?: number;
}
