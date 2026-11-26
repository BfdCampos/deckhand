import { HttpError } from './security.js';

const OPS_LIMIT = 48 * 1024 * 1024;

const closed = () => new HttpError(409, 'deck_closed', 'This deck is no longer open.');

export function deckRoutes({ session, notes, sample = null }) {
  const currentDeck = (deckId) => {
    const meta = session.meta();
    if (!meta || deckId !== meta.deckId) throw closed();
    return meta;
  };

  return {
    'POST /api/deck/open': async ({ body }) => session.open(sample ? await sample.resolve(body.path) : body.path),
    'POST /api/deck/close': async ({ body }) => {
      if (session.meta()?.deckId === body.deckId) await session.close();
      return {};
    },
    'POST /api/deck/ops': {
      limit: OPS_LIMIT,
      handler: ({ body }) => session.applyOps(body.deckId, String(body.tabId ?? ''), body.baseRev, body.ops),
    },
    'POST /api/deck/undo': ({ body }) => session.undo(body.deckId, String(body.tabId ?? ''), body.opId),
    'POST /api/deck/redo': ({ body }) => session.redo(body.deckId, String(body.tabId ?? ''), body.opId),
    'GET /api/notes': () => notes.snapshot(),
    'POST /api/notes': async ({ body }) => {
      currentDeck(body.deckId);
      if (session.isLocked()) throw new HttpError(423, 'run_active', 'Notes are locked while the agent is working.');
      const result = await notes.apply(body);
      await session.flushAnchors();
      return result;
    },
  };
}
