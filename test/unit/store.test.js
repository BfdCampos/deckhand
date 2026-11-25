import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createStore } from '../../src/server/store.js';
import { tempDir, removeTempDirs } from '../helpers/fakes.js';

after(removeTempDirs);

async function setup() {
  const home = tempDir('deckhand-store-');
  const stateDir = path.join(home, '.deckhand');
  const decks = path.join(home, 'decks');
  await fsp.mkdir(decks);
  const deck = async (name) => {
    const p = path.join(decks, name);
    await fsp.writeFile(p, '<h1>x</h1>');
    return p;
  };
  const store = createStore({ stateDir });
  await store.load();
  return { home, stateDir, file: path.join(stateDir, 'state.json'), decks, deck, store };
}

describe('store', () => {
  test('a fresh store is empty and writes nothing until something changes', async () => {
    const s = await setup();
    assert.deepEqual(await s.store.recents(), []);
    assert.equal(s.store.getAgent(), null);
    assert.equal(fs.existsSync(s.file), false);
  });

  test('recents are most recent first with name, dir and openedAt', async () => {
    const s = await setup();
    const a = await s.deck('a.html');
    const b = await s.deck('b.html');
    await s.store.addRecent(a);
    await s.store.addRecent(b);
    const items = await s.store.recents();
    assert.deepEqual(items.map((i) => i.path), [b, a]);
    assert.equal(items[0].name, 'b.html');
    assert.equal(items[0].dir, s.decks);
    assert.equal(items[0].missing, false);
    assert.ok(!Number.isNaN(Date.parse(items[0].openedAt)));
    const saved = JSON.parse(await fsp.readFile(s.file, 'utf8'));
    assert.equal(saved.version, 1);
    assert.deepEqual(saved.recents.map((r) => r.path), [b, a]);
  });

  test('re-opening moves a deck to the top without duplicating it, matching by realpath', async () => {
    const s = await setup();
    const a = await s.deck('a.html');
    const b = await s.deck('b.html');
    const link = path.join(s.home, 'link.html');
    await fsp.symlink(a, link);
    await s.store.addRecent(a);
    await s.store.addRecent(b);
    await s.store.addRecent(link);
    assert.deepEqual((await s.store.recents()).map((i) => i.path), [a, b]);
  });

  test('shows 8 and stores 50', async () => {
    const s = await setup();
    for (let i = 0; i < 55; i++) await s.store.addRecent(await s.deck(`d${i}.html`));
    const shown = await s.store.recents();
    assert.equal(shown.length, 8);
    assert.equal(shown[0].name, 'd54.html');
    assert.equal((await s.store.recents({ limit: 100 })).length, 50);
    assert.equal(JSON.parse(await fsp.readFile(s.file, 'utf8')).recents.length, 50);
  });

  test('AC-23 a deleted deck shows as missing and can be removed', async () => {
    const s = await setup();
    const a = await s.deck('a.html');
    const b = await s.deck('b.html');
    await s.store.addRecent(a);
    await s.store.addRecent(b);
    await fsp.rm(a);
    const items = await s.store.recents();
    assert.deepEqual(items.map((i) => [i.name, i.missing]), [['b.html', false], ['a.html', true]]);
    const after = await s.store.removeRecent(a);
    assert.deepEqual(after.map((i) => i.name), ['b.html']);
    assert.deepEqual(JSON.parse(await fsp.readFile(s.file, 'utf8')).recents.map((r) => r.path), [b]);
  });

  test('removeRecent accepts a symlinked path to the same deck', async () => {
    const s = await setup();
    const a = await s.deck('a.html');
    const link = path.join(s.home, 'alias.html');
    await fsp.symlink(a, link);
    await s.store.addRecent(a);
    assert.deepEqual(await s.store.removeRecent(link), []);
  });

  test('persists across instances, including the chosen agent', async () => {
    const s = await setup();
    await s.store.addRecent(await s.deck('a.html'));
    await s.store.setAgent('codex');
    const again = createStore({ stateDir: s.stateDir });
    await again.load();
    assert.equal(again.getAgent(), 'codex');
    assert.equal((await again.recents())[0].name, 'a.html');
  });

  test('a corrupt state file is set aside and the store starts fresh', async () => {
    const s = await setup();
    await fsp.mkdir(s.stateDir, { recursive: true });
    await fsp.writeFile(s.file, '{"recents": [oops');
    const store = createStore({ stateDir: s.stateDir });
    await store.load();
    assert.deepEqual(await store.recents(), []);
    const backups = fs.readdirSync(s.stateDir).filter((f) => f.startsWith('state.json.corrupt-'));
    assert.equal(backups.length, 1);
    assert.equal(await fsp.readFile(path.join(s.stateDir, backups[0]), 'utf8'), '{"recents": [oops');
    await store.addRecent(await s.deck('a.html'));
    assert.equal(JSON.parse(await fsp.readFile(s.file, 'utf8')).recents.length, 1);
  });

  test('invalid entries are dropped on load', async () => {
    const s = await setup();
    const a = await s.deck('a.html');
    await fsp.mkdir(s.stateDir, { recursive: true });
    await fsp.writeFile(s.file, JSON.stringify({
      version: 1,
      agent: 42,
      recents: [{ path: 'relative.html', openedAt: 'x' }, null, 'str', { path: a, openedAt: '2026-11-24T14:00:00.000Z' }, { path: a, openedAt: '2026-11-20T14:00:00.000Z' }],
    }));
    const store = createStore({ stateDir: s.stateDir });
    await store.load();
    assert.equal(store.getAgent(), null);
    assert.deepEqual((await store.recents()).map((i) => i.path), [a]);
  });

  test('concurrent adds are not lost and leave no temp files', async () => {
    const s = await setup();
    const paths = await Promise.all(Array.from({ length: 10 }, (_, i) => s.deck(`c${i}.html`)));
    await Promise.all(paths.map((p) => s.store.addRecent(p)));
    assert.equal((await s.store.recents({ limit: 50 })).length, 10);
    assert.equal(JSON.parse(await fsp.readFile(s.file, 'utf8')).recents.length, 10);
    assert.deepEqual(fs.readdirSync(s.stateDir).filter((f) => f.includes('tmp')), []);
  });

  test('the state file is private to the user', async () => {
    const s = await setup();
    await s.store.addRecent(await s.deck('a.html'));
    assert.equal((await fsp.stat(s.file)).mode & 0o777, 0o600);
    assert.equal((await fsp.stat(s.stateDir)).mode & 0o777, 0o700);
  });
});
