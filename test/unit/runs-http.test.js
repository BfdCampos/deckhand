import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import WebSocket from 'ws';
import { startDeckhand } from '../helpers/deckhand.js';
import { request, postJson } from '../helpers/http.js';
import { waitFor } from '../helpers/util.js';

function listen(srv) {
  const events = [];
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { Origin: srv.url } });
  ws.on('message', (m) => events.push(JSON.parse(m)));
  const open = new Promise((r) => ws.on('open', r));
  return { events, ws, open, of: (type) => events.filter((e) => e.type === type) };
}

async function addNote(srv, text) {
  const { deckId } = (await request(srv.port, { path: '/api/state' })).json.deck;
  const res = await postJson(srv.port, '/api/notes', { deckId, op: 'add', note: { text, aiId: 'dh1', targetTag: 'h1', slide: 1 } });
  assert.equal(res.status, 200, res.text);
  return res.json.notes.at(-1);
}

async function settled(srv) {
  return waitFor(async () => {
    const r = (await request(srv.port, { path: '/api/runs/current' })).json;
    return r && r.status !== 'running' ? r : null;
  }, { timeout: 8000 });
}

describe('runs over HTTP and the socket', () => {
  let srv;
  before(async () => { srv = await startDeckhand({ deck: 'test/fixtures/decks/basic.html', agents: ['claude', 'codex'] }); });
  after(async () => { await srv?.dispose(); });

  test('the launch line and /api/state carry the agents payload', async () => {
    assert.match(srv.stdout(), /^\s*Agent: Claude Code 2\.1\.331 \(Codex 0\.130\.0 also found\)$/m);
    const state = (await request(srv.port, { path: '/api/state' })).json;
    assert.equal(state.agents.selected, 'claude');
    assert.deepEqual(state.agents.list.map((a) => [a.id, a.found, a.version]), [['claude', true, '2.1.331'], ['codex', true, '0.130.0']]);
    assert.equal(state.run, null);
    assert.equal(typeof state.decksDir, 'string');
  });

  test('a run streams run and run-activity events that match GET /api/runs/current', async () => {
    const sock = listen(srv);
    await sock.open;
    await waitFor(() => sock.of('agents').length);
    const note = await addNote(srv, 'Make it bolder');
    const started = await postJson(srv.port, '/api/runs', { kind: 'edit', scope: 'all' });
    assert.equal(started.status, 200, started.text);
    const run = started.json;
    assert.equal(run.status, 'running');
    assert.deepEqual(run.noteIds, [note.id]);
    assert.equal(run.targetPath, (await request(srv.port, { path: '/api/state' })).json.deck.path);

    const done = await settled(srv);
    assert.equal(done.status, 'succeeded', done.error);
    assert.deepEqual(done.summary, { applied: 1, total: 1 });
    assert.equal(done.canRevert, true);
    await waitFor(() => sock.of('run').some((e) => e.run.status === 'succeeded'));
    const live = sock.of('run-activity').filter((e) => e.runId === run.id).map((e) => e.line);
    assert.deepEqual(live.map((l) => l.seq), done.activity.map((l) => l.seq));
    assert.deepEqual(done.activity.map((l) => l.kind), ['status', 'status', 'read', 'edit', 'text', 'result']);
    assert.ok(sock.of('notes').some((e) => e.notes.some((n) => n.id === note.id && n.status === 'done')));
    sock.ws.close();

    const reverted = await postJson(srv.port, `/api/runs/${run.id}/revert`, {});
    assert.equal(reverted.status, 200, reverted.text);
    assert.equal(reverted.json.reverted, true);
    assert.equal(reverted.json.canRevert, false);
    assert.doesNotMatch(fs.readFileSync(srv.deckPath, 'utf8'), /Edited: /);
    const again = await postJson(srv.port, `/api/runs/${run.id}/revert`, {});
    assert.equal(again.status, 409);
    assert.equal(again.json.error.code, 'cannot_revert');
  });

  test('Stop over HTTP, busy while running, and select refused while busy', async () => {
    await addNote(srv, `Wait forever [[fake:hang]]`);
    const notes = (await request(srv.port, { path: '/api/notes' })).json.notes;
    const open = notes.find((n) => n.status === 'open' && n.text.includes('fake:hang'));
    const run = (await postJson(srv.port, '/api/runs', { kind: 'edit', scope: 'note', noteId: open.id })).json;
    assert.equal(run.status, 'running');
    const busy = await postJson(srv.port, '/api/runs', { kind: 'create', description: 'tea' });
    assert.equal(busy.status, 409);
    assert.equal(busy.json.error.code, 'busy');
    const select = await postJson(srv.port, '/api/agents/select', { id: 'codex' });
    assert.equal(select.status, 409);
    assert.equal((await request(srv.port, { path: '/api/state' })).json.run.status, 'running');
    const stopped = await postJson(srv.port, `/api/runs/${run.id}/stop`, {});
    assert.equal(stopped.status, 200);
    assert.equal(stopped.json.status, 'stopped');
    assert.equal(stopped.json.canRevert, true);
    const notRunning = await postJson(srv.port, `/api/runs/${run.id}/stop`, {});
    assert.equal(notRunning.json.error.code, 'not_running');
  });

  test('detect and select broadcast agents events', async () => {
    const sock = listen(srv);
    await sock.open;
    await waitFor(() => sock.of('agents').length);
    const sel = await postJson(srv.port, '/api/agents/select', { id: 'codex' });
    assert.equal(sel.json.agents.selected, 'codex');
    await waitFor(() => sock.of('agents').some((e) => e.agents.selected === 'codex'));
    srv.setAgents(['claude']);
    const det = await postJson(srv.port, '/api/agents/detect', {});
    assert.equal(det.json.agents.selected, 'claude');
    assert.equal(det.json.agents.list[1].found, false);
    await waitFor(() => sock.of('agents').some((e) => e.agents.selected === 'claude'));
    sock.ws.close();
    srv.setAgents(['claude', 'codex']);
    await postJson(srv.port, '/api/agents/detect', {});
  });
});
