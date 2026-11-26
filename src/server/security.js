import fsp from 'node:fs/promises';
import path from 'node:path';

export const JSON_LIMIT = 1024 * 1024;
export const UPLOAD_LIMIT = 20 * 1024 * 1024;
const DRAIN_LIMIT = 4 * UPLOAD_LIMIT;

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const forbidden = (code = 'forbidden', message = 'Not allowed.') => new HttpError(403, code, message);
export const notFound = (message = 'Not found.') => new HttpError(404, 'not_found', message);

export function parseRequestPath(rawUrl = '/') {
  const cut = rawUrl.search(/[?#]/);
  const rawPath = cut === -1 ? rawUrl : rawUrl.slice(0, cut);
  const rawQuery = cut === -1 || rawUrl[cut] === '#' ? '' : rawUrl.slice(cut + 1).split('#')[0];
  let pathname;
  try {
    pathname = decodeURIComponent(rawPath);
  } catch {
    throw new HttpError(400, 'bad_path', 'That address is not valid.');
  }
  if (!pathname.startsWith('/')) throw new HttpError(400, 'bad_path', 'That address is not valid.');
  if (pathname.includes('\0')) throw forbidden('forbidden_path');
  const segments = pathname.split(/[/\\]/);
  if (segments.some((s) => s === '..' || s === '.')) throw forbidden('forbidden_path');
  let query;
  try {
    query = new URLSearchParams(rawQuery);
  } catch {
    throw new HttpError(400, 'bad_path', 'That address is not valid.');
  }
  return { pathname, query };
}

export function createGuard({ getPort }) {
  const hosts = () => {
    const port = getPort();
    return [`127.0.0.1:${port}`, `localhost:${port}`];
  };

  return {
    checkHost(req) {
      const host = String(req.headers.host || '').toLowerCase();
      if (!hosts().includes(host)) throw forbidden('forbidden_host', 'Deckhand only answers on 127.0.0.1 or localhost.');
    },
    checkOrigin(req) {
      const origin = req.headers.origin;
      if (origin !== undefined && !hosts().map((h) => `http://${h}`).includes(String(origin).toLowerCase())) {
        throw forbidden('forbidden_origin', 'Requests from other sites are not allowed.');
      }
      const site = req.headers['sec-fetch-site'];
      if (site !== undefined && site !== 'same-origin' && site !== 'none') {
        throw forbidden('forbidden_origin', 'Requests from other sites are not allowed.');
      }
    },
  };
}

function isUnder(root, p) {
  return p === root || p.startsWith(root + path.sep);
}

export async function resolveUnder(root, relPath) {
  let realRoot;
  try {
    realRoot = await fsp.realpath(root);
  } catch {
    throw notFound();
  }
  const segments = relPath.split(/[/\\]/).filter(Boolean);
  if (segments.some((s) => s === '..' || s === '.' || s.includes('\0'))) throw forbidden('forbidden_path');
  const candidate = path.join(realRoot, ...segments);
  if (!isUnder(realRoot, candidate)) throw forbidden('forbidden_path');
  let real;
  try {
    real = await fsp.realpath(candidate);
  } catch {
    throw notFound();
  }
  if (!isUnder(realRoot, real)) throw forbidden('forbidden_path');
  return real;
}

export async function ensureDirUnder(root, name) {
  const realRoot = await fsp.realpath(root);
  const dir = path.join(realRoot, name);
  await fsp.mkdir(dir, { recursive: true });
  const real = await fsp.realpath(dir);
  if (!isUnder(realRoot, real) || real === realRoot) throw forbidden('forbidden_path', 'The assets folder points outside the deck folder.');
  return real;
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => new HttpError(413, 'too_large', 'That is too large.');
    let size = 0;
    let over = false;
    const chunks = [];
    const overflow = () => {
      over = true;
      chunks.length = 0;
    };
    const declared = Number(req.headers['content-length']);
    if (declared > DRAIN_LIMIT) {
      over = true;
      reject(tooLarge());
      return;
    }
    if (declared > limit) overflow();
    req.on('data', (chunk) => {
      size += chunk.length;
      if (over) {
        if (size > DRAIN_LIMIT) {
          reject(tooLarge());
          req.destroy();
        }
        return;
      }
      if (size > limit) return overflow();
      chunks.push(chunk);
    });
    req.on('end', () => (over ? reject(tooLarge()) : resolve(Buffer.concat(chunks))));
    req.on('error', (e) => reject(e));
  });
}

export async function readJson(req, limit = JSON_LIMIT) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'bad_content_type', 'Send JSON.');
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  let body;
  try {
    body = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad_json', 'That request was not valid JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'bad_json', 'Send a JSON object.');
  return body;
}

const startsWith = (buf, bytes, at = 0) => bytes.every((b, i) => buf[at + i] === b);
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

export function sniffImage(buf) {
  if (!buf || buf.length < 4) return null;
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ext: 'png', type: 'image/png' };
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return { ext: 'jpg', type: 'image/jpeg' };
  if (startsWith(buf, ascii('GIF87a')) || startsWith(buf, ascii('GIF89a'))) return { ext: 'gif', type: 'image/gif' };
  if (startsWith(buf, ascii('RIFF')) && startsWith(buf, ascii('WEBP'), 8)) return { ext: 'webp', type: 'image/webp' };
  if (looksLikeSvg(buf)) return { ext: 'svg', type: 'image/svg+xml' };
  return null;
}

function looksLikeSvg(buf) {
  let text = buf.subarray(0, 4096).toString('utf8').replace(/^﻿/, '');
  const prolog = /^\s*(<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!doctype[^>]*>)/i;
  for (let i = 0; i < 20 && prolog.test(text); i++) text = text.replace(prolog, '');
  return /^\s*<svg[\s>/]/i.test(text);
}

export function sanitiseFileName(raw) {
  let name = String(raw || '');
  try { name = decodeURIComponent(name); } catch {}
  name = name.split(/[/\\]/).pop();
  name = name.replace(/\.[^.]*$/, '');
  name = name.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/_+/g, '_').replace(/^[._-]+|[._-]+$/g, '').slice(0, 60);
  return name.replace(/[._-]+$/, '') || 'image';
}

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

const POLICIES = {
  app: "frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'",
  deck: "connect-src 'none'; frame-ancestors 'self'",
  svg: "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; frame-ancestors 'self'",
};

export function securityHeaders(kind = 'app') {
  const headers = { ...BASE_HEADERS, 'X-Frame-Options': 'SAMEORIGIN' };
  if (POLICIES[kind]) headers['Content-Security-Policy'] = POLICIES[kind];
  return headers;
}
