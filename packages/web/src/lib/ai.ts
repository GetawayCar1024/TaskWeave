import { computed, reactive } from 'vue';
import type { AiChange, AiEndpoint, AiFinding, AiSessionDetail, AiSessionMode, AiSessionSummary, AiTranscriptItem, WsEvent } from '@polyforge/shared';
import { api } from './api';

/**
 * Client state of the AI agent for one problem: sessions, the open session's
 * transcript (persisted part + what is streaming right now) and its change set.
 */
export function useAi(problemId: string) {
  const state = reactive({
    endpoints: [] as AiEndpoint[],
    sessions: [] as AiSessionSummary[],
    current: null as AiSessionDetail | null,
    /** Items of the turn in progress, before the server's transcript catches up. */
    live: [] as AiTranscriptItem[],
    changes: [] as AiChange[],
    loading: false,
    /** Endpoint / model for the next new session or AI check; follows the open session. */
    pick: { endpoint: '', model: '' },
  });

  /** Mirror the open session's endpoint / model into the picker. */
  function follow(d: AiSessionDetail | null) {
    if (d) state.pick = { endpoint: d.endpoint, model: d.model };
  }

  const running = computed(() => state.current?.state === 'running');
  let turnEnded = false;

  async function init() {
    state.loading = true;
    try {
      const [eps, list, settings] = await Promise.all([api.aiEndpoints().catch(() => []), api.aiSessions(problemId).catch(() => []), api.settings().catch(() => null)]);
      [state.endpoints, state.sessions] = [eps, list];
      // Before any session: the default endpoint / model from the settings.
      if (!state.pick.endpoint && eps.length) {
        const def = settings?.config.ai;
        const ep = eps.find((e) => e.name === def?.endpoint) ?? eps[0];
        state.pick = { endpoint: ep.name, model: (ep.name === def?.endpoint && def?.model) || ep.models[0] || '' };
      }
      const first = state.sessions.find((x) => x.mode === 'agent');
      if (!state.current && first) await open(first.id);
    } finally {
      state.loading = false;
    }
  }

  /** Open the newest session of a mode, or none. */
  async function openLatest(mode: AiSessionMode) {
    const s = state.sessions.find((x) => x.mode === mode);
    if (s) await open(s.id);
    else {
      state.current = null;
      state.live = [];
      state.changes = [];
    }
  }

  /** AI check: a read-only review session (DESIGN §4.4, M5). */
  async function startReview() {
    const d = await api.startReview(problemId, pickReq());
    state.sessions = await api.aiSessions(problemId);
    state.current = d;
    state.live = [];
    state.changes = [];
  }

  /** Hand a finding to a fresh agent session. */
  async function fix(f: AiFinding) {
    await create();
    const lines = [
      'Fix this issue found by the AI check.',
      '',
      `[${f.severity}] ${f.title}`,
      f.detail,
      f.file ? `File: ${f.file}${f.line ? `:${f.line}` : ''}` : '',
      f.suggestion ? `Suggestion: ${f.suggestion}` : '',
      '',
      'Verify the fix with the tools.',
    ];
    await send(lines.filter((l, i) => l !== '' || i === 1 || i === 6).join('\n'));
  }

  async function open(sid: string) {
    state.current = await api.aiSession(problemId, sid);
    follow(state.current);
    state.live = [];
    state.changes = await api.aiChanges(problemId, sid).catch(() => []);
  }

  async function refresh() {
    if (!state.current) return;
    const sid = state.current.id;
    const [d, ch, list] = await Promise.all([api.aiSession(problemId, sid), api.aiChanges(problemId, sid), api.aiSessions(problemId)]);
    if (state.current?.id !== sid) return;
    state.current = d;
    follow(d);
    state.changes = ch;
    state.sessions = list;
    if (d.state !== 'running') state.live = [];
  }

  const pickReq = () => ({ endpoint: state.pick.endpoint || undefined, model: state.pick.model || undefined });

  /** A new agent session with the picked endpoint / model. */
  async function create() {
    const d = await api.createAiSession(problemId, pickReq());
    state.sessions = await api.aiSessions(problemId);
    state.current = d;
    state.live = [];
    state.changes = [];
    return d;
  }

  async function send(text: string) {
    if (!state.current) await create();
    const sid = state.current!.id;
    state.live = [{ kind: 'user', text }];
    turnEnded = false;
    const d = await api.sendAi(problemId, sid, text);
    if (state.current?.id !== sid) return;
    // A very short run may already be over (and refreshed) before this response arrives.
    if (turnEnded) return refresh();
    state.current = d;
    // The server transcript now holds the user message; keep anything already streamed.
    state.live = state.live.filter((x) => x.kind !== 'user');
  }

  async function cancel() {
    if (state.current) await api.cancelAi(problemId, state.current.id);
  }

  async function remove(sid: string) {
    await api.deleteAiSession(problemId, sid);
    state.sessions = await api.aiSessions(problemId);
    if (state.current?.id === sid) {
      state.current = null;
      state.changes = [];
      if (state.sessions[0]) await open(state.sessions[0].id);
    }
  }

  /** Pick the endpoint / model: for the open session (when idle) and for new ones. */
  async function setModel(endpoint: string, model: string) {
    state.pick = { endpoint, model };
    if (!state.current || running.value) return;
    state.current = await api.updateAiSession(problemId, state.current.id, { endpoint, model });
  }

  async function accept(paths: string[]) {
    if (state.current) state.changes = await api.acceptAi(problemId, state.current.id, paths);
  }

  async function reject(paths: string[]) {
    if (state.current) state.changes = await api.rejectAi(problemId, state.current.id, paths);
  }

  const lastLive = (kind: 'assistant' | 'thinking') => {
    const last = state.live[state.live.length - 1];
    if (last && last.kind === kind) return last;
    const item = { kind, text: '' } as Extract<AiTranscriptItem, { kind: 'assistant' | 'thinking' }>;
    state.live.push(item);
    return item;
  };

  function onWsEvent(e: WsEvent) {
    if (e.type !== 'ai:event' || e.problemId !== problemId || e.sessionId !== state.current?.id) return;
    const ev = e.event;
    switch (ev.type) {
      case 'text':
        lastLive('assistant').text += ev.delta;
        break;
      case 'thinking':
        lastLive('thinking').text += ev.delta;
        break;
      case 'tool_call':
        state.live.push({ kind: 'tool', id: ev.id, name: ev.name, input: ev.input });
        break;
      case 'tool_result': {
        const t = state.live.find((x) => x.kind === 'tool' && x.id === ev.id);
        if (t && t.kind === 'tool') Object.assign(t, { result: ev.result, isError: ev.isError });
        break;
      }
      case 'finding':
        state.current?.findingList.push(ev.finding);
        break;
      case 'plan':
        if (state.current) state.current.plan = ev.plan;
        break;
      case 'changes':
        state.changes = ev.changes;
        break;
      case 'notice':
        state.live.push({ kind: 'notice', level: ev.level, text: ev.text });
        break;
      case 'usage':
        if (state.current) Object.assign(state.current, { usage: ev.usage, cost: ev.cost, currency: ev.currency });
        break;
      case 'state':
        if (state.current) state.current.state = ev.state;
        // The persisted transcript replaces the live tail once the turn is over.
        if (ev.state !== 'running') {
          turnEnded = true;
          refresh();
        }
        break;
    }
  }

  /** Persisted transcript plus the live tail (deduplicated once the server catches up). */
  const transcript = computed<AiTranscriptItem[]>(() => {
    const base = state.current?.transcript ?? [];
    const known = new Set(base.filter((x) => x.kind === 'tool').map((x) => (x as { id: string }).id));
    return [...base, ...state.live.filter((x) => x.kind !== 'tool' || !known.has(x.id))];
  });

  return { state, running, transcript, init, open, openLatest, refresh, create, send, cancel, remove, setModel, accept, reject, startReview, fix, onWsEvent };
}

export type Ai = ReturnType<typeof useAi>;
