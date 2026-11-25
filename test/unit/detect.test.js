import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createAgents } from '../../src/server/agents/index.js';
import { createStore } from '../../src/server/store.js';
import { agentBinDir, nodeBinDir, tempDir } from '../helpers/fakes.js';

async function setup({ agents = ['claude'], env = {}, extraBinDirs = [], timeoutMs } = {}) {
  const root = tempDir();
  const link = path.join(root, 'bin');
  fs.symlinkSync(agentBinDir(agents), link);
  const store = createStore({ stateDir: path.join(root, 'state') });
  await store.load();
  const events = [];
  const fullEnv = { PATH: `${link}:${nodeBinDir()}`, HOME: root, ...env };
  const make = () => createAgents({ config: { extraBinDirs }, store, broadcast: (e) => events.push(e), env: fullEnv, timeoutMs, log: () => {} });
  const agents_ = make();
  await agents_.detect();
  const swap = (list) => {
    fs.rmSync(link);
    fs.symlinkSync(agentBinDir(list), link);
  };
  return { agents: agents_, store, events, swap, make, root };
}

const byId = (payload, id) => payload.list.find((a) => a.id === id);

test('AC-6 only claude on PATH: claude is found and selected, codex is not', async () => {
  const { agents } = await setup({ agents: ['claude'] });
  const p = agents.payload();
  assert.equal(p.selected, 'claude');
  assert.deepEqual(p.list.map((a) => a.id), ['claude', 'codex']);
  assert.deepEqual(byId(p, 'claude'), { id: 'claude', name: 'Claude Code', found: true, version: '2.1.331', docsUrl: byId(p, 'claude').docsUrl });
  assert.equal(byId(p, 'codex').found, false);
  assert.equal(byId(p, 'codex').version, null);
  assert.equal(agents.launchLine(), 'Claude Code 2.1.331 (Codex not found)');
});

test('AC-7 both found: claude by default, a Codex choice persists across a restart', async () => {
  const { agents, make, events } = await setup({ agents: ['claude', 'codex'] });
  assert.equal(agents.payload().selected, 'claude');
  assert.equal(agents.launchLine(), 'Claude Code 2.1.331 (Codex 0.130.0 also found)');
  const after = await agents.select('codex');
  assert.equal(after.selected, 'codex');
  assert.equal(events.at(-1).type, 'agents');
  assert.equal(events.at(-1).agents.selected, 'codex');

  const restarted = make();
  await restarted.detect();
  assert.equal(restarted.payload().selected, 'codex');
  assert.equal(restarted.selected().adapter.id, 'codex');
  assert.equal(restarted.launchLine(), 'Codex 0.130.0 (Claude Code 2.1.331 also found)');
});

test('AC-8 neither found: nothing selected and selecting fails', async () => {
  const { agents } = await setup({ agents: [] });
  assert.equal(agents.payload().selected, null);
  assert.equal(agents.selected(), null);
  assert.equal(agents.launchLine(), 'none found');
  await assert.rejects(agents.select('claude'), (e) => e.status === 400 && e.code === 'unknown_agent');
  await assert.rejects(agents.select('gpt'), (e) => e.status === 400 && e.code === 'unknown_agent');
});

test('AC-9 detecting again finds an agent added to PATH without a restart', async () => {
  const { agents, swap, events } = await setup({ agents: [] });
  swap(['claude']);
  const p = await agents.detect();
  assert.equal(p.selected, 'claude');
  assert.equal(events.at(-1).type, 'agents');
});

test('a slow --version still counts as found, without a version', async () => {
  const started = Date.now();
  const { agents } = await setup({ env: { FAKE_CLAUDE_VERSION_DELAY: '2000' }, timeoutMs: 300 });
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
  assert.equal(byId(agents.payload(), 'claude').found, true);
  assert.equal(byId(agents.payload(), 'claude').version, null);
  assert.equal(agents.launchLine(), 'Claude Code (Codex not found)');
});

test('a garbled version is omitted', async () => {
  const { agents } = await setup({ env: { FAKE_CLAUDE_VERSION: 'who knows' } });
  assert.equal(byId(agents.payload(), 'claude').version, null);
});

test('flags missing from --help are dropped from the invocation', async () => {
  const { agents } = await setup({ env: { FAKE_CLAUDE_HELP_OMIT: '--restricted' } });
  const sel = agents.selected();
  assert.equal(sel.flags.has('--restricted'), false);
  assert.equal(sel.flags.has('--tools'), true);
  const inv = sel.adapter.invocation({ prompt: 'P', guardrail: 'G', cwd: '/tmp', kind: 'edit', flags: sel.flags });
  assert.ok(!inv.args.includes('--restricted'));
});

test('extra bin dirs are searched after PATH', async () => {
  const root = tempDir();
  const store = createStore({ stateDir: root });
  const agents = createAgents({
    config: { extraBinDirs: [agentBinDir(['claude'])] }, store, broadcast: () => {}, env: { PATH: nodeBinDir() }, log: () => {},
  });
  await agents.detect();
  assert.equal(agents.payload().selected, 'claude');
  assert.equal(agents.selected().path, path.join(agentBinDir(['claude']), 'claude'));
});

test('routes: detect and select, and select refuses while a run is busy', async () => {
  const { agents } = await setup({ agents: ['claude', 'codex'] });
  let busy = false;
  const routes = agents.routes({ isBusy: () => busy });
  assert.equal((await routes['POST /api/agents/detect']({ body: {} })).agents.selected, 'claude');
  assert.equal((await routes['POST /api/agents/select']({ body: { id: 'codex' } })).agents.selected, 'codex');
  busy = true;
  await assert.rejects(routes['POST /api/agents/select']({ body: { id: 'claude' } }), (e) => e.status === 409 && e.code === 'busy');
});
