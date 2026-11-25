import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import chokidar from 'chokidar';
import { parse } from 'parse5';
import { HttpError, UPLOAD_LIMIT, ensureDirUnder, sniffImage } from './security.js';
import { slugify, uniqueDeckName } from '../shared/slug.js';
import { createPrompt, editPrompt, guardrail } from './prompts.js';

const KILL_GRACE_MS = 1500;
const ASSETS = 'deckhand-assets';
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
const STDERR_KEEP = 4096;
const MAX_ACTIVITY = 5000;
const ERROR_MAX = 400;

const stemOf = (name) => name.replace(/\.html?$/i, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function killGroup(pid, signal) {
  try { process.kill(-pid, signal); } catch { /* gone */ }
}

async function readOrNull(file) {
  try { return await fsp.readFile(file); } catch { return null; }
}

async function listFiles(dir) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

export function isUsableDeck(html) {
  if (!html || !html.trim()) return false;
  const doc = parse(html);
  const htmlEl = doc.childNodes.find((n) => n.nodeName === 'html');
  const body = htmlEl?.childNodes.find((n) => n.nodeName === 'body');
  return !!body?.childNodes.some((n) => n.tagName);
}

function trimError(text) {
  const t = String(text || '').trim();
  return t.length > ERROR_MAX ? `${t.slice(0, ERROR_MAX - 1)}…` : t;
}

export function createRuns({ config, session, notes, agents, store, broadcast = () => {}, env = process.env, tmpDir = os.tmpdir(), log = console.log }) {
  let current = null;
  let active = null;

  const publicState = (run) => ({ ...run.state });
  const announce = (run) => broadcast({ type: 'run', run: publicState(run) });

  function record(run, event) {
    const line = { ...event, seq: ++run.seq, ts: new Date().toISOString() };
    run.activity.push(line);
    if (run.activity.length > MAX_ACTIVITY) run.activity.shift();
    broadcast({ type: 'run-activity', runId: run.state.id, line });
  }

  function display(p) {
    const rel = path.relative(config.home, p);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `~/${rel}` : p;
  }

  async function targetFor(description) {
    const slug = slugify(description);
    const name = uniqueDeckName(slug, (n) => fs.existsSync(path.join(config.decksDir, n)));
    return path.join(config.decksDir, name);
  }

  function noteLabel(id) {
    const i = notes.list().findIndex((n) => n.id === id);
    return i >= 0 ? `Note ${i + 1}` : 'Note';
  }

  async function makeStaging() {
    await fsp.mkdir(tmpDir, { recursive: true });
    return fsp.realpath(await fsp.mkdtemp(path.join(tmpDir, 'deckhand-run-')));
  }

  async function prepareEdit(run, body) {
    const meta = session.meta();
    if (!meta) throw new HttpError(409, 'deck_closed', 'No deck is open.');
    if (meta.readOnly) throw new HttpError(403, 'read_only', 'This deck is read-only.');
    if (meta.missing) throw new HttpError(409, 'deck_missing', "Can't find the deck file.");
    const all = notes.list();
    let noteIds;
    if (body.scope === 'note') {
      const note = all.find((n) => n.id === body.noteId);
      if (!note) throw new HttpError(404, 'no_note', 'That note no longer exists.');
      if (note.status !== 'open') throw new HttpError(400, 'nothing_to_do', 'That note is already done.');
      noteIds = [note.id];
      Object.assign(run.state, { scope: 'note', label: noteLabel(note.id) });
    } else {
      noteIds = all.filter((n) => n.status === 'open').map((n) => n.id);
      if (!noteIds.length && !Object.keys(notes.tweaks()).length) throw new HttpError(400, 'nothing_to_do', 'Add a note first.');
      Object.assign(run.state, { scope: 'all', label: 'All notes' });
    }
    Object.assign(run.state, { kind: 'edit', noteIds, targetPath: meta.path });
    run.deckId = meta.deckId;
    run.deckName = meta.name;
    run.mdName = `${stemOf(meta.name)}.deckhand.md`;

    session.lock(run.state.id);
    notes.lock();
    run.locked = true;
    await notes.flush();

    const served = session.servedSource();
    const deckBytes = served === null ? await session.readDisk() : Buffer.from(served, 'utf8');
    run.snapshot = {
      deck: await session.readDisk(),
      json: await readOrNull(meta.notesPath),
      md: await readOrNull(meta.workOrderPath),
      assets: new Set(await listFiles(path.join(meta.dir, ASSETS))),
      paths: { deck: meta.path, json: meta.notesPath, md: meta.workOrderPath, dir: meta.dir },
    };
    run.lastDeck = deckBytes;

    run.staging = await makeStaging();
    await fsp.writeFile(path.join(run.staging, meta.name), deckBytes);
    await fsp.writeFile(path.join(run.staging, run.mdName), notes.renderWorkOrder(run.state.scope === 'note' ? { noteIds } : {}));
    if (run.snapshot.assets.size) {
      await fsp.mkdir(path.join(run.staging, ASSETS));
      for (const name of run.snapshot.assets) {
        if (IMAGE_EXT.test(name)) await fsp.copyFile(path.join(meta.dir, ASSETS, name), path.join(run.staging, ASSETS, name));
      }
    }

    const inScope = all.filter((n) => noteIds.includes(n.id));
    return {
      prompt: editPrompt({ deck: meta.name, workOrder: run.mdName, notes: inScope, noteId: run.state.scope === 'note' ? noteIds[0] : null }),
      guard: guardrail({ kind: 'edit', deck: meta.name, workOrder: run.mdName }),
    };
  }

  async function prepareCreate(run, body) {
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    if (!description) throw new HttpError(400, 'empty_description', 'Describe the deck you want first.');
    if (description.length > 20000) throw new HttpError(400, 'description_too_long', 'That description is too long.');
    await fsp.mkdir(config.decksDir, { recursive: true });
    const target = await targetFor(description);
    const name = path.basename(target);
    Object.assign(run.state, { kind: 'create', noteIds: [], label: 'New deck', description, targetPath: target });
    run.targetName = name;
    run.staging = await makeStaging();
    return { prompt: createPrompt({ name, description }), guard: guardrail({ kind: 'create', target: name }) };
  }

  async function mirrorOnce(run) {
    const meta = session.meta();
    if (!meta || meta.deckId !== run.deckId) return;
    const staged = await readOrNull(path.join(run.staging, run.deckName));
    if (staged && !staged.equals(run.lastDeck)) {
      run.lastDeck = staged;
      await session.writeExternal(staged, 'agent');
    }
    const md = await readOrNull(path.join(run.staging, run.mdName));
    if (md) {
      const ticked = [...notes.parseTicks(md.toString('utf8'))].filter((id) => run.state.noteIds.includes(id));
      const applied = ticked.length;
      if (applied !== run.state.summary?.applied) {
        run.ticked = ticked;
        run.state.summary = { applied, total: run.state.noteIds.length };
        announce(run);
      }
    }
    const stagedAssets = path.join(run.staging, ASSETS);
    for (const name of await listFiles(stagedAssets)) {
      if (run.snapshot.assets.has(name) || run.addedAssets.has(name) || !IMAGE_EXT.test(name)) continue;
      const src = path.join(stagedAssets, name);
      const st = await fsp.lstat(src).catch(() => null);
      if (!st?.isFile() || st.size > UPLOAD_LIMIT) continue;
      const buf = await fsp.readFile(src);
      if (!sniffImage(buf)) continue;
      try {
        const dir = await ensureDirUnder(run.snapshot.paths.dir, ASSETS);
        await fsp.writeFile(path.join(dir, name), buf, { flag: 'wx' });
        run.addedAssets.add(name);
      } catch { /* exists already or not allowed */ }
    }
  }

  function mirror(run) {
    run.mirrorChain = run.mirrorChain.then(() => mirrorOnce(run)).catch((e) => log(`[deckhand] mirror failed: ${e.message}`));
    return run.mirrorChain;
  }

  function startWatching(run) {
    let timer = null;
    run.watcher = chokidar.watch(run.staging, { ignoreInitial: true, depth: 2 });
    const kick = () => {
      clearTimeout(timer);
      timer = setTimeout(() => mirror(run), 100);
    };
    run.watcher.on('add', kick).on('change', kick);
    run.stopWatching = async () => {
      clearTimeout(timer);
      await run.watcher.close();
    };
  }

  function errorFor(run, parsed, code, signal) {
    if (parsed.ok === false && parsed.text) return trimError(parsed.text);
    const lastErr = run.stderr.split('\n').map((l) => l.trim()).filter(Boolean).at(-1);
    if (lastErr) return trimError(lastErr);
    if (signal) return `${run.state.agentName} was stopped by ${signal}.`;
    return `${run.state.agentName} exited with code ${code}.`;
  }

  async function finishEdit(run, status) {
    if (run.watcher) await run.stopWatching();
    await run.mirrorChain;
    await mirror(run);
    const meta = session.meta();
    const sameDeck = meta && meta.deckId === run.deckId;
    if (sameDeck) {
      const ticked = run.ticked || [];
      await notes.markDone(ticked, run.state.agentId);
      run.state.summary = { applied: ticked.length, total: run.state.noteIds.length };
      if (status === 'succeeded' && run.state.scope === 'all') await notes.clearTweaks();
    }
    run.state.canRevert = !!sameDeck;
  }

  async function finishCreate(run, status) {
    const staged = path.join(run.staging, run.targetName);
    const html = (await readOrNull(staged))?.toString('utf8') ?? null;
    const usable = isUsableDeck(html);
    if (status === 'stopped') return { status };
    if (status === 'succeeded' && !usable) {
      return { status: 'failed', error: html === null ? 'The agent finished without writing the deck.' : "The agent's file isn't a usable deck." };
    }
    if (!usable) return { status };
    let target = run.state.targetPath;
    for (;;) {
      try {
        await fsp.copyFile(staged, target, fs.constants.COPYFILE_EXCL);
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        target = await targetFor(run.state.description);
      }
    }
    run.state.targetPath = target;
    run.created = target;
    run.state.canRevert = true;
    if (status === 'failed') {
      run.state.outputUsable = true;
      return { status };
    }
    const meta = await session.open(target);
    run.state.targetPath = meta.path;
    run.created = meta.path;
    return { status };
  }

  async function finish(run, { code = null, signal = null, spawnError = null }) {
    if (run.finishing) return run.done;
    run.finishing = true;
    run.done = (async () => {
      if (run.stdoutRest) handleLine(run, run.stdoutRest);
      const parsed = run.parser ? run.parser.finish() : { ok: null, text: null };
      let status;
      let error = null;
      if (run.stopRequested) status = 'stopped';
      else if (spawnError) {
        status = 'failed';
        error = spawnError.code === 'ENOENT'
          ? `Couldn't start ${run.state.agentName}. Check it's installed, then click Check again.`
          : `Couldn't start ${run.state.agentName}: ${spawnError.message}`;
      } else if (code === 0 && parsed.ok !== false) status = 'succeeded';
      else {
        status = 'failed';
        error = errorFor(run, parsed, code, signal);
      }
      try {
        if (run.state.kind === 'edit') await finishEdit(run, status);
        else {
          const out = await finishCreate(run, status);
          status = out.status;
          if (out.error) error = out.error;
        }
      } catch (e) {
        status = 'failed';
        error = trimError(e.message);
      } finally {
        if (run.locked) {
          session.unlock();
          notes.unlock();
        }
        if (run.staging && env.DECKHAND_KEEP_STAGING !== '1') await fsp.rm(run.staging, { recursive: true, force: true }).catch(() => {});
      }
      if (error && !run.activity.some((l) => l.kind === 'error' && l.text === error)) record(run, { kind: 'error', text: error });
      Object.assign(run.state, { status, endedAt: new Date().toISOString() });
      if (error) run.state.error = error;
      if (active === run) active = null;
      announce(run);
      log(`[deckhand] ${run.state.label}: ${status}${error ? ` (${error})` : ''}`);
    })();
    return run.done;
  }

  function handleLine(run, text) {
    for (const event of run.parser.line(text)) record(run, event);
  }

  function launch(run, agent, { prompt, guard }) {
    const inv = agent.adapter.invocation({ prompt, guardrail: guard, cwd: run.staging, kind: run.state.kind, flags: agent.flags });
    run.parser = agent.adapter.createParser({ cwd: run.staging });
    let child;
    try {
      child = spawn(agent.path, inv.args, {
        cwd: run.staging, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, ...(inv.env || {}) },
      });
    } catch (e) {
      finish(run, { spawnError: e });
      return;
    }
    run.child = child;
    run.exited = new Promise((r) => child.once('close', r));
    child.on('error', (e) => finish(run, { spawnError: e }));
    child.stdout.on('data', (d) => {
      const text = run.stdoutRest + d.toString('utf8');
      const lines = text.split('\n');
      run.stdoutRest = lines.pop();
      for (const l of lines) handleLine(run, l);
    });
    child.stderr.on('data', (d) => { run.stderr = (run.stderr + d.toString('utf8')).slice(-STDERR_KEEP); });
    child.on('close', (code, signal) => finish(run, { code, signal }));
    child.stdin.on('error', () => {});
    child.stdin.end(inv.stdin);
    if (run.state.kind === 'edit') startWatching(run);
  }

  async function start(body = {}) {
    if (active) throw new HttpError(409, 'busy', 'Deckhand is busy with another run.');
    if (body.kind !== 'edit' && body.kind !== 'create') throw new HttpError(400, 'bad_run', 'Unknown kind of run.');
    const agent = agents.selected();
    if (!agent) throw new HttpError(400, 'no_agent', 'Install Claude Code or Codex first.');
    const tooOld = agent.adapter.blocker(agent.flags);
    if (tooOld) throw new HttpError(400, 'agent_too_old', tooOld);
    const run = {
      state: {
        id: `run_${crypto.randomBytes(6).toString('hex')}`,
        kind: body.kind,
        agentId: agent.adapter.id,
        agentName: agent.adapter.name,
        status: 'running',
        noteIds: [],
        label: '',
        targetPath: null,
        startedAt: new Date().toISOString(),
        canRevert: false,
      },
      activity: [],
      seq: 0,
      stderr: '',
      stdoutRest: '',
      addedAssets: new Set(),
      mirrorChain: Promise.resolve(),
      stopRequested: false,
    };
    active = run;
    let inputs;
    try {
      inputs = body.kind === 'edit' ? await prepareEdit(run, body) : await prepareCreate(run, body);
    } catch (e) {
      active = null;
      if (run.locked) {
        session.unlock();
        notes.unlock();
      }
      if (run.staging) await fsp.rm(run.staging, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
    if (current) current.state.canRevert = false;
    current = run;
    log(`[deckhand] ${run.state.label}: running with ${run.state.agentName}`);
    announce(run);
    launch(run, agent, inputs);
    return publicState(run);
  }

  async function terminate(run) {
    run.stopRequested = true;
    const pid = run.child?.pid;
    if (pid) {
      killGroup(pid, 'SIGTERM');
      const deadline = Date.now() + KILL_GRACE_MS;
      const leaderGone = () => run.child.exitCode !== null || run.child.signalCode !== null;
      while (groupAlive(pid) && !leaderGone() && Date.now() < deadline) await sleep(50);
      if (groupAlive(pid)) killGroup(pid, 'SIGKILL');
      await Promise.race([run.exited, sleep(500)]);
    }
    if (!run.finishing) finish(run, { signal: 'SIGKILL' });
    await run.done;
  }

  async function stop(id) {
    if (!active || active.state.id !== id) throw new HttpError(409, 'not_running', 'That run has already finished.');
    await terminate(active === current ? current : active);
    return publicState(current);
  }

  async function revert(id) {
    const run = current;
    if (!run || run.state.id !== id || active === run || !run.state.canRevert) {
      throw new HttpError(409, 'cannot_revert', "This run can't be reverted any more.");
    }
    if (run.state.kind === 'edit') {
      const meta = session.meta();
      if (!meta || meta.deckId !== run.deckId) {
        run.state.canRevert = false;
        throw new HttpError(409, 'cannot_revert', "This run can't be reverted any more.");
      }
      const { snapshot } = run;
      for (const [file, bytes] of [[snapshot.paths.json, snapshot.json], [snapshot.paths.md, snapshot.md]]) {
        if (bytes) await fsp.writeFile(file, bytes);
        else await fsp.rm(file, { force: true });
      }
      for (const name of run.addedAssets) await fsp.rm(path.join(snapshot.paths.dir, ASSETS, name), { force: true });
      await session.writeExternal(snapshot.deck, 'revert');
      await notes.reloadFromDisk();
    } else if (run.created) {
      if (session.meta()?.path === run.created) await session.close();
      await fsp.rm(run.created, { force: true });
      try { await store.removeRecent?.(run.created); } catch { /* best effort */ }
    }
    Object.assign(run.state, { canRevert: false, reverted: true });
    announce(run);
    return publicState(run);
  }

  async function stopAll() {
    if (active) await terminate(active);
  }

  function currentWithActivity() {
    return current ? { ...publicState(current), activity: current.activity.slice() } : null;
  }

  async function promptFor(query) {
    if (query.get('kind') === 'create') {
      const description = query.get('description') || '';
      const target = await targetFor(description);
      return {
        prompt: createPrompt({ name: path.basename(target), description }),
        deckPath: target,
        workOrderPath: null,
      };
    }
    const meta = session.meta();
    if (!meta) throw new HttpError(409, 'deck_closed', 'No deck is open.');
    const noteId = query.get('scope') === 'note' ? query.get('noteId') : null;
    const open = notes.list().filter((n) => n.status === 'open' && (!noteId || n.id === noteId));
    if (noteId && !open.length) throw new HttpError(404, 'no_note', 'That note no longer exists.');
    await session.flushAnchors();
    const guard = guardrail({ kind: 'edit', deck: meta.path, workOrder: meta.workOrderPath });
    return {
      prompt: `${guard}\n\n${editPrompt({ deck: meta.path, workOrder: meta.workOrderPath, notes: open, noteId })}`,
      deckPath: meta.path,
      workOrderPath: meta.workOrderPath,
    };
  }

  const routes = {
    'POST /api/runs': ({ body }) => start(body),
    'GET /api/runs/current': () => currentWithActivity(),
    'POST /api/runs/:id/stop': ({ params }) => stop(params.id),
    'POST /api/runs/:id/revert': ({ params }) => revert(params.id),
    'GET /api/create/target': async ({ query }) => {
      const target = await targetFor(query.get('description') || '');
      return { path: target, display: display(target) };
    },
    'GET /api/prompt': ({ query }) => promptFor(query),
  };

  return {
    start,
    stop,
    revert,
    stopAll,
    current: currentWithActivity,
    state: () => (current ? publicState(current) : null),
    isBusy: () => !!active,
    routes,
  };
}
