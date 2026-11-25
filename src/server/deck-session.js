import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import chokidar from 'chokidar';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function createDeckSession({ broadcast }) {
  const state = {
    deckPath: null,
    deckDir: null,
    base: null,
    notesJson: null,
    notesMd: null,
  };
  let watcher = null;
  let lastWrittenHash = null;

  let writeChain = Promise.resolve();
  let pendingHtml = null;

  function queueWrite(html) {
    pendingHtml = html;
    writeChain = writeChain.then(async () => {
      if (pendingHtml === null || !state.deckPath) return;
      const next = pendingHtml;
      pendingHtml = null;
      lastWrittenHash = sha(next);
      await fsp.writeFile(state.deckPath, next, 'utf8');
    }).catch((e) => console.error('[deckhand] deck write failed:', e.message));
    return writeChain;
  }

  function publicState() {
    if (!state.deckPath) return { bound: false };
    return {
      bound: true,
      deckPath: state.deckPath,
      base: state.base,
      deckUrl: '/deckroot/' + encodeURIComponent(state.base),
      notesJson: state.notesJson,
      notesMd: state.notesMd,
    };
  }

  function startWatching() {
    if (watcher) watcher.close();
    watcher = chokidar.watch(state.deckPath, { ignoreInitial: true });
    let t = null;
    const check = () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        try {
          const cur = await fsp.readFile(state.deckPath, 'utf8');
          if (sha(cur) !== lastWrittenHash) broadcast({ type: 'deck-changed' });
        } catch {}
      }, 120);
    };
    watcher.on('change', check).on('add', check);
  }

  async function bind(p) {
    const abs = path.resolve(p);
    const st = await fsp.stat(abs);
    if (!st.isFile()) throw Object.assign(new Error('Not a file'), { code: 'EISDIR' });
    state.deckPath = abs;
    state.deckDir = path.dirname(abs);
    state.base = path.basename(abs);
    const stem = state.base.replace(/\.html?$/i, '');
    state.notesJson = path.join(state.deckDir, `${stem}.deckhand.json`);
    state.notesMd = path.join(state.deckDir, `${stem}.deckhand.md`);
    lastWrittenHash = sha(await fsp.readFile(abs, 'utf8'));
    startWatching();
    broadcast({ type: 'bound', deck: publicState() });
  }

  async function close() {
    if (watcher) await watcher.close();
    watcher = null;
    await writeChain;
  }

  return { state, bind, publicState, queueWrite, close };
}
