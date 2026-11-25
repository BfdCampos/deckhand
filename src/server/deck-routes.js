import { HttpError } from './security.js';

const closed = () => new HttpError(409, 'deck_closed', 'This deck is no longer open.');

export function deckRoutes({ session, notes }) {
  const currentDeck = (deckId) => {
    const meta = session.meta();
    if (!meta || deckId !== meta.deckId) throw closed();
    return meta;
  };

  return {
    'POST /api/deck/open': ({ body }) => session.open(body.path),
    'POST /api/deck/close': async ({ body }) => {
      if (session.meta()?.deckId === body.deckId) await session.close();
      return {};
    },
    'POST /api/deck/ops': ({ body }) => session.applyOps(body.deckId, String(body.tabId ?? ''), body.baseRev, body.ops),
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
