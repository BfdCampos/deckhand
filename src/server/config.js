import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const DEFAULT_PORT = 4321;
export const PORT_ATTEMPTS = 20;

function defaultBinDirs(home) {
  return [path.join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.npm-global/bin')];
}

function parsePort(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`Invalid port: ${value}`);
  return n;
}

export function loadConfig(argv = process.argv.slice(2), env = process.env) {
  const home = env.HOME || os.homedir();
  const config = {
    port: DEFAULT_PORT,
    open: true,
    deckPath: null,
    warnings: [],
    home,
    stateDir: path.join(home, '.deckhand'),
    decksDir: path.join(home, 'Deckhand'),
    rootDir: ROOT,
    publicDir: path.join(ROOT, 'public'),
    sharedDir: path.join(ROOT, 'src/shared'),
    test: env.DECKHAND_TEST === '1',
    extraBinDirs: env.DECKHAND_EXTRA_BIN_DIRS !== undefined
      ? env.DECKHAND_EXTRA_BIN_DIRS.split(':').filter(Boolean)
      : defaultBinDirs(home),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') config.port = parsePort(argv[++i]);
    else if (arg.startsWith('--port=')) config.port = parsePort(arg.slice('--port='.length));
    else if (arg === '--no-open') config.open = false;
    else if (arg.startsWith('-')) config.warnings.push(`Ignoring unknown option ${arg}`);
    else if (!config.deckPath) config.deckPath = path.resolve(arg);
  }

  if (env.CI || config.test) config.open = false;
  return config;
}
