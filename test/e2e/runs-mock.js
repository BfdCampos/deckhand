import fs from 'node:fs';
import path from 'node:path';

// In-page stand-in for the WP3.1 agents and runs API (plan 1.12) and its
// WebSocket events. Every route here is mocked with page.route and every
// event is injected through page.routeWebSocket. Swap for the real server
// once WP3.1 lands.

const CATALOGUE = {
  claude: { id: 'claude', name: 'Claude Code', version: '2.1.331', docsUrl: 'https://docs.claude.com/en/docs/claude-code/setup' },
  codex: { id: 'codex', name: 'Codex', version: '0.130.0', docsUrl: 'https://developers.openai.com/codex/cli' },
};

export function agentsPayload(found, selected) {
  const pick = found.includes(selected) ? selected : (found[0] ?? null);
  return {
    selected: pick,
    list: Object.values(CATALOGUE).map((a) => ({
      ...a,
      found: found.includes(a.id),
      version: found.includes(a.id) ? a.version : null,
    })),
  };
}

export function writeNotes(deckPath, notes, layoutTweaks = {}) {
  const stem = path.basename(deckPath).replace(/\.html?$/i, '');
  const file = path.join(path.dirname(deckPath), `${stem}.deckhand.json`);
  const full = notes.map((n, i) => ({
    id: n.id || `n_${i + 1}`,
    aiId: n.aiId ?? null,
    targetTag: n.targetTag || 'h2',
    targetText: n.targetText || '',
    scope: n.scope || 'element',
    text: n.text || `Note ${i + 1}`,
    slide: n.slide ?? 1,
    docX: n.docX ?? 200,
    docY: n.docY ?? 120 + i * 40,
    status: n.status || 'open',
  }));
  fs.writeFileSync(file, JSON.stringify({ version: 2, deck: path.basename(deckPath), notes: full, layoutTweaks }, null, 2));
  return full;
}

export async function mockRuns(page, { deckPath, agents = ['claude'], selected = 'claude', run = null, activity = [], extraState = () => ({}), createTarget = null } = {}) {
  const mock = {
    found: [...agents],
    selected,
    run,
    activity: [...activity],
    calls: [],
    sent: [],
    sockets: new Set(),
    seq: activity.reduce((m, l) => Math.max(m, l.seq || 0), 0),
    runCount: 0,
    failNext: {},
    holdStop: false,
  };
  const workOrderPath = deckPath ? deckPath.replace(/\.html?$/i, '.deckhand.md') : '/tmp/deck.deckhand.md';

  mock.agents = () => agentsPayload(mock.found, mock.selected);
  mock.agentName = (id) => CATALOGUE[id]?.name || id;

  mock.emit = (event) => {
    for (const ws of mock.sockets) ws.send(JSON.stringify(event));
  };
  mock.ready = async () => {
    const start = Date.now();
    while (!mock.sockets.size) {
      if (Date.now() - start > 5000) throw new Error('page never opened its WebSocket');
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  mock.setRun = (patch) => {
    mock.run = { ...mock.run, ...patch };
    mock.emit({ type: 'run', run: mock.run });
    return mock.run;
  };
  mock.line = (line) => {
    const full = { seq: ++mock.seq, ts: new Date().toISOString(), ...line };
    mock.activity.push(full);
    mock.emit({ type: 'run-activity', runId: mock.run?.id, line: full });
    return full;
  };
  mock.finish = (status, patch = {}) => mock.setRun({
    status,
    endedAt: new Date().toISOString(),
    canRevert: true,
    ...patch,
  });
  mock.setFound = (list) => { mock.found = [...list]; };
  mock.callsTo = (method, p) => mock.calls.filter((c) => c.method === method && c.path === p);

  const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const error = (route, status, code, message) => json(route, status, { error: { code, message } });

  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const method = req.method();
    let body = null;
    if (method === 'POST') { try { body = req.postDataJSON(); } catch { body = null; } }
    const key = `${method} ${p}`;

    if (key === 'GET /api/state') {
      const res = await route.fetch();
      const real = await res.json();
      return json(route, 200, { ...real, ...extraState(), agents: mock.agents(), run: mock.run });
    }

    const handled = [
      'POST /api/agents/detect', 'POST /api/agents/select', 'GET /api/runs/current', 'POST /api/runs', 'GET /api/prompt',
    ].includes(key) || /^\/api\/runs\/[^/]+\/(stop|revert)$/.test(p);
    if (!handled) return route.fallback();

    mock.calls.push({ method, path: p, body, query: Object.fromEntries(url.searchParams) });

    const forced = mock.failNext[key] || mock.failNext[p];
    if (forced) {
      delete mock.failNext[key];
      delete mock.failNext[p];
      return error(route, forced.status, forced.code, forced.message || forced.code);
    }

    if (key === 'POST /api/agents/detect') {
      const agentsNow = mock.agents();
      mock.selected = agentsNow.selected;
      mock.emit({ type: 'agents', agents: agentsNow });
      return json(route, 200, { agents: agentsNow });
    }
    if (key === 'POST /api/agents/select') {
      if (mock.run?.status === 'running') return error(route, 409, 'busy', 'A run is in progress.');
      if (!mock.found.includes(body?.id)) return error(route, 400, 'unknown_agent', 'Unknown agent.');
      mock.selected = body.id;
      mock.emit({ type: 'agents', agents: mock.agents() });
      return json(route, 200, { agents: mock.agents() });
    }
    if (key === 'GET /api/runs/current') {
      return json(route, 200, mock.run ? { ...mock.run, activity: mock.activity } : null);
    }
    if (key === 'GET /api/prompt') {
      if (url.searchParams.get('kind') === 'create') {
        const description = url.searchParams.get('description') || '';
        return json(route, 200, { prompt: `You're creating a new slide deck for Deckhand.\n\n${description}`, deckPath: createTarget?.(description) || null, workOrderPath: null });
      }
      const scope = url.searchParams.get('scope') || 'all';
      const prompt = [
        `Read the Deckhand work order at ${workOrderPath}, then edit ${deckPath}.`,
        scope === 'note' ? `Apply only note ${url.searchParams.get('noteId')}.` : 'Apply every open note.',
        'Tick each note in the work order when it is applied.',
      ].join('\n\n');
      return json(route, 200, { prompt, deckPath, workOrderPath });
    }
    if (key === 'POST /api/runs') {
      if (mock.run?.status === 'running') return error(route, 409, 'busy', 'Another run is in progress.');
      const agentsNow = mock.agents();
      if (!agentsNow.selected) return error(route, 400, 'no_agent', 'No agent is installed.');
      mock.runCount += 1;
      mock.activity = [];
      mock.run = {
        id: `run_${mock.runCount}`,
        kind: body.kind,
        agentId: agentsNow.selected,
        agentName: mock.agentName(agentsNow.selected),
        status: 'running',
        scope: body.scope,
        noteIds: body.noteId ? [body.noteId] : (body.noteIds || []),
        label: body.kind === 'create' ? 'New deck' : body.scope === 'note' ? null : 'All notes',
        description: body.kind === 'create' ? body.description : undefined,
        targetPath: body.kind === 'create' ? createTarget?.(body.description) : deckPath,
        startedAt: new Date().toISOString(),
        canRevert: false,
      };
      mock.emit({ type: 'run', run: mock.run });
      return json(route, 200, mock.run);
    }
    const m = /^\/api\/runs\/([^/]+)\/(stop|revert)$/.exec(p);
    if (m) {
      if (!mock.run || mock.run.id !== m[1]) return error(route, 409, m[2] === 'stop' ? 'not_running' : 'cannot_revert', 'No such run.');
      if (m[2] === 'stop') {
        if (mock.run.status !== 'running') return error(route, 409, 'not_running', 'Not running.');
        if (mock.holdStop) await new Promise((r) => { mock.releaseStop = r; });
        mock.run = { ...mock.run, status: 'stopped', endedAt: new Date().toISOString(), canRevert: true };
      } else {
        if (!mock.run.canRevert) return error(route, 409, 'cannot_revert', 'Nothing to revert.');
        mock.run = { ...mock.run, canRevert: false, reverted: true };
      }
      mock.emit({ type: 'run', run: mock.run });
      return json(route, 200, mock.run);
    }
    return route.fallback();
  });

  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      mock.sent.push(message);
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
    mock.sockets.add(ws);
    ws.onClose(() => mock.sockets.delete(ws));
  });

  return mock;
}

export function runningRun(deckPath, patch = {}) {
  return {
    id: 'run_live',
    kind: 'edit',
    agentId: 'claude',
    agentName: 'Claude Code',
    status: 'running',
    scope: 'all',
    noteIds: [],
    label: 'All notes',
    targetPath: deckPath,
    startedAt: new Date(Date.now() - 42000).toISOString(),
    canRevert: false,
    ...patch,
  };
}
