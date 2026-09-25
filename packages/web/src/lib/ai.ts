import { computed, reactive } from 'vue';
import type { AiChange, AiEndpoint, AiSessionDetail, AiSessionSummary, AiTranscriptItem, WsEvent } from '@polyforge/shared';
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
  });

  const running = computed(() => state.current?.state === 'running');
  let turnEnded = false;

  async function init() {
    state.loading = true;
    try {
      [state.endpoints, state.sessions] = await Promise.all([api.aiEndpoints().catch(() => []), api.aiSessions(problemId).catch(() => [])]);
      if (!state.current && state.sessions[0]) await open(state.sessions[0].id);
    } finally {
      state.loading = false;
    }
  }

  async function open(sid: string) {
    state.current = await api.aiSession(problemId, sid);
    state.live = [];
    state.changes = await api.aiChanges(problemId, sid).catch(() => []);
  }

  async function refresh() {
    if (!state.current) return;
    const sid = state.current.id;
    const [d, ch, list] = await Promise.all([api.aiSession(problemId, sid), api.aiChanges(problemId, sid), api.aiSessions(problemId)]);
    if (state.current?.id !== sid) return;
    state.current = d;
    state.changes = ch;
    state.sessions = list;
    if (d.state !== 'running') state.live = [];
  }

  async function create(endpoint?: string, model?: string) {
    const d = await api.createAiSession(problemId, { endpoint, model });
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

  async function setModel(endpoint: string, model: string) {
    if (!state.current) return;
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
      case 'plan':
        if (state.current) state.current.plan = ev.plan;
        break;
      case 'changes':
        state.changes = ev.changes;
        break;
      case 'notice':
        state.live.push({ kind: 'notice', level: ev.level, text: ev.text });
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

  return { state, running, transcript, init, open, refresh, create, send, cancel, remove, setModel, accept, reject, onWsEvent };
}

export type Ai = ReturnType<typeof useAi>;
