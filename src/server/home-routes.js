import { listDir, startFolder } from './files.js';

export function homeRoutes({ store, config }) {
  const { home, decksDir } = config;
  return {
    'GET /api/recents': async () => ({ items: await store.recents() }),
    'POST /api/recents/remove': async ({ body }) => ({ items: await store.removeRecent(body.path) }),
    'GET /api/fs': async ({ query }) => listDir(query.get('dir') || (await startFolder({ store, decksDir, home })), { home }),
  };
}
