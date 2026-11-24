import { h } from '../dom.js';
import { api, onEvent } from '../api.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { openModal } from '../ui/modal.js';

const HANDOFF_LABEL = 'Hand off to AI →';
const keyOf = (id) => (id == null ? '' : id);

export function mountRuns(ctx) {
  const runState = {};

  const status = h('span', { class: 'count' });
  const log = h('div', { class: 'activity-log' });
  const activity = ctx.slots.activity;
  activity.hidden = true;
  activity.append(h('div', { class: 'sb-title' }, 'Activity ', status), log);

  const implement = h('button', { type: 'button', class: 'implement', onclick: handoff }, HANDOFF_LABEL);
  const menu = h('div', { class: 'menu', hidden: true },
    h('button', { type: 'button', onclick: copyPrompt }, 'Copy prompt'),
    h('button', { type: 'button', onclick: () => { toggleMenu(true); showPrompt(); } }, 'Show prompt'),
  );
  const caret = h('button', {
    type: 'button',
    class: 'implement-caret',
    title: 'More options',
    'aria-label': 'More options',
    onclick: (e) => { e.stopPropagation(); toggleMenu(); },
  }, icon('caret'));
  ctx.slots.footer.append(h('div', { class: 'split' }, implement, caret, menu));
  document.addEventListener('click', () => toggleMenu(true));

  function toggleMenu(forceHidden) {
    menu.hidden = forceHidden === undefined ? !menu.hidden : forceHidden;
  }

  async function fetchPrompt() {
    ctx.notesApi.persist();
    return (await api.post('/api/implement', {})).prompt;
  }

  async function copyPrompt() {
    toggleMenu(true);
    try {
      await navigator.clipboard.writeText(await fetchPrompt());
      toast('Prompt copied');
    } catch (err) {
      toast(err.message, { tone: 'error' });
    }
  }

  async function showPrompt() {
    let prompt;
    try { prompt = await fetchPrompt(); } catch (err) { toast(err.message, { tone: 'error' }); return; }
    const body = h('div', null,
      h('p', null, "This runs automatically on hand-off. Paste it into Claude Code yourself if you'd rather. It points your agent at the work order and the deck file, which it reads for the real structure and styles."),
      h('pre', { class: 'impl-prompt' }, prompt),
    );
    const modal = openModal({
      title: 'The prompt we hand your AI',
      body,
      actions: [
        { label: 'Copy prompt', primary: true, onClick: () => navigator.clipboard.writeText(prompt).then(() => toast('Prompt copied')) },
        { label: 'Close', onClick: () => modal.close() },
      ],
    });
  }

  function handoff() {
    if (!ctx.notes.length && !ctx.notesApi.computeTweaks().length) return;
    ctx.notesApi.persist();
    api.post('/api/implement', { run: true }).catch((err) => toast(err.message, { tone: 'error' }));
  }

  function runNote(n) {
    ctx.notesApi.persist();
    api.post('/api/run-note', { note: { id: n.id, text: n.text, aiId: n.aiId, targetTag: n.targetTag, scope: n.scope, slide: n.slide } })
      .catch((err) => toast(err.message, { tone: 'error' }));
  }

  function setStatus(s) {
    status.textContent = s === 'working' ? 'working… keep this open' : s === 'done' ? 'done' : s === 'error' ? 'error' : '';
    status.className = 'count st-' + (s || 'idle');
  }

  function addLine(m) {
    log.appendChild(h('div', { class: 'act ' + (m.kind || '') }, (m.kind === 'tool' ? '› ' : '') + (m.text || '')));
    log.scrollTop = log.scrollHeight;
  }

  function onQueued(m) { runState[keyOf(m.noteId)] = 'queued'; ctx.notesApi.render(); }

  function onStarted(m) {
    runState[keyOf(m.noteId)] = 'running';
    if (m.noteId == null) { implement.disabled = true; implement.textContent = 'Working…'; }
    ctx.notesApi.render();
    activity.hidden = false;
    log.replaceChildren();
    setStatus('working');
    addLine({ kind: 'head', text: m.label });
  }

  function onDone(m) {
    delete runState[keyOf(m.noteId)];
    if (m.noteId == null) { implement.disabled = false; implement.textContent = HANDOFF_LABEL; }
    setStatus(m.ok ? 'done' : 'error');
    if (m.ok) {
      ctx.notes = m.noteId == null ? [] : ctx.notes.filter((x) => x.id !== m.noteId);
      ctx.notesApi.persist();
    } else {
      addLine({ kind: 'blocked', text: m.error || 'Run failed. You can copy the prompt and run it yourself.' });
    }
    ctx.notesApi.render();
  }

  onEvent((m) => {
    if (m.type === 'run-queued') onQueued(m);
    else if (m.type === 'run-started') onStarted(m);
    else if (m.type === 'run-activity') addLine(m);
    else if (m.type === 'run-done') onDone(m);
  });

  return { stateOf: (noteId) => runState[keyOf(noteId)], runNote };
}
