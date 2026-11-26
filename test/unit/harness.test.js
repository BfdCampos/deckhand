import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startDeckhand } from '../helpers/deckhand.js';
import { DECKS, agentBinDir } from '../helpers/fakes.js';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('startDeckhand runs an isolated server that restarts on the same port', async () => {
  const dh = await startDeckhand({ deck: 'test/fixtures/decks/basic.html', agents: ['claude'] });
  try {
    assert.match(dh.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.notEqual(dh.port, 0);
    assert.equal((await fetch(dh.url + '/')).status, 200);

    assert.ok(dh.home.startsWith(dh.root));
    assert.equal(fs.readFileSync(dh.deckPath, 'utf8'), fs.readFileSync(path.join(DECKS, 'basic.html'), 'utf8'));
    const agentsDir = path.join(dh.root, 'agents');
    assert.equal(fs.realpathSync(agentsDir), fs.realpathSync(agentBinDir(['claude'])));

    dh.setAgents([]);
    assert.equal(fs.realpathSync(agentsDir), fs.realpathSync(agentBinDir([])));
    dh.setAgents(['claude', 'codex']);
    assert.deepEqual(fs.readdirSync(agentsDir).sort(), ['claude', 'codex']);

    const { port, pid } = dh;
    await dh.restart();
    assert.equal(dh.port, port);
    assert.notEqual(dh.pid, pid);
    assert.equal(alive(pid), false);
    assert.equal((await fetch(dh.url + '/')).status, 200);
  } finally {
    await dh.dispose();
  }
  assert.equal(fs.existsSync(dh.root), false);
});

test('stop leaves the temp folder for inspection until dispose', async () => {
  const dh = await startDeckhand();
  const { pid } = dh;
  await dh.stop();
  assert.equal(alive(pid), false);
  assert.ok(fs.existsSync(dh.home));
  await dh.dispose();
  assert.equal(fs.existsSync(dh.root), false);
});
