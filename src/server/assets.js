import fsp from 'node:fs/promises';
import path from 'node:path';
import { HttpError, UPLOAD_LIMIT, ensureDirUnder, readBody, sanitiseFileName, sniffImage } from './security.js';

const notImage = () => new HttpError(415, 'not_image', 'That file is not an image Deckhand can use.');

export function createAssets({ session }) {
  let lastStamp = 0;
  const stamp = () => {
    lastStamp = Math.max(Date.now(), lastStamp + 1);
    return lastStamp;
  };

  async function upload({ req }) {
    const meta = session.meta();
    if (!meta) throw new HttpError(409, 'deck_closed', 'No deck is open.');
    if (meta.readOnly) throw new HttpError(403, 'read_only', 'This deck is read-only.');
    const deckDir = meta.dir;
    const type = String(req.headers['content-type'] || '').toLowerCase();
    if (!type.startsWith('image/')) throw notImage();
    const buf = await readBody(req, UPLOAD_LIMIT);
    const kind = sniffImage(buf);
    if (!kind) throw notImage();
    const dir = await ensureDirUnder(deckDir, 'deckhand-assets');
    const stem = `${stamp()}-${sanitiseFileName(req.headers['x-filename'])}`;
    for (let i = 0; i < 100; i++) {
      const name = `${stem}${i ? `-${i}` : ''}.${kind.ext}`;
      try {
        await fsp.writeFile(path.join(dir, name), buf, { flag: 'wx' });
        return { url: `deckhand-assets/${name}` };
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }
    throw new HttpError(500, 'internal', "Couldn't save that image.");
  }

  return { routes: { 'POST /api/assets': { body: 'raw', handler: upload } } };
}
