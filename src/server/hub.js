import { WebSocketServer } from 'ws';
import { HttpError, parseRequestPath } from './security.js';

function refuse(socket, status, text) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function createHub({ server, guard, snapshot = () => [], onMessage = null, maxPayload = 16 * 1024 }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload });
  const clients = new Set();

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    try {
      guard.checkHost(req);
      if (parseRequestPath(req.url).pathname !== '/ws') return refuse(socket, 404, 'Not Found');
      guard.checkOrigin(req);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 400;
      return refuse(socket, status, status === 403 ? 'Forbidden' : 'Bad Request');
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
    for (const event of snapshot()) ws.send(JSON.stringify(event));
    if (onMessage) {
      ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        try {
          await onMessage(msg, ws);
        } catch (e) {
          console.error('[deckhand] socket message failed:', e?.message || e);
        }
      });
    }
  });

  return {
    broadcast(event) {
      const s = JSON.stringify(event);
      for (const c of clients) if (c.readyState === 1) c.send(s);
    },
    send(ws, event) {
      if (ws.readyState === 1) ws.send(JSON.stringify(event));
    },
    close() {
      for (const c of clients) c.terminate();
      wss.close();
    },
  };
}
