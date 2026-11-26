import { h } from './dom.js';
import { openModal } from './ui/modal.js';

const fileName = (p) => p.split('/').filter(Boolean).pop() || p;

export function confirmDeepLink(path, { onOpen, onCancel, reason = 'link' }) {
  let opening = false;
  const why = reason === 'history'
    ? `You had ${fileName(path)} open earlier in this tab. Opening it again closes the deck that's open now.`
    : 'A link asked Deckhand to open this file. Only open it if you meant to.';
  return openModal({
    title: 'Open this deck?',
    width: 480,
    body: h('div', { class: 'deep-link' },
      h('p', { class: 't-small text-muted' }, why),
      h('p', { class: 'mono deep-link-path' }, path)),
    actions: [
      { label: 'Cancel' },
      { label: 'Open', primary: true, onClick: ({ close }) => { opening = true; close(); onOpen(); } },
    ],
    onClose: () => { if (!opening) onCancel(); },
  });
}
