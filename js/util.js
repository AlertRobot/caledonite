// Small helpers: dates, times and text. Everything works in the phone's local time (UK).

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const WEEKDAY_NAMES = { 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday', 7: 'Sunday' };

export const pad = (n) => String(n).padStart(2, '0');

export function dayKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function fromDayKey(k) {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
export function addDays(d, n) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
  return x;
}
export function addMinutes(d, n) {
  return new Date(d.getTime() + n * 60000);
}
export function isoWeekday(d) {
  const w = d.getDay();
  return w === 0 ? 7 : w;
}
export function mondayOf(d) {
  return addDays(startOfDay(d), 1 - isoWeekday(d));
}
// "07:30" on a given day key -> Date
export function atTime(key, hhmm) {
  const base = fromDayKey(key);
  const [h, m] = (hhmm || '00:00').split(':').map(Number);
  return new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m || 0);
}
export function hhmm(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function minutesOf(hm) {
  const [h, m] = (hm || '00:00').split(':').map(Number);
  return h * 60 + (m || 0);
}
export function roundDown(d, mins) {
  const ms = mins * 60000;
  return new Date(Math.floor(d.getTime() / ms) * ms);
}
export function roundUp(d, mins) {
  const ms = mins * 60000;
  return new Date(Math.ceil(d.getTime() / ms) * ms);
}

// 7pm, 7:30pm, 12pm, midnight
export function fmtTime(d) {
  const h = d.getHours();
  const m = d.getMinutes();
  if (h === 0 && m === 0) return 'midnight';
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${pad(m)}${suffix}` : `${h12}${suffix}`;
}
export function fmtHM(hm) {
  return fmtTime(atTime('2000-01-01', hm));
}
export function fmtRange(a, b) {
  return `${fmtTime(a)} to ${fmtTime(b)}`;
}
// Tuesday 17 November
export function fmtDate(d) {
  return `${DAY_NAMES[d.getDay()]} ${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`;
}
export function fmtDateShort(d) {
  return `${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`;
}
// Today / Tomorrow / Friday / Friday 4 December
export function relDay(d, now = new Date()) {
  const diff = Math.round((startOfDay(d) - startOfDay(now)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 7) return DAY_NAMES[d.getDay()];
  return fmtDate(d);
}
export function relDayLower(d, now = new Date()) {
  const r = relDay(d, now);
  return r === 'Today' ? 'today' : r === 'Tomorrow' ? 'tomorrow' : r;
}
export function agoText(ms, now = Date.now()) {
  if (!ms) return 'never';
  const s = Math.round((now - ms) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function uid(prefix = '') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
export function initial(name) {
  return (name || '?').trim().charAt(0).toUpperCase();
}
// Merge [start,end] intervals (ms numbers)
export function mergeIntervals(list) {
  const s = list.filter((x) => x[1] > x[0]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const iv of s) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}
// window minus busy -> free intervals
export function subtractIntervals(win, busy) {
  let free = [[win[0], win[1]]];
  for (const b of mergeIntervals(busy)) {
    const next = [];
    for (const f of free) {
      if (b[1] <= f[0] || b[0] >= f[1]) { next.push(f); continue; }
      if (b[0] > f[0]) next.push([f[0], b[0]]);
      if (b[1] < f[1]) next.push([b[1], f[1]]);
    }
    free = next;
  }
  return free;
}
export function intersectIntervals(a, b) {
  const out = [];
  for (const x of a) for (const y of b) {
    const s = Math.max(x[0], y[0]);
    const e = Math.min(x[1], y[1]);
    if (e > s) out.push([s, e]);
  }
  return out.sort((p, q) => p[0] - q[0]);
}
