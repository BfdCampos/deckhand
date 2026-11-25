const LEADING = new Set(['a', 'an', 'the', 'make', 'create', 'me', 'please', 'build', 'write']);
const FILLER = new Set(['a', 'an', 'the', 'me', 'for', 'our', 'my', 'your', 'of', 'to', 'and', 'or', 'with', 'in', 'on', 'about', 'some']);
const CLAUSE = new Set(['we', 'they', 'i', 'you', 'he', 'she', 'it', 'us', 'them', 'what', 'which', 'that', 'who', 'whom', 'whose', 'so', 'because', 'why', 'how', 'when', 'where', 'while', 'if', 'then', 'can', 'will', 'should', 'would', 'could', 'must', 'is', 'are', 'was', 'were', 'be', 'been']);
const TRAILING = new Set([...CLAUSE, ...FILLER, 'from', 'at', 'by', 'as', 'into', 'than', 'this', 'these', 'those', 'its', 'their']);
const NUMBER_WORDS = new Set(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']);
const SLIDE_WORDS = new Set(['slide', 'slides']);
const DECK_WORDS = new Set(['deck', 'decks', 'presentation', 'presentations', 'slideshow', 'slides', 'talk']);
const SIZE_WORDS = new Set(['short', 'quick', 'brief', 'simple', 'little', 'small']);
const CONNECTORS = new Set([
  'that', 'which', 'about', 'on', 'for', 'to', 'of', 'with', 'is', 'through', 'called', 'titled', 'named',
  'explain', 'explains', 'explaining', 'introduce', 'introduces', 'introducing', 'show', 'shows', 'showing',
  'cover', 'covers', 'covering', 'walk', 'walks', 'walking', 'describe', 'describes', 'describing',
  'present', 'presents', 'presenting', 'outline', 'outlines', 'outlining', 'summarise', 'summarises', 'summarising',
  'summarize', 'summarizes', 'summarizing', 'give', 'gives', 'giving',
]);
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
  const text = String(description ?? '')
    .slice(0, MAX_INPUT)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  const lead = text.split(/[^a-z0-9]+/).filter(Boolean);
  const isCount = (w) => /^\d+$/.test(w) || NUMBER_WORDS.has(w);
  let sawMeta = false;
  let i = 0;
  while (i < lead.length) {
    const w = lead[i];
    const next = lead[i + 1];
    if (LEADING.has(w)) i++;
    else if (isCount(w) && SLIDE_WORDS.has(next)) { i += 2; sawMeta = true; }
    else if (DECK_WORDS.has(w) || SLIDE_WORDS.has(w)) { i++; sawMeta = true; }
    else if (SIZE_WORDS.has(w) && (DECK_WORDS.has(next) || isCount(next))) i++;
    else if (sawMeta && CONNECTORS.has(w)) i++;
    else break;
  }
  let rest = lead.slice(i).join(' ');
  for (const re of META) rest = rest.replace(re, ' ');
  const words = rest.split(' ').filter(Boolean);
  if (!words.length && sawMeta) return 'deck';
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
