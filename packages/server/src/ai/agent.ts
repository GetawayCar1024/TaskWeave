import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  AiChange,
  AiEvent,
  AiFinding,
  AiSessionMode,
  AiPlanStep,
  AiRunState,
  AiSessionDetail,
  AiSessionSummary,
  AiTranscriptItem,
  CreateAiSessionRequest,
  AiUsage,
} from '@polyforge/shared';
import { addUsage, emptyUsage } from '@polyforge/shared';
import { recordCost, UsageLog } from './usage.js';
import type { RawAiEndpoint } from '../global.js';
import type { Judge } from '../judge/index.js';
import { atomicWrite, HttpError } from '../util/fs.js';
import type { ProblemRef } from '../workspace/problems.js';
import type { WsHub } from '../ws.js';
import { reviewKickoff, reviewSystemPrompt, systemPrompt } from './prompts.js';
import { cleanApiError, createProvider, defaultModel, ToolInputParseError, type AgentMessage, type Block } from './provider.js';
import { Sandbox } from './sandbox.js';
import { clip, runTool, toolsFor, WRITE_TOOLS } from './tools.js';
import { localChecks } from '../judge/checks.js';

/** Upper bound of model round-trips per user message. */
const MAX_STEPS = 80;

interface Notice {
  /** Shown after this many messages. */
  at: number;
  level: 'info' | 'warning' | 'error';
  text: string;
}

interface SessionData {
  id: string;
  /** Sessions written before review mode existed have no mode: they are agent sessions. */
  mode?: AiSessionMode;
  findings?: AiFinding[];
  problemId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  endpoint: string;
  model: string;
  messages: AgentMessage[];
  plan: AiPlanStep[];
  touched: string[];
  notices: Notice[];
  /** Token usage by "endpoint\0model" (the model can change during a session). */
  usage?: Record<string, { endpoint: string; model: string; protocol: string; usage: AiUsage }>;
}

interface Live {
  data: SessionData;
  sandbox: Sandbox;
  state: AiRunState;
  error?: string;
  abort?: AbortController;
  running?: Promise<void>;
}

const sessionsDir = (ref: ProblemRef) => path.join(ref.dir, '.polyforge', 'ai');

/**
 * AI agent sessions (DESIGN §4.4). Each session owns a sandbox copy of the problem;
 * the agent reads, edits and judges files there with tools, and the user accepts or
 * rejects the resulting changes file by file.
 */
export class AgentService {
  private live = new Map<string, Live>();
  readonly usageLog: UsageLog;

  constructor(
    private judge: Judge,
    private hub: WsHub,
  ) {
    this.usageLog = new UsageLog(judge.global);
  }

  /** Total usage of a session and its cost (only when every part has a price in one currency). */
  private sessionCost(d: SessionData, endpoints: RawAiEndpoint[]): { usage: AiUsage; cost?: number; currency?: string } {
    let usage = emptyUsage();
    let cost: number | undefined = 0;
    let currency: string | undefined;
    for (const part of Object.values(d.usage ?? {})) {
      usage = addUsage(usage, part.usage);
      const c = recordCost(part, endpoints.find((e) => e.name === part.endpoint));
      if (!c || (currency && currency !== c.currency)) cost = undefined;
      else if (cost !== undefined) {
        cost += c.cost;
        currency = c.currency;
      }
    }
    return usage.requests ? { usage, cost, currency: cost !== undefined ? currency : undefined } : { usage };
  }

  private async withCost<T extends AiSessionSummary>(l: Live, s: T): Promise<T> {
    const c = this.sessionCost(l.data, await this.judge.global.aiEndpointsRaw());
    return { ...s, usage: c.usage, cost: c.cost, currency: c.currency };
  }

  private key(problemId: string, sid: string) {
    return `${problemId}\0${sid}`;
  }

  private emit(l: Live, event: AiEvent) {
    this.hub.broadcast({ type: 'ai:event', problemId: l.data.problemId, sessionId: l.data.id, event });
  }

  /** Add one request's tokens to the session and the global log, and tell the UI. */
  private async recordUsage(l: Live, ep: RawAiEndpoint, u: { input: number; output: number; cacheRead?: number; cacheWrite?: number }) {
    const d = l.data;
    const usage: AiUsage = { requests: 1, input: u.input, output: u.output, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0 };
    const key = `${ep.name}\0${d.model}`;
    d.usage ??= {};
    const part = (d.usage[key] ??= { endpoint: ep.name, model: d.model, protocol: ep.protocol, usage: emptyUsage() });
    part.usage = addUsage(part.usage, usage);
    await this.usageLog
      .append({ at: new Date().toISOString(), endpoint: ep.name, protocol: ep.protocol, model: d.model, problem: d.problemId, session: d.id, usage })
      .catch(() => {});
    const c = this.sessionCost(d, await this.judge.global.aiEndpointsRaw());
    this.emit(l, { type: 'usage', usage: c.usage, cost: c.cost, currency: c.currency });
  }

  private async save(l: Live) {
    l.data.updatedAt = new Date().toISOString();
    l.data.touched = [...l.sandbox.touched];
    const ref = await this.judge.registry.get(l.data.problemId);
    await atomicWrite(path.join(sessionsDir(ref), l.data.id, 'session.json'), JSON.stringify(l.data));
  }

  private async load(problemId: string, sid: string): Promise<Live> {
    const k = this.key(problemId, sid);
    const cached = this.live.get(k);
    if (cached) return cached;
    if (!/^[a-z0-9]+$/.test(sid)) throw new HttpError(400, 'bad_session', 'Invalid session id');
    const ref = await this.judge.registry.get(problemId);
    const dir = path.join(sessionsDir(ref), sid);
    let data: SessionData;
    try {
      data = JSON.parse(await fsp.readFile(path.join(dir, 'session.json'), 'utf8')) as SessionData;
    } catch {
      throw new HttpError(404, 'session_not_found', `AI session not found: ${sid}`);
    }
    const l: Live = { data, sandbox: new Sandbox(ref.dir, path.join(dir, 'work'), new Set(data.touched)), state: 'idle' };
    this.live.set(k, l);
    return l;
  }

  async create(problemId: string, req: CreateAiSessionRequest): Promise<AiSessionDetail> {
    const ref = await this.judge.registry.get(problemId);
    const ep = await this.judge.global.aiEndpoint(req.endpoint);
    const id = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
    const now = new Date().toISOString();
    const mode = req.mode ?? 'agent';
    const data: SessionData = {
      id,
      mode,
      findings: [],
      problemId,
      title: req.title?.trim() || (mode === 'review' ? `AI check ${now.slice(0, 16).replace('T', ' ')}` : 'New session'),
      createdAt: now,
      updatedAt: now,
      endpoint: ep.name,
      model: req.model || this.judge.global.config.ai?.model || defaultModel(ep),
      messages: [],
      plan: [],
      touched: [],
      notices: [],
    };
    const l: Live = { data, sandbox: new Sandbox(ref.dir, path.join(sessionsDir(ref), id, 'work'), new Set()), state: 'idle' };
    this.live.set(this.key(problemId, id), l);
    await this.save(l);
    return this.detail(l);
  }

  async list(problemId: string): Promise<AiSessionSummary[]> {
    const ref = await this.judge.registry.get(problemId);
    const ids = await fsp.readdir(sessionsDir(ref)).catch(() => [] as string[]);
    const out: AiSessionSummary[] = [];
    for (const id of ids) {
      try {
        const l = await this.load(problemId, id);
        out.push(await this.withCost(l, this.summary(l, l.sandbox.touched.size)));
      } catch {
        /* not a session */
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private summary(l: Live, changes: number): AiSessionSummary {
    const d = l.data;
    return {
      id: d.id,
      mode: d.mode ?? 'agent',
      findings: d.findings?.length ?? 0,
      title: d.title,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      endpoint: d.endpoint,
      model: d.model,
      state: l.state,
      changes,
    };
  }

  private transcript(d: SessionData): AiTranscriptItem[] {
    const out: AiTranscriptItem[] = [];
    const tools = new Map<string, Extract<AiTranscriptItem, { kind: 'tool' }>>();
    const notices = [...d.notices];
    d.messages.forEach((m, i) => {
      while (notices.length && notices[0].at <= i) {
        const n = notices.shift()!;
        out.push({ kind: 'notice', level: n.level, text: n.text });
      }
      for (const b of m.content) {
        if (b.type === 'text' && b.text.trim()) out.push({ kind: m.role === 'user' ? 'user' : 'assistant', text: b.text });
        else if (b.type === 'thinking' && b.text.trim()) out.push({ kind: 'thinking', text: b.text });
        else if (b.type === 'tool_use') {
          const item = { kind: 'tool' as const, id: b.id, name: b.name, input: b.input };
          tools.set(b.id, item);
          out.push(item);
        } else if (b.type === 'tool_result') {
          const t = tools.get(b.tool_use_id);
          if (t) Object.assign(t, { result: b.content, isError: !!b.is_error });
        }
      }
    });
    for (const n of notices) out.push({ kind: 'notice', level: n.level, text: n.text });
    return out;
  }

  private async detail(l: Live): Promise<AiSessionDetail> {
    const changes = await l.sandbox.changes().catch(() => [] as AiChange[]);
    return this.withCost(l, { ...this.summary(l, changes.length), transcript: this.transcript(l.data), findingList: l.data.findings ?? [], plan: l.data.plan, error: l.error });
  }

  async get(problemId: string, sid: string): Promise<AiSessionDetail> {
    return this.detail(await this.load(problemId, sid));
  }

  async update(problemId: string, sid: string, patch: { title?: string; endpoint?: string; model?: string }): Promise<AiSessionDetail> {
    const l = await this.load(problemId, sid);
    if (patch.title !== undefined) l.data.title = patch.title.trim() || l.data.title;
    if (patch.endpoint !== undefined) l.data.endpoint = (await this.judge.global.aiEndpoint(patch.endpoint)).name;
    if (patch.model !== undefined && patch.model.trim()) l.data.model = patch.model.trim();
    await this.save(l);
    return this.detail(l);
  }

  async remove(problemId: string, sid: string): Promise<void> {
    const l = await this.load(problemId, sid);
    l.abort?.abort();
    await l.running?.catch(() => {});
    const ref = await this.judge.registry.get(problemId);
    await fsp.rm(path.join(sessionsDir(ref), sid), { recursive: true, force: true });
    this.live.delete(this.key(problemId, sid));
  }

  /** AI check: a read-only review session seeded with the local check results. */
  async startReview(problemId: string, req: CreateAiSessionRequest): Promise<AiSessionDetail> {
    const d = await this.create(problemId, { ...req, mode: 'review' });
    const checks = await localChecks(this.judge, await this.judge.ctx(problemId));
    return this.send(problemId, d.id, reviewKickoff(checks));
  }

  cancel(problemId: string, sid: string) {
    this.live.get(this.key(problemId, sid))?.abort?.abort();
  }

  /** Start the agent on a user message; progress arrives as `ai:event`s. */
  async send(problemId: string, sid: string, text: string): Promise<AiSessionDetail> {
    const l = await this.load(problemId, sid);
    if (l.state === 'running') throw new HttpError(409, 'busy', 'The agent is still working on the previous message');
    if (!text.trim()) throw new HttpError(400, 'empty', 'Message is empty');
    if (l.data.messages.length === 0 && l.data.title === 'New session') l.data.title = text.trim().split('\n')[0].slice(0, 60);
    l.data.messages.push({ role: 'user', content: [{ type: 'text', text }] });
    l.state = 'running';
    l.error = undefined;
    l.abort = new AbortController();
    await this.save(l);
    this.emit(l, { type: 'state', state: 'running' });
    l.running = this.loop(l, l.abort.signal).finally(() => (l.running = undefined));
    return this.detail(l);
  }

  private notice(l: Live, level: Notice['level'], text: string) {
    l.data.notices.push({ at: l.data.messages.length, level, text });
    this.emit(l, { type: 'notice', level, text });
  }

  private async loop(l: Live, signal: AbortSignal): Promise<void> {
    const d = l.data;
    try {
      await l.sandbox.sync();
      const ep = await this.judge.global.aiEndpoint(d.endpoint);
      const provider = await createProvider(ep);
      const mode = d.mode ?? 'agent';
      const system = mode === 'review' ? await reviewSystemPrompt(this.judge.global.sharedDir) : await systemPrompt(this.judge.global.sharedDir);
      const tools = toolsFor(mode);
      const ref = await this.judge.registry.get(d.problemId);
      const sandboxRef: ProblemRef = { id: `${d.problemId}@ai`, dir: l.sandbox.dir, root: ref.root };
      const buildRoot = path.join(ref.dir, '.polyforge', 'build');
      const env = {
        sandbox: l.sandbox,
        judge: this.judge,
        ctx: () => this.judge.ctxFor(sandboxRef, buildRoot),
        signal,
        setPlan: (plan: AiPlanStep[]) => {
          d.plan = plan;
          this.emit(l, { type: 'plan', plan });
        },
        changed: () => {},
        report: (f: Omit<AiFinding, 'id'>) => {
          const finding: AiFinding = { id: `f${(d.findings ??= []).length + 1}`, ...f };
          d.findings.push(finding);
          this.emit(l, { type: 'finding', finding });
        },
      };

      let parseRetries = 0;
      for (let step = 0; step < MAX_STEPS; step++) {
        signal.throwIfAborted();
        let res;
        try {
          res = await provider.chat({
            model: d.model,
            system,
            messages: d.messages,
            tools,
            signal,
            onText: (delta) => this.emit(l, { type: 'text', delta }),
            onThinking: (delta) => this.emit(l, { type: 'thinking', delta }),
          });
          parseRetries = 0;
          if (res.usage) await this.recordUsage(l, ep, res.usage);
        } catch (e) {
          if (e instanceof ToolInputParseError && parseRetries++ < 2) {
            this.notice(l, 'warning', 'The model produced an unreadable tool call; retrying the step.');
            continue;
          }
          throw e;
        }
        const toolUses = res.message.content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
        // A refusal or a cut-off can leave half-written tool input: never run those tools.
        if (res.stopReason === 'refusal') {
          d.messages.push({ ...res.message, content: res.message.content.filter((b) => b.type !== 'tool_use'), raw: undefined });
          this.notice(l, 'error', `The model declined to continue (${res.stopDetail ?? 'refusal'}).`);
          break;
        }
        if (res.stopReason === 'max_tokens' && toolUses.length) {
          d.messages.push({ ...res.message, content: res.message.content.filter((b) => b.type !== 'tool_use'), raw: undefined });
          this.notice(l, 'warning', 'The response hit the output limit in the middle of a tool call; ask the agent to continue in smaller steps.');
          break;
        }
        d.messages.push(res.message);
        if (!toolUses.length) {
          if (res.stopReason === 'max_tokens') this.notice(l, 'warning', 'The response was cut off at the output limit.');
          break;
        }

        // All results of one assistant turn go back in a single user message.
        const results: Block[] = [];
        let wrote = false;
        for (const tu of toolUses) {
          this.emit(l, { type: 'tool_call', id: tu.id, name: tu.name, input: tu.input });
          const r = await runTool(tu.name, tu.input, env, mode);
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: clip(r.content), is_error: r.isError || undefined });
          this.emit(l, { type: 'tool_result', id: tu.id, result: clip(r.content, 4000), isError: r.isError });
          if (WRITE_TOOLS.has(tu.name) && !r.isError) wrote = true;
        }
        d.messages.push({ role: 'user', content: results });
        if (wrote) this.emit(l, { type: 'changes', changes: await l.sandbox.changes() });
        await this.save(l);
        if (step === MAX_STEPS - 1) this.notice(l, 'warning', `Stopped after ${MAX_STEPS} steps; send a message to continue.`);
      }
      l.state = 'idle';
    } catch (e) {
      if (signal.aborted) {
        l.state = 'idle';
        this.notice(l, 'info', 'Stopped.');
        // A dangling tool_use without results would break the next request.
        const last = d.messages[d.messages.length - 1];
        if (last?.role === 'assistant' && last.content.some((b) => b.type === 'tool_use')) {
          d.messages.push({
            role: 'user',
            content: last.content.flatMap((b) => (b.type === 'tool_use' ? [{ type: 'tool_result' as const, tool_use_id: b.id, content: 'Cancelled by the user.', is_error: true }] : [])),
          });
        }
      } else {
        l.state = 'error';
        l.error = cleanApiError(e);
        this.notice(l, 'error', l.error);
      }
    }
    await this.save(l).catch(() => {});
    this.emit(l, { type: 'changes', changes: await l.sandbox.changes().catch(() => []) });
    this.emit(l, { type: 'state', state: l.state, error: l.error });
  }

  // ---- change review ----

  async changes(problemId: string, sid: string): Promise<AiChange[]> {
    return (await this.load(problemId, sid)).sandbox.changes();
  }

  async changeContent(problemId: string, sid: string, file: string) {
    return (await this.load(problemId, sid)).sandbox.content(file);
  }

  async accept(problemId: string, sid: string, paths: string[]): Promise<AiChange[]> {
    const l = await this.load(problemId, sid);
    if (l.state === 'running') throw new HttpError(409, 'busy', 'Wait for the agent to finish');
    await l.sandbox.accept(paths);
    await this.save(l);
    const ch = await l.sandbox.changes();
    this.emit(l, { type: 'changes', changes: ch });
    return ch;
  }

  async reject(problemId: string, sid: string, paths: string[]): Promise<AiChange[]> {
    const l = await this.load(problemId, sid);
    if (l.state === 'running') throw new HttpError(409, 'busy', 'Wait for the agent to finish');
    await l.sandbox.reject(paths);
    await this.save(l);
    const ch = await l.sandbox.changes();
    this.emit(l, { type: 'changes', changes: ch });
    return ch;
  }
}
