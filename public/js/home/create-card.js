import { h } from '../dom.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { icon } from '../ui/icons.js';
import { detectAgents, foundAgents, selectedAgent } from '../ui/agent-chip.js';
import { isMac } from './paths.js';

export const DRAFT_KEY = 'deckhand.draft';
const TARGET_CHARS = 500;

const PLACEHOLDER = "Describe the deck you want. Who's it for, what should it say, how many slides, any look and feel. For example: a 6-slide pitch for our new coffee subscription, warm and minimal, for the leadership team.";

const EXAMPLES = [
  ['Pitch', 'A 6-slide pitch for our new coffee subscription, warm and minimal, for the leadership team.'],
  ['Team update', 'A short team update on the quarter: three wins, one thing we learnt, and one ask. Calm and confident.'],
  ['Talk', 'A 10-minute conference talk on why calm software wins, with big type and one idea per slide.'],
];

const DOCS = {
  claude: 'https://docs.claude.com/en/docs/claude-code/setup',
  codex: 'https://developers.openai.com/codex/cli',
};

const CREATE_ERRORS = {
  busy: 'Busy with another run. Try again when it finishes.',
  no_agent: 'No agent found. Install Claude Code or Codex, then check again.',
};

export function readDraft() {
  try { return localStorage.getItem(DRAFT_KEY) || ''; } catch { return ''; }
}

export function writeDraft(text) {
  try {
    if (text && text.trim()) localStorage.setItem(DRAFT_KEY, text);
    else localStorage.removeItem(DRAFT_KEY);
  } catch { /* private mode */ }
}

export function createCreateCard({ getInfo, onStarted }) {
  const textarea = h('textarea', {
    class: 'textarea create-input',
    rows: 6,
    placeholder: PLACEHOLDER,
    'aria-label': 'Describe the deck you want',
    spellcheck: 'true',
  });
  const target = h('span', { class: 'create-target truncate' }, 'Saves to ', h('span', { class: 'create-target-path' }, '~/Deckhand'));
  const submit = h('button', { type: 'button', class: 'btn btn-primary btn-lg create-submit', disabled: true },
    'Create deck', h('span', { class: 'kbd', 'aria-hidden': 'true' }, isMac() ? '⌘ Enter' : 'Ctrl Enter'));
  const errorText = h('span', null);
  const error = h('p', { class: 'field-error create-error', role: 'alert', hidden: true }, icon('alert-circle', { size: 14 }), errorText);

  const examples = h('div', { class: 'create-examples', role: 'group', 'aria-label': 'Example descriptions' },
    h('span', { class: 't-meta' }, 'Try'),
    EXAMPLES.map(([label, text]) => h('button', {
      type: 'button',
      class: 'chip chip-quiet create-example',
      title: text,
      onclick: () => { textarea.value = text; onInput(); textarea.focus(); },
    }, label)));

  const form = h('div', { class: 'create-form' },
    h('div', { class: 'create-field' }, textarea, examples),
    h('div', { class: 'create-foot' }, target, submit),
    error);

  const empty = h('div', { class: 'create-empty' });
  const body = h('div', { class: 'create-body' }, form);

  const el = h('section', { class: 'card-lg home-card home-create', 'aria-labelledby': 'create-title' },
    h('header', { class: 'home-card-head' },
      h('span', { class: 'home-card-icon home-card-icon-accent' }, icon('sparkle')),
      h('h2', { class: 't-card-title', id: 'create-title' }, 'Create a new deck')),
    body);

  let seq = 0;
  let timer = null;
  let busy = false;

  const hasText = () => textarea.value.trim().length > 0;
  const agentReady = () => !!selectedAgent(store.get().agents);

  function decksLabel() {
    return getInfo()?.decksDirLabel || '~/Deckhand';
  }

  function updateTarget() {
    clearTimeout(timer);
    const mine = ++seq;
    const text = textarea.value.trim();
    if (!text) { setTarget('Saves to', decksLabel()); return; }
    timer = setTimeout(async () => {
      try {
        const res = await api.post('/api/create/target', { description: text.slice(0, TARGET_CHARS) });
        if (mine === seq && res?.display) setTarget('Saves as', res.display);
      } catch { /* keep the last line */ }
    }, 150);
  }

  function setTarget(lead, where) {
    target.replaceChildren(`${lead} `, h('span', { class: 'create-target-path' }, where));
    target.title = where;
  }

  function setError(text) {
    errorText.textContent = text || '';
    error.hidden = !text;
  }

  function sync() {
    submit.disabled = busy || !hasText() || !agentReady() || store.get().run?.status === 'running';
  }

  function onInput() {
    writeDraft(textarea.value);
    setError('');
    updateTarget();
    sync();
  }

  async function create() {
    if (submit.disabled) return;
    const description = textarea.value.trim();
    busy = true;
    sync();
    submit.firstChild.textContent = 'Starting…';
    try {
      const run = await api.post('/api/runs', { kind: 'create', description });
      onStarted(run);
    } catch (err) {
      setError(CREATE_ERRORS[err.code] || err.message);
      if (err.code === 'no_agent') detectAgents().catch(() => {});
    } finally {
      busy = false;
      submit.firstChild.textContent = 'Create deck';
      sync();
    }
  }

  textarea.addEventListener('input', onInput);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); create(); }
  });
  submit.addEventListener('click', create);

  function renderEmpty() {
    const status = h('p', { class: 'create-empty-status', role: 'status', hidden: true });
    const check = h('button', { type: 'button', class: 'btn btn-secondary' }, icon('refresh'), 'Check again');
    check.addEventListener('click', async () => {
      check.disabled = true;
      check.replaceChildren(h('span', { class: 'spin' }), 'Checking…');
      try {
        const agents = await detectAgents();
        if (!foundAgents(agents).length) { status.textContent = 'Still no agent found.'; status.hidden = false; }
      } catch (err) {
        status.textContent = err.message;
        status.hidden = false;
      }
      if (check.isConnected) {
        check.disabled = false;
        check.replaceChildren(icon('refresh'), 'Check again');
      }
    });
    const link = (label, href) => h('a', { class: 'link create-empty-link', href, target: '_blank', rel: 'noopener noreferrer' }, label, icon('external', { size: 12 }));
    empty.replaceChildren(
      h('span', { class: 'empty-icon create-empty-icon' }, icon('terminal', { size: 20 })),
      h('p', { class: 'create-empty-title' }, 'Deckhand needs Claude Code or Codex to create and edit decks for you.'),
      h('p', { class: 'create-empty-body' }, 'Install one, then click Check again.'),
      h('div', { class: 'create-empty-links' }, link('Claude Code', DOCS.claude), link('Codex', DOCS.codex)),
      check,
      status);
  }

  function render() {
    const { agents } = store.get();
    const none = !!agents && !foundAgents(agents).length;
    if (none) {
      if (!empty.isConnected) { renderEmpty(); body.replaceChildren(empty); }
    } else if (!form.isConnected) {
      body.replaceChildren(form);
    }
    sync();
  }

  store.subscribe((_, patch) => { if ('agents' in patch || 'run' in patch) render(); });

  return {
    el,
    render,
    focus() { if (textarea.isConnected) textarea.focus(); },
    setDraft(text) {
      textarea.value = text || '';
      writeDraft(textarea.value);
      setError('');
      updateTarget();
      sync();
    },
    refreshTarget: updateTarget,
  };
}
