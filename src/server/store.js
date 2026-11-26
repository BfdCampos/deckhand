import fsp from 'node:fs/promises';
import path from 'node:path';

const EMPTY = { version: 1, agent: null, recents: [] };

export function createStore({ stateDir }) {
  const file = path.join(stateDir, 'state.json');
  let data = { ...EMPTY };

  async function load() {
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
      data = { ...EMPTY, ...parsed, recents: Array.isArray(parsed.recents) ? parsed.recents : [] };
    } catch {
      data = { ...EMPTY };
    }
    return data;
  }

  async function save() {
    await fsp.mkdir(stateDir, { recursive: true });
    const tmp = `${file}.deckhand-tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
    await fsp.rename(tmp, file);
  }

  async function update(patch) {
    data = { ...data, ...patch };
    await save();
    return data;
  }

  return { load, save, update, get: () => data, path: file };
}
