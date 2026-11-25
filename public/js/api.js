export const tabId = crypto.randomUUID();

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function parse(res) {
  let body = null;
  try { body = await res.json(); } catch { }
  const err = body && body.error;
  if (!res.ok || err) {
    if (err && typeof err === 'object') throw new ApiError(err.code || 'error', err.message || 'Something went wrong.', res.status);
    throw new ApiError('error', typeof err === 'string' ? err : `Request failed (${res.status}).`, res.status);
  }
  return body;
}

export const api = {
  async get(path) {
    return parse(await fetch(path, { headers: { Accept: 'application/json' } }));
  },
  async post(path, body = {}) {
    return parse(await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    }));
  },
  async upload(file) {
    return parse(await fetch('/api/assets', {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name || 'image') },
      body: file,
    }));
  },
};

const listeners = new Set();
let lastSeq = -1;
let serverId = null;

export function onEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function dispatch(msg) {
  if (msg.type === 'hello' && msg.serverId !== serverId) { serverId = msg.serverId; lastSeq = -1; }
  if (typeof msg.seq === 'number') {
    if (msg.seq <= lastSeq) return;
    lastSeq = msg.seq;
  }
  for (const fn of listeners) fn(msg);
}

export function connectEvents({ onStatus } = {}) {
  const open = () => {
    const socket = new WebSocket(`ws://${location.host}/ws`);
    socket.onopen = () => onStatus && onStatus(true);
    socket.onclose = () => { onStatus && onStatus(false); setTimeout(open, 800); };
    socket.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      dispatch(msg);
    };
  };
  open();
}

export function normaliseDeck(d) {
  return d && d.path ? d : null;
}

export function deckFromState(s) {
  return s ? normaliseDeck(s.deck) : null;
}
