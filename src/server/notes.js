import fsp from 'node:fs/promises';

export function truncate(s, n) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export function createNotes({ session }) {
  let chain = Promise.resolve();

  function renderDigest(payload) {
    const { base, deckPath } = session.state;
    const notes = payload.notes || [];
    const tweaks = payload.layoutTweaks || [];
    const L = [];
    L.push(`# Deckhand work order: ${base}`);
    L.push('');
    L.push('A human is editing this presentation in Deckhand and left the notes below.');
    L.push('Apply each note as a precise edit to the deck HTML, keeping the deck\'s existing');
    L.push('structure and style system. Do **not** remove `data-ai-id` attributes: they are');
    L.push('anchors. When a note is applied, remove it from this list (or mark it done).');
    L.push('');
    L.push(`Deck file: \`${deckPath}\``);
    L.push('');
    if (!notes.length && !tweaks.length) {
      L.push('_No notes yet._');
      return L.join('\n') + '\n';
    }
    if (notes.length) {
      L.push('## Notes');
      L.push('');
      notes.forEach((n, i) => {
        const anchor = n.aiId ? ` \`#${n.aiId}\`` : '';
        const where = n.scope === 'global' ? 'ALL matching elements' : (n.targetTag || 'element');
        L.push(`### ${i + 1}. [${where}]${anchor}`);
        if (n.targetText) L.push(`Current text: "${truncate(n.targetText, 120)}"`);
        if (n.slide != null) L.push(`Slide: ${n.slide}`);
        L.push('');
        L.push(`> ${n.text}`);
        L.push('');
      });
    }
    if (tweaks.length) {
      L.push('## Layout tweaks (manual moves / resizes)');
      L.push('');
      L.push('The human nudged these by hand. Treat them as **intent**, but reconcile with the');
      L.push('deck\'s overall layout, and don\'t hard-code pixel offsets where a cleaner fix fits.');
      L.push('');
      tweaks.forEach((t) => {
        if (t.kind === 'move') L.push(`- \`#${t.aiId}\` (${t.tag}): moved by (${Math.round(t.dx)}, ${Math.round(t.dy)})px`);
        else if (t.kind === 'resize') L.push(`- \`#${t.aiId}\` (img): resized to ${Math.round(t.w)}×${Math.round(t.h)}px`);
      });
      L.push('');
    }
    return L.join('\n') + '\n';
  }

  function save(payload) {
    if (!session.state.deckPath) return chain;
    const { notesJson, notesMd } = session.state;
    chain = chain.then(async () => {
      await fsp.writeFile(notesJson, JSON.stringify(payload, null, 2), 'utf8');
      await fsp.writeFile(notesMd, renderDigest(payload), 'utf8');
    }).catch((e) => console.error('[deckhand] notes write failed:', e.message));
    return chain;
  }

  return { save, renderDigest, flush: () => chain };
}
