// What each of you is doing, when you're both free, shifts, dinner.
// Pure functions over the store's state. No network, no DOM.
import {
  dayKey, fromDayKey, addDays, addMinutes, atTime, startOfDay, isoWeekday, fmtTime, fmtHM, fmtRange,
  relDay, relDayLower, roundDown, roundUp, mergeIntervals, subtractIntervals, intersectIntervals, DAY_NAMES, minutesOf
} from './util.js';

export const DEFAULT_SHIFT_TYPES = {
  long: { label: 'Long day', start: '07:30', end: '20:00' },
  night: { label: 'Night', start: '19:30', end: '08:00' },
  early: { label: 'Early', start: '07:00', end: '15:30' },
  late: { label: 'Late', start: '12:30', end: '20:30' },
  leave: { label: 'Holiday', allDay: true },
  off: { label: 'Day off', allDay: true }
};
export const SHIFT_ORDER = ['off', 'long', 'night', 'early', 'late', 'leave'];

export const DEFAULT_SETTINGS = {
  workLabel: 'Working',
  workStart: '09:00',
  workEnd: '17:30',
  workDays: [1, 2, 3, 4, 5],
  hasShifts: false,
  shiftTypes: DEFAULT_SHIFT_TYPES,
  sleepUntil: '14:00',
  travelMins: 30,
  rotaUrl: '',
  notif: { quiet: true, requests: true, rota: true, notes: true }
};

export const LAYER_INFO = {
  family: { label: 'family', colour: '#C2549B', soft: '#F8E1EE', ink: '#8E2468' },
  friends: { label: 'friends', colour: '#0F8B8D', soft: '#DDF3F2', ink: '#0B5E60' },
  other: { label: 'other calendars', colour: '#7A6FB0', soft: '#ECE9F7', ink: '#4B4180' }
};

const HOLIDAY_RE = /\b(holiday|annual leave|day off|out of office|ooo|bank holiday|leave)\b/i;

// ---------- people ----------
export function settingsOf(state, pid) {
  const p = state.people[pid] || {};
  const s = Object.assign({}, DEFAULT_SETTINGS, p.settings || {});
  s.shiftTypes = Object.assign({}, DEFAULT_SHIFT_TYPES, (p.settings && p.settings.shiftTypes) || {});
  s.notif = Object.assign({}, DEFAULT_SETTINGS.notif, (p.settings && p.settings.notif) || {});
  return s;
}
export function nameOf(state, pid) {
  if (pid === 'both') return 'Both of you';
  return (state.people[pid] && state.people[pid].name) || 'Someone';
}
export function youOr(state, pid) {
  return pid === state.me ? 'You' : nameOf(state, pid);
}
export function personColour(state, pid) {
  const p = state.people[pid];
  return (p && p.colour) || (pid === state.me ? 'blue' : 'orange');
}
export function calOf(state, ev) {
  return state.calendars[`${ev.owner}__${ev.calKey}`] || { role: 'normal', layer: 'own', show: true, share: 'all' };
}
export function layerKey(owner, layer) {
  return `${owner}:${layer}`;
}
export function layerLabel(state, key) {
  const [owner, layer] = key.split(':');
  const info = LAYER_INFO[layer] || LAYER_INFO.other;
  const label = info.label;
  if (owner === state.me) return `Your ${label}`;
  return `${nameOf(state, owner)}'s ${label}`;
}
export function layerChipLabel(state, key) {
  const l = layerLabel(state, key);
  return l.charAt(0).toUpperCase() + l.slice(1);
}

// ---------- events of one person for one day ----------
function eventsOn(state, pid, key) {
  const s = atTime(key, '00:00').getTime();
  const e = addDays(atTime(key, '00:00'), 1).getTime();
  return state.events.filter((ev) => ev.owner === pid && ev.start.getTime() < e && ev.end.getTime() > s);
}

// ---------- shifts ----------
function inferShift(ev) {
  const t = (ev.title || '').toLowerCase();
  if (ev.allDay) {
    if (/leave|holiday|annual|\bal\b/.test(t)) return 'leave';
    if (/off|rest/.test(t)) return 'off';
    return null;
  }
  if (/night/.test(t)) return 'night';
  if (/long/.test(t)) return 'long';
  if (/early/.test(t)) return 'early';
  if (/late/.test(t)) return 'late';
  const crosses = ev.end.getDate() !== ev.start.getDate();
  const hours = (ev.end - ev.start) / 3600000;
  if (crosses || ev.start.getHours() >= 18) return 'night';
  if (hours >= 11) return 'long';
  if (ev.start.getHours() < 10) return 'early';
  return 'late';
}

export function shiftFor(state, pid, key) {
  const s = settingsOf(state, pid);
  const ov = state.shifts[`${pid}|${key}`];
  let type = null; let start = null; let end = null; let source = null; let title = null;
  if (ov) {
    type = ov.type; source = 'manual';
    const def = s.shiftTypes[type] || {};
    if (!def.allDay && type !== 'off' && type !== 'leave') {
      start = atTime(key, ov.start || def.start);
      end = atTime(key, ov.end || def.end);
      if (end <= start) end = addDays(end, 1);
    }
  } else {
    const dayStart = atTime(key, '00:00');
    const rota = state.events.filter((ev) => ev.owner === pid && calOf(state, ev).role === 'rota' && (ev.allDay ? ev.startKey === key : dayKey(ev.start) === key));
    if (!rota.length) return null;
    const ev = rota[0];
    type = inferShift(ev) || 'other'; source = 'rota'; title = ev.title;
    if (!ev.allDay) { start = ev.start; end = ev.end; }
    if (ev.start < dayStart && !ev.allDay) return null;
  }
  const def = s.shiftTypes[type] || { label: title || 'Shift' };
  const label = def.label || title || 'Shift';
  const allDay = !start;
  return { type, label, start, end, allDay, source, title, key };
}
export function isWorkingShift(sh) {
  return sh && !sh.allDay && sh.type !== 'off' && sh.type !== 'leave';
}

// ---------- work hours ----------
function workFor(state, pid, key, viewer) {
  const s = settingsOf(state, pid);
  const date = fromDayKey(key);
  if (!s.workDays || !s.workDays.includes(isoWeekday(date))) return null;
  const evs = eventsOn(state, pid, key);
  const ownCalEvs = evs.filter((ev) => {
    const c = calOf(state, ev);
    return c.layer === 'own';
  });
  if (ownCalEvs.some((ev) => ev.allDay && HOLIDAY_RE.test(ev.title || ''))) return null;
  if (isWorkingShift(shiftFor(state, pid, key))) return null;
  const workCals = Object.values(state.calendars).filter((c) => c.owner === pid && c.role === 'work');
  if (viewer !== pid && workCals.length && workCals.every((c) => c.share === 'none')) return null;
  let start = atTime(key, s.workStart);
  let end = atTime(key, s.workEnd);
  const workEvs = evs.filter((ev) => !ev.allDay && calOf(state, ev).role === 'work' && ev.end - ev.start < 14 * 3600000);
  for (const ev of workEvs) {
    if (ev.start < start && ev.start.getHours() >= 6) start = ev.start;
    if (ev.end > end && ev.end.getHours() <= 23 && sameDate(ev.end, date)) end = ev.end;
  }
  const meetings = viewer === pid ? workEvs.filter((ev) => !/^working$/i.test(ev.title || '')) : [];
  return { kind: 'work', who: pid, title: s.workLabel || 'Working', start, end, meetings };
}
function sameDate(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// ---------- dinner ----------
function dinnerFor(state, key, persons) {
  const hh = state.household || {};
  if (!state.partner || hh.dinnerTime === '' || hh.showDinner === false) return null;
  const dinner = atTime(key, hh.dinnerTime || '19:00');
  const ids = [state.me, state.partner];
  // someone leaves for a shift around dinner time
  for (const pid of ids) {
    const p = persons[pid];
    const sh = p.shift;
    if (!isWorkingShift(sh)) continue;
    const s = settingsOf(state, pid);
    const leave = addMinutes(sh.start, -(s.travelMins || 0));
    const home = addMinutes(sh.end, s.travelMins || 0);
    if (sh.start.getHours() >= 15 && sh.start < addMinutes(dinner, 90) && sameDate(sh.start, fromDayKey(key))) {
      if (hh.moveDinner === false) return null;
      const early = roundDown(addMinutes(leave, -45), 15);
      const other = ids.find((x) => x !== pid);
      const ow = persons[other] && persons[other].work;
      if (ow && ow.end > early) return null;
      return {
        kind: 'together', who: 'both', auto: true, title: 'Early dinner together', start: early, end: addMinutes(early, 40),
        sub: `Moved from your usual ${fmtTime(dinner)}, as ${nameOf(state, pid)} leaves for work at ${fmtTime(leave)}.`
      };
    }
    if (sh.end > dinner && sh.start < dinner) {
      if (home.getHours() > 21 || (home.getHours() === 21 && home.getMinutes() > 30) || !sameDate(home, fromDayKey(key))) return null;
      const other = ids.find((x) => x !== pid);
      const hs = [home.getTime(), addMinutes(home, 45).getTime()];
      if (persons[other].busy.some((b) => b[0] < hs[1] && b[1] > hs[0])) return null;
      return {
        kind: 'together', who: 'both', auto: true, title: `Dinner when ${nameOf(state, pid)} is home`, start: home, end: addMinutes(home, 45),
        sub: `${nameOf(state, pid)} finishes at ${fmtTime(sh.end)}.`
      };
    }
  }
  // both free at the usual time?
  const span = [dinner.getTime(), addMinutes(dinner, 45).getTime()];
  for (const pid of ids) {
    const p = persons[pid];
    if (p.sleep && p.sleep.end > dinner && p.sleep.start < addMinutes(dinner, 45)) return null;
    for (const b of p.busy) if (b[0] < span[1] && b[1] > span[0]) return null;
  }
  return { kind: 'together', who: 'both', auto: true, title: 'Dinner together', start: dinner, end: addMinutes(dinner, 45), sub: 'Your usual dinner time.' };
}

// ---------- one whole day ----------
const cache = new Map();
export function clearDayCache() { cache.clear(); }

export function buildDay(state, key, now = new Date()) {
  const ck = `${state.rev}|${key}|${Math.floor(now.getTime() / 300000)}`;
  if (cache.has(ck)) return cache.get(ck);
  const date = fromDayKey(key);
  const dayStart = date.getTime();
  const dayEnd = addDays(date, 1).getTime();
  const ids = [state.me, state.partner].filter(Boolean);
  const persons = {};
  const together = [];
  const layers = {};
  const seenTags = new Set();
  const tagEvents = {};

  for (const pid of ids) {
    const s = settingsOf(state, pid);
    const items = [];
    const busy = [];
    // shift today
    const shift = shiftFor(state, pid, key);
    // carry-over from a night shift that started yesterday
    const prevKey = dayKey(addDays(date, -1));
    const prev = shiftFor(state, pid, prevKey);
    let sleep = null;
    if (isWorkingShift(prev) && prev.end.getTime() > dayStart) {
      items.push({ kind: 'shift', who: pid, title: prev.label, sub: 'Started last night', start: new Date(dayStart), end: prev.end, cont: true, shift: prev });
      busy.push([dayStart, prev.end.getTime() + (s.travelMins || 0) * 60000]);
      if (prev.type === 'night') {
        const ss = addMinutes(prev.end, s.travelMins || 0);
        const se = atTime(key, s.sleepUntil || '14:00');
        if (se > ss) {
          sleep = { kind: 'sleep', who: pid, title: 'Sleeping after a night shift', start: ss, end: se };
          items.push(sleep);
          busy.push([ss.getTime(), se.getTime()]);
        }
      }
    }
    if (shift) {
      if (isWorkingShift(shift)) {
        items.push({ kind: 'shift', who: pid, title: shift.label, sub: shift.source === 'rota' ? 'From the work rota' : 'Shift', start: shift.start, end: shift.end, shift });
        busy.push([addMinutes(shift.start, -(s.travelMins || 0)).getTime(), Math.min(addMinutes(shift.end, s.travelMins || 0).getTime(), dayEnd + 86400000)]);
      } else {
        items.push({ kind: 'shift', who: pid, title: shift.label, sub: shift.type === 'leave' ? 'Holiday' : 'Not working', allDay: true, start: new Date(dayStart), end: new Date(dayEnd), shift });
      }
    }
    // working hours
    const work = workFor(state, pid, key, state.me);
    if (work) {
      items.push(work);
      busy.push([work.start.getTime(), work.end.getTime()]);
    }
    // calendar events
    for (const ev of eventsOn(state, pid, key)) {
      const c = calOf(state, ev);
      if (pid === state.me && c.show === false) continue;
      if (c.role === 'rota') continue;
      if (c.role === 'work' && (pid === state.me || /^working$/i.test(ev.title || ''))) continue;
      if (ev.tag) {
        (tagEvents[ev.tag] = tagEvents[ev.tag] || []).push(ev);
        continue;
      }
      const it = {
        kind: 'event', who: pid, title: ev.busy ? 'Busy' : (ev.title || 'Busy'), sub: c.role === 'work' ? 'Work' : '',
        start: ev.start, end: ev.end, allDay: ev.allDay, calName: c.name, location: ev.location || '', busyOnly: !!ev.busy
      };
      if (c.layer && c.layer !== 'own') {
        const lk = layerKey(pid, c.layer);
        it.who = lk; it.layer = lk;
        (layers[lk] = layers[lk] || []).push(it);
        continue;
      }
      items.push(it);
      if (!ev.allDay) busy.push([ev.start.getTime(), ev.end.getTime()]);
    }
    persons[pid] = { items, busy, shift, sleep, work, settings: s };
  }

  // tagged events: things added for both of you, or from requests
  for (const tag of Object.keys(tagEvents)) {
    seenTags.add(tag);
    const evs = tagEvents[tag];
    const ev = evs[0];
    const owners = new Set(evs.map((e) => e.owner));
    const hold = /^pencilled in:/i.test(ev.title || '');
    const title = (ev.title || '').replace(/^pencilled in:\s*/i, '');
    const req = state.requests.find((r) => `req:${r.id}` === tag);
    if (req && (req.status === 'no' || req.status === 'cancelled')) continue;
    const both = owners.size > 1 || (req && req.type !== 'favour' && req.type !== 'add') || tag.startsWith('both:');
    const who = both ? 'both' : ev.owner;
    const it = {
      kind: hold ? 'hold' : (both ? 'together' : 'event'), who, title, start: ev.start, end: ev.end, allDay: ev.allDay,
      sub: hold ? `Pencilled in, waiting for ${req ? nameOf(state, req.to) : 'an answer'}` : (req && req.type === 'favour' ? `${nameOf(state, req.from)} asked` : ''),
      tag
    };
    if (who === 'both') together.push(it);
    else if (persons[who]) persons[who].items.push(it);
  }
  // requests not in the calendars yet
  for (const r of state.requests) {
    if (!r.when || !r.when.day || r.when.day !== key) continue;
    const tag = `req:${r.id}`;
    if (seenTags.has(tag)) continue;
    const start = r.when.allDay ? new Date(dayStart) : atTime(key, r.when.start || '19:00');
    const end = r.when.allDay ? new Date(dayEnd) : atTime(key, r.when.end || addHM(r.when.start || '19:00', 60));
    if ((r.status === 'waiting' || r.status === 'maybe') && r.hold) {
      together.push({ kind: 'hold', who: 'both', title: r.title, start, end, allDay: r.when.allDay, sub: `Pencilled in, waiting for ${nameOf(state, r.to)}`, pending: true, reqId: r.id });
    } else if (r.status === 'yes' && r.type !== 'heads') {
      if (r.type === 'favour') {
        const doer = r.to;
        if (persons[doer]) persons[doer].items.push({ kind: 'event', who: doer, title: r.title, start, end, allDay: r.when.allDay, sub: `${nameOf(state, r.from)} asked`, pending: true });
      } else if (r.type === 'add') {
        if (persons[r.to]) persons[r.to].items.push({ kind: 'event', who: r.to, title: r.title, start, end, allDay: r.when.allDay, sub: `Added by ${nameOf(state, r.from)}`, pending: true });
      } else {
        together.push({ kind: 'together', who: 'both', title: r.type === 'free' ? `Kept free: ${r.title}` : r.title, start, end, allDay: r.when.allDay, sub: 'Saving to your calendars', pending: true, reqId: r.id });
      }
    }
  }
  // things just added in this app, not synced yet
  for (const o of state.outbox) {
    if (o.op !== 'create' || o.done || !o.event || o.event.day !== key) continue;
    if (!o.tag || seenTags.has(o.tag) || o.tag.startsWith('req:')) continue;
    if (together.some((t) => t.tag === o.tag)) continue;
    const ev = o.event;
    const start = ev.allDay ? new Date(dayStart) : atTime(key, ev.start);
    const end = ev.allDay ? new Date(dayEnd) : atTime(key, ev.end);
    const it = { kind: o.both ? 'together' : 'event', who: o.both ? 'both' : o.person, title: ev.title, start, end, allDay: ev.allDay, sub: 'Saving to Google Calendar', pending: true, tag: o.tag };
    if (o.both) { if (o.person === state.me) together.push(it); }
    else if (persons[o.person]) persons[o.person].items.push(it);
  }
  // together things make both of you busy
  for (const t of together) {
    if (t.allDay) continue;
    for (const pid of ids) persons[pid].busy.push([t.start.getTime(), t.end.getTime()]);
  }
  // dinner
  if (ids.length === 2) {
    const din = dinnerFor(state, key, persons);
    if (din) together.push(din);
  }

  // both free (7am to 11pm, from now if today)
  let bothFree = [];
  let freeEvening = false;
  if (ids.length === 2) {
    let ws = atTime(key, '07:00').getTime();
    const we = atTime(key, '23:00').getTime();
    if (key === dayKey(now)) ws = Math.max(ws, roundUp(now, 15).getTime());
    if (we > ws) {
      const frees = ids.map((pid) => subtractIntervals([ws, we], persons[pid].busy));
      bothFree = intersectIntervals(frees[0], frees[1]).filter((iv) => iv[1] - iv[0] >= 60 * 60000);
    }
    const eveS = atTime(key, '18:00').getTime();
    const fullFrees = ids.map((pid) => subtractIntervals([atTime(key, '07:00').getTime(), we], persons[pid].busy));
    const fullBoth = intersectIntervals(fullFrees[0], fullFrees[1]);
    freeEvening = fullBoth.some((iv) => Math.min(iv[1], we) - Math.max(iv[0], eveS) >= 120 * 60000);
  }

  for (const pid of ids) persons[pid].items.sort(byTime);
  together.sort(byTime);
  for (const k of Object.keys(layers)) layers[k].sort(byTime);
  const out = { key, date, persons, together, layers, bothFree, freeEvening };
  cache.set(ck, out);
  if (cache.size > 400) cache.delete(cache.keys().next().value);
  return out;
}
function addHM(hm, mins) {
  const t = minutesOf(hm) + mins;
  const h = Math.min(23, Math.floor(t / 60));
  const m = h === 23 && t >= 24 * 60 ? 59 : t % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
function byTime(a, b) {
  if (a.allDay && !b.allDay) return -1;
  if (!a.allDay && b.allDay) return 1;
  return a.start - b.start || a.end - b.end;
}

// Everything for a day as one list, filtered by who you want to see.
export function dayList(state, key, filter = {}) {
  const d = buildDay(state, key);
  const out = [];
  for (const pid of [state.me, state.partner].filter(Boolean)) {
    if (filter[pid] === false) continue;
    out.push(...d.persons[pid].items);
  }
  out.push(...d.together);
  for (const lk of Object.keys(d.layers)) {
    if (filter[lk] === false) continue;
    out.push(...d.layers[lk]);
  }
  return out.sort(byTime);
}

export function itemTime(it, key) {
  if (it.allDay) return 'All day';
  const dayStart = atTime(key, '00:00');
  const startsBefore = it.start < dayStart;
  const endsAfter = it.end > addDays(dayStart, 1);
  if (it.kind === 'sleep') return `Until ${fmtTime(it.end)}`;
  if (it.cont || startsBefore) return `Until ${fmtTime(it.end)}`;
  if (it.kind === 'shift' || it.kind === 'work' || (it.end - it.start) >= 90 * 60000) {
    if (endsAfter) return `${fmtTime(it.start)} to ${fmtTime(it.end)}`;
    return fmtRange(it.start, it.end);
  }
  return fmtTime(it.start);
}
export function itemTitle(state, it) {
  if (it.kind === 'shift' && !it.allDay) return it.title === 'Night' ? 'Night shift' : it.title;
  return it.title;
}
export function itemSub(state, it) {
  if (it.kind === 'work') {
    if (it.who === state.me) {
      const n = it.meetings ? it.meetings.length : 0;
      return n ? `${n} meeting${n === 1 ? '' : 's'}. Only you see the details.` : 'Working hours';
    }
    return 'Working hours';
  }
  if (it.kind === 'shift' && !it.allDay && !it.cont) {
    const s = settingsOf(state, it.who);
    const home = addMinutes(it.end, s.travelMins || 0);
    return `Home about ${fmtTime(home)}${it.end.getDate() !== it.start.getDate() ? ' tomorrow morning' : ''}.`;
  }
  if (it.kind === 'sleep') return 'Notifications wait until after this.';
  if (it.location) return it.location;
  return it.sub || '';
}

// ---------- right now ----------
export function statusNow(state, pid, now = new Date()) {
  const key = dayKey(now);
  const d = buildDay(state, key, now);
  const p = d.persons[pid];
  if (!p) return null;
  const t = now.getTime();
  const timed = [...p.items, ...d.together].filter((it) => !it.allDay);
  const active = timed.filter((it) => it.start.getTime() <= t && it.end.getTime() > t);
  const rank = { sleep: 0, shift: 1, together: 2, hold: 4, event: 3, work: 5 };
  active.sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9));
  const cur = active[0];
  const later = timed.filter((it) => it.start.getTime() > t && sameDate(it.start, now)).sort(byTime);
  const name = nameOf(state, pid);
  const nextShift = later.find((it) => it.kind === 'shift');
  const nextOther = later.find((it) => it.kind !== 'work');
  const untilText = (it) => `Until ${it.kind === 'sleep' ? 'about ' : ''}${fmtTime(it.end)}${sameDate(it.end, now) ? '' : ' ' + relDayLower(it.end, now)}.`;
  if (!cur) {
    const allDayShift = p.items.find((it) => it.kind === 'shift' && it.allDay);
    const hr = now.getHours();
    let title = allDayShift ? allDayShift.title : 'Free';
    if (!allDayShift && (hr >= 23 || hr < 6)) title = 'Night-time';
    const sub = nextOther ? `Next: ${itemTitle(state, nextOther)} at ${fmtTime(nextOther.start)}.` : 'Nothing else planned today.';
    return { kind: 'free', title, sub };
  }
  if (cur.kind === 'sleep') {
    const back = nextShift ? ` Back at work at ${fmtTime(nextShift.start)}${nextShift.start.getHours() >= 17 ? ' tonight' : ''}.` : '';
    return { kind: 'sleep', title: 'Asleep after a night shift', sub: untilText(cur) + back, quiet: true };
  }
  if (cur.kind === 'shift') {
    const s = settingsOf(state, pid);
    const home = addMinutes(cur.end, s.travelMins || 0);
    return { kind: 'shift', title: `At work: ${cur.title === 'Night' ? 'night shift' : cur.title.toLowerCase()}`, sub: `Until ${fmtTime(cur.end)}. Home about ${fmtTime(home)}.` };
  }
  if (cur.kind === 'work') {
    const after = later.find((it) => it.kind !== 'work' && it.start >= cur.end);
    const t2 = after ? itemTitle(state, after) : '';
    const then = after ? ` Then ${t2.charAt(0).toLowerCase() + t2.slice(1)} at ${fmtTime(after.start)}.` : ', then free.';
    return { kind: 'work', title: cur.title, sub: `Until ${fmtTime(cur.end)}${then.startsWith(',') ? then : '.' + then}` };
  }
  return { kind: cur.kind, title: itemTitle(state, cur), sub: untilText(cur) };
}

// ---------- next time you're both free ----------
export function nextBothFree(state, now = new Date(), days = 21) {
  if (!state.partner) return null;
  for (let i = 0; i < days; i++) {
    const date = addDays(startOfDay(now), i);
    const key = dayKey(date);
    const d = buildDay(state, key, now);
    const wd = isoWeekday(date);
    const weekend = wd >= 6;
    for (const iv of d.bothFree) {
      const s = new Date(iv[0]);
      const e = new Date(iv[1]);
      const mins = (iv[1] - iv[0]) / 60000;
      const evening = e.getHours() >= 20 || (e.getHours() === 23) || e >= atTime(key, '20:00');
      if ((evening && mins >= 90 && s.getHours() >= 16) || (weekend && mins >= 180) || (!weekend && mins >= 180 && s.getHours() >= 9)) {
        const day = relDay(date, now);
        const open = e >= atTime(key, '22:30');
        const label = open ? `${day === 'Today' ? 'Tonight' : day} from ${fmtTime(s)}` : `${day}, ${fmtRange(s, e)}`;
        return { start: s, end: e, key, label, sub: reasonFor(state, d) };
      }
    }
  }
  return null;
}
function reasonFor(state, d) {
  const bits = [];
  for (const pid of [state.partner, state.me]) {
    const p = d.persons[pid];
    if (!p) continue;
    const sh = p.shift;
    if (sh && sh.allDay) bits.push(`${pid === state.me ? 'your' : nameOf(state, pid) + "'s"} ${sh.label.toLowerCase()}`);
    else if (p.work) bits.push(pid === state.me ? "you've finished work" : `${nameOf(state, pid)} has finished work`);
  }
  if (!bits.length) return 'Nothing booked for either of you.';
  const s = bits.join(', and ');
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

// Free windows for the composer: next N both-free slots
export function freeSlots(state, now = new Date(), count = 4, days = 21) {
  const out = [];
  if (!state.partner) return out;
  for (let i = 0; i < days && out.length < count; i++) {
    const date = addDays(startOfDay(now), i);
    const key = dayKey(date);
    const d = buildDay(state, key, now);
    for (const iv0 of d.bothFree) {
      if (out.length >= count) break;
      const iv = [Math.max(iv0[0], atTime(key, '09:00').getTime()), iv0[1]];
      const s = new Date(iv[0]);
      const e = new Date(iv[1]);
      if ((iv[1] - iv[0]) < 90 * 60000) continue;
      const open = e >= atTime(key, '22:30');
      const cap = open ? addMinutes(s, 120) : e;
      out.push({
        key, start: hm(s), end: hm(cap), allDay: false,
        label: open ? `${relDay(date, now)}, from ${fmtTime(s)}` : `${relDay(date, now)}, ${fmtRange(s, e)}`
      });
    }
  }
  return out;
}
function hm(d) { return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }

// ---------- short lines for "Coming up" ----------
export function dayLine(state, pid, key) {
  const d = buildDay(state, key);
  const p = d.persons[pid];
  if (!p) return '';
  const bits = [];
  for (const it of p.items) {
    if (it.cont || it.kind === 'sleep') continue;
    if (it.kind === 'shift') bits.push(it.allDay ? it.title : `${itemTitle(state, it)}, ${fmtRange(it.start, it.end)}`);
    else if (it.kind === 'work') bits.push(`${it.title}, ${fmtRange(it.start, it.end)}`);
    else if (bits.length < 3) bits.push(it.allDay ? it.title : `${it.title} at ${fmtTime(it.start)}`);
  }
  for (const t of d.together) {
    if (t.auto && t.title.startsWith('Dinner together')) continue;
    bits.push(t.allDay ? t.title : `${t.title} at ${fmtTime(t.start)}`);
  }
  return bits.length ? bits.join('. ') + '.' : 'Nothing planned.';
}

// ---------- month cell summary ----------
export function monthCell(state, key, filter) {
  const d = buildDay(state, key);
  const bars = [];
  const me = d.persons[state.me];
  const pa = state.partner ? d.persons[state.partner] : null;
  if (me && filter[state.me] !== false) {
    if (me.items.some((it) => (it.kind === 'event' && !it.allDay) || (it.kind === 'shift' && !it.allDay))) bars.push('me');
  }
  if (pa && filter[state.partner] !== false) {
    if (pa.sleep) bars.push('sleep');
    if (pa.items.some((it) => (it.kind === 'shift' && !it.allDay && !it.cont) || (it.kind === 'event' && !it.allDay))) bars.push('partner');
  }
  if (d.together.some((t) => !t.auto)) bars.push(d.together.some((t) => !t.auto && t.kind !== 'hold') ? 'together' : 'hold');
  for (const lk of Object.keys(d.layers)) if (filter[lk] !== false && d.layers[lk].length) bars.push(lk);
  return { bars: bars.slice(0, 4), freeEvening: d.freeEvening };
}

// All extra layers that exist (family, friends...)
export function allLayers(state) {
  const set = new Set();
  for (const c of Object.values(state.calendars)) {
    if (c.layer && c.layer !== 'own' && (c.owner === state.me ? c.show !== false : c.share !== 'none')) set.add(layerKey(c.owner, c.layer));
  }
  return [...set].sort();
}

// Is someone asleep after nights right now? Used to hold notifications.
export function sleepingUntil(state, pid, now = new Date()) {
  const d = buildDay(state, dayKey(now), now);
  const p = d.persons[pid];
  if (p && p.sleep && p.sleep.start <= now && p.sleep.end > now) return p.sleep.end;
  return null;
}

export { DAY_NAMES, fmtHM };
