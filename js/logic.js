// What each of you is doing, when you're both free, shifts, dinner.
// Pure functions over the store's state. No network, no DOM.
import {
  dayKey, fromDayKey, addDays, addMinutes, atTime, startOfDay, isoWeekday, fmtTime, fmtHM, fmtRange,
  relDay, relDayLower, roundDown, roundUp, mergeIntervals, subtractIntervals, intersectIntervals, DAY_NAMES, minutesOf, hhmm
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
  workEnd: '18:00',
  workDays: [1, 2, 3, 4, 5],
  altOff: null, // { day: 5, from: '2026-10-30' } = every other Friday off, starting then
  hasShifts: false,
  shiftTypes: DEFAULT_SHIFT_TYPES,
  sleepUntil: '14:00',
  travelMins: 30,
  rotaUrl: '',
  remindAt: '09:00',
  autoRemind: { birthdays: [] },
  quiet: { on: true, from: '23:00', to: '07:00', skip: null },
  morning: { on: true, at: '07:30' },
  weekAhead: { on: true, day: 7, at: '18:00' },
  christmas: true,
  lowCals: [], // calendars (owner__calKey) kept off Today and the week, for this viewer
  leave: { allowance: 25, yearStart: '01-01', bankHolsCount: false },
  notif: { quiet: true, requests: true, rota: true, notes: true, reminders: true, jobs: true, summary: true }
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
  s.autoRemind = Object.assign({}, DEFAULT_SETTINGS.autoRemind, (p.settings && p.settings.autoRemind) || {});
  for (const k of ['quiet', 'morning', 'weekAhead', 'leave']) s[k] = Object.assign({}, DEFAULT_SETTINGS[k], (p.settings && p.settings[k]) || {});
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
// Low priority: kept off Today and the week for whoever chose it. Still there when you look at a day.
export function isLowCal(state, cid) {
  return (settingsOf(state, state.me).lowCals || []).includes(cid);
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
  // ending at midnight is still the same day's shift (a late until 12), not a night
  const crosses = new Date(ev.end.getTime() - 1).getDate() !== ev.start.getDate();
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
    // all-day rota entries count on every day they cover (a week of leave is often one entry)
    const rota = state.events.filter((ev) => ev.owner === pid && calOf(state, ev).role === 'rota' && (ev.allDay ? ev.startKey <= key && key < dayKey(ev.end) : dayKey(ev.start) === key));
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
// "Every other Friday off": true on the days off, counting in fortnights from the first one.
export function isAltDayOff(s, key) {
  const a = s && s.altOff;
  if (!a || !a.day || !a.from) return false;
  const date = fromDayKey(key);
  if (isoWeekday(date) !== Number(a.day)) return false;
  const days = Math.round((date - fromDayKey(a.from)) / 86400000);
  return ((days % 14) + 14) % 14 === 0;
}
export function nextAltDaysOff(s, from = new Date(), count = 2) {
  const out = [];
  if (!s.altOff) return out;
  for (let i = 0; i < 60 && out.length < count; i++) {
    const k = dayKey(addDays(startOfDay(from), i));
    if (isAltDayOff(s, k)) out.push(k);
  }
  return out;
}
function workFor(state, pid, key, viewer) {
  const s = settingsOf(state, pid);
  const date = fromDayKey(key);
  if (!s.workDays || !s.workDays.includes(isoWeekday(date))) return null;
  if (isAltDayOff(s, key)) return null;
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
// Tonight's meal from Peckish, and a nudge to cook extra before a long shift
function withPeckish(state, key, din) {
  const pk = state.linked && state.linked.peckish;
  const meal = pk && pk.days && pk.days[key];
  if (!din && !meal) return din;
  const out = din ? Object.assign({}, din) : null;
  if (out && meal) {
    out.title = meal.takeaway ? 'Takeaway night' : `Dinner: ${meal.title}`;
    out.meal = meal;
  }
  // a long day, early or night shift tomorrow: make extra for a packed lunch
  const tomorrow = dayKey(addDays(fromDayKey(key), 1));
  const lunch = [state.me, state.partner].filter(Boolean).find((pid) => {
    const sh = shiftFor(state, pid, tomorrow);
    return isWorkingShift(sh) && (sh.end - sh.start) >= 9 * 3600000;
  });
  if (out && lunch && meal && !meal.takeaway) {
    out.lunchFor = lunch;
    out.sub = `${lunch === state.me ? 'You have' : nameOf(state, lunch) + ' has'} a long shift tomorrow: make extra for a packed lunch.`;
  } else if (out && meal) {
    out.sub = meal.time ? `${meal.time} minutes, from Peckish.` : 'From Peckish.';
  }
  return out;
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
    // every other Friday (or whichever day) off
    if (!s.hasShifts && s.workDays.includes(isoWeekday(date)) && isAltDayOff(s, key) && !shift) {
      items.push({ kind: 'shift', who: pid, title: 'Day off', sub: `Every other ${DAY_NAMES[date.getDay()]}`, allDay: true, start: new Date(dayStart), end: new Date(dayEnd), dayOff: true });
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
      if (c.role === 'work' && /^working$/i.test(ev.title || '')) continue;
      if (ev.tag) {
        (tagEvents[ev.tag] = tagEvents[ev.tag] || []).push(ev);
        continue;
      }
      const it = {
        kind: 'event', who: pid, title: ev.busy ? 'Busy' : (ev.title || 'Busy'), sub: c.role === 'work' ? 'Work' : '',
        start: ev.start, end: ev.end, allDay: ev.allDay, calName: c.name, location: ev.location || '', busyOnly: !!ev.busy,
        ref: evRef(ev), owner: ev.owner, repeats: !!ev.sid, src: ev, cal: `${ev.owner}__${ev.calKey}`, low: isLowCal(state, `${ev.owner}__${ev.calKey}`)
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
    // paydays and bills from Budgie, on this phone only
    if (pid === state.me && state.linked && state.linked.budgie && state.linked.budgie.days) {
      for (const m of state.linked.budgie.days[key] || []) {
        items.push({ kind: 'money', who: pid, title: m.name, sub: m.sub || '', allDay: true, start: new Date(dayStart), end: new Date(dayEnd), money: m });
      }
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
    const mine = evs.find((e) => e.owner === state.me) || ev;
    const it = {
      kind: hold ? 'hold' : (both ? 'together' : 'event'), who, title, start: ev.start, end: ev.end, allDay: ev.allDay,
      sub: hold ? `Pencilled in, waiting for ${req ? nameOf(state, req.to) : 'an answer'}` : (req && req.type === 'favour' ? `${nameOf(state, req.from)} asked` : ''),
      tag, ref: hold ? null : evRef(mine), owner: mine.owner, calName: (calOf(state, mine) || {}).name, src: mine
    };
    if (who === 'both') together.push(it);
    else if (persons[who]) addOwn(persons[who], it);
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
        if (persons[doer]) addOwn(persons[doer], { kind: 'event', who: doer, title: r.title, start, end, allDay: r.when.allDay, sub: `${nameOf(state, r.from)} asked`, pending: true });
      } else if (r.type === 'add') {
        if (persons[r.to]) addOwn(persons[r.to], { kind: 'event', who: r.to, title: r.title, start, end, allDay: r.when.allDay, sub: `Added by ${nameOf(state, r.from)}`, pending: true });
      } else {
        together.push({ kind: 'together', who: 'both', title: r.type === 'free' ? `Kept free: ${r.title}` : r.title, start, end, allDay: r.when.allDay, sub: 'Saving to your calendars', pending: true, reqId: r.id });
      }
    }
  }
  // things just added in this app, not synced yet (only your own: your partner's may be private)
  const myEmail = ((state.people[state.me] || {}).email || '').toLowerCase();
  for (const o of state.outbox) {
    if (o.op !== 'create' || o.done || !o.event || o.event.day !== key) continue;
    if (o.byEmail && String(o.byEmail).toLowerCase() !== myEmail) continue;
    if (!o.tag || seenTags.has(o.tag) || o.tag.startsWith('req:')) continue;
    if (together.some((t) => t.tag === o.tag)) continue;
    const ev = o.event;
    const start = ev.allDay ? new Date(dayStart) : atTime(key, ev.start);
    const end = ev.allDay ? new Date(dayEnd) : atTime(key, ev.end);
    const it = { kind: o.both ? 'together' : 'event', who: o.both ? 'both' : o.person, title: ev.title, start, end, allDay: ev.allDay, sub: 'Saving to Google Calendar', pending: true, tag: o.tag, ref: `t:${o.tag}`, owner: o.person };
    if (o.both) { if (o.person === state.me) together.push(it); }
    else if (persons[o.person]) addOwn(persons[o.person], it);
  }
  // together things make both of you busy
  for (const t of together) {
    if (t.allDay) continue;
    for (const pid of ids) persons[pid].busy.push([t.start.getTime(), t.end.getTime()]);
  }
  // dinner
  if (ids.length === 2) {
    const din = withPeckish(state, key, dinnerFor(state, key, persons));
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
// one person's own thing: on their list, and (when it has a time) it makes them busy
function addOwn(p, it) {
  p.items.push(it);
  if (!it.allDay) p.busy.push([it.start.getTime(), it.end.getTime()]);
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
// filter.hideLow leaves out low-priority calendars (Today and the week do this)
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
  return (filter.hideLow ? out.filter((it) => !it.low) : out).sort(byTime);
}
// how many things a low-priority calendar has on this day (shown as "2 more")
export function lowCount(state, key, filter = {}) {
  return dayList(state, key, Object.assign({}, filter, { hideLow: false })).filter((it) => it.low).length;
}

export function itemTime(it, key) {
  if (it.allDay) return 'All day';
  const dayStart = atTime(key, '00:00');
  const startsBefore = it.start < dayStart;
  const endsAfter = it.end > addDays(dayStart, 1);
  if (it.kind === 'sleep') return `Until ${fmtTime(it.end)}`;
  // the middle day of something that runs over several days
  if (startsBefore && endsAfter) return 'All day';
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
      return n ? `Working hours, ${n} meeting${n === 1 ? '' : 's'}` : 'Working hours';
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
    if (me.items.some((it) => !it.low && ((it.kind === 'event' && !it.allDay) || (it.kind === 'shift' && !it.allDay)))) bars.push('me');
  }
  if (pa && filter[state.partner] !== false) {
    if (pa.sleep) bars.push('sleep');
    if (pa.items.some((it) => !it.low && ((it.kind === 'shift' && !it.allDay && !it.cont) || (it.kind === 'event' && !it.allDay)))) bars.push('partner');
  }
  if (d.together.some((t) => !t.auto)) bars.push(d.together.some((t) => !t.auto && t.kind !== 'hold') ? 'together' : 'hold');
  for (const lk of Object.keys(d.layers)) if (filter[lk] !== false && d.layers[lk].some((it) => !it.low)) bars.push(lk);
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

// ---------- changing an event's time ----------
// The new timing for an event being changed (d: what was typed, any of day, start, end). Something that runs
// over several days keeps its length in days; something that already ran past midnight can still end the next
// morning. Returns { day, start, end, endDay? }, or { error }.
export function editTimes(src, d) {
  const day = d.day || dayKey(src.start);
  const start = d.start || hhmm(src.start);
  const end = d.end || hhmm(src.end);
  const nights = Math.round((startOfDay(src.end) - startOfDay(src.start)) / 86400000);
  let endDay = day;
  if (src.end - src.start >= 86400000) endDay = dayKey(addDays(fromDayKey(day), nights));
  else if (end <= start) {
    if (nights < 1) return { error: 'The end needs to be after the start.' };
    endDay = dayKey(addDays(fromDayKey(day), 1));
  }
  if (atTime(endDay, end) <= atTime(day, start)) return { error: 'The end needs to be after the start.' };
  const out = { day, start, end };
  if (endDay !== day) out.endDay = endDay;
  return out;
}

// ---------- reminders ----------
// A reminder belongs to one person and points at an event (or a repeating series, or
// something added in this app). The calendar sync sends it to their phone at the right
// time; Today shows it until the day has passed or it's ticked off.
export const REMIND_OPTIONS = [
  { v: 'w2', label: 'Two weeks before', days: 14 },
  { v: 'w1', label: 'A week before', days: 7 },
  { v: 'd1', label: 'The day before', days: 1 },
  { v: 'd0', label: 'On the day', days: 0 },
  { v: 'h1', label: 'An hour before', mins: 60, timedOnly: true },
  { v: 'm30', label: '30 minutes before', mins: 30, timedOnly: true }
];
export const REMIND_NOTES = ['Buy a card and a present', 'Send a message', 'Book a table', 'Get something ready'];
const BIRTHDAY_RE = /\bbirthday\b|\bbday\b|\bb-day\b/i;

export function evRef(ev) {
  if (ev.tag) return `t:${ev.tag}`;
  // tied to the event itself, not its time, so moving it keeps the reminder
  return `e:${ev.owner}:${ev.calKey}:${ev.uid || ev.sid || ev.id}`;
}
export function reminderId(ref) {
  let h = 5381;
  for (let i = 0; i < ref.length; i++) h = ((h * 33) ^ ref.charCodeAt(i)) >>> 0;
  return 'r' + h.toString(36) + ref.length.toString(36);
}
function occKeyOf(ref, ev) {
  return `${ref}@${ev.allDay ? (ev.startKey || dayKey(ev.start)) : dayKey(ev.start)}`;
}
export function isBirthday(ev) {
  return !!ev.allDay && BIRTHDAY_RE.test(ev.title || '');
}
// My own reminder for this event, or the automatic birthday one, or null.
export function reminderFor(state, ref, ev) {
  const p = state.people[state.me] || {};
  const r = (p.reminders || {})[reminderId(ref)];
  const s = settingsOf(state, state.me);
  // a ticked-off automatic one follows the birthday setting
  if (r && r.auto) return Object.assign({ id: reminderId(ref) }, r, { times: s.autoRemind.birthdays || [] });
  if (r) return Object.assign({ id: reminderId(ref), auto: false }, r);
  if (ev && ev.owner === state.me && isBirthday(ev) && (s.autoRemind.birthdays || []).length) {
    return { id: reminderId(ref), ref, owner: ev.owner, times: s.autoRemind.birthdays, note: '', auto: true };
  }
  return null;
}
export function fireTimes(times, ev, remindAt = '09:00') {
  const out = [];
  const startKey = ev.allDay ? (ev.startKey || dayKey(ev.start)) : dayKey(ev.start);
  for (const code of times || []) {
    const o = REMIND_OPTIONS.find((x) => x.v === code);
    if (!o) continue;
    if (o.timedOnly) { if (!ev.allDay) out.push({ code, at: new Date(ev.start.getTime() - o.mins * 60000) }); continue; }
    let at = atTime(dayKey(addDays(fromDayKey(startKey), -o.days)), remindAt);
    // on the day of something early: an hour before it, if that comes first
    if (o.days === 0 && !ev.allDay && ev.start.getTime() - 3600000 < at.getTime()) at = new Date(ev.start.getTime() - 3600000);
    out.push({ code, at });
  }
  return out.sort((a, b) => a.at - b.at);
}
// "In a week, on Friday 6 November." Used on Today and in the phone notification.
export function reminderLine(ev, now = new Date()) {
  const date = ev.allDay ? fromDayKey(ev.startKey || dayKey(ev.start)) : ev.start;
  const days = Math.round((startOfDay(date) - startOfDay(now)) / 86400000);
  const time = ev.allDay ? '' : ` at ${fmtTime(ev.start)}`;
  const full = `${DAY_NAMES[date.getDay()]} ${date.getDate()} ${MONTH_LONG[date.getMonth()]}`;
  if (days <= 0) {
    if (!ev.allDay && ev.start > now && ev.start - now <= 90 * 60000) return `Soon, at ${fmtTime(ev.start)}.`;
    return `Today${time}.`;
  }
  if (days === 1) return `Tomorrow${time}.`;
  if (days === 7) return `In a week, on ${full}${time}.`;
  if (days === 14) return `In two weeks, on ${full}${time}.`;
  return `In ${days} days, on ${full}${time}.`;
}
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Every event I can see that has a reminder for me, with when it fires.
export function myReminders(state, now = new Date(), daysAhead = 60) {
  const s = settingsOf(state, state.me);
  const limit = addDays(startOfDay(now), daysAhead).getTime();
  const todayStart = startOfDay(now).getTime();
  const seen = new Set();
  const out = [];
  for (const ev of state.events) {
    if (ev.end.getTime() <= todayStart || ev.start.getTime() > limit) continue;
    if (ev.busy) continue;
    const ref = evRef(ev);
    const occ = occKeyOf(ref, ev);
    if (seen.has(occ)) continue;
    const c = calOf(state, ev);
    if (ev.owner === state.me && c.show === false) continue;
    const rem = reminderFor(state, ref, ev);
    if (!rem || !(rem.times || []).length) continue;
    seen.add(occ);
    const fires = fireTimes(rem.times, ev, s.remindAt);
    if (!fires.length) continue;
    const doneAt = (rem.done && rem.done[occ]) || 0;
    const fired = fires.filter((f) => f.at <= now);
    const lastFired = fired.length ? fired[fired.length - 1].at.getTime() : 0;
    const next = fires.find((f) => f.at > now) || null;
    const active = !!lastFired && ev.end > now && doneAt < lastFired;
    out.push({ ref, occ, ev, rem, fires, next, active, doneAt, title: ev.title || 'Something', note: rem.note || '' });
  }
  return out.sort((a, b) => a.ev.start - b.ev.start);
}
// Reminder chips in a short sentence: "A week before and on the day"
export function remindSummary(times) {
  const labels = REMIND_OPTIONS.filter((o) => (times || []).includes(o.v)).map((o) => o.label.toLowerCase());
  if (!labels.length) return 'No reminder';
  const t = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// ---------- jobs ----------
export const JOB_REPEATS = [
  { v: '', label: 'Just once' },
  { v: 'week:1', label: 'Every week' },
  { v: 'week:2', label: 'Every 2 weeks' },
  { v: 'month:1', label: 'Every month' },
  { v: 'day:1', label: 'Every day' }
];
export function repeatOf(v) {
  if (!v) return null;
  const [unit, every] = v.split(':');
  return { unit, every: Number(every) || 1 };
}
export function repeatValue(r) { return r ? `${r.unit}:${r.every || 1}` : ''; }
export function repeatLabel(r) {
  const o = JOB_REPEATS.find((x) => x.v === repeatValue(r));
  return o ? o.label : 'Just once';
}
// the next time a repeating job is due, after it's been done today
export function nextJobDay(job, todayK) {
  const r = job.repeat;
  let d = fromDayKey(job.day || todayK);
  const today = fromDayKey(todayK);
  // monthly: the same day of the month, or the last day of a shorter month (31 January, then 28 February, not 3 March)
  const dom = d.getDate(); const y0 = d.getFullYear(); const m0 = d.getMonth(); let months = 0;
  const step = () => {
    if (r.unit === 'day') d = addDays(d, r.every || 1);
    else if (r.unit === 'week') d = addDays(d, 7 * (r.every || 1));
    else {
      months += r.every || 1;
      const last = new Date(y0, m0 + months + 1, 0).getDate();
      d = new Date(y0, m0 + months, Math.min(dom, last));
    }
  };
  step();
  while (d <= today) step();
  return dayKey(d);
}
// jobs for someone on a day (today also shows anything overdue)
export function jobsOn(state, key, who) {
  const todayK = dayKey(new Date());
  return state.jobs.filter((j) => !j.done && j.day && (j.day === key || (key === todayK && j.day < todayK)) && (!who || j.who === who || j.who === 'both'))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : (a.time || '99') < (b.time || '99') ? -1 : 1));
}
export function jobWho(state, j) {
  if (j.who === 'both') return 'Both of you';
  return j.who === state.me ? 'You' : nameOf(state, j.who);
}

// ---------- holidays and allowances ----------
// Bank holidays in England and Wales
export const BANK_HOLIDAYS = [
  '2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28',
  '2027-01-01', '2027-03-26', '2027-03-29', '2027-05-03', '2027-05-31', '2027-08-30', '2027-12-27', '2027-12-28',
  '2028-01-03', '2028-04-14', '2028-04-17', '2028-05-01', '2028-05-29', '2028-08-28', '2028-12-25', '2028-12-26'
];
// The working days a holiday takes from someone's allowance
export function leaveDaysFor(state, pid, fromK, toK) {
  const s = settingsOf(state, pid);
  let n = 0;
  for (let d = fromDayKey(fromK); dayKey(d) <= toK; d = addDays(d, 1)) {
    const k = dayKey(d);
    const wd = isoWeekday(d);
    if (!s.leave.bankHolsCount && BANK_HOLIDAYS.includes(k)) continue;
    if (s.hasShifts) {
      // a shift worker: the days they'd be on shift, or weekdays when the rota isn't known yet
      const sh = shiftFor(state, pid, k);
      if (sh ? isWorkingShift(sh) || sh.type === 'leave' : wd <= 5) n++;
      continue;
    }
    if (!s.workDays.includes(wd) || isAltDayOff(s, k)) continue;
    n++;
  }
  return n;
}
function leaveYear(s, now = new Date()) {
  const [mm, dd] = (s.leave.yearStart || '01-01').split('-').map(Number);
  let start = new Date(now.getFullYear(), mm - 1, dd);
  if (start > now) start = new Date(now.getFullYear() - 1, mm - 1, dd);
  const end = new Date(start.getFullYear() + 1, mm - 1, dd);
  return { start: dayKey(start), end: dayKey(addDays(end, -1)) };
}
// Holidays booked this leave year (requests that were agreed), and what's left
export function leaveSummary(state, pid, now = new Date()) {
  const s = settingsOf(state, pid);
  const yr = leaveYear(s, now);
  const todayK = dayKey(now);
  const list = [];
  let used = 0; let booked = 0;
  for (const r of state.requests) {
    if (r.type !== 'leave' || r.status !== 'yes' || !r.when || !r.when.day) continue;
    const people = r.people || [r.from, r.to];
    if (!people.includes(pid)) continue;
    const from = r.when.day; const to = r.when.endDay || r.when.day;
    if (to < yr.start || from > yr.end) continue;
    const days = r.days && typeof r.days[pid] === 'number' ? r.days[pid] : leaveDaysFor(state, pid, from, to);
    if (from <= todayK) used += days; else booked += days;
    list.push({ id: r.id, title: r.title || 'Holiday', from, to, days, past: to < todayK, together: people.length > 1 });
  }
  list.sort((a, b) => (a.from < b.from ? -1 : 1));
  const allowance = Number(s.leave.allowance) || 0;
  return { allowance, used, booked, left: allowance - used - booked, year: yr, list };
}

// ---------- countdowns ----------
// A countdown shows on both your Todays only when your partner can already see the event's name
export function countdownShared(state, ev) {
  if (!ev || !ev.owner || ev.owner !== state.me) return true;
  if (ev.tag && (ev.tag.startsWith('both:') || ev.tag.startsWith('req:'))) return true;
  const c = calOf(state, ev);
  return c.share === 'all' && c.role !== 'work' && !ev.busy;
}
export function countdowns(state, now = new Date()) {
  const out = [];
  const today = startOfDay(now);
  const add = (id, title, dateK, who, mine) => {
    const days = Math.round((fromDayKey(dateK) - today) / 86400000);
    if (days < 0 || days > 400) return;
    out.push({ id, title, date: dateK, days, who, mine });
  };
  for (const pid of [state.me, state.partner].filter(Boolean)) {
    const p = state.people[pid] || {};
    for (const [id, c] of Object.entries(p.countdowns || {})) {
      if (!c || !c.date) continue;
      if (pid !== state.me && c.shared === false) continue;
      add(`${pid}:${id}`, c.title, c.date, pid, pid === state.me);
    }
  }
  const s = settingsOf(state, state.me);
  const todayK = dayKey(now);
  const y0 = now.getFullYear();
  // the next time a yearly date (MM-DD) comes round
  const nextOf = (mmdd) => (`${y0}-${mmdd}` >= todayK ? `${y0}-${mmdd}` : `${y0 + 1}-${mmdd}`);
  const nextBy = (fn) => { const k = fn(y0); return k >= todayK ? k : fn(y0 + 1); };
  if (s.christmas !== false) {
    add('christmas', 'Christmas', nextOf('12-25'), 'both', false);
    add('newyear', 'New Year', nextOf('01-01'), 'both', false);
    add('valentines', "Valentine's Day", nextOf('02-14'), 'both', false);
    add('easter', 'Easter', nextBy(easterKey), 'both', false);
    add('mothers', "Mother's Day", nextBy((y) => dayKey(addDays(fromDayKey(easterKey(y)), -21))), 'both', false);
    add('fathers', "Father's Day", nextBy(fathersDayKey), 'both', false);
  }
  // birthdays: from Our routine, or a "Sophie's birthday" event in either calendar
  const bdays = state.household.birthdays || {};
  for (const pid of [state.me, state.partner].filter(Boolean)) {
    const name = nameOf(state, pid);
    const title = pid === state.me ? 'Your birthday' : `${name}'s birthday`;
    if (/^\d{2}-\d{2}$/.test(bdays[pid] || '')) { add(`bday:${pid}`, title, nextOf(bdays[pid]), pid, false); continue; }
    const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(['’]s)?\\s+(birthday|bday)\\b`, 'i');
    const ev = state.events.filter((e) => e.allDay && re.test(e.title || '') && dayKey(e.start) >= todayK).sort((x, z) => x.start - z.start)[0];
    if (ev) add(`bday:${pid}`, title, dayKey(ev.start), pid, false);
  }
  // the anniversary: from Our routine, or an "anniversary" event in either calendar
  const ann = state.household.anniversary;
  if (ann && /^\d{4}-\d{2}-\d{2}$/.test(ann)) {
    const k = nextOf(ann.slice(5));
    const years = Number(k.slice(0, 4)) - Number(ann.slice(0, 4));
    add('anniversary', years > 0 ? `Your anniversary (${years} ${years === 1 ? 'year' : 'years'})` : 'Your anniversary', k, 'both', false);
  } else {
    const ev = state.events.filter((e) => /anniversary/i.test(e.title || '') && [state.me, state.partner].includes(e.owner) && dayKey(e.start) >= todayK).sort((x, z) => x.start - z.start)[0];
    if (ev) add('anniversary', 'Your anniversary', dayKey(ev.start), 'both', false);
  }
  // holidays you've booked together count down by themselves
  for (const r of state.requests) {
    if (r.type !== 'leave' || r.status !== 'yes' || !r.when) continue;
    add(`leave:${r.id}`, r.title ? `Holiday: ${r.title}` : 'Holiday', r.when.day, (r.people || []).length === 1 ? r.from : 'both', false);
  }
  const seen = new Set();
  return out.filter((c) => { const k = `${c.title}|${c.date}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.days - b.days);
}
// Easter Sunday (the Anonymous Gregorian method)
function easterKey(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
// the third Sunday in June
function fathersDayKey(y) {
  const first = new Date(y, 5, 1);
  return dayKey(new Date(y, 5, 1 + ((7 - first.getDay()) % 7) + 14));
}
export function countdownText(c) {
  if (c.days === 0) return `${c.title} is today`;
  if (c.days === 1) return `${c.title} is tomorrow`;
  if (c.days < 7) return `${c.title} in ${c.days} days`;
  const w = Math.floor(c.days / 7);
  if (c.days >= 14 && c.days % 7 === 0) return `${c.title} in ${w} weeks`;
  return `${c.title} in ${c.days} days`;
}

// ---------- quiet hours ----------
export function inQuietHours(s, now = new Date()) {
  const q = s.quiet;
  if (!q || !q.on) return false;
  const m = now.getHours() * 60 + now.getMinutes();
  const a = minutesOf(q.from || '23:00'); const b = minutesOf(q.to || '07:00');
  const inside = a <= b ? (m >= a && m < b) : (m >= a || m < b);
  if (!inside) return false;
  // "not tonight": the quiet night that starts on the skipped date
  const nightStart = a > b && m < b ? dayKey(addDays(now, -1)) : dayKey(now);
  return q.skip !== nightStart;
}
// the date the coming (or current) quiet night starts on, for "not tonight"
export function quietNight(s, now = new Date()) {
  const q = s.quiet;
  const m = now.getHours() * 60 + now.getMinutes();
  const a = minutesOf(q.from || '23:00'); const b = minutesOf(q.to || '07:00');
  return a > b && m < b ? dayKey(addDays(now, -1)) : dayKey(now);
}

export { DAY_NAMES, fmtHM };
