const LEADING = new Set(['a', 'an', 'the', 'make', 'create', 'me', 'please', 'build', 'write']);
const FILLER = new Set(['a', 'an', 'the', 'me', 'for', 'our', 'my', 'your', 'of', 'to', 'and', 'or', 'with', 'in', 'on', 'about', 'some']);
const MAX_WORDS = 6;
const MAX_LENGTH = 48;
export const FALLBACK_SLUG = 'untitled-deck';
const MAX_INPUT = 500;
const COUNT = '(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
const META = [
  new RegExp(`\\b${COUNT}[\\s-]+slides?\\b`, 'g'),
  /\b(?:deck|presentation|slideshow|slides|talk)\s+(?:about|on|introducing|covering|explaining|for)\b/g,
];

export function slugify(description) {
  let text = String(description ?? '')
    .slice(0, MAX_INPUT)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  for (const re of META) text = text.replace(re, ' ');
  const words = text
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  while (words.length && LEADING.has(words[0])) words.shift();
  const meaningful = words.filter((w) => !FILLER.has(w)).slice(0, MAX_WORDS);
  let slug = '';
  for (const word of meaningful) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > MAX_LENGTH) break;
    slug = next;
  }
  if (!slug && meaningful.length) slug = meaningful[0].slice(0, MAX_LENGTH);
  return slug || FALLBACK_SLUG;
}

export function uniqueDeckName(slug, isTaken) {
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${slug}.html` : `${slug}-${n}.html`;
    if (!isTaken(name)) return name;
  }
}
