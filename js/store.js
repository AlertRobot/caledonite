// The app's state, built from whichever backend is running (Firebase, or the demo).
// Views read `store.state` and call `actions.*`. Every change re-renders.
import { dayKey, fromDayKey, uid, addDays, startOfDay } from './util.js';
import { clearDayCache, settingsOf, sleepingUntil, nameOf, DEFAULT_SETTINGS } from './logic.js';

const listeners = new Set();
export const store = {
  backend: null,
  raw: null,
  state: emptyState(),
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  emit() { for (const fn of listeners) fn(this.state); }
};

function emptyState() {
  return {
    rev: 0, phase: 'loading', error: null, demo: false,
    user: null, me: null, partner: null,
    people: {}, household: {}, calendars: {}, events: [], shifts: {}, requests: [], notes: [], outbox: [], status: {}
  };
}

// Raw backend data -> tidy state
export function setRaw(raw, extra = {}) {
  store.raw = raw;
  const s = emptyState();
  Object.assign(s, extra);
  s.rev = (store.state.rev || 0) + 1;
  s.household = raw.household || {};
  s.people = {};
  for (const [pid, p] of Object.entries(raw.people || {})) s.people[pid] = Object.assign({ id: pid }, p);
  const email = (s.user && s.user.email || '').toLowerCase();
  if (s.demo) {
    s.me = extra.me;
  } else {
    s.me = Object.keys(s.people).find((pid) => (s.people[pid].email || '').toLowerCase() === email) || null;
  }
  s.partner = Object.keys(s.people).find((pid) => pid !== s.me) || null;
  s.calendars = {};
  for (const [k, c] of Object.entries(raw.calendars || {})) {
    s.calendars[k] = Object.assign({ show: true, share: 'busy', role: 'normal', layer: 'own' }, c, { key: k });
  }
  const evs = [];
  for (const f of raw.feeds || []) {
    // my own private feeds, and the partner's shared ones
    if (f.owner === s.me && !f.private) continue;
    if (f.owner !== s.me && f.private) continue;
    for (const e of f.events || []) {
      let start; let end;
      if (e.ad) {
        start = fromDayKey(e.sd);
        end = e.ed ? fromDayKey(e.ed) : addDays(start, 1);
      } else {
        start = new Date(e.s);
        end = new Date(e.e);
      }
      if (!(end > start)) end = new Date(start.getTime() + 30 * 60000);
      evs.push({ owner: f.owner, calKey: f.calKey, id: e.id, title: e.t || '', start, end, allDay: !!e.ad, startKey: e.ad ? e.sd : null, busy: !!e.b, tag: e.tag || null, location: e.l || '' });
    }
  }
  s.events = evs;
  s.shifts = {};
  for (const sh of Object.values(raw.shifts || {})) if (sh && sh.person && sh.day) s.shifts[`${sh.person}|${sh.day}`] = sh;
  s.requests = Object.entries(raw.requests || {}).map(([id, r]) => Object.assign({ id }, r)).sort((a, b) => (b.created || 0) - (a.created || 0));
  s.notes = Object.entries(raw.notes || {}).map(([id, n]) => Object.assign({ id }, n)).sort((a, b) => (b.created || 0) - (a.created || 0));
  s.outbox = Object.entries(raw.outbox || {}).map(([id, o]) => Object.assign({ id }, o)).filter((o) => !o.done);
  s.status = raw.status || {};
  if (s.phase === 'ready' && !s.me) s.phase = 'not-member';
  store.state = s;
  clearDayCache();
  store.emit();
}

export function setPhase(phase, extra = {}) {
  store.state = Object.assign({}, store.state, { phase, rev: store.state.rev + 1 }, extra);
  store.emit();
}

// ---------- actions ----------
function db() { return store.backend; }
const now = () => Date.now();

function notify(to, title, body, link = '#today', kind = 'requests') {
  const st = store.state;
  const s = settingsOf(st, to);
  let sendAfter = now();
  if (s.notif.quiet) {
    const until = sleepingUntil(st, to);
    if (until) sendAfter = until.getTime();
  }
  if (s.notif[kind] === false) return null;
  return db().add('notify', { to, kind, title, body, link, sendAfter, sent: false, created: now() });
}

export const actions = {
  async createRequest({ type, title, when, hold, note }) {
    const st = store.state;
    const id = uid('r');
    const req = {
      from: st.me, to: st.partner, type, title: title.trim(), when: when || null, hold: !!(hold && when && type !== 'heads'),
      status: type === 'heads' ? 'sent' : 'waiting', note: note || '', created: now()
    };
    await db().set(`requests/${id}`, req);
    if (req.hold) {
      for (const pid of [st.me, st.partner]) {
        await db().add('outbox', { person: pid, op: 'create', tag: `req:${id}`, both: true, event: evFromWhen(`Pencilled in: ${req.title}`, when), done: false, created: now() });
      }
    }
    const me = nameOf(st, st.me);
    const titles = { plan: `${me} wants to plan something`, favour: `${me} asked a favour`, free: `${me} asked you to keep some time free`, heads: `Heads up from ${me}`, add: `${me} added something for you` };
    await notify(st.partner, titles[type] || `${me} asked you something`, req.title + (when ? ` (${when.label})` : ''), '#requests');
    db().ping();
    return id;
  },

  async answerRequest(id, answer, extra = {}) {
    const st = store.state;
    const r = st.requests.find((x) => x.id === id);
    if (!r) return;
    const tag = `req:${id}`;
    const me = nameOf(st, st.me);
    const both = [r.from, r.to];
    const patch = { answeredAt: now() };
    if (answer === 'yes') {
      patch.status = 'yes';
      if (r.type === 'favour') {
        if (r.hold) for (const pid of both) await db().add('outbox', { person: pid, op: 'delete', tag, done: false, created: now() });
        if (r.when) await db().add('outbox', { person: r.to, op: 'create', tag, event: evFromWhen(`${r.title} (for ${nameOf(st, r.from)})`, r.when, '19:00'), done: false, created: now() });
      } else if (r.type === 'add') {
        if (r.when) await db().add('outbox', { person: r.to, op: 'create', tag, event: evFromWhen(r.title, r.when), done: false, created: now() });
      } else if (r.type !== 'heads' && r.when) {
        const title = r.type === 'free' ? `Kept free: ${r.title}` : r.title;
        for (const pid of both) {
          if (r.hold) await db().add('outbox', { person: pid, op: 'update', tag, event: { title }, done: false, created: now() });
          else await db().add('outbox', { person: pid, op: 'create', tag, both: true, event: evFromWhen(title, r.when), done: false, created: now() });
        }
      }
      await notify(r.from, `${me} said yes`, r.title, '#requests');
    } else if (answer === 'no') {
      patch.status = 'no';
      if (r.hold) for (const pid of both) await db().add('outbox', { person: pid, op: 'delete', tag, done: false, created: now() });
      await notify(r.from, `${me} can't this time`, r.title, '#requests');
    } else if (answer === 'maybe') {
      patch.status = 'maybe';
      await notify(r.from, `${me} isn't sure yet`, r.title, '#requests');
    } else if (answer === 'seen') {
      patch.status = 'seen';
    } else if (answer === 'other') {
      patch.status = 'other';
      patch.counter = extra.when;
      await notify(r.from, `${me} suggested another time`, `${r.title}: ${extra.when.label}`, '#requests');
    } else if (answer === 'accept-counter') {
      // the person who asked agrees to the other time
      patch.status = 'yes';
      patch.when = r.counter;
      patch.counter = null;
      const title = r.type === 'free' ? `Kept free: ${r.title}` : r.title;
      for (const pid of both) {
        if (r.hold) await db().add('outbox', { person: pid, op: 'delete', tag, done: false, created: now() });
        await db().add('outbox', { person: pid, op: 'create', tag, both: true, event: evFromWhen(title, r.counter), done: false, created: now() });
      }
      await notify(r.to, `${me} said yes to your time`, `${r.title}: ${r.counter.label}`, '#requests');
    } else if (answer === 'cancel') {
      patch.status = 'cancelled';
      if (r.hold) for (const pid of both) await db().add('outbox', { person: pid, op: 'delete', tag, done: false, created: now() });
    } else if (answer === 'remind') {
      patch.reminded = now();
      await notify(r.to, `Reminder from ${me}`, r.title, '#requests');
    } else if (answer === 'undo') {
      patch.status = 'waiting';
    }
    await db().update(`requests/${id}`, patch);
    db().ping();
  },

  async addEvent({ who, title, day, start, end, allDay, calKey, busyOnly }) {
    const st = store.state;
    const when = { day, start, end, allDay, label: '' };
    if (who === 'partner') {
      return actions.createRequest({ type: 'add', title, when: Object.assign(when, { label: whenLabel(when) }), hold: false });
    }
    const tag = `${who === 'both' ? 'both' : 'add'}:${uid()}`;
    const ev = { title: title.trim(), day, start, end, allDay: !!allDay, calKey: calKey || null, busyOnly: !!busyOnly };
    if (who === 'both') {
      for (const pid of [st.me, st.partner]) await db().add('outbox', { person: pid, op: 'create', tag, both: true, event: Object.assign({}, ev, { calKey: pid === st.me ? ev.calKey : null }), done: false, created: now() });
      await notify(st.partner, `${nameOf(st, st.me)} added something for you both`, `${ev.title} (${whenLabel(when)})`, '#calendar');
    } else {
      await db().add('outbox', { person: st.me, op: 'create', tag, event: ev, done: false, created: now() });
    }
    db().ping();
  },

  async setShift(pid, key, type) {
    const id = `${pid}_${key}`;
    if (!type) await db().del(`shifts/${id}`);
    else await db().set(`shifts/${id}`, { person: pid, day: key, type, by: store.state.me, updated: now() });
    const st = store.state;
    const other = pid === st.me ? st.partner : st.me;
    if (pid !== st.me && other) { /* changing your partner's shift: they'll just see it */ }
  },

  async saveNote(text) {
    const st = store.state;
    const until = sleepingUntil(st, st.partner);
    await db().add('notes', { from: st.me, to: st.partner, text: text.trim(), created: now(), showAfter: until ? until.getTime() : now(), seen: false });
    await notify(st.partner, `A note from ${nameOf(st, st.me)}`, text.trim(), '#today', 'notes');
    db().ping();
  },
  async noteSeen(id) {
    await db().update(`notes/${id}`, { seen: true, seenAt: now() });
  },

  async updateCalendar(key, patch) {
    await db().update(`calendars/${key}`, patch);
    await db().update('', { settingsRev: now() });
    db().ping();
  },
  async updateMySettings(patch) {
    const st = store.state;
    const cur = (st.people[st.me] && st.people[st.me].settings) || {};
    await db().update(`people/${st.me}`, { settings: Object.assign({}, cur, patch) });
    await db().update('', { settingsRev: now() });
  },
  async updatePersonSettings(pid, patch) {
    const st = store.state;
    const cur = (st.people[pid] && st.people[pid].settings) || {};
    await db().update(`people/${pid}`, { settings: Object.assign({}, cur, patch) });
    await db().update('', { settingsRev: now() });
  },
  async updateHousehold(patch) {
    await db().update('', patch);
  },
  async updatePerson(pid, patch) {
    await db().update(`people/${pid}`, patch);
  },
  syncNow() { return db().ping(true); },
  enableNotifications() { return db().enableNotifications(); },
  signIn() { return db().signIn(); },
  signOut() { return db().signOut(); },
  createHousehold(info) { return db().createHousehold(info); }
};

export function whenLabel(w) {
  if (!w || !w.day) return '';
  const d = fromDayKey(w.day);
  const base = `${relDayCap(d)}`;
  if (w.allDay) return `${base}, all day`;
  const [sh, sm] = (w.start || '19:00').split(':').map(Number);
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), sh, sm);
  if (!w.end) return `${base}, ${fmtT(s)}`;
  const [eh, em] = w.end.split(':').map(Number);
  const e = new Date(d.getFullYear(), d.getMonth(), d.getDate(), eh, em);
  return `${base}, ${fmtT(s)} to ${fmtT(e)}`;
}
function fmtT(d) {
  const h = d.getHours(); const m = d.getMinutes();
  const suf = h < 12 ? 'am' : 'pm'; const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, '0')}${suf}` : `${h12}${suf}`;
}
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function relDayCap(d) {
  const diff = Math.round((startOfDay(d) - startOfDay(new Date())) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
function evFromWhen(title, w, defaultStart = '19:00') {
  return { title, day: w.day, start: w.allDay ? null : (w.start || defaultStart), end: w.allDay ? null : (w.end || plusHour(w.start || defaultStart)), allDay: !!w.allDay };
}
function plusHour(hm) {
  const [h, m] = hm.split(':').map(Number);
  return `${String(Math.min(23, h + 1)).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export { DEFAULT_SETTINGS, dayKey };
