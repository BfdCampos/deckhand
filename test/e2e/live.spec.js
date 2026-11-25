import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/server/config.js';
import { createAgents } from '../../src/server/agents/index.js';
import { createDeckSession } from '../../src/server/deck-session.js';
import { createNotes } from '../../src/server/notes.js';
import { createRuns } from '../../src/server/runs.js';
import { createStore } from '../../src/server/store.js';

test.skip(!process.env.DECKHAND_LIVE, 'Live runs use the real claude and cost tokens. Run npm run test:live.');

async function finished(runs, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = runs.current();
    if (r && r.status !== 'running') return r;
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error('run did not finish in time');
}

test('AC-57 the real claude creates a two-slide deck, then applies one note', async ({}, testInfo) => {
  test.setTimeout(15 * 60_000);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deckhand-live-')));
  const config = { ...loadConfig([], process.env), decksDir: path.join(root, 'Deckhand'), home: root };
  const log = (line) => console.log(`  ${line}`);
  const hub = {
    broadcast: (e) => { if (e.type === 'run-activity') log(`[${e.line.kind}] ${e.line.text.split('\n')[0].slice(0, 120)}`); },
  };
  const store = createStore({ stateDir: path.join(root, 'state') });
  await store.load();
  const notes = createNotes({ hub });
  const session = createDeckSession({ hub, store, notes });
  const agents = createAgents({ config, store, broadcast: hub.broadcast, env: process.env });
  await agents.detect();
  const agent = agents.selected();
  test.skip(!agent || agent.adapter.id !== 'claude', 'claude is not installed here');
  log(`Agent: ${agents.launchLine()}`);
  const runs = createRuns({ config, session, notes, agents, store, broadcast: hub.broadcast, env: process.env, log });

  try {
    let t0 = Date.now();
    await runs.start({
      kind: 'create',
      description: 'A tiny two-slide deck about tea. Slide 1 has the heading "Tea" and one short sentence. Slide 2 has the heading "Thanks". Keep the CSS short.',
    });
    const created = await finished(runs, 10 * 60_000);
    const createMs = Date.now() - t0;
    log(`create: ${created.status} in ${Math.round(createMs / 1000)} s`);
    expect(created.status, created.error).toBe('succeeded');
    const html = fs.readFileSync(created.targetPath, 'utf8');
    expect(html.match(/<section\b[^>]*class="[^"]*\bslide\b/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(session.meta().path).toBe(created.targetPath);

    const aiId = /<h1\b[^>]*data-ai-id="(dh\d+)"/.exec(session.servedSource())?.[1];
    expect(aiId, 'first heading is anchored').toBeTruthy();
    await notes.apply({ op: 'add', note: { text: 'Change this heading to exactly "Tea time".', aiId, targetTag: 'h1', slide: 1 } });
    const noteId = notes.list()[0].id;

    t0 = Date.now();
    await runs.start({ kind: 'edit', scope: 'note', noteId });
    const edited = await finished(runs, 10 * 60_000);
    const editMs = Date.now() - t0;
    log(`edit: ${edited.status} in ${Math.round(editMs / 1000)} s, summary ${JSON.stringify(edited.summary)}`);
    expect(edited.status, edited.error).toBe('succeeded');
    expect(fs.readFileSync(created.targetPath, 'utf8')).toContain('Tea time');
    testInfo.annotations.push(
      { type: 'create', description: `${Math.round(createMs / 1000)} s` },
      { type: 'edit', description: `${Math.round(editMs / 1000)} s, note ${notes.list()[0].status}` },
    );
    expect(notes.list()[0].status, 'the agent ticked the note').toBe('done');
  } finally {
    await runs.stopAll();
    await session.dispose?.();
    if (!process.env.DECKHAND_KEEP_TEST_HOME) fs.rmSync(root, { recursive: true, force: true });
  }
});
