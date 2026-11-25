import fsp from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './security.js';

export async function listDir(dir) {
  const abs = path.resolve(dir);
  let items;
  try {
    items = await fsp.readdir(abs, { withFileTypes: true });
  } catch {
    throw new HttpError(400, 'unreadable', "Couldn't read that folder.");
  }
  const entries = items
    .filter((d) => !d.name.startsWith('.'))
    .map((d) => ({ name: d.name, isDir: d.isDirectory(), isHtml: /\.html?$/i.test(d.name) }))
    .filter((e) => e.isDir || e.isHtml)
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  return { path: abs, parent: path.dirname(abs), entries };
}
