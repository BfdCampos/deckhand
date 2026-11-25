import fs from 'node:fs';
import path from 'node:path';
import { expect } from './fixtures.js';

export const DECK = '<!DOCTYPE html><html><head><title>t</title></head><body><section class="slide"><h1>Hello</h1></section></body></html>';

export function makeDeck(dir, name, body = DECK) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  return p;
}

export const realHome = (deckhand) => fs.realpathSync(deckhand.home);
export const decksDir = (deckhand) => path.join(realHome(deckhand), 'Deckhand');

async function call(deckhand, method, p, body) {
  const res = await fetch(deckhand.url + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${p} ${res.status} ${JSON.stringify(json)}`);
  return json;
}

export const getApi = (deckhand, p) => call(deckhand, 'GET', p);
export const postApi = (deckhand, p, body = {}) => call(deckhand, 'POST', p, body);

export async function openAsRecent(deckhand, ...paths) {
  for (const p of paths) await postApi(deckhand, '/api/deck/open', { path: p });
  await postApi(deckhand, '/api/deck/close', { deckId: (await getApi(deckhand, '/api/state')).deck?.deckId });
}

export async function openHome(page, deckhand) {
  await page.goto(deckhand.url);
  await expect(page.locator('.home')).toBeVisible();
  await page.waitForLoadState('networkidle');
}

export function trackRequests(page, pathname, method = 'POST') {
  const hits = [];
  page.on('request', (r) => {
    if (r.method() === method && new URL(r.url()).pathname === pathname) hits.push(r.postDataJSON?.() ?? null);
  });
  return hits;
}

export const input = (page) => page.getByRole('textbox', { name: 'Describe the deck you want' });
export const createBtn = (page) => page.locator('.create-submit');
export const pathField = (page) => page.getByRole('textbox', { name: 'Deck path' });
export const topName = (page) => page.locator('.editor .topbar-name');
export const homeChip = (page) => page.locator('.home .home-top .agent-chip');
