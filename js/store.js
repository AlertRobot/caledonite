// The app's state, built from whichever backend is running (Firebase, or the demo).
// Views read `store.state` and call `actions.*`. Every change re-renders.
// Each action saves everything it changes in one batch, so nothing is ever half saved.
import { dayKey, fromDayKey, uid, addDays, startOfDay } from './util.js';
import { clearDayCache, settingsOf, sleepingUntil, nameOf, DEFAULT_SETTINGS, reminderId, leaveDaysFor, nextJobDay } from './logic.js';
import './ops.js';

const Ops = (typeof self !== 'undefined' ? self : window).CaledoniteOps;
const listeners = new Set();
export const store = {
  backend: null,
  raw: null,
  linked: {},
  state: emptyState(),
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  emit() { for (const fn of listeners) fn(this.state); }
};

function emptyState() {
  return {
    rev: 0, phase: 'loading', error: null, demo: false,
    user: null, me: null, partner: null,
    people: {}, household: {}, calendars: {}, events: [], shifts: {}, requests: [], notes: [], outbox: [], status: {},
    jobs: [], ideas: [], tokens: null, linked: {}
  };
}

// Values that end up in class names or styles: only ever known words
const COLOURS = ['blue', 'orange', 'green', 'purple', 'pink', 'teal', 'red', 'grey'];
const LAYERS = ['own', 'family', 'friends', 'other'];
const ROLES = ['normal', 'work', 'rota'];
const SHARES = ['all', 'busy', 'none', 'hours'];
const pick = (v, list, d) => (list.includes(v) ? v : d);
const safeColour = (c) => (typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : '');

// Raw backend data -> tidy state
export function setRaw(raw, extra = {}) {
  store.raw = raw;
  const s = emptyState();
  Object.assign(s, extra);
  s.rev = (store.state.rev || 0) + 1;
  s.household = raw.household || {};
  s.people = {};
  let n = 0;
  for (const [pid, p] of Object.entries(raw.people || {})) {
    s.people[pid] = Object.assign({ id: pid }, p, { colour: pick(p.colour, COLOURS, n === 0 ? 'blue' : 'orange') });
    n++;
  }
  const email = (s.user && s.user.email || '').toLowerCase();
  if (s.demo) {
    s.me = extra.me;
  } else {
    s.me = Object.keys(s.people).find((pid) => (s.people[pid].email || '').toLowerCase() === email) || null;
  }
  s.partner = Object.keys(s.people).find((pid) => pid !== s.me) || null;
  s.calendars = {};
  for (const [k, c] of Object.entries(raw.calendars || {})) {
    const cal = Object.assign({ show: true, share: 'busy', role: 'normal', layer: 'own' }, c, { key: k });
    cal.layer = pick(cal.layer, LAYERS, 'other');
    cal.role = pick(cal.role, ROLES, 'normal');
    cal.share = pick(cal.share, SHARES, 'busy');
    cal.color = safeColour(cal.color);
    s.calendars[k] = cal;
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
      evs.push({
        owner: f.owner, calKey: f.calKey, id: e.id, title: e.t || '', start, end, allDay: !!e.ad, startKey: e.ad ? e.sd : null,
        busy: !!e.b, tag: e.tag || null, location: e.l || '', sid: e.sid || null, uid: e.uid || null, gid: e.gid || null, rid: e.rid || null
      });
    }
  }
  s.events = evs;
  s.shifts = {};
  for (const sh of Object.values(raw.shifts || {})) if (sh && sh.person && sh.day) s.shifts[`${sh.person}|${sh.day}`] = sh;
  s.requests = Object.entries(raw.requests || {}).map(([id, r]) => Object.assign({ id }, r)).sort((a, b) => (b.created || 0) - (a.created || 0));
  s.notes = Object.entries(raw.notes || {}).map(([id, x]) => Object.assign({ id }, x)).sort((a, b) => (b.created || 0) - (a.created || 0));
  s.outbox = Object.entries(raw.outbox || {}).map(([id, o]) => Object.assign({ id }, o)).filter((o) => !o.done);
  s.jobs = Object.entries(raw.jobs || {}).map(([id, j]) => Object.assign({ id }, j));
  s.ideas = Object.entries(raw.ideas || {}).map(([id, i]) => Object.assign({ id }, i)).sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  s.tokens = raw.tokens === undefined ? null : Object.keys(raw.tokens || {});
  s.status = raw.status || {};
  s.linked = store.linked || {};
  if (s.phase === 'ready' && !s.me) s.phase = 'not-member';
  store.state = s;
  clearDayCache();
  store.emit();
}

// Data from Peckish and Budgie on this phone (see linked.js)
export function setLinked(linked) {
  store.linked = linked || {};
  store.state = Object.assign({}, store.state, { linked: store.linked, rev: store.state.rev + 1 });
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
function myEmail() {
  const st = store.state;
  return ((st.people[st.me] && st.people[st.me].email) || (st.user && st.user.email) || '').toLowerCase();
}

// A notification to send. Quiet hours are handled when it's sent; sleep after a night shift here.
function notifyOp(to, title, body, link = '#today', kind = 'requests', extra = {}) {
  const st = store.state;
  if (!to) return null;
  const s = settingsOf(st, to);
  if (s.notif[kind] === false) return null;
  let sendAfter = now();
  if (s.notif.quiet) {
    const until = sleepingUntil(st, to);
    if (until) sendAfter = until.getTime();
  }
  return { type: 'add', path: 'notify', data: Object.assign({ to, kind, title, body, link, sendAfter, sent: false, created: now() }, extra) };
}
// The phone's time zone: times typed in the app are this phone's clock (on holiday abroad too)
export function phoneTz() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (e) { return null; }
}
function outboxOp(item) {
  return { type: 'add', path: 'outbox', data: Object.assign({ byEmail: myEmail(), done: false, created: now(), tz: phoneTz() }, item) };
}
async function commit(ops, ping = true) {
  await db().commit(ops.filter(Boolean));
  if (ping) db().ping();
}
function names() {
  const st = store.state;
  const out = {};
  for (const pid of Object.keys(st.people)) out[pid] = nameOf(st, pid);
  return out;
}

export const actions = {
  async createRequest({ type, title, when, hold, note, days, people }) {
    const st = store.state;
    const id = uid('r');
    const req = {
      from: st.me, to: st.partner, type, title: (title || '').trim(), when: when || null, hold: !!(hold && when && type !== 'heads' && type !== 'leave'),
      status: type === 'heads' ? 'sent' : 'waiting', note: note || '', created: now()
    };
    if (type === 'leave') { req.days = days || {}; req.people = people || [st.me, st.partner]; }
    const ops = [{ type: 'set', path: `requests/${id}`, data: req }];
    if (req.hold) {
      for (const pid of [st.me, st.partner]) ops.push(outboxOp({ person: pid, op: 'create', tag: `req:${id}`, both: true, event: Ops.evFromWhen(`Pencilled in: ${req.title}`, when) }));
    }
    const me = nameOf(st, st.me);
    const titles = {
      plan: `${me} wants to plan something`, favour: `${me} asked a favour`, free: `${me} asked you to keep some time free`,
      heads: `Heads up from ${me}`, add: `${me} added something for you`, leave: `${me} would like to book a holiday together`
    };
    const body = (req.title || 'Holiday') + (when ? ` (${when.label})` : '');
    ops.push(notifyOp(st.partner, titles[type] || `${me} asked you something`, body, '#requests', 'requests', type === 'heads' ? { reqId: id } : { reqId: id, ask: '1' }));
    await commit(ops);
    return id;
  },

  // Your own holiday, just you: no answer needed, it goes straight in your calendar
  async bookOwnLeave({ title, when, days }) {
    const st = store.state;
    const id = uid('r');
    const req = { from: st.me, to: st.partner, type: 'leave', title: (title || '').trim(), when, hold: false, status: 'yes', own: true, days: days || {}, people: [st.me], note: '', created: now(), answeredAt: now() };
    const ops = [{ type: 'set', path: `requests/${id}`, data: req }];
    ops.push(outboxOp({ person: st.me, op: 'create', tag: `req:${id}`, event: Ops.evFromWhen(Ops.eventTitle(req), when) }));
    ops.push(notifyOp(st.partner, `${nameOf(st, st.me)} booked a holiday`, `${req.title || 'Holiday'} (${when.label})`, '#requests'));
    await commit(ops);
  },

  async answerRequest(id, answer, extra = {}) {
    const st = store.state;
    const r = st.requests.find((x) => x.id === id);
    if (!r) return;
    const res = Ops.buildAnswer({ req: r, id, answer, me: st.me, byEmail: myEmail(), names: names(), when: extra.when, now: now(), tz: phoneTz() });
    const ops = [{ type: 'update', path: `requests/${id}`, data: res.patch }];
    for (const o of res.outbox) ops.push({ type: 'add', path: 'outbox', data: o });
    // a reminder to answer gets the same Yes and Can't buttons as the first notification
    const ask = answer === 'remind' && r.type !== 'heads' ? { reqId: id, ask: '1' } : {};
    if (res.notify) ops.push(notifyOp(res.notify.to, res.notify.title, res.notify.body, res.notify.link, res.notify.kind, ask));
    await commit(ops);
  },

  async addEvent({ who, title, day, endDay, start, end, allDay, calKey, busyOnly, repeat }) {
    const st = store.state;
    const when = { day, start, end, allDay, label: '' };
    if (who === 'partner') {
      return actions.createRequest({ type: 'add', title, when: Object.assign(when, { label: whenLabel(when) }), hold: false });
    }
    const tag = `${who === 'both' ? 'both' : 'add'}:${uid()}`;
    const ev = { title: title.trim(), day, start, end, allDay: !!allDay, calKey: calKey || null, busyOnly: !!busyOnly };
    if (endDay && endDay !== day) ev.endDay = endDay;
    if (repeat) ev.repeat = repeat;
    const ops = [];
    if (who === 'both') {
      for (const pid of [st.me, st.partner]) ops.push(outboxOp({ person: pid, op: 'create', tag, both: true, event: Object.assign({}, ev, { calKey: pid === st.me ? ev.calKey : null }) }));
      ops.push(notifyOp(st.partner, `${nameOf(st, st.me)} added something for you both`, `${ev.title} (${whenLabel(when)})`, '#calendar'));
    } else {
      ops.push(outboxOp({ person: st.me, op: 'create', tag, event: ev }));
    }
    await commit(ops);
    return tag;
  },

  // Change something already in Google Calendar. Things made in this app change by their tag,
  // in both calendars; your own other events by their Google id.
  async editEvent({ ev, changes, scope = 'one' }) {
    const st = store.state;
    const ops = [];
    if (ev.tag) {
      const parties = partiesOf(st, ev);
      for (const pid of parties) ops.push(outboxOp({ person: pid, op: 'update', tag: ev.tag, changes }));
      const other = parties.find((p) => p !== st.me);
      if (other) ops.push(notifyOp(other, `${nameOf(st, st.me)} changed something`, `${changes.title || ev.title}`, '#calendar'));
    } else {
      const cal = st.calendars[`${ev.owner}__${ev.calKey}`] || {};
      ops.push(outboxOp({ person: st.me, op: 'edit', account: cal.account || null, calId: cal.calId || null, gid: ev.gid, rid: ev.rid || null, scope, changes }));
    }
    await commit(ops);
  },
  async removeEvent({ ev, scope = 'one' }) {
    const st = store.state;
    const ops = [];
    if (ev.tag) {
      const parties = partiesOf(st, ev);
      for (const pid of parties) ops.push(outboxOp({ person: pid, op: 'delete', tag: ev.tag }));
      const other = parties.find((p) => p !== st.me);
      if (other) ops.push(notifyOp(other, `${nameOf(st, st.me)} removed something`, ev.title, '#calendar'));
      if (ev.tag.startsWith('req:')) ops.push({ type: 'update', path: `requests/${ev.tag.slice(4)}`, data: { status: 'cancelled', answeredAt: now() } });
    } else {
      const cal = st.calendars[`${ev.owner}__${ev.calKey}`] || {};
      ops.push(outboxOp({ person: st.me, op: 'remove', account: cal.account || null, calId: cal.calId || null, gid: ev.gid, rid: ev.rid || null, scope }));
    }
    await commit(ops);
  },

  async setShift(pid, key, type) {
    const id = `${pid}_${key}`;
    if (!type) await commit([{ type: 'delete', path: `shifts/${id}` }], false);
    else await commit([{ type: 'set', path: `shifts/${id}`, data: { person: pid, day: key, type, by: store.state.me, updated: now() } }], false);
  },

  async saveNote(text) {
    const st = store.state;
    const until = sleepingUntil(st, st.partner);
    await commit([
      { type: 'add', path: 'notes', data: { from: st.me, to: st.partner, text: text.trim(), created: now(), showAfter: until ? until.getTime() : now(), seen: false } },
      notifyOp(st.partner, `A note from ${nameOf(st, st.me)}`, text.trim(), '#today', 'notes')
    ]);
  },
  async noteSeen(id) {
    await commit([{ type: 'update', path: `notes/${id}`, data: { seen: true, seenAt: now() } }], false);
  },

  async updateCalendar(key, patch) {
    await commit([
      { type: 'update', path: `calendars/${key}`, data: Object.assign({ userSet: true }, patch) },
      { type: 'update', path: '', data: { settingsRev: now() } }
    ]);
  },
  async updateMySettings(patch) {
    const st = store.state;
    // only what changed: it merges into what's saved, so a change made on your other phone isn't undone
    await commit([
      { type: 'update', path: `people/${st.me}`, data: { settings: patch } },
      { type: 'update', path: '', data: { settingsRev: now() } }
    ], false);
  },
  async updatePersonSettings(pid, patch) {
    const st = store.state;
    if (pid === st.me) return actions.updateMySettings(patch);
    await commit([{ type: 'update', path: `people/${pid}`, data: { settings: patch } }], false);
  },
  async updateHousehold(patch) {
    await commit([{ type: 'update', path: '', data: patch }], false);
  },
  async updatePerson(pid, patch) {
    await commit([{ type: 'update', path: `people/${pid}`, data: patch }], false);
  },
  async setPartnerEmail(email) {
    const st = store.state;
    await commit([
      { type: 'update', path: `people/${st.partner}`, data: { email } },
      { type: 'update', path: '', data: { emails: [myEmail(), email] } }
    ], false);
  },
  async setLinkedAccounts(list) {
    await commit([{ type: 'update', path: `people/${store.state.me}`, data: { linked: list } }], false);
  },
  // First sign-in: mark yourself as joined; once you both have, the two emails are fixed
  async markJoined() {
    const st = store.state;
    if (!st.me || st.demo) return;
    const ops = [];
    if (!st.people[st.me].joined) ops.push({ type: 'update', path: `people/${st.me}`, data: { joined: true, joinedAt: now() } });
    const partnerJoined = st.partner && st.people[st.partner].joined;
    if (partnerJoined && !st.household.emailsLocked) ops.push({ type: 'update', path: '', data: { emailsLocked: true } });
    if (ops.length) await commit(ops, false);
  },

  // ----- reminders (on your own record) -----
  async setReminder({ ref, owner, title, times, note }) {
    const st = store.state;
    const id = reminderId(ref);
    const cur = ((st.people[st.me] || {}).reminders || {})[id] || {};
    const r = { ref, owner, title: title || cur.title || '', times: times ?? cur.times ?? [], note: note ?? cur.note ?? '', created: cur.created || now(), updated: now() };
    await commit([{ type: 'update', path: `people/${st.me}`, data: { reminders: { [id]: r } } }], false);
  },
  async removeReminder(ref) {
    await commit([{ type: 'unset', path: `people/${store.state.me}`, field: `reminders.${reminderId(ref)}` }], false);
  },
  async reminderDone(ref, occ, title) {
    const st = store.state;
    const id = reminderId(ref);
    const cur = ((st.people[st.me] || {}).reminders || {})[id];
    if (!cur) {
      // an automatic birthday reminder: keep a record so it stays ticked off
      const s = settingsOf(st, st.me);
      await commit([{ type: 'update', path: `people/${st.me}`, data: { reminders: { [id]: { ref, owner: st.me, title: title || '', times: s.autoRemind.birthdays || [], note: '', auto: true, created: now(), done: { [occ]: now() } } } } }], false);
      return;
    }
    await commit([{ type: 'update', path: `people/${st.me}`, data: { reminders: { [id]: { done: { [occ]: now() } } } } }], false);
  },

  // ----- countdowns (on your own record, shown to you both) -----
  async setCountdown({ id, title, date, ref, shared = true }) {
    const st = store.state;
    await commit([{ type: 'update', path: `people/${st.me}`, data: { countdowns: { [id]: { title, date, ref: ref || null, shared: !!shared, created: now() } } } }], false);
  },
  async removeCountdown(id) {
    await commit([{ type: 'unset', path: `people/${store.state.me}`, field: `countdowns.${id}` }], false);
  },

  // ----- jobs -----
  async addJob({ title, who, day, time, repeat }) {
    const st = store.state;
    const job = { title: title.trim(), who, day, time: time || null, repeat: repeat || null, remind: true, done: false, created: now(), by: st.me };
    const ops = [{ type: 'add', path: 'jobs', data: job }];
    const other = who === 'both' ? st.partner : (who !== st.me ? who : null);
    if (other) ops.push(notifyOp(other, who === 'both' ? `${nameOf(st, st.me)} added a job for you both` : `${nameOf(st, st.me)} added a job for you`, `${job.title} (${whenLabel({ day, allDay: true }).replace(', all day', '')})`, '#jobs', 'jobs'));
    await commit(ops, false);
  },
  async updateJob(id, patch) {
    await commit([{ type: 'update', path: `jobs/${id}`, data: patch }], false);
  },
  async jobDone(job) {
    const st = store.state;
    const patch = job.repeat ? { day: nextJobDay(job, dayKey(new Date())), lastDone: now(), lastDoneBy: st.me } : { done: true, doneAt: now(), lastDoneBy: st.me };
    await commit([{ type: 'update', path: `jobs/${job.id}`, data: patch }], false);
  },
  async jobUndo(job, prev) {
    await commit([{ type: 'update', path: `jobs/${job.id}`, data: prev }], false);
  },
  async deleteJob(id) {
    await commit([{ type: 'delete', path: `jobs/${id}` }], false);
  },

  // ----- ideas jar -----
  async seedIdeas(list) {
    const ops = list.map((i) => ({ type: 'set', path: `ideas/${i.id}`, data: Object.assign({ used: 0, created: now(), seeded: true }, i, { id: null }) }));
    for (const o of ops) delete o.data.id;
    await commit(ops, false);
  },
  async addIdea({ title, cost, where }) {
    await commit([{ type: 'add', path: 'ideas', data: { title: title.trim(), cost: Number(cost) || 0, where: where || 'out', used: 0, created: now(), by: store.state.me } }], false);
  },
  async updateIdea(id, patch) {
    await commit([{ type: 'update', path: `ideas/${id}`, data: patch }], false);
  },
  async deleteIdea(id) {
    await commit([{ type: 'delete', path: `ideas/${id}` }], false);
  },

  async testPush() {
    const st = store.state;
    await commit([{ type: 'add', path: 'notify', data: { to: st.me, kind: 'test', title: 'Caledonite test', body: 'Notifications are working on this phone.', link: '#settings/notifications', sendAfter: now(), sent: false, created: now() } }]);
  },
  syncNow() { return db().ping(true); },
  enableNotifications() { return db().enableNotifications(); },
  signIn() { return db().signIn(); },
  signOut() { return db().signOut(); },
  createHousehold(info) { return db().createHousehold(info); }
};

// First-time setup: the household and both of your records, saved together
export function setupOps(email, { myName, myShifts, partnerName, partnerEmail, partnerShifts }) {
  const myEmail = String(email || '').toLowerCase();
  const slug = (n, fallback) => (n || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20) || fallback;
  const a = slug(myName, 'me');
  let b = slug(partnerName, 'partner');
  if (a === b) b = b + '2';
  const settingsFor = (shifts) => shifts
    ? { workLabel: 'Working', workDays: [], hasShifts: true, sleepUntil: '14:00', travelMins: 30 }
    : { workLabel: 'Working', workStart: '09:00', workEnd: '18:00', workDays: [1, 2, 3, 4, 5], hasShifts: false };
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(18))).map((x) => x.toString(16).padStart(2, '0')).join('');
  const pe = String(partnerEmail || '').toLowerCase().trim();
  const emails = [myEmail, pe].filter((x, i, all) => x && all.indexOf(x) === i);
  return [
    { type: 'set', path: '', data: {
      emails, created: now(), dinnerTime: '19:00', moveDinner: true, pencilDefault: true, nudgeHours: 24,
      favours: ['Put the bins out', 'Pick up some shopping', 'Give me a lift', 'Book a table somewhere'],
      pingSecret: secret, pingUrl: '', settingsRev: now()
    } },
    { type: 'set', path: `people/${a}`, data: { name: String(myName || '').trim(), email: myEmail, colour: 'blue', joined: true, settings: settingsFor(myShifts) } },
    { type: 'set', path: `people/${b}`, data: { name: String(partnerName || '').trim(), email: emails[1] || '', colour: 'orange', settings: settingsFor(partnerShifts) } }
  ];
}

// Who has a copy of something made in this app
function partiesOf(st, ev) {
  const owners = new Set(st.events.filter((e) => e.tag === ev.tag).map((e) => e.owner));
  if (ev.tag.startsWith('both:') || owners.size > 1) return [st.me, st.partner].filter(Boolean);
  if (ev.tag.startsWith('req:')) {
    const r = st.requests.find((x) => `req:${x.id}` === ev.tag);
    if (r && r.type !== 'favour' && r.type !== 'add' && !(r.people && r.people.length === 1)) return [st.me, st.partner].filter(Boolean);
  }
  return [ev.owner || st.me];
}

export function whenLabel(w) {
  if (!w || !w.day) return '';
  const d = fromDayKey(w.day);
  const base = `${relDayCap(d)}`;
  if (w.endDay && w.endDay !== w.day) return `${base} to ${relDayCap(fromDayKey(w.endDay))}`;
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

export { DEFAULT_SETTINGS, dayKey, leaveDaysFor };
