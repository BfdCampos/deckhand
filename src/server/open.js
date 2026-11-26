import { spawn } from 'node:child_process';

const OPENERS = { darwin: 'open', linux: 'xdg-open' };

export function browserCommand({ platform = process.platform, env = process.env } = {}) {
  return env.DECKHAND_OPEN_CMD || OPENERS[platform] || null;
}

export function openBrowser(url, options) {
  const cmd = browserCommand(options);
  if (!cmd) return;
  try {
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {}
}
