import { ref } from 'vue';
import type { WsEvent } from '@polyforge/shared';
import { token } from './api';

type Handler = (e: WsEvent) => void;
const handlers = new Set<Handler>();

export const wsConnected = ref(false);

let socket: WebSocket | null = null;
let retry = 0;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
  socket.onopen = () => {
    const reconnected = retry > 0;
    retry = 0;
    wsConnected.value = true;
    // Events may have been missed while disconnected: ask everyone to refresh.
    if (reconnected) handlers.forEach((h) => h({ type: 'problems:changed' }));
  };
  socket.onmessage = (m) => {
    let e: WsEvent;
    try {
      e = JSON.parse(m.data);
    } catch {
      return;
    }
    handlers.forEach((h) => h(e));
  };
  socket.onclose = () => {
    wsConnected.value = false;
    retry++;
    setTimeout(connect, Math.min(5000, 300 * 2 ** Math.min(retry, 4)));
  };
}

export function startWs() {
  if (!socket) connect();
}

/** Subscribe to server events; returns an unsubscribe function. */
export function onWs(h: Handler): () => void {
  handlers.add(h);
  return () => handlers.delete(h);
}
