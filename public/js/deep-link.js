import { h } from './dom.js';
import { openModal } from './ui/modal.js';

export function confirmDeepLink(path, { onOpen, onCancel }) {
  let opening = false;
  return openModal({
    title: 'Open this deck?',
    width: 480,
    body: h('div', { class: 'deep-link' },
      h('p', { class: 't-small text-muted' }, 'A link asked Deckhand to open this file. Only open it if you meant to.'),
      h('p', { class: 'mono deep-link-path' }, path)),
    actions: [
      { label: 'Cancel' },
      { label: 'Open', primary: true, onClick: ({ close }) => { opening = true; close(); onOpen(); } },
    ],
    onClose: () => { if (!opening) onCancel(); },
  });
}
