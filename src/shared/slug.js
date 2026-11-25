const LEADING = new Set(['a', 'an', 'the', 'make', 'create', 'me', 'please', 'build', 'write']);
const FILLER = new Set(['a', 'an', 'the', 'me', 'for', 'our', 'my', 'your', 'of', 'to', 'and', 'or', 'with', 'in', 'on', 'about', 'some']);
const CLAUSE = new Set(['we', 'they', 'i', 'you', 'he', 'she', 'it', 'us', 'them', 'what', 'which', 'that', 'who', 'whom', 'whose', 'so', 'because', 'why', 'how', 'when', 'where', 'while', 'if', 'then', 'can', 'will', 'should', 'would', 'could', 'must', 'is', 'are', 'was', 'were', 'be', 'been']);
const TRAILING = new Set([...CLAUSE, ...FILLER, 'from', 'at', 'by', 'as', 'into', 'than', 'this', 'these', 'those', 'its', 'their']);
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
  const meaningful = [];
  for (const w of words) {
    if (FILLER.has(w)) continue;
    if (CLAUSE.has(w) && meaningful.length >= 2) break;
    meaningful.push(w);
    if (meaningful.length === MAX_WORDS) break;
  }
  const kept = [];
  for (const word of meaningful) {
    if ([...kept, word].join('-').length > MAX_LENGTH) break;
    kept.push(word);
  }
  while (kept.length > 1 && TRAILING.has(kept.at(-1))) kept.pop();
  let slug = kept.join('-');
  if (!slug && meaningful.length) slug = meaningful[0].slice(0, MAX_LENGTH);
  return slug || FALLBACK_SLUG;
}

export function uniqueDeckName(slug, isTaken) {
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${slug}.html` : `${slug}-${n}.html`;
    if (!isTaken(name)) return name;
  }
}
