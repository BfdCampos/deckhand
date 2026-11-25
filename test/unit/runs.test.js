import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createAgents } from '../../src/server/agents/index.js';
import { createDeckSession } from '../../src/server/deck-session.js';
import { createNotes } from '../../src/server/notes.js';
import { createRuns } from '../../src/server/runs.js';
import { createStore } from '../../src/server/store.js';
import { DECKS, agentBinDir, nodeBinDir, readAgentLog, removeTempDirs, tempDir } from '../helpers/fakes.js';
import { pidAlive, waitFor } from '../helpers/util.js';

after(removeTempDirs);
const live = [];
after(async () => { for (const r of live) await r.stopAll().catch(() => {}); });

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"></svg>';

async function setup({ agents = ['claude'], deck = 'basic.html', notes = ['Make it bolder'], env = {}, scenario } = {}) {
  const root = tempDir();
  const home = path.join(root, 'home');
  const decksDir = path.join(home, 'Deckhand');
  const deckDir = path.join(root, 'decks');
  const tmp = path.join(root, 'tmp');
  for (const d of [home, deckDir, tmp]) fs.mkdirSync(d, { recursive: true });
  const deckPath = path.join(deckDir, 'deck.html');
  fs.copyFileSync(path.join(DECKS, deck), deckPath);
  const link = path.join(root, 'bin');
  fs.symlinkSync(agentBinDir(agents), link);
  const logPath = path.join(root, 'agent.log');
  const fullEnv = {
    PATH: `${link}:${nodeBinDir()}`, HOME: home, FAKE_AGENT_LOG: logPath,
    ...(scenario ? { FAKE_AGENT_SCENARIO: scenario } : {}), ...env,
  };

  const events = [];
  const hub = { broadcast: (e) => events.push(e) };
  const store = createStore({ stateDir: path.join(home, '.deckhand') });
  await store.load();
  const notesMod = createNotes({ hub });
  const session = createDeckSession({ hub, store, notes: notesMod });
  const agentsMod = createAgents({ config: { extraBinDirs: [] }, store, broadcast: hub.broadcast, env: fullEnv, log: () => {} });
  await agentsMod.detect();
  const runs = createRuns({
    config: { decksDir, home }, session, notes: notesMod, agents: agentsMod, store, broadcast: hub.broadcast, env: fullEnv, tmpDir: tmp, log: () => {},
  });
  live.push(runs);
  await session.open(deckPath);
  for (const text of notes) await notesMod.apply({ op: 'add', note: { text, aiId: 'dh1', targetTag: 'h1', slide: 1 } });
  const meta = session.meta();
  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p) : null);
  const files = () => ({ deck: read(meta.path), json: read(meta.notesPath), md: read(meta.workOrderPath) });
  return {
    root, home, decksDir, deckDir, deckPath: meta.path, tmp, logPath, events, store, session, notes: notesMod, agents: agentsMod, runs, meta, files,
    log: () => readAgentLog(logPath, { mode: 'run' }),
    setScenario: (name) => { fullEnv.FAKE_AGENT_SCENARIO = name; },
  };
}

async function finished(runs, timeout = 8000) {
  return waitFor(() => {
    const r = runs.current();
    return r && r.status !== 'running' ? r : null;
  }, { timeout });
}

function scenarioFile(dir, steps) {
  const f = path.join(dir, `scenario-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify({ steps }));
  return f;
}

const CREATE = (description) => ({ kind: 'create', description });

describe('create runs', () => {
  test('AC-13 the agent gets the contract then the text, in a staging cwd, and the deck lands in ~/Deckhand', async () => {
    const t = await setup({ notes: [] });
    await t.session.close();
    const run = await t.runs.start(CREATE('A deck about tea'));
    assert.equal(run.kind, 'create');
    assert.equal(run.status, 'running');
    assert.equal(run.targetPath, path.join(t.decksDir, 'deck-tea.html'));
    const done = await finished(t.runs);
    assert.equal(done.status, 'succeeded', done.error);
    const [entry] = t.log();
    assert.match(path.basename(entry.cwd), /^deckhand-run-/);
    assert.ok(fs.realpathSync(path.dirname(entry.cwd)) === fs.realpathSync(t.tmp));
    assert.match(entry.stdin, /^You're creating a new slide deck for Deckhand/);
    assert.match(entry.stdin, /Write exactly one file, `deck-tea\.html`/);
    assert.match(entry.stdin, /\n\nA deck about tea$/);
    assert.ok(fs.existsSync(done.targetPath));
    assert.equal(t.session.meta().path, fs.realpathSync(done.targetPath));
    assert.equal(done.canRevert, true);
    assert.equal(fs.existsSync(entry.cwd), false, 'staging removed');
  });

  test('an existing name gets -2', async () => {
    const t = await setup({ notes: [] });
    fs.mkdirSync(t.decksDir, { recursive: true });
    fs.writeFileSync(path.join(t.decksDir, 'deck-tea.html'), 'x');
    const run = await t.runs.start(CREATE('A deck about tea'));
    assert.equal(path.basename(run.targetPath), 'deck-tea-2.html');
    await finished(t.runs);
  });

  test('AC-16 a failing agent leaves no file and reports its error', async () => {
    const t = await setup({ notes: [], scenario: 'fail' });
    const run = await t.runs.start(CREATE('A deck about tea'));
    const done = await finished(t.runs);
    assert.equal(done.status, 'failed');
    assert.equal(done.error, 'Something went wrong.');
    assert.equal(fs.existsSync(run.targetPath), false);
    assert.ok(!done.outputUsable);
  });

  test('AC-17 exit 0 without the file says so', async () => {
    const t = await setup({ notes: [], scenario: 'create-nothing' });
    await t.runs.start(CREATE('A deck about tea'));
    const done = await finished(t.runs);
    assert.equal(done.status, 'failed');
    assert.equal(done.error, 'The agent finished without writing the deck.');
  });

  test('a file with an empty body is not a deck', async () => {
    const t = await setup({ notes: [], scenario: 'create-empty-body' });
    const run = await t.runs.start(CREATE('A deck about tea'));
    const done = await finished(t.runs);
    assert.equal(done.status, 'failed');
    assert.equal(fs.existsSync(run.targetPath), false);
  });

  test('a failed run that wrote a valid deck keeps it as usable output', async () => {
    const t = await setup({ notes: [], scenario: 'edit-then-fail' });
    const run = await t.runs.start(CREATE('A deck about tea'));
    const done = await finished(t.runs);
    assert.equal(done.status, 'failed');
    assert.equal(done.outputUsable, true);
    assert.ok(fs.existsSync(run.targetPath));
  });

  test('AC-18 Stop kills the agent and leaves no file', async () => {
    const t = await setup({ notes: [], scenario: 'hang' });
    const run = await t.runs.start(CREATE('A deck about tea'));
    await waitFor(() => t.log().length);
    const { pid } = t.log()[0];
    const stopped = await t.runs.stop(run.id);
    assert.equal(stopped.status, 'stopped');
    assert.equal(pidAlive(pid), false);
    assert.equal(fs.existsSync(run.targetPath), false);
  });

  test('Revert on a create deletes the deck and closes it (D-16)', async () => {
    const t = await setup({ notes: [] });
    const run = await t.runs.start(CREATE('A deck about tea'));
    await finished(t.runs);
    const reverted = await t.runs.revert(run.id);
    assert.equal(reverted.reverted, true);
    assert.equal(reverted.canRevert, false);
    assert.equal(fs.existsSync(run.targetPath), false);
    assert.equal(t.session.meta(), null);
    assert.ok(!t.store.get().recents.some((r) => r.path.endsWith('deck-tea.html')));
  });

  test('an empty description is refused', async () => {
    const t = await setup({ notes: [] });
    await assert.rejects(t.runs.start(CREATE('   ')), (e) => e.status === 400 && e.code === 'empty_description');
  });
});

describe('edit runs', () => {
  test('AC-56 Claude is invoked with the tool list, restrictions and guardrail; the prompt only on stdin', async () => {
    const t = await setup();
    await t.runs.start({ kind: 'edit', scope: 'all' });
    await finished(t.runs);
    const [entry] = t.log();
    assert.equal(entry.tool, 'claude');
    const argv = entry.argv;
    assert.equal(argv[argv.indexOf('--tools') + 1], 'Read,Edit,Write,Glob,Grep');
    for (const f of ['--restricted', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']) assert.ok(argv.includes(f), f);
    assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'acceptEdits');
    const guard = argv[argv.indexOf('--append-system-prompt') + 1];
    assert.match(guard, /Never create, edit, move or delete any other file/);
    assert.ok(!argv.some((a) => a.includes('Read the Deckhand work order')));
    assert.match(entry.stdin, /Read the Deckhand work order in deck\.deckhand\.md/);
  });

  test('AC-7 after choosing Codex the next run invokes codex with its sandbox flags', async () => {
    const t = await setup({ agents: ['claude', 'codex'] });
    await t.agents.select('codex');
    const run = await t.runs.start({ kind: 'edit', scope: 'all' });
    assert.equal(run.agentId, 'codex');
    assert.equal(run.agentName, 'Codex');
    const done = await finished(t.runs);
    assert.equal(done.status, 'succeeded', done.error);
    const [entry] = t.log();
    assert.equal(entry.tool, 'codex');
    assert.equal(entry.argv[entry.argv.indexOf('--sandbox') + 1], 'workspace-write');
    assert.ok(entry.argv.includes('approval_policy="never"'));
    assert.ok(entry.argv.includes('sandbox_workspace_write.network_access=false'));
    assert.match(entry.stdin, /^You are the slide editor inside Deckhand/);
    assert.match(fs.readFileSync(t.deckPath, 'utf8'), /Edited: Basic deck/);
  });

  test('AC-45 all notes vs one note', async () => {
    const t = await setup({ notes: ['First', 'Second'] });
    const [n1, n2] = t.notes.list();
    const one = await t.runs.start({ kind: 'edit', scope: 'note', noteId: n2.id });
    assert.deepEqual(one.noteIds, [n2.id]);
    assert.equal(one.label, 'Note 2');
    let done = await finished(t.runs);
    assert.equal(done.status, 'succeeded');
    assert.match(t.log()[0].stdin, new RegExp(`one note only: ${n2.id}`));
    assert.deepEqual(t.notes.list().map((n) => n.status), ['open', 'done']);
    assert.deepEqual(done.summary, { applied: 1, total: 1 });

    const all = await t.runs.start({ kind: 'edit', scope: 'all' });
    assert.deepEqual(all.noteIds, [n1.id]);
    assert.equal(all.label, 'All notes');
    done = await finished(t.runs);
    assert.deepEqual(t.notes.list().map((n) => n.status), ['done', 'done']);
    assert.equal(t.notes.list()[0].doneBy, 'claude');
  });

  test('AC-49 two of three ticked leaves one open and says so', async () => {
    const t = await setup({ notes: ['One', 'Two', 'Three'] });
    const ids = t.notes.list().map((n) => n.id);
    t.setScenario(scenarioFile(t.root, [{ emit: 'init' }, { emit: 'read' }, { tick: [ids[0], ids[2]] }, { emit: 'text', text: 'Did two.' }, { emit: 'result' }]));
    await t.runs.start({ kind: 'edit', scope: 'all' });
    const done = await finished(t.runs);
    assert.deepEqual(done.summary, { applied: 2, total: 3 });
    assert.deepEqual(t.notes.list().map((n) => n.status), ['done', 'open', 'done']);
  });

  test('AC-50 notes and deck are locked during a run and the agent ticks win afterwards', async () => {
    const t = await setup({ notes: ['One'], scenario: 'slow' });
    await t.runs.start({ kind: 'edit', scope: 'all' });
    assert.equal(t.notes.isLocked(), true);
    assert.equal(t.session.isLocked(), true);
    await assert.rejects(t.notes.apply({ op: 'add', note: { text: 'sneaky' } }), (e) => e.status === 423);
    await finished(t.runs);
    assert.equal(t.notes.isLocked(), false);
    assert.equal(t.session.isLocked(), false);
    const json = JSON.parse(fs.readFileSync(t.meta.notesPath, 'utf8'));
    assert.deepEqual(json.notes.map((n) => n.status), ['done']);
  });

  test('AC-48 the deck file changes while the agent is still running', async () => {
    const t = await setup({ scenario: 'slow' });
    await t.runs.start({ kind: 'edit', scope: 'all' });
    await waitFor(() => fs.readFileSync(t.deckPath, 'utf8').includes('Edited: Basic deck'), { timeout: 4000 });
    assert.equal(t.runs.current().status, 'running');
    assert.ok(t.events.some((e) => e.type === 'deck-changed' && e.source === 'agent'));
    await finished(t.runs);
  });

  test('AC-51 Revert restores the deck, notes and work order byte for byte and removes new assets', async () => {
    const t = await setup({ notes: ['One', 'Two'] });
    const before = t.files();
    t.setScenario(scenarioFile(t.root, [
      { emit: 'init' }, { emit: 'read' },
      { emit: 'edit', replace: ['(<h1\\b[^>]*>)', '$1Edited: '], regex: true },
      { emit: 'write', file: 'deckhand-assets/pic.svg', content: SVG },
      { tick: 'all' }, { emit: 'result', text: 'Done.' },
    ]));
    const run = await t.runs.start({ kind: 'edit', scope: 'all' });
    const done = await finished(t.runs);
    assert.equal(done.status, 'succeeded', done.error);
    assert.ok(fs.existsSync(path.join(t.deckDir, 'deckhand-assets/pic.svg')));
    assert.notDeepEqual(t.files().deck, before.deck);

    const reverted = await t.runs.revert(run.id);
    assert.equal(reverted.reverted, true);
    const now = t.files();
    assert.ok(now.deck.equals(before.deck), 'deck bytes');
    assert.ok(now.json.equals(before.json), 'json bytes');
    assert.ok(now.md.equals(before.md), 'md bytes');
    assert.equal(fs.existsSync(path.join(t.deckDir, 'deckhand-assets/pic.svg')), false);
    assert.deepEqual(t.notes.list().map((n) => n.status), ['open', 'open']);
    await assert.rejects(t.runs.revert(run.id), (e) => e.status === 409 && e.code === 'cannot_revert');
  });

  test('the staging allowlist keeps stray files out of the deck folder', async () => {
    const t = await setup({ scenario: 'stray-write' });
    await t.runs.start({ kind: 'edit', scope: 'all' });
    const done = await finished(t.runs);
    assert.equal(done.status, 'succeeded');
    assert.equal(fs.existsSync(path.join(t.deckDir, 'other.txt')), false);
    assert.match(fs.readFileSync(t.deckPath, 'utf8'), /Edited: Basic deck/);
    assert.deepEqual(fs.readdirSync(t.tmp), []);
  });

  test('images the agent adds are copied, other asset files are not', async () => {
    const t = await setup();
    t.setScenario(scenarioFile(t.root, [
      { emit: 'init' },
      { write: 'deckhand-assets/ok.svg', content: SVG },
      { write: 'deckhand-assets/fake.png', content: 'not a png' },
      { write: 'deckhand-assets/notes.txt', content: 'x' },
      { emit: 'result' },
    ]));
    await t.runs.start({ kind: 'edit', scope: 'all' });
    await finished(t.runs);
    assert.deepEqual(fs.readdirSync(path.join(t.deckDir, 'deckhand-assets')), ['ok.svg']);
  });

  test('AC-53 Stop kills an edit run and offers Revert', async () => {
    const t = await setup({ scenario: 'hang' });
    const run = await t.runs.start({ kind: 'edit', scope: 'all' });
    await waitFor(() => t.log().length);
    const { pid } = t.log()[0];
    const stopped = await t.runs.stop(run.id);
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.canRevert, true);
    assert.equal(pidAlive(pid), false);
    assert.equal(t.session.isLocked(), false);
    await assert.rejects(t.runs.stop(run.id), (e) => e.status === 409 && e.code === 'not_running');
  });

  test('Stop escalates to SIGKILL for an agent that ignores SIGTERM', async () => {
    const t = await setup({ scenario: 'hang-ignore-term' });
    const run = await t.runs.start({ kind: 'edit', scope: 'all' });
    await waitFor(() => t.log().length);
    const { pid } = t.log()[0];
    const t0 = Date.now();
    await t.runs.stop(run.id);
    assert.equal(pidAlive(pid), false);
    assert.ok(Date.now() - t0 < 2500, `took ${Date.now() - t0} ms`);
  });

  test('AC-4 stopAll kills the agent and its children within 2 s', async () => {
    const t = await setup({ scenario: 'hang-with-child' });
    await t.runs.start({ kind: 'edit', scope: 'all' });
    const child = await waitFor(() => readAgentLog(t.logPath, { mode: 'child' })[0]);
    const t0 = Date.now();
    await t.runs.stopAll();
    await waitFor(() => !pidAlive(child.pid) && !pidAlive(child.childPid), { timeout: 2000 });
    assert.ok(Date.now() - t0 < 2000);
  });

  test('one run at a time: a second start is busy', async () => {
    const t = await setup({ scenario: 'hang' });
    const run = await t.runs.start({ kind: 'edit', scope: 'all' });
    assert.equal(t.runs.isBusy(), true);
    await assert.rejects(t.runs.start({ kind: 'edit', scope: 'all' }), (e) => e.status === 409 && e.code === 'busy');
    await assert.rejects(t.runs.start(CREATE('tea')), (e) => e.status === 409 && e.code === 'busy');
    await t.runs.stop(run.id);
  });

  test('a failing edit keeps the notes open and offers Revert', async () => {
    const t = await setup({ scenario: 'fail' });
    await t.runs.start({ kind: 'edit', scope: 'all' });
    const done = await finished(t.runs);
    assert.equal(done.status, 'failed');
    assert.equal(done.error, 'Something went wrong.');
    assert.equal(done.canRevert, true);
    assert.deepEqual(t.notes.list().map((n) => n.status), ['open']);
  });

  test('a crash without a result uses the last stderr line', async () => {
    const t = await setup({ scenario: 'crash' });
    await t.runs.start({ kind: 'edit', scope: 'all' });
    const done = await finished(t.runs);
    assert.equal(done.status, 'failed');
    assert.equal(done.error, 'panic: fake crash');
  });

  test('a vanished binary fails cleanly', async () => {
    const t = await setup();
    fs.rmSync(path.join(t.root, 'bin'));
    fs.symlinkSync(agentBinDir([]), path.join(t.root, 'bin'));
    await t.runs.start({ kind: 'edit', scope: 'all' });
    const done = await finished(t.runs);
    assert.equal(done.status, 'failed');
    assert.match(done.error, /^Couldn't start Claude Code/);
    assert.equal(t.session.isLocked(), false);
  });

  test('refusals: no agent, nothing to do, unknown note, closed deck', async () => {
    const none = await setup({ agents: [] });
    await assert.rejects(none.runs.start({ kind: 'edit', scope: 'all' }), (e) => e.status === 400 && e.code === 'no_agent');
    const empty = await setup({ notes: [] });
    await assert.rejects(empty.runs.start({ kind: 'edit', scope: 'all' }), (e) => e.status === 400 && e.code === 'nothing_to_do');
    await assert.rejects(empty.runs.start({ kind: 'edit', scope: 'note', noteId: 'n_nope' }), (e) => e.status === 404 && e.code === 'no_note');
    await assert.rejects(empty.runs.start({ kind: 'magic' }), (e) => e.status === 400 && e.code === 'bad_run');
    await empty.session.close();
    await assert.rejects(empty.runs.start({ kind: 'edit', scope: 'all' }), (e) => e.status === 409 && e.code === 'deck_closed');
  });

  test('activity lines carry increasing seq and replay from current()', async () => {
    const t = await setup({ scenario: 'blocked' });
    const run = await t.runs.start({ kind: 'edit', scope: 'all' });
    const done = await finished(t.runs);
    const { activity } = t.runs.current();
    assert.equal(done.id, run.id);
    assert.deepEqual(activity.map((l) => l.kind), ['status', 'read', 'blocked', 'blocked', 'edit', 'text', 'result']);
    assert.deepEqual(activity.map((l) => l.seq), activity.map((_, i) => i + 1));
    assert.ok(activity.every((l) => typeof l.ts === 'string'));
    const live = t.events.filter((e) => e.type === 'run-activity');
    assert.deepEqual(live.map((e) => e.line.seq), activity.map((l) => l.seq));
    assert.ok(live.every((e) => e.runId === run.id));
    assert.ok(t.events.some((e) => e.type === 'run' && e.run.status === 'succeeded'));
  });
});

describe('routes', () => {
  test('create target and prompts', async () => {
    const t = await setup({ notes: ['One'] });
    const routes = t.runs.routes;
    const q = (o) => ({ query: new URLSearchParams(o) });
    const target = await routes['GET /api/create/target'](q({ description: 'Make me a pitch for tea' }));
    assert.deepEqual(target, { path: path.join(t.decksDir, 'pitch-tea.html'), display: '~/Deckhand/pitch-tea.html' });
    const empty = await routes['GET /api/create/target'](q({ description: '' }));
    assert.equal(empty.display, '~/Deckhand/untitled-deck.html');

    const all = await routes['GET /api/prompt'](q({ scope: 'all' }));
    assert.equal(all.deckPath, t.deckPath);
    assert.equal(all.workOrderPath, t.meta.workOrderPath);
    assert.ok(all.prompt.includes(t.deckPath) && all.prompt.includes(t.meta.workOrderPath), 'AC-55');
    const note = await routes['GET /api/prompt'](q({ scope: 'note', noteId: t.notes.list()[0].id }));
    assert.match(note.prompt, /one note only/);
    const create = await routes['GET /api/prompt'](q({ kind: 'create', description: 'tea' }));
    assert.match(create.prompt, /Write exactly one file, `tea\.html`/);
    assert.equal(create.workOrderPath, null);

    assert.equal(await routes['GET /api/runs/current'](), null);
    const run = await routes['POST /api/runs']({ body: { kind: 'edit', scope: 'all' } });
    await finished(t.runs);
    assert.equal((await routes['GET /api/runs/current']()).id, run.id);
    await routes['POST /api/runs/:id/revert']({ params: { id: run.id } });
    await assert.rejects(routes['POST /api/runs/:id/stop']({ params: { id: 'nope' } }), (e) => e.code === 'not_running');
  });
});
