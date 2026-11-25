import { test, describe, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { validateDeckPath, listDir, startFolder, nextFreeName, tildify, OPEN_COPY } from '../../src/server/files.js';
import { createStore } from '../../src/server/store.js';
import { tempDir, removeTempDirs } from '../helpers/fakes.js';
import { startDeckhand } from '../helpers/deckhand.js';

after(removeTempDirs);

const rejectsWith = (promise, code, message) => assert.rejects(promise, (e) => {
  assert.equal(e.status, 400);
  assert.equal(e.code, code);
  if (message) assert.equal(e.message, message);
  return true;
});

describe('validateDeckPath', () => {
  let home;
  let deck;

  beforeEach(async () => {
    home = tempDir('deckhand-files-');
    deck = path.join(home, 'My deck.html');
    await fsp.writeFile(deck, '<h1>Hi</h1>');
  });

  test('uses the product copy for each open error', async () => {
    assert.deepEqual(OPEN_COPY, {
      not_found: "Can't find that file.",
      not_html: "That's not an HTML file. Deckhand opens .html decks.",
      is_dir: "That's a folder. Pick an .html file inside it.",
      empty: 'That file is empty.',
      unreadable: "Deckhand can't read that file (permission denied).",
    });
    await fsp.writeFile(path.join(home, 'notes.txt'), 'hi');
    await fsp.writeFile(path.join(home, 'blank.html'), ' \n\t');
    await fsp.writeFile(path.join(home, 'locked.html'), '<p>x</p>');
    await fsp.chmod(path.join(home, 'locked.html'), 0o000);
    await rejectsWith(validateDeckPath(path.join(home, 'gone.html'), { home }), 'not_found', OPEN_COPY.not_found);
    await rejectsWith(validateDeckPath(path.join(home, 'notes.txt'), { home }), 'not_html', OPEN_COPY.not_html);
    await rejectsWith(validateDeckPath(home, { home }), 'is_dir', OPEN_COPY.is_dir);
    await rejectsWith(validateDeckPath(path.join(home, 'blank.html'), { home }), 'empty', OPEN_COPY.empty);
    await rejectsWith(validateDeckPath(path.join(home, 'locked.html'), { home }), 'unreadable', OPEN_COPY.unreadable);
    await rejectsWith(validateDeckPath('', { home }), 'not_found');
    await rejectsWith(validateDeckPath(42, { home }), 'not_found');
  });

  test('a folder named like a deck is still a folder', async () => {
    await fsp.mkdir(path.join(home, 'folder.html'));
    await rejectsWith(validateDeckPath(path.join(home, 'folder.html'), { home }), 'is_dir');
  });

  test('accepts .htm and uppercase extensions', async () => {
    for (const name of ['a.htm', 'b.HTML']) {
      await fsp.writeFile(path.join(home, name), '<p>x</p>');
      assert.equal((await validateDeckPath(path.join(home, name), { home })).real, path.join(home, name));
    }
  });

  test('accepts pasted forms of a path', async () => {
    const forms = [
      `  ${deck}  `,
      `"${deck}"`,
      `'${deck}'`,
      deck.replace(/ /g, '\\ '),
      'file://' + encodeURI(deck),
      '~/My deck.html',
      'My deck.html',
    ];
    for (const form of forms) {
      const { real, buf } = await validateDeckPath(form, { home });
      assert.equal(real, deck, form);
      assert.equal(buf.toString(), '<h1>Hi</h1>');
    }
  });

  test('resolves symlinks to the real file', async () => {
    const link = path.join(home, 'link.html');
    await fsp.symlink(deck, link);
    assert.equal((await validateDeckPath(link, { home })).real, deck);
    await fsp.symlink(path.join(home, 'nowhere.html'), path.join(home, 'broken.html'));
    await rejectsWith(validateDeckPath(path.join(home, 'broken.html'), { home }), 'not_found');
  });
});

describe('listDir', () => {
  let home;

  beforeEach(async () => {
    home = tempDir('deckhand-browse-');
    for (const d of ['Beta', 'alpha', '.hidden', 'deck 10 folder', 'locked']) await fsp.mkdir(path.join(home, d));
    for (const f of ['deck 10.html', 'deck 2.html', 'Zed.HTM', 'notes.md', '.secret.html', 'deck.deckhand.json', 'deck 2.html.deckhand-tmp', '<img src=x onerror=alert(1)>.html']) {
      await fsp.writeFile(path.join(home, f), 'x');
    }
    await fsp.symlink(path.join(home, 'alpha'), path.join(home, 'linked'));
    await fsp.symlink(path.join(home, 'nothing'), path.join(home, 'dangling.html'));
    await fsp.chmod(path.join(home, 'locked'), 0o000);
  });

  afterEach(async () => { await fsp.chmod(path.join(home, 'locked'), 0o755); });

  test('AC-25 lists folders then decks, hidden and other files excluded, naturally sorted', async () => {
    const res = await listDir(home, { home });
    assert.equal(res.path, home);
    assert.deepEqual(res.entries.map((e) => [e.name, e.kind]), [
      ['alpha', 'dir'],
      ['Beta', 'dir'],
      ['deck 10 folder', 'dir'],
      ['linked', 'dir'],
      ['locked', 'dir'],
      ['<img src=x onerror=alert(1)>.html', 'deck'],
      ['deck 2.html', 'deck'],
      ['deck 10.html', 'deck'],
      ['Zed.HTM', 'deck'],
    ]);
    for (const e of res.entries) assert.equal(e.path, path.join(home, e.name));
  });

  test('breadcrumb runs from the root to the folder, with a parent link', async () => {
    const res = await listDir(path.join(home, 'alpha'), { home });
    assert.equal(res.parent, home);
    assert.deepEqual(res.crumbs[0], { name: '/', path: '/' });
    assert.deepEqual(res.crumbs.at(-1), { name: 'alpha', path: path.join(home, 'alpha') });
    assert.equal(res.crumbs.map((c) => c.path).at(-2), home);
    assert.equal(res.home, home);
    const root = await listDir('/', { home });
    assert.equal(root.parent, null);
    assert.deepEqual(root.crumbs, [{ name: '/', path: '/' }]);
  });

  test('folder errors carry their own copy', async () => {
    await rejectsWith(listDir(path.join(home, 'locked'), { home }), 'unreadable', "Deckhand can't open that folder (permission denied).");
    await rejectsWith(listDir(path.join(home, 'gone'), { home }), 'not_found', "Can't find that folder.");
    await rejectsWith(listDir(path.join(home, 'deck 2.html'), { home }), 'not_dir', "That's a file, not a folder.");
  });

  test('accepts ~ and resolves symlinked folders', async () => {
    assert.equal((await listDir('~', { home })).path, home);
    assert.equal((await listDir(path.join(home, 'linked'), { home })).path, path.join(home, 'alpha'));
  });
});

describe('startFolder, nextFreeName and tildify', () => {
  test('starts in the most recent deck folder, else ~/Deckhand, else home', async () => {
    const home = tempDir('deckhand-start-');
    const decksDir = path.join(home, 'Deckhand');
    const store = createStore({ stateDir: path.join(home, '.deckhand') });
    await store.load();
    assert.equal(await startFolder({ store, decksDir, home }), home);
    await fsp.mkdir(decksDir);
    assert.equal(await startFolder({ store, decksDir, home }), decksDir);
    const work = path.join(home, 'work');
    await fsp.mkdir(work);
    await fsp.writeFile(path.join(work, 'a.html'), 'x');
    await store.addRecent(path.join(work, 'a.html'));
    assert.equal(await startFolder({ store, decksDir, home }), work);
    await fsp.rm(work, { recursive: true });
    assert.equal(await startFolder({ store, decksDir, home }), decksDir);
  });

  test('nextFreeName appends -2, -3 for taken names and honours reservations', async () => {
    const dir = tempDir('deckhand-names-');
    assert.deepEqual(await nextFreeName(dir, 'coffee-pitch'), { name: 'coffee-pitch.html', path: path.join(dir, 'coffee-pitch.html') });
    await fsp.writeFile(path.join(dir, 'coffee-pitch.html'), 'x');
    assert.equal((await nextFreeName(dir, 'coffee-pitch')).name, 'coffee-pitch-2.html');
    await fsp.writeFile(path.join(dir, 'coffee-pitch-2.html'), 'x');
    assert.equal((await nextFreeName(dir, 'coffee-pitch', { taken: new Set([path.join(dir, 'coffee-pitch-3.html')]) })).name, 'coffee-pitch-4.html');
    assert.equal((await nextFreeName(path.join(dir, 'not-yet'), 'x')).name, 'x.html');
  });

  test('tildify shortens paths under home', () => {
    assert.equal(tildify('/Users/me/Deckhand/a.html', '/Users/me'), '~/Deckhand/a.html');
    assert.equal(tildify('/Users/me', '/Users/me'), '~');
    assert.equal(tildify('/Users/meagain/x', '/Users/me'), '/Users/meagain/x');
  });
});

describe('home routes over HTTP', () => {
  let dh;
  const post = (p, body) => fetch(dh.url + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: dh.url },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: await r.json() }));
  const get = (p) => fetch(dh.url + p).then(async (r) => ({ status: r.status, json: await r.json() }));

  afterEach(async () => { await dh?.dispose(); });

  test('AC-21 AC-23 recents fill on open, survive a restart, show missing and can be removed', async () => {
    dh = await startDeckhand({ agents: [] });
    assert.deepEqual((await get('/api/recents')).json, { items: [] });
    const dir = path.join(dh.home, 'Talks');
    fs.mkdirSync(dir);
    const a = path.join(dir, 'a.html');
    const b = path.join(dir, 'b.html');
    fs.writeFileSync(a, '<h1>A</h1>');
    fs.writeFileSync(b, '<h1>B</h1>');
    assert.equal((await post('/api/deck/open', { path: a })).status, 200);
    assert.equal((await post('/api/deck/open', { path: b })).status, 200);
    assert.equal((await post('/api/deck/open', { path: path.join(dir, 'nope.html') })).json.error.message, "Can't find that file.");
    assert.deepEqual((await get('/api/recents')).json.items.map((i) => i.name), ['b.html', 'a.html']);

    await dh.restart();
    fs.rmSync(a);
    const items = (await get('/api/recents')).json.items;
    assert.deepEqual(items.map((i) => [i.name, i.missing]), [['b.html', false], ['a.html', true]]);
    const removed = await post('/api/recents/remove', { path: a });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.json.items.map((i) => i.name), ['b.html']);

    const fsRes = await get('/api/fs');
    assert.equal(fsRes.json.path, dir, 'Browse starts in the most recent deck folder');
    assert.deepEqual(fsRes.json.entries.map((e) => e.name), ['b.html']);
  });

  test('a corrupt state file at startup does not stop the server', async () => {
    const first = await startDeckhand({ agents: [] });
    fs.mkdirSync(path.join(first.home, '.deckhand'), { recursive: true });
    fs.writeFileSync(path.join(first.home, '.deckhand', 'state.json'), 'not json');
    await first.stop();
    dh = await startDeckhand({ agents: [], env: { HOME: first.home } });
    assert.deepEqual((await get('/api/recents')).json.items, []);
    await first.dispose();
  });

  test('state exposes the decks folder and the sample deck', async () => {
    dh = await startDeckhand({ agents: [] });
    const state = (await get('/api/state')).json;
    assert.equal(state.decksDir, path.join(dh.home, 'Deckhand'));
    assert.equal(state.decksDirLabel, '~/Deckhand');
    assert.ok(state.sampleDeck.endsWith(path.join('samples', 'sample-deck.html')));
    assert.ok(fs.existsSync(state.sampleDeck));
    const browse = await get('/api/fs?dir=' + encodeURIComponent(path.join(dh.home, 'missing')));
    assert.equal(browse.status, 400);
    assert.equal(browse.json.error.code, 'not_found');
  });
});
