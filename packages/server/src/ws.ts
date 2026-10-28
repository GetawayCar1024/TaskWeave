import type { WebSocket } from 'ws';
import type { WsEvent } from '@taskweave/shared';

export class WsHub {
  private clients = new Set<WebSocket>();

  add(socket: WebSocket) {
    this.clients.add(socket);
    socket.on('close', () => this.clients.delete(socket));
    socket.on('error', () => this.clients.delete(socket));
  }

  broadcast(event: WsEvent) {
    const msg = JSON.stringify(event);
    for (const c of this.clients) {
      if (c.readyState === c.OPEN) c.send(msg);
    }
  }
}
