import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { HttpError, forbidden, notFound, parseRequestPath, readJson, resolveUnder, securityHeaders } from './security.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const SPA_PATHS = new Set(['/', '/create', '/edit']);
const DECK_ASSET_EXTS = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico',
  '.woff', '.woff2', '.ttf', '.otf', '.mp4', '.webm', '.mp3', '.wav', '.ogg',
]);

function deckFileAllowed(rel) {
  const segments = rel.split(/[/\\]/).filter(Boolean);
  if (!segments.length || segments.some((s) => s.startsWith('.'))) return false;
  const name = segments.at(-1).toLowerCase();
  return DECK_ASSET_EXTS.has(path.extname(name)) || name.endsWith('.deckhand.json');
}

const typeOf = (file) => TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';

function compile(pattern) {
  const keys = [];
  const source = pattern.split('/').map((part) => {
    if (!part.startsWith(':')) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    keys.push(part.slice(1));
    return '([^/]+)';
  }).join('/');
  return { regex: new RegExp(`^${source}$`), keys };
}

export function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { ...securityHeaders('app'), 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
}

export function createHttp({ config, guard, deckDir, deckSource = () => null }) {
  const routes = [];

  function registerRoutes(table) {
    for (const [key, spec] of Object.entries(table)) {
      const [method, pattern] = key.split(/\s+/);
      if (!method || !pattern?.startsWith('/api/')) throw new Error(`Bad route key: ${key}`);
      if (routes.some((r) => r.method === method && r.pattern === pattern)) throw new Error(`Route already registered: ${key}`);
      const { handler, body = method === 'POST' ? 'json' : 'none', limit } = typeof spec === 'function' ? { handler: spec } : spec;
      routes.push({ method, pattern, handler, body, limit, ...compile(pattern) });
    }
  }

  async function handleApi(req, res, pathname, query) {
    let matchedPath = false;
    for (const route of routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      matchedPath = true;
      if (route.method !== req.method) continue;
      const params = Object.fromEntries(route.keys.map((k, i) => [k, m[i + 1]]));
      const ctx = { req, res, pathname, query, params, body: undefined };
      if (route.body === 'json') ctx.body = await readJson(req, route.limit);
      const result = await route.handler(ctx);
      if (!res.headersSent) sendJson(res, 200, result ?? {});
      return;
    }
    if (matchedPath) throw new HttpError(405, 'method_not_allowed', 'That method is not allowed here.');
    throw notFound();
  }

  async function sendFile(req, res, file, kind) {
    let data;
    try {
      const st = await fsp.stat(file);
      if (!st.isFile()) throw notFound();
      data = await fsp.readFile(file);
    } catch (e) {
      throw e instanceof HttpError ? e : notFound();
    }
    res.writeHead(200, { ...securityHeaders(kind), 'Content-Type': typeOf(file), 'Content-Length': data.length });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  async function serveDeckFile(req, res, rel) {
    const dir = deckDir();
    if (!dir) throw notFound('No deck is open.');
    if (!deckFileAllowed(rel)) throw forbidden('forbidden_path');
    const file = await resolveUnder(dir, rel);
    const ext = path.extname(file).toLowerCase();
    const kind = ext === '.html' || ext === '.htm' ? 'deck' : ext === '.svg' ? 'svg' : 'asset';
    const served = deckSource(file);
    if (typeof served === 'string') {
      const data = Buffer.from(served, 'utf8');
      res.writeHead(200, { ...securityHeaders('deck'), 'Content-Type': typeOf(file), 'Content-Length': data.length });
      return res.end(req.method === 'HEAD' ? undefined : data);
    }
    return sendFile(req, res, file, kind);
  }

  async function serveApp(req, res, pathname) {
    if (SPA_PATHS.has(pathname)) return sendFile(req, res, path.join(config.publicDir, 'index.html'), 'app');
    if (pathname.startsWith('/shared/')) {
      return sendFile(req, res, await resolveUnder(config.sharedDir, pathname.slice('/shared/'.length)), 'app');
    }
    const segments = pathname.split('/').filter(Boolean);
    if (!segments.length || segments.some((s) => s.startsWith('.'))) throw notFound();
    if (/^test-.*\.html?$/i.test(segments.at(-1)) && !config.test) throw notFound();
    return sendFile(req, res, await resolveUnder(config.publicDir, pathname), 'app');
  }

  function sendError(req, res, err, isApi) {
    if (!(err instanceof HttpError)) {
      if (err?.code === 'ECONNRESET' || err?.message === 'aborted') return res.destroy();
      console.error(`[deckhand] request failed: ${err?.message || err}`);
      err = new HttpError(500, 'internal', 'Something went wrong.');
    }
    if (res.headersSent) return res.destroy();
    const headers = err.status === 413 ? { Connection: 'close' } : {};
    if (isApi) return sendJson(res, err.status, { error: { code: err.code, message: err.message } }, headers);
    res.writeHead(err.status, { ...securityHeaders('app'), 'Content-Type': 'text/plain; charset=utf-8', ...headers });
    res.end(err.message);
  }

  const server = http.createServer(async (req, res) => {
    const isApi = /^\/api(\/|$|\?)/.test(req.url || '');
    try {
      guard.checkHost(req);
      const { pathname, query } = parseRequestPath(req.url);
      if (isApi) {
        guard.checkOrigin(req);
        return await handleApi(req, res, pathname, query);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', 'That method is not allowed here.');
      if (pathname.startsWith('/deckroot/')) return await serveDeckFile(req, res, pathname.slice('/deckroot/'.length));
      return await serveApp(req, res, pathname);
    } catch (err) {
      sendError(req, res, err, isApi);
    }
  });

  return { server, registerRoutes };
}
