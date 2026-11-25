#!/usr/bin/env node
import crypto from 'node:crypto';
import { loadConfig, PORT_ATTEMPTS } from './src/server/config.js';
import { createGuard, HttpError } from './src/server/security.js';
import { createHttp } from './src/server/http.js';
import { createHub } from './src/server/hub.js';
import { createStore } from './src/server/store.js';
import { listDir } from './src/server/files.js';
import { createDeckSession } from './src/server/deck-session.js';
import { createNotes } from './src/server/notes.js';
import { createAssets } from './src/server/assets.js';
import { createLegacyRuns } from './src/server/legacy-runs.js';

let config;
try {
  config = loadConfig();
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
for (const w of config.warnings) console.error(w);

const serverId = crypto.randomUUID();
let hub = null;
const broadcast = (event) => hub?.broadcast(event);

const store = createStore({ stateDir: config.stateDir });
const session = createDeckSession({ broadcast });
const notes = createNotes({ session });
const assets = createAssets({ session });
const runs = createLegacyRuns({ session, notes, broadcast, config });

let port = null;
const guard = createGuard({ getPort: () => port });
const app = createHttp({ config, guard, deckDir: () => session.state.deckDir });

const OPEN_ERRORS = {
  ENOENT: [400, 'not_found', "Couldn't find that file."],
  ENOTDIR: [400, 'not_found', "Couldn't find that file."],
  EISDIR: [400, 'is_dir', 'That is a folder, not a deck.'],
  EACCES: [400, 'unreadable', "Couldn't read that file."],
  EPERM: [400, 'unreadable', "Couldn't read that file."],
};

async function openDeck(p) {
  if (typeof p !== 'string' || !p) throw new HttpError(400, 'not_found', "Couldn't find that file.");
  try {
    await session.bind(p);
  } catch (e) {
    const [status, code, message] = OPEN_ERRORS[e.code] || [400, 'unreadable', "Couldn't open that file."];
    throw new HttpError(status, code, message);
  }
}

function stateSnapshot() {
  const deck = session.publicState();
  return { ...deck, deck: deck.bound ? deck : null, serverId };
}

app.registerRoutes({
  'GET /api/state': () => stateSnapshot(),
  'GET /api/fs': ({ query }) => listDir(query.get('dir') || config.home),
  'POST /api/open': async ({ body }) => {
    await openDeck(body.path);
    return session.publicState();
  },
  ...assets.routes,
  ...runs.routes,
});

hub = createHub({
  server: app.server,
  guard,
  snapshot: () => [
    { type: 'hello', serverId, state: stateSnapshot() },
    { type: 'bound', deck: session.publicState() },
  ],
  onMessage: async (msg, ws) => {
    if (msg.type === 'save-html') {
      if (session.state.deckPath && typeof msg.html === 'string') session.queueWrite(msg.html);
    } else if (msg.type === 'save-notes') {
      await notes.save(msg.payload || {});
    } else if (msg.type === 'open') {
      try {
        await openDeck(msg.path);
      } catch (e) {
        hub.send(ws, { type: 'error', error: e.message });
      }
    }
  },
});

function tryListen(server, p) {
  return new Promise((resolve, reject) => {
    const onError = (e) => { server.off('listening', onListening); reject(e); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(p, '127.0.0.1');
  });
}

async function listen(server, first) {
  const attempts = first === 0 ? 1 : PORT_ATTEMPTS;
  for (let i = 0; i < attempts; i++) {
    const p = first + i;
    if (p > 65535) break;
    try {
      await tryListen(server, p);
      return server.address().port;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  const last = Math.min(first + attempts - 1, 65535);
  throw new Error(`Ports ${first} to ${last} are all in use. Try --port <number>.`);
}

let shuttingDown = false;
async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  setTimeout(() => process.exit(code), 1900).unref();
  try { await runs.stopAll(); } catch {}
  hub.close();
  app.server.closeAllConnections();
  app.server.close();
  await session.close().catch(() => {});
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException', (e) => {
  console.error('[deckhand] unexpected error:', e?.stack || e);
  shutdown(1);
});

try {
  await store.load();
  port = await listen(app.server, config.port);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

if (config.deckPath) {
  try {
    await openDeck(config.deckPath);
  } catch (e) {
    console.error(`Couldn't open ${config.deckPath}: ${e.message}`);
  }
}

const agent = runs.claudePath() ? 'Claude Code' : 'none found';
console.log(`\n  Deckhand is running at http://127.0.0.1:${port}\n  Agent: ${agent}\n  Press Ctrl+C to stop.\n`);
