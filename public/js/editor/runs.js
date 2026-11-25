import { h } from '../dom.js';
import { api, onEvent } from '../api.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { openModal } from '../ui/modal.js';
import { openMenu } from '../ui/popover.js';

const HANDOFF_LABEL = 'Hand off to AI';
const keyOf = (id) => (id == null ? '' : id);

export function mountRuns(ctx) {
  const runState = {};

  const status = h('span', { class: 'act-status t-meta' });
  const log = h('div', { class: 'activity-log' });
  const activity = ctx.slots.activity;
  activity.hidden = true;
  activity.append(h('div', { class: 'sb-title' }, h('span', { class: 't-label' }, 'Activity'), status), log);

  const implementLabel = h('span', null, HANDOFF_LABEL);
  const implement = h('button', { type: 'button', class: 'btn btn-primary btn-lg implement', onclick: handoff }, icon('sparkle'), implementLabel);
  const caret = h('button', {
    type: 'button',
    class: 'btn btn-primary btn-lg btn-icon implement-caret',
    title: 'More options',
    'aria-label': 'More options',
    'aria-haspopup': 'menu',
    onclick: toggleMenu,
  }, icon('caret'));
  let menu = null;

  function toggleMenu() {
    if (menu) { menu.close(); return; }
    menu = openMenu({
      anchor: caret,
      align: 'end',
      label: 'Hand-off options',
      onClose: () => { menu = null; },
      items: [
        { label: 'Copy prompt', icon: 'copy', onSelect: copyPrompt },
        { label: 'Show prompt', icon: 'eye', onSelect: showPrompt },
      ],
    });
  }
  ctx.slots.footer.append(h('div', { class: 'btn-group split' }, implement, caret));

  async function fetchPrompt() {
    ctx.notesApi.persist();
    return (await api.post('/api/implement', {})).prompt;
  }

  async function copyPrompt() {
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
      h('p', { class: 't-small text-muted prompt-intro' }, "This runs automatically on hand-off. Paste it into Claude Code yourself if you'd rather. It points your agent at the work order and the deck file, which it reads for the real structure and styles."),
      h('pre', { class: 'impl-prompt' }, prompt),
    );
    openModal({
      title: 'The prompt we hand your AI',
      body,
      width: 640,
      actions: [
        { label: 'Close', onClick: ({ close }) => close() },
        { label: 'Copy prompt', primary: true, icon: 'copy', onClick: () => navigator.clipboard.writeText(prompt).then(() => toast('Prompt copied', { tone: 'success' })) },
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
    status.textContent = s === 'working' ? 'Working… keep this open' : s === 'done' ? 'Done' : s === 'error' ? "Didn't finish" : '';
    status.className = 'act-status t-meta ' + ({ working: 'text-ink-2', done: 'text-success', error: 'text-error' }[s] || '');
  }

  function addLine(m) {
    log.appendChild(h('div', { class: 'act ' + (m.kind || '') }, (m.kind === 'tool' ? '› ' : '') + (m.text || '')));
    log.scrollTop = log.scrollHeight;
  }

  function onQueued(m) { runState[keyOf(m.noteId)] = 'queued'; ctx.notesApi.render(); }

  function onStarted(m) {
    runState[keyOf(m.noteId)] = 'running';
    if (m.noteId == null) { implement.disabled = true; implementLabel.textContent = 'Working…'; }
    ctx.notesApi.render();
    activity.hidden = false;
    log.replaceChildren();
    setStatus('working');
    addLine({ kind: 'head', text: m.label });
  }

  function onDone(m) {
    delete runState[keyOf(m.noteId)];
    if (m.noteId == null) { implement.disabled = false; implementLabel.textContent = HANDOFF_LABEL; }
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
