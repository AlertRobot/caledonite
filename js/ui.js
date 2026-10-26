// Shared bits of interface: icons, avatars, chips, switches, segmented buttons.
import { esc, initial } from './util.js';
import { nameOf, personColour, LAYER_INFO } from './logic.js';

const svg = (inner, size = 22, extra = '') => `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${extra}>${inner}</svg>`;
export const icon = {
  today: (s) => svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>', s),
  calendar: (s) => svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>', s),
  requests: (s) => svg('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>', s),
  add: (s) => svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>', s),
  plus: (s) => svg('<path d="M12 5v14M5 12h14"/>', s, ' stroke-width="2.2"'),
  back: (s) => svg('<path d="M15 18l-6-6 6-6"/>', s, ' stroke-width="2.2"'),
  next: (s) => svg('<path d="M9 6l6 6-6 6"/>', s, ' stroke-width="2.2"'),
  close: (s) => svg('<path d="M6 6l12 12M18 6L6 18"/>', s, ' stroke-width="2.2"'),
  moon: (s) => svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>', s),
  home: (s) => svg('<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>', s),
  eye: (s) => svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>', s),
  clock: (s) => svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', s),
  check: (s) => svg('<path d="M5 12l5 5 9-10"/>', s, ' stroke-width="2.5"'),
  sync: (s) => svg('<path d="M21 12a9 9 0 0 1-15.5 6.2M3 12A9 9 0 0 1 18.5 5.8"/><path d="M18 2v4h-4M6 22v-4h4"/>', s),
  bell: (s) => svg('<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>', s),
  work: (s) => svg('<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>', s),
  heart: (s) => svg('<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z"/>', s),
  settings: (s) => svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>', s, ' stroke-width="1.8"'),
  pencil: (s) => svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>', s),
  repeat: (s) => svg('<path d="M17 2l4 4-4 4"/><path d="M3 11V10a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>', s),
  user: (s) => svg('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>', s),
  drop: (s) => svg('<path d="M12 2.7l5.7 5.6a8 8 0 1 1-11.4 0z"/>', s),
  link: (s) => svg('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>', s),
  plane: (s) => svg('<path d="M17.8 19.2L16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>', s),
  gift: (s) => svg('<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M19 12v9H5v-9"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/>', s),
  sliders: (s) => svg('<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>', s),
  // theme motifs
  orbit: (s) => svg('<circle cx="12" cy="12" r="5"/><ellipse cx="12" cy="12" rx="11" ry="4" transform="rotate(-20 12 12)"/><circle cx="20" cy="5" r="0.8"/><circle cx="4" cy="19" r="0.8"/>', s, ' stroke-width="1.6"'),
  wing: (s) => svg('<path d="M2 19c3-7 7-12 20-15-4 3-5 6-4 9-3-2-6-1-8 2-2-2-5-1-8 4z"/><path d="M10 15c1-3 3-5 6-6"/><path d="M6 19c0 2 1 3 3 3"/>', s, ' stroke-width="1.6"'),
  castle: (s) => svg('<path d="M3 21V9l3 2V7l3 2V5l3 2 3-2v4l3-2v4l3-2v12z"/><path d="M10 21v-4a2 2 0 0 1 4 0v4"/><path d="M12 5V2l2 1-2 1"/>', s, ' stroke-width="1.7"'),
  gem: (s) => svg('<path d="M6 3h12l4 6-10 12L2 9z"/><path d="M2 9h20M12 21L8 9l4-6 4 6z"/>', s, ' stroke-width="1.7"')
};

export function avatar(state, pid, size = 44) {
  const col = personColour(state, pid);
  return `<span class="av av-${col}" style="--s:${size}px" aria-hidden="true">${esc(initial(nameOf(state, pid)))}</span>`;
}
export function whoChip(state, who) {
  if (who === 'both') return '<span class="chip chip-tog">Both of you</span>';
  if (who && who.includes(':')) {
    const [owner, layer] = who.split(':');
    const info = LAYER_INFO[layer] || LAYER_INFO.other;
    const label = owner === state.me ? `Your ${info.label}` : `${nameOf(state, owner)}'s ${info.label}`;
    return `<span class="chip" style="background:var(--layer-${layer}-soft, ${info.soft});color:var(--layer-${layer}-ink, ${info.ink})">${esc(label.charAt(0).toUpperCase() + label.slice(1))}</span>`;
  }
  const col = personColour(state, who);
  return `<span class="chip chip-${col}">${who === state.me ? 'You' : esc(nameOf(state, who))}</span>`;
}
export function seg(items, { act, label, cls = '' } = {}) {
  return `<div class="seg ${cls}" role="group" aria-label="${esc(label || '')}">${items.map((it) =>
    `<button type="button" class="${it.on ? 'on' : ''}" aria-pressed="${it.on ? 'true' : 'false'}" data-act="${act}" data-v="${esc(it.v)}"${it.extra || ''}>${esc(it.label)}</button>`).join('')}</div>`;
}
export function toggleRow({ act, on, label, sub = '', data = '' }) {
  return `<button type="button" class="row-toggle" aria-pressed="${on ? 'true' : 'false'}" data-act="${act}" ${data}>
    <span class="grow"><span class="b">${esc(label)}</span>${sub ? `<span class="small muted">${esc(sub)}</span>` : ''}</span>
    <span class="switch ${on ? 'on' : ''}"><span></span></span></button>`;
}
export function pill(text, cls = '') {
  return `<span class="pill ${cls}">${esc(text)}</span>`;
}
export function empty(text) {
  return `<p class="muted empty">${esc(text)}</p>`;
}
