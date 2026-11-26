#!/usr/bin/env node
import crypto from 'node:crypto';
import path from 'node:path';
import { loadConfig, PORT_ATTEMPTS } from './src/server/config.js';
import { createGuard } from './src/server/security.js';
import { createHttp } from './src/server/http.js';
import { createHub } from './src/server/hub.js';
import { createStore } from './src/server/store.js';
import { tildify } from './src/server/files.js';
import { homeRoutes } from './src/server/home-routes.js';
import { openBrowser } from './src/server/open.js';
import { createDeckSession } from './src/server/deck-session.js';
import { createNotes } from './src/server/notes.js';
import { createAssets } from './src/server/assets.js';
import { deckRoutes } from './src/server/deck-routes.js';
import { createSample } from './src/server/sample.js';
import { createAgents } from './src/server/agents/index.js';
import { createRuns } from './src/server/runs.js';

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

const hubProxy = { broadcast };
const store = createStore({ stateDir: config.stateDir });
const notes = createNotes({ hub: hubProxy });
const session = createDeckSession({ hub: hubProxy, store, notes, home: config.home });
const sample = createSample({ config });
const assets = createAssets({ session });
const agents = createAgents({ config, store, broadcast });
const runs = createRuns({ config, session, notes, agents, store, broadcast });

let port = null;
const guard = createGuard({ getPort: () => port });
const app = createHttp({
  config,
  guard,
  deckDir: () => session.meta()?.dir ?? null,
  deckSource: (file) => (file === session.meta()?.path ? session.servedSource() : null),
});

function stateSnapshot() {
  const meta = session.meta();
  return {
    deck: meta,
    agents: agents.payload(),
    run: runs.state(),
    serverId,
    decksDir: config.decksDir,
    decksDirLabel: tildify(config.decksDir, config.home),
    sampleDeck: path.join(config.rootDir, 'samples', 'sample-deck.html'),
  };
}

app.registerRoutes({
  'GET /api/state': () => stateSnapshot(),
  ...deckRoutes({ session, notes, sample }),
  ...homeRoutes({ store, config }),
  ...assets.routes,
  ...agents.routes({ isBusy: runs.isBusy }),
  ...runs.routes,
});

hub = createHub({
  server: app.server,
  guard,
  snapshot: () => [
    { type: 'hello', serverId, state: stateSnapshot() },
    { type: 'deck', deck: session.meta() },
    { type: 'notes', ...notes.snapshot() },
    { type: 'agents', agents: agents.payload() },
    ...(runs.state() ? [{ type: 'run', run: runs.state() }] : []),
  ],
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
  await session.dispose().catch(() => {});
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('unhandledRejection', (e) => {
  console.error('[deckhand] unhandled error:', e?.stack || e);
});
process.on('uncaughtException', (e) => {
  console.error('[deckhand] unexpected error:', e?.stack || e);
  shutdown(1);
});

let detecting;
try {
  await store.load();
  detecting = agents.detect().catch((e) => console.error(`[deckhand] agent detection failed: ${e.message}`));
  port = await listen(app.server, config.port);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

if (config.deckPath) {
  try {
    await session.open(await sample.resolve(config.deckPath));
  } catch (e) {
    console.error(`Couldn't open ${config.deckPath}: ${e.message}`);
  }
}

await detecting;
const url = `http://127.0.0.1:${port}`;
const bound = session.meta();
const landing = bound ? `${url}/edit?deck=${encodeURIComponent(bound.path)}` : url;
console.log(`\n  Deckhand is running at ${landing}\n  Agent: ${agents.launchLine()}\n  Press Ctrl+C to stop.\n`);

if (config.open) openBrowser(bound ? landing : `${url}/`);
