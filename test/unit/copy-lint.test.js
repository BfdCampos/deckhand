import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO } from '../helpers/fakes.js';

// Files that break a rule today and are being fixed by their owners in PR1. Each entry must go once
// its file is fixed or deleted; the test prints a diagnostic for entries that no longer need it.
const TEMPORARY_ALLOWLIST = {
  emDash: [],
  emoji: [],
  spelling: [],
  innerHTML: [],
};

const BINARY = /\.(png|jpe?g|gif|webp|ico|svgz|woff2?|ttf|otf|eot|pdf|zip|gz|tgz)$/i;
const EMOJI = /(?![\u00a9\u00ae\u2122\u2194-\u2199\u21a9\u21aa])\p{Extended_Pictographic}/u;
const RAW_HTML = /\.(?:inner|outer)HTML\s*\+?=(?!=)|insertAdjacentHTML\s*\(/;

const US_TO_UK = {
  color: 'colour', colored: 'coloured', coloring: 'colouring', colorful: 'colourful',
  center: 'centre', centered: 'centred', centering: 'centring',
  behavior: 'behaviour', favorite: 'favourite', gray: 'grey', honor: 'honour', humor: 'humour',
  flavor: 'flavour', neighbor: 'neighbour', labor: 'labour', rumor: 'rumour', endeavor: 'endeavour',
  canceled: 'cancelled', canceling: 'cancelling', labeled: 'labelled', labeling: 'labelling',
  modeled: 'modelled', modeling: 'modelling', traveled: 'travelled', traveling: 'travelling',
  catalog: 'catalogue', analog: 'analogue', defense: 'defence', offense: 'offence',
  fiber: 'fibre', theater: 'theatre', meter: 'metre', liter: 'litre',
  analyze: 'analyse', analyzed: 'analysed', analyzing: 'analysing', paralyze: 'paralyse',
};
for (const stem of ['organiz', 'recogniz', 'realiz', 'customiz', 'optimiz', 'summariz', 'prioritiz', 'finaliz', 'normaliz',
  'visualiz', 'authoriz', 'minimiz', 'maximiz', 'apologiz', 'categoriz', 'initializ', 'synchroniz', 'emphasiz',
  'personaliz', 'standardiz', 'utiliz', 'memoriz', 'characteriz', 'serializ']) {
  const uk = stem.slice(0, -1) + 's';
  for (const end of ['e', 'ed', 'es', 'ing', 'ation', 'ations', 'er', 'ers']) US_TO_UK[stem + end] = uk + end;
}
for (const [us, uk] of Object.entries({ ...US_TO_UK })) {
  if (!/(e|ed|ing|ation|ations|er|ers|s)$/.test(us)) US_TO_UK[us + 's'] ??= uk + 's';
}
const US_WORD = new RegExp(`\\b(${Object.keys(US_TO_UK).join('|')})\\b`, 'gi');

function listFiles() {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: REPO });
  return out.toString().split('\0').filter(Boolean).filter((f) => {
    const abs = path.join(REPO, f);
    return !BINARY.test(f) && fs.existsSync(abs) && fs.lstatSync(abs).isFile();
  });
}

const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const isPublicJs = (f) => f.startsWith('public/') && f.endsWith('.js');
const isServerJs = (f) => f === 'server.js' || (f.startsWith('src/') && f.endsWith('.js'));

export function stringLiterals(src) {
  const out = [];
  let i = 0;
  const templates = [];
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (templates.length && c === '}' && templates.at(-1) === 0) {
      templates.pop();
      i = readTemplate(i + 1);
      continue;
    }
    if (templates.length && c === '{') templates[templates.length - 1]++;
    if (templates.length && c === '}') templates[templates.length - 1]--;
    if (c === '/' && n === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && n === '*') { i = src.indexOf('*/', i + 2); if (i < 0) break; i += 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      out.push({ text: src.slice(i + 1, j), index: i + 1 });
      i = j + 1;
      continue;
    }
    if (c === '`') { i = readTemplate(i + 1); continue; }
    i++;
  }
  return out;

  function readTemplate(start) {
    let j = start;
    while (j < src.length && src[j] !== '`') {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '$' && src[j + 1] === '{') {
        out.push({ text: src.slice(start, j), index: start });
        templates.push(0);
        return j + 2;
      }
      j++;
    }
    out.push({ text: src.slice(start, j), index: start });
    return j + 1;
  }
}

export function looksLikeCopy(text) {
  const prose = text.replace(/\b[a-z-]+\s*:\s*[^;]*;?/g, ' ');
  return /[A-Za-z]+\s+[A-Za-z]+/.test(prose) || /^[A-Z][a-z]+$/.test(prose.trim());
}

export function proseOfMarkdown(md) {
  return md
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length))
    .replace(/https?:\/\/\S+/g, (m) => ' '.repeat(m.length));
}

export function usWords(text, offset = 0) {
  const hits = [];
  for (const m of text.matchAll(US_WORD)) hits.push({ word: m[0], uk: US_TO_UK[m[0].toLowerCase()], index: offset + m.index });
  return hits;
}

function check(rule, files, find) {
  const problems = [];
  const stale = [];
  for (const f of files) {
    const found = find(f);
    if (TEMPORARY_ALLOWLIST[rule].includes(f)) {
      if (!found.length) stale.push(f);
      continue;
    }
    problems.push(...found.map((p) => `${f}:${p}`));
  }
  return { problems, stale };
}

function report(t, rule, { problems, stale }) {
  for (const f of stale) t.diagnostic(`${f} no longer breaks the ${rule} rule; remove it from TEMPORARY_ALLOWLIST`);
  assert.deepEqual(problems, [], `${rule} problems:\n${problems.join('\n')}`);
}

const files = listFiles();

test('no em-dash (U+2014) in any tracked text file', (t) => {
  report(t, 'emDash', check('emDash', files, (f) => {
    const text = read(f);
    return [...text.matchAll(/\u2014/g)].map((m) => `${lineOf(text, m.index)}: em-dash`);
  }));
});

test('no emoji in public/', (t) => {
  report(t, 'emoji', check('emoji', files.filter((f) => f.startsWith('public/')), (f) => {
    const text = read(f);
    const re = new RegExp(EMOJI.source, 'gu');
    return [...text.matchAll(re)].map((m) => `${lineOf(text, m.index)}: emoji ${m[0]}`);
  }));
});

test('UI copy and the README use British spelling', (t) => {
  const targets = files.filter((f) => isPublicJs(f) || isServerJs(f) || f === 'README.md');
  report(t, 'spelling', check('spelling', targets, (f) => {
    const text = read(f);
    if (f.endsWith('.md')) return usWords(proseOfMarkdown(text)).map((h) => `${lineOf(text, h.index)}: "${h.word}" (use "${h.uk}")`);
    return stringLiterals(text)
      .filter((s) => looksLikeCopy(s.text))
      .flatMap((s) => usWords(s.text, s.index))
      .map((h) => `${lineOf(text, h.index)}: "${h.word}" (use "${h.uk}")`);
  }));
});

test('no innerHTML assignment in public/ scripts', (t) => {
  report(t, 'innerHTML', check('innerHTML', files.filter(isPublicJs), (f) => {
    const text = read(f);
    const re = new RegExp(RAW_HTML.source, 'g');
    return [...text.matchAll(re)].map((m) => `${lineOf(text, m.index)}: ${m[0].trim()}`);
  }));
});

test('the lint helpers tell copy from CSS', () => {
  assert.equal(looksLikeCopy('Pick a color'), true);
  assert.equal(looksLikeCopy('Color'), true);
  assert.equal(looksLikeCopy('center'), false);
  assert.equal(looksLikeCopy('text-align: center; color: red'), false);
  assert.equal(looksLikeCopy('flex-center'), false);
  const lits = stringLiterals("const a = 'one'; // 'skip'\nconst b = `two ${x + `three`} four`; /* 'no' */ const c = \"five\";").map((s) => s.text);
  assert.deepEqual(lits, ['one', 'two ', 'three', ' four', 'five']);
  assert.deepEqual(usWords('We organized the colors.').map((h) => h.uk), ['organised', 'colours']);
  assert.equal(usWords(proseOfMarkdown('Use `color` here, see https://x.org/color.')).length, 0);
  assert.equal(EMOJI.test('\u2693'), true);
  assert.equal(EMOJI.test('\u2190 Home'), false);
  assert.equal(RAW_HTML.test('el.innerHTML = x'), true);
  assert.equal(RAW_HTML.test('if (el.innerHTML === x)'), false);
});
