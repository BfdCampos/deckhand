import { h } from '../dom.js';
import { api, onEvent } from '../api.js';
import { store } from '../store.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { openPopover, openMenu } from './popover.js';
import { ensureStylesheet } from './util.js';

const DOCS = {
  claude: { name: 'Claude Code', docsUrl: 'https://docs.claude.com/en/docs/claude-code/setup' },
  codex: { name: 'Codex', docsUrl: 'https://developers.openai.com/codex/cli' },
};

export function normaliseAgents(raw) {
  if (!raw) return null;
  const items = Array.isArray(raw) ? raw : (raw.list || raw.items || raw.available || []);
  const list = items.map((a) => ({
    id: a.id,
    name: a.name || DOCS[a.id]?.name || a.id,
    found: a.found !== false,
    version: a.version || null,
    docsUrl: a.docsUrl || DOCS[a.id]?.docsUrl || null,
  }));
  const found = list.filter((a) => a.found);
  let selected = Array.isArray(raw) ? items.find((a) => a.selected)?.id : raw.selected;
  if (!found.some((a) => a.id === selected)) selected = found[0]?.id || null;
  return { list, selected };
}

export const foundAgents = (agents) => (agents ? agents.list.filter((a) => a.found) : []);
export const selectedAgent = (agents) => foundAgents(agents).find((a) => a.id === agents.selected) || null;
const describe = (a) => (a.version ? `${a.name} ${a.version}` : a.name);

export function setAgents(raw) {
  store.set({ agents: normaliseAgents(raw) });
}

let synced = false;
function syncFromEvents() {
  if (synced) return;
  synced = true;
  onEvent((m) => {
    if (m.type === 'agents') setAgents(m.agents);
    else if (m.type === 'hello' && m.state && 'agents' in m.state) setAgents(m.state.agents);
  });
}

export async function detectAgents() {
  const res = await api.post('/api/agents/detect', {});
  setAgents(res.agents);
  return store.get().agents;
}

export async function selectAgent(id) {
  try {
    const res = await api.post('/api/agents/select', { id });
    setAgents(res.agents);
  } catch (err) {
    toast(err.code === 'busy' ? "You can't switch agents during a run." : err.message, { tone: 'error' });
  }
}

function foundMessage(agents) {
  const found = foundAgents(agents);
  return `Found ${found.map(describe).join(' and ')}`;
}

export function createAgentChip() {
  ensureStylesheet('/css/runs.css');
  syncFromEvents();

  const dot = h('span', { class: 'dot' });
  const name = h('span', { class: 'agent-chip-name' });
  const caret = icon('chevron-down', { size: 14, className: 'agent-chip-caret' });
  const el = h('button', { type: 'button', class: 'chip agent-chip', hidden: true }, dot, name);
  let open = null;

  function render() {
    const { agents, run } = store.get();
    el.hidden = !agents;
    if (!agents) return;
    const found = foundAgents(agents);
    const current = selectedAgent(agents);
    const running = run?.status === 'running';
    dot.className = found.length ? 'dot dot-success' : 'dot dot-warning';
    name.textContent = current ? current.name : 'No agent';
    if (found.length > 1) {
      el.setAttribute('aria-haspopup', 'menu');
      if (!caret.isConnected) el.append(caret);
    } else {
      el.setAttribute('aria-haspopup', 'dialog');
      caret.remove();
    }
    el.disabled = running;
    el.title = running ? "You can't switch agents during a run." : current ? `Using ${describe(current)}` : 'No agent found';
    el.setAttribute('aria-label', current ? `Agent: ${current.name}` : 'No agent found');
    if (running && open) open.close();
  }

  function checkButton(status) {
    const btn = h('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, icon('refresh', { size: 14 }), 'Check again');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.replaceChildren(h('span', { class: 'spin' }), 'Checking…');
      try {
        const before = foundAgents(store.get().agents).length;
        const agents = await detectAgents();
        const found = foundAgents(agents);
        if (found.length) {
          open?.close();
          toast(found.length === before ? `Still using ${describe(selectedAgent(agents))}` : foundMessage(agents), { tone: 'success' });
          return;
        }
        status.textContent = 'Still no agent found.';
        status.hidden = false;
      } catch (err) {
        status.textContent = err.message;
        status.hidden = false;
      }
      btn.disabled = false;
      btn.replaceChildren(icon('refresh', { size: 14 }), 'Check again');
    });
    return btn;
  }

  function popoverContent(agents) {
    const current = selectedAgent(agents);
    const status = h('p', { class: 'agent-pop-status', role: 'status', hidden: true });
    if (current) {
      return h('div', { class: 'agent-pop' },
        h('div', { class: 'agent-pop-head' }, h('span', { class: 'dot dot-success' }), h('strong', null, current.name), current.version ? h('span', { class: 'tnum text-muted' }, current.version) : null),
        h('p', { class: 'agent-pop-body' }, `Using ${describe(current)}. Deckhand runs it on this machine with your existing login.`),
        status,
        h('div', { class: 'agent-pop-actions' }, checkButton(status)));
    }
    const link = (id) => {
      const a = agents.list.find((x) => x.id === id) || { name: DOCS[id].name, docsUrl: DOCS[id].docsUrl };
      return h('a', { class: 'agent-pop-link', href: a.docsUrl || DOCS[id].docsUrl, target: '_blank', rel: 'noopener noreferrer' }, a.name, icon('external', { size: 12 }));
    };
    return h('div', { class: 'agent-pop' },
      h('div', { class: 'agent-pop-head' }, h('span', { class: 'dot dot-warning' }), h('strong', null, 'No agent found')),
      h('p', { class: 'agent-pop-body' }, 'Deckhand needs Claude Code or Codex to create and edit decks for you.'),
      h('p', { class: 'agent-pop-body text-muted' }, 'Install one, then click Check again.'),
      h('div', { class: 'agent-pop-links' }, link('claude'), link('codex')),
      status,
      h('div', { class: 'agent-pop-actions' }, checkButton(status)));
  }

  el.addEventListener('click', () => {
    if (open) { open.close(); return; }
    const { agents } = store.get();
    if (!agents) return;
    const found = foundAgents(agents);
    const onClose = () => { open = null; el.setAttribute('aria-expanded', 'false'); };
    if (found.length > 1) {
      open = openMenu({
        anchor: el,
        label: 'Choose an agent',
        onClose,
        items: [
          { heading: 'Run with' },
          ...found.map((a) => ({ label: a.name, checked: a.id === agents.selected, onSelect: () => { if (a.id !== agents.selected) selectAgent(a.id); } })),
          { separator: true },
          { label: 'Check again', icon: 'refresh', onSelect: () => detectAgents().then((next) => toast(foundMessage(next), { tone: 'success' })).catch((err) => toast(err.message, { tone: 'error' })) },
        ],
      });
    } else {
      open = openPopover({ anchor: el, content: popoverContent(agents), label: 'Agent', onClose, className: 'agent-popover' });
      el.setAttribute('aria-expanded', 'true');
    }
  });

  const unsubscribe = store.subscribe((_, patch) => {
    if ('agents' in patch || 'run' in patch) render();
  });
  render();

  return {
    el,
    destroy() {
      unsubscribe();
      open?.close();
      el.remove();
    },
  };
}
