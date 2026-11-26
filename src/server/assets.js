import fsp from 'node:fs/promises';
import path from 'node:path';
import { HttpError, UPLOAD_LIMIT, ensureDirUnder, readBody, sanitiseFileName, sniffImage } from './security.js';

const notImage = () => new HttpError(415, 'not_image', 'That file is not an image Deckhand can use.');

export function createAssets({ session }) {
  async function upload({ req }) {
    const deckDir = session.state.deckDir;
    if (!deckDir) throw new HttpError(409, 'deck_closed', 'No deck is open.');
    const type = String(req.headers['content-type'] || '').toLowerCase();
    if (!type.startsWith('image/')) throw notImage();
    const buf = await readBody(req, UPLOAD_LIMIT);
    const kind = sniffImage(buf);
    if (!kind) throw notImage();
    const dir = await ensureDirUnder(deckDir, 'deckhand-assets');
    const stem = `${Date.now()}-${sanitiseFileName(req.headers['x-filename'])}`;
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
