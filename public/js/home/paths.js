export const OPEN_COPY = {
  not_found: "Can't find that file.",
  not_html: "That's not an HTML file. Deckhand opens .html decks.",
  is_dir: "That's a folder. Pick an .html file inside it.",
  empty: 'That file is empty.',
  unreadable: "Deckhand can't read that file (permission denied).",
};

export const openErrorText = (err) => OPEN_COPY[err?.code] || err?.message || "Deckhand couldn't open that file.";

export function homeOf(info) {
  if (!info) return null;
  if (info.home) return info.home;
  const { decksDir, decksDirLabel } = info;
  if (decksDir && decksDirLabel?.startsWith('~/')) return decksDir.slice(0, decksDir.length - (decksDirLabel.length - 1));
  return null;
}

export function tildify(p, home) {
  if (!p || !home) return p;
  if (p === home) return '~';
  return p.startsWith(home + '/') ? `~${p.slice(home.length)}` : p;
}

export function middleTruncate(text, max = 40) {
  if (!text || text.length <= max) return text;
  const tail = Math.ceil((max - 1) * 0.6);
  return `${text.slice(0, max - 1 - tail)}…${text.slice(-tail)}`;
}

const rtf = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' });
const STEPS = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

export function relativeTime(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const secs = Math.round((t - now) / 1000);
  if (Math.abs(secs) < 45) return 'Just now';
  for (const [unit, size] of STEPS) {
    if (Math.abs(secs) >= size || unit === 'minute') {
      const text = rtf.format(Math.round(secs / size), unit);
      return text.charAt(0).toUpperCase() + text.slice(1);
    }
  }
  return '';
}

export const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
