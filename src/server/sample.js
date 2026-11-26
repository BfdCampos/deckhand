import fsp from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './security.js';
import { expandPath, tildify } from './files.js';

async function realOrNull(p) {
  try { return await fsp.realpath(p); } catch { return null; }
}

const pad = (n) => String(n).padStart(2, '0');

function localStamp(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export function createSample({ config }) {
  const tracked = path.join(config.rootDir, 'samples', 'sample-deck.html');
  const now = () => (config.testNow ? new Date(config.testNow) : new Date());

  async function copy() {
    const original = await fsp.readFile(tracked);
    const stem = `sample-deck-${localStamp(now())}`;
    try {
      await fsp.mkdir(config.decksDir, { recursive: true });
      for (let n = 1; ; n++) {
        const p = path.join(config.decksDir, n === 1 ? `${stem}.html` : `${stem}-${n}.html`);
        try {
          await fsp.writeFile(p, original, { flag: 'wx' });
        } catch (e) {
          if (e.code === 'EEXIST') continue;
          throw e;
        }
        return p;
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, 'decks_dir_unwritable', `Deckhand can't write to ${tildify(config.decksDir, config.home)}. Check its permissions.`);
    }
  }

  return {
    tracked,
    async resolve(input) {
      if (typeof input !== 'string' || !input.trim()) return input;
      const target = await realOrNull(expandPath(input, config.home));
      if (!target || target !== (await realOrNull(tracked))) return input;
      return copy();
    },
  };
}
