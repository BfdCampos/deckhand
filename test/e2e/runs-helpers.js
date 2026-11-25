import fs from 'node:fs';
import { expect } from './fixtures.js';
import { editUrl } from './editor-helpers.js';

export const BASIC = 'test/fixtures/decks/basic.html';

export const THREE = [
  { text: 'Make the title bigger', targetTag: 'h1', slide: 1 },
  { text: 'Two columns here', targetTag: 'ul', slide: 2 },
  { text: 'Warmer quote', targetTag: 'blockquote', slide: 3 },
];

async function call(deckhand, method, path, body) {
  const res = await fetch(deckhand.url + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} ${res.status} ${JSON.stringify(json)}`);
  return json;
}

export const getState = (deckhand) => call(deckhand, 'GET', '/api/state');
export const postApi = (deckhand, path, body = {}) => call(deckhand, 'POST', path, body);

export async function addNotes(deckhand, notes) {
  const { deck } = await getState(deckhand);
  let last = null;
  for (const note of notes) last = await postApi(deckhand, '/api/notes', { deckId: deck.deckId, op: 'add', note });
  return last ? last.notes : [];
}

export async function openEditor(page, deckhand) {
  await page.goto(await editUrl(deckhand));
  await expect(page.locator('.editor')).toBeVisible();
  await expect(page.locator('.runs-foot')).toBeVisible();
  await expect(page.frameLocator('iframe#deck').locator('h1')).toBeVisible();
  await page.waitForLoadState('networkidle');
}

export const sidecar = (deckhand, ext) => deckhand.deckPath.replace(/\.html$/, `.deckhand.${ext}`);
export const readMaybe = (p) => (fs.existsSync(p) ? fs.readFileSync(p) : null);
export const runs = (deckhand) => deckhand.agentLog({ mode: 'run' });

export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export const handoff = (page) => page.locator('.runs-handoff');
export const stopButton = (page) => page.locator('.runs-stop');
export const card = (page) => page.locator('.editor .activity-card');
export const chip = (page) => page.locator('.editor .topbar-agent .agent-chip');
