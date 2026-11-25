const NS = 'http://www.w3.org/2000/svg';

const circle = (cx, cy, r, extra = {}) => ({ tag: 'circle', cx, cy, r, ...extra });
const rect = (x, y, width, height, rx = 2) => ({ tag: 'rect', x, y, width, height, rx });
const dot = (cx, cy) => circle(cx, cy, 1.1, { fill: 'currentColor', stroke: 'none' });

const FILE = 'M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5L13.5 3Z';
const FILE_FOLD = 'M13.5 3v4a1.5 1.5 0 0 0 1.5 1.5h4';

const ICONS = {
  home: ['M4 10.2 12 4l8 6.2', 'M6 8.8V19a1 1 0 0 0 1 1h3.5v-5.5h3V20H17a1 1 0 0 0 1-1V8.8'],
  folder: ['M3.5 7A2 2 0 0 1 5.5 5h3.6a2 2 0 0 1 1.4.6L12 7h6.5a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7Z'],
  'folder-open': ['M3.5 17V7A2 2 0 0 1 5.5 5h3.6a2 2 0 0 1 1.4.6L12 7h5.5a2 2 0 0 1 2 2v1.5', 'M3.6 18.2 6 11.8a1.5 1.5 0 0 1 1.4-1h12.2a1 1 0 0 1 .95 1.3l-2.1 6.3a1.5 1.5 0 0 1-1.4 1H5a1.5 1.5 0 0 1-1.4-1.2Z'],
  file: [FILE, FILE_FOLD],
  deck: [FILE, FILE_FOLD, 'm10 12.5-2 2 2 2', 'm14 12.5 2 2-2 2'],
  slides: [rect(3, 5, 18, 12, 2), 'M8 21h8', 'M12 17v4'],
  upload: ['M12 15.5V4', 'm7.5 8.5 4.5-4.5 4.5 4.5', 'M4.5 15v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3'],
  download: ['M12 4v11.5', 'm7.5 11 4.5 4.5 4.5-4.5', 'M4.5 15v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3'],
  image: [rect(3.5, 4.5, 17, 15, 2.5), circle(9, 10, 1.6), 'm20.5 15.5-4.3-4.3a1.5 1.5 0 0 0-2.1 0L5 20'],
  text: ['M5 7V5h14v2', 'M12 5v14', 'M9.5 19h5'],
  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
  trash: ['M4.5 7h15', 'M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7', 'm6.5 7 .8 11.6A1.5 1.5 0 0 0 8.8 20h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7', 'M10.5 11v5', 'M13.5 11v5'],
  undo: ['M9 14 4.5 9.5 9 5', 'M4.5 9.5H14a5.5 5.5 0 0 1 0 11h-2.5'],
  redo: ['m15 14 4.5-4.5L15 5', 'M19.5 9.5H10a5.5 5.5 0 0 0 0 11h2.5'],
  play: ['M7.5 5.6v12.8a1 1 0 0 0 1.5.86l10.6-6.4a1 1 0 0 0 0-1.72L9 4.74a1 1 0 0 0-1.5.86Z'],
  stop: [rect(6, 6, 12, 12, 2.5)],
  check: ['m5 12.5 4.5 4.5L19 7.5'],
  'check-circle': [circle(12, 12, 8.5), 'm8.5 12.2 2.4 2.4 4.6-4.8'],
  x: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
  'chevron-down': ['m6.5 9.5 5.5 5.5 5.5-5.5'],
  'chevron-up': ['m6.5 14.5 5.5-5.5 5.5 5.5'],
  'chevron-left': ['M14.5 6.5 9 12l5.5 5.5'],
  'chevron-right': ['M9.5 6.5 15 12l-5.5 5.5'],
  'arrow-left': ['M19 12H5', 'm11 6-6 6 6 6'],
  'arrow-right': ['M5 12h14', 'm13 6 6 6-6 6'],
  'arrow-up': ['M12 19V5', 'm6 11 6-6 6 6'],
  sparkle: ['M12 3.5c.6 4.6 3.4 7.4 8 8-4.6.6-7.4 3.4-8 8-.6-4.6-3.4-7.4-8-8 4.6-.6 7.4-3.4 8-8Z', 'M19 3v3.5', 'M17.25 4.75h3.5'],
  note: ['M5.5 4h13a1.5 1.5 0 0 1 1.5 1.5V14l-6 6H5.5A1.5 1.5 0 0 1 4 18.5v-13A1.5 1.5 0 0 1 5.5 4Z', 'M14 20v-4.5a1.5 1.5 0 0 1 1.5-1.5H20', 'M8 8.5h8', 'M8 12h4.5'],
  message: ['M20 15a1.5 1.5 0 0 1-1.5 1.5H8.5L4 20V5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5V15Z'],
  pin: ['M12 21s-6.5-5.4-6.5-10.8a6.5 6.5 0 0 1 13 0C18.5 15.6 12 21 12 21Z', circle(12, 10.2, 2.3)],
  copy: [rect(8.5, 8.5, 11.5, 11.5, 2), 'M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5'],
  eye: ['M2.8 12.3a1 1 0 0 1 0-.6C4.3 7.9 7.9 5.5 12 5.5s7.7 2.4 9.2 6.2a1 1 0 0 1 0 .6c-1.5 3.8-5.1 6.2-9.2 6.2s-7.7-2.4-9.2-6.2Z', circle(12, 12, 3)],
  'eye-off': ['M10.6 5.6A9.7 9.7 0 0 1 12 5.5c4.1 0 7.7 2.4 9.2 6.2a1 1 0 0 1 0 .6 10 10 0 0 1-2 3', 'M6.6 6.6A10 10 0 0 0 2.8 11.7a1 1 0 0 0 0 .6c1.5 3.8 5.1 6.2 9.2 6.2 1.9 0 3.7-.5 5.3-1.5', 'M9.9 9.9a3 3 0 0 0 4.2 4.2', 'M3.5 3.5l17 17'],
  alert: ['M10.3 4.6 3 17.3A2 2 0 0 0 4.7 20.3h14.6a2 2 0 0 0 1.7-3L13.7 4.6a2 2 0 0 0-3.4 0Z', 'M12 9.5v4', dot(12, 16.8)],
  'alert-circle': [circle(12, 12, 8.5), 'M12 8v4.5', dot(12, 15.8)],
  info: [circle(12, 12, 8.5), 'M12 11v5', dot(12, 8.2)],
  refresh: ['M19.5 12a7.5 7.5 0 1 1-2.2-5.3L19.5 9', 'M19.5 4.5V9H15'],
  external: ['M14 4.5h5.5V10', 'M19.5 4.5 11 13', 'M17.5 13.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8.5a2 2 0 0 1 2-2h4.5'],
  anchor: [circle(12, 5.5, 2.2), 'M12 7.7V20.5', 'M8.5 10.5h7', 'M4.5 13a7.5 7.5 0 0 0 15 0', 'm3 14.5 1.5-1.5L6 14.5', 'm18 14.5 1.5-1.5 1.5 1.5'],
  search: [circle(11, 11, 6.5), 'm20 20-4.4-4.4'],
  more: [dot(6, 12), dot(12, 12), dot(18, 12)],
  clock: [circle(12, 12, 8.5), 'M12 7.5V12l3 2'],
  terminal: [rect(3.5, 4.5, 17, 15, 2.5), 'm7.5 9.5 3 2.5-3 2.5', 'M12.5 15h4'],
  pencil: ['M15.2 5.3a2.1 2.1 0 0 1 3 3L8.5 18 4.5 19.5 6 15.5l9.2-10.2Z', 'm13.5 7 3 3'],
  move: ['M12 3.5v17', 'M3.5 12h17', 'm9.5 6 2.5-2.5L14.5 6', 'm9.5 18 2.5 2.5 2.5-2.5', 'M6 9.5 3.5 12 6 14.5', 'm18 9.5 2.5 2.5-2.5 2.5'],
  present: [rect(3, 4.5, 18, 12, 2), 'm10 8 4.5 2.5L10 13Z', 'M8.5 20.5 12 16.5l3.5 4'],
  keyboard: [rect(3, 6, 18, 12, 2), 'M7 10h.01', 'M11 10h.01', 'M15 10h.01', 'M8 14h8'],
  loader: ['M12 3.5a8.5 8.5 0 1 0 8.5 8.5'],
};

const ALIASES = {
  caret: 'chevron-down',
  close: 'x',
  warning: 'alert',
  error: 'alert-circle',
  notes: 'note',
  edit: 'pencil',
  'file-html': 'deck',
  monitor: 'present',
};

export const iconNames = [...Object.keys(ICONS), ...Object.keys(ALIASES)];

function shape(spec) {
  if (typeof spec === 'string') {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', spec);
    return p;
  }
  const { tag, ...attrs } = spec;
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

export function icon(name, { size = 16, label, className } = {}) {
  const key = ALIASES[name] || name;
  const specs = ICONS[key];
  if (!specs) throw new Error(`Unknown icon: ${name}`);
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', className ? `icon icon-${key} ${className}` : `icon icon-${key}`);
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  svg.setAttribute('focusable', 'false');
  for (const spec of specs) {
    const node = shape(spec);
    node.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(node);
  }
  return svg;
}
