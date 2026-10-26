// Demo mode: sample data held in memory, so the app can be tried without signing in.
// It behaves like the real thing, including a pretend calendar sync.
import { dayKey, addDays, startOfDay, atTime, isoWeekday, uid } from './util.js';
import { setRaw, setPhase, whenLabel } from './store.js';
import { DEFAULT_SHIFT_TYPES, reminderId } from './logic.js';

export function createDemoBackend(me = 'ethan') {
  const T = startOfDay(new Date());
  const k = (n) => dayKey(addDays(T, n));
  const evs = [];
  let n = 0;
  const add = (owner, calKey, title, dayOffset, start, end, extra = {}) => {
    const key = k(dayOffset);
    if (start === null) {
      evs.push(Object.assign({ owner, calKey, id: `d${n++}`, t: title, ad: 1, sd: key, ed: k(dayOffset + 1) }, extra));
      return;
    }
    const s = atTime(key, start);
    let e = atTime(key, end);
    if (e <= s) e = addDays(e, 1);
    evs.push(Object.assign({ owner, calKey, id: `d${n++}`, t: title, s: s.getTime(), e: e.getTime() }, extra));
  };

  // Sophie's rota: a two-week pattern, lined up so today is the day after a night shift
  const cycle = ['night', 'night', 'off', 'long', 'off', 'long', 'off', 'off', 'long', 'off', 'early', 'late', 'off', 'off'];
  for (let i = -10; i <= 45; i++) {
    const type = cycle[((i + 1) % 14 + 14) % 14];
    if (type === 'off') continue;
    const t = DEFAULT_SHIFT_TYPES[type];
    add('sophie', 'rota', t.label === 'Night' ? 'Night' : t.label, i, t.start, t.end);
  }
  // Ethan's work meetings (only he sees the names)
  for (let i = -10; i <= 45; i++) {
    const wd = isoWeekday(addDays(T, i));
    if (wd > 5) continue;
    add('ethan', 'work', 'Team stand-up', i, '09:30', '09:45');
    if (wd === 2 || wd === 4) add('ethan', 'work', 'Integration review', i, '14:00', '15:00');
    if (wd === 1) add('ethan', 'work', 'Sprint planning', i, '11:00', '12:00');
  }
  // Ethan's own things
  const nextWd = (wd, after = 0) => { for (let i = after; i < after + 8; i++) if (isoWeekday(addDays(T, i)) === wd) return i; return after; };
  add('ethan', 'primary', 'Pub quiz', nextWd(3, 1), '20:00', '22:30');
  add('ethan', 'primary', 'Pub quiz', nextWd(3, 15), '20:00', '22:30');
  add('ethan', 'primary', 'Dentist', 2, '16:30', '17:15', { l: 'Shirley Dental' });
  add('ethan', 'primary', 'Haircut', nextWd(6, 1), '11:00', '11:45');
  add('ethan', 'second', 'Band practice', nextWd(4, 7), '19:30', '21:30');
  add('ethan', 'family', 'Sunday lunch', nextWd(7, 1), '13:00', '16:00');
  add('ethan', 'family', 'Christmas market', nextWd(6, 22), '11:00', '15:00');
  add('ethan', 'family', "Gran's birthday", nextWd(5, 9), null, null, { sid: 'granbday' });
  add('ethan', 'family', "Dad's birthday", 5, null, null, { sid: 'dadbday' });
  // Sophie's own things
  add('sophie', 'primary', 'Hair appointment', 4, '10:00', '11:00');
  add('sophie', 'friends', "Girls' night", nextWd(5, 9), '19:00', '23:00');
  add('sophie', 'friends', 'Book club', nextWd(2, 7), '19:30', '21:00');
  add('sophie', 'family', 'Mum visiting', nextWd(6, 15), null, null);
  // Things together (from earlier requests)
  const dateDay = nextWd(5, 1);
  add('ethan', 'primary', 'Date night: pizza and a film', dateDay, '19:00', '22:30', { tag: 'req:r_date' });
  add('sophie', 'primary', 'Date night: pizza and a film', dateDay, '19:00', '22:30', { tag: 'req:r_date' });
  const keepDay = nextWd(6, 8);
  add('ethan', 'primary', 'Pencilled in: Keep the day free for me', keepDay, null, null, { tag: 'req:r_keep' });
  add('sophie', 'primary', 'Pencilled in: Keep the day free for me', keepDay, null, null, { tag: 'req:r_keep' });

  const raw = {
    household: {
      dinnerTime: '19:00', moveDinner: true, pencilDefault: true, nudgeHours: 24,
      favours: ['Put the bins out', 'Pick up some shopping', 'Give me a lift', 'Book a table somewhere'],
      linked: []
    },
    people: {
      ethan: {
        name: 'Ethan', email: 'ethan@example.com', colour: 'blue',
        settings: { workLabel: 'Working from home', workStart: '09:00', workEnd: '18:00', workDays: [1, 2, 3, 4, 5], hasShifts: false, altOff: { day: 5, from: k(nextWd(5, 0)) }, autoRemind: { birthdays: ['d0'] } },
        reminders: {
          [reminderId('e:ethan:family:dadbday')]: { ref: 'e:ethan:family:dadbday', owner: 'ethan', title: "Dad's birthday", times: ['w1', 'd0'], note: 'Buy a card and a present', created: Date.now() }
        }
      },
      sophie: { name: 'Sophie', email: 'sophie@example.com', colour: 'orange', settings: { workLabel: 'Working', workDays: [], hasShifts: true, sleepUntil: '14:00', travelMins: 30 } }
    },
    calendars: {
      ethan__primary: { owner: 'ethan', calKey: 'primary', name: 'Personal', account: 'Personal Gmail', color: '#2456C7', primary: true, canWrite: true, show: true, share: 'all', role: 'normal', layer: 'own' },
      ethan__family: { owner: 'ethan', calKey: 'family', name: 'Family', account: 'Personal Gmail', color: '#C2549B', canWrite: false, show: true, share: 'all', role: 'normal', layer: 'family' },
      ethan__birthdays: { owner: 'ethan', calKey: 'birthdays', name: 'Birthdays', account: 'Personal Gmail', color: '#5B8DEF', canWrite: false, show: false, share: 'none', role: 'normal', layer: 'own' },
      ethan__second: { owner: 'ethan', calKey: 'second', name: 'Main calendar', account: 'Second Gmail', color: '#3F7FB5', canWrite: true, show: true, share: 'busy', role: 'normal', layer: 'own' },
      ethan__work: { owner: 'ethan', calKey: 'work', name: 'Work', account: 'Work email', color: '#1E3A8A', canWrite: true, show: true, share: 'hours', role: 'work', layer: 'own' },
      sophie__primary: { owner: 'sophie', calKey: 'primary', name: 'Personal', account: 'Google', color: '#F08A3C', primary: true, canWrite: true, show: true, share: 'all', role: 'normal', layer: 'own' },
      sophie__rota: { owner: 'sophie', calKey: 'rota', name: 'Work rota', account: 'Rota link', color: '#F08A3C', canWrite: false, show: true, share: 'all', role: 'rota', layer: 'own' },
      sophie__friends: { owner: 'sophie', calKey: 'friends', name: 'Friends', account: 'Google', color: '#0F8B8D', canWrite: false, show: true, share: 'all', role: 'normal', layer: 'friends' },
      sophie__family: { owner: 'sophie', calKey: 'family', name: 'Family', account: 'Google', color: '#C2549B', canWrite: false, show: true, share: 'busy', role: 'normal', layer: 'family' }
    },
    feeds: [],
    shifts: {},
    requests: {
      r_ikea: { from: 'sophie', to: 'ethan', type: 'plan', title: 'IKEA for the hallway shelves?', when: { day: k(nextWd(7, 1)), start: '10:00', end: '12:00', allDay: false, label: '' }, hold: false, status: 'waiting', created: Date.now() - 9 * 3600000 },
      r_bins: { from: 'sophie', to: 'ethan', type: 'favour', title: "Can you put the bins out? I'm on a long day.", when: { day: k(2), start: '19:00', end: '19:15', allDay: false, label: '' }, hold: false, status: 'waiting', created: Date.now() - 20 * 3600000 },
      r_heads: { from: 'sophie', to: 'ethan', type: 'heads', title: "I might finish late on my next long day. I'll text when I leave.", when: null, hold: false, status: 'sent', created: Date.now() - 22 * 3600000 },
      r_date: { from: 'ethan', to: 'sophie', type: 'plan', title: 'Date night: pizza and a film', when: { day: k(dateDay), start: '19:00', end: '22:30', allDay: false, label: '' }, hold: false, status: 'yes', created: Date.now() - 3 * 86400000 },
      r_keep: { from: 'ethan', to: 'sophie', type: 'free', title: 'Keep the day free for me', when: { day: k(keepDay), start: null, end: null, allDay: true, label: '' }, hold: true, status: 'waiting', created: Date.now() - 4 * 3600000 }
    },
    notes: {},
    outbox: {},
    jobs: {
      j_bins: { title: 'Put the bins out', who: 'ethan', day: k(nextWd(1, 0)), repeat: { unit: 'week', every: 1 }, remind: true, done: false, created: Date.now() },
      j_shop: { title: 'Food shop', who: 'both', day: k(nextWd(6, 0)), time: '10:00', repeat: { unit: 'week', every: 1 }, remind: true, done: false, created: Date.now() },
      j_hoover: { title: 'Hoover the flat', who: 'sophie', day: k(0), repeat: { unit: 'week', every: 2 }, remind: true, done: false, created: Date.now() }
    },
    ideas: {},
    tokens: {},
    status: {
      a1: { person: 'ethan', account: 'Personal Gmail', lastRun: Date.now() - 120000, ok: true },
      a2: { person: 'ethan', account: 'Second Gmail', lastRun: Date.now() - 300000, ok: true },
      a3: { person: 'ethan', account: 'Work email', lastRun: Date.now() - 240000, ok: true },
      a4: { person: 'sophie', account: 'Google', lastRun: Date.now() - 360000, ok: true }
    }
  };
  // fill in labels for the sample requests
  for (const r of Object.values(raw.requests)) if (r.when) r.when.label = whenLabel(r.when);

  // The calendar sync's privacy filter, in miniature
  function feedsFor(meId) {
    const groups = {};
    for (const e of evs) (groups[`${e.owner}__${e.calKey}`] = groups[`${e.owner}__${e.calKey}`] || []).push(e);
    const feeds = [];
    for (const [key, list] of Object.entries(groups)) {
      const cal = raw.calendars[key];
      const owner = list[0].owner;
      const calKey = list[0].calKey;
      if (owner === meId) { feeds.push({ owner, calKey, private: true, events: list.map((e) => Object.assign({ gid: e.id, uid: e.sid || e.id }, e)) }); continue; }
      if (!cal || cal.share === 'none') continue;
      if (cal.share === 'all') { feeds.push({ owner, calKey, private: false, events: list }); continue; }
      if (cal.share === 'busy') { feeds.push({ owner, calKey, private: false, events: list.map((e) => Object.assign({}, e, { t: 'Busy', b: 1, l: '' })) }); continue; }
      if (cal.share === 'hours') {
        const byDay = {};
        for (const e of list) {
          if (e.ad) continue;
          const key2 = dayKey(new Date(e.s));
          const d = byDay[key2] = byDay[key2] || { s: e.s, e: e.e };
          d.s = Math.min(d.s, e.s); d.e = Math.max(d.e, e.e);
        }
        feeds.push({ owner, calKey, private: false, events: Object.entries(byDay).map(([dk, v]) => ({ id: `w${dk}`, t: 'Working', s: v.s, e: v.e })) });
      }
    }
    return feeds;
  }

  function publish() {
    raw.feeds = feedsFor(me);
    setRaw(raw, { phase: 'ready', demo: true, me, user: { email: raw.people[me].email, name: raw.people[me].name } });
  }

  // pretend calendar sync: process the outbox
  function runSync() {
    let changed = false;
    for (const [id, o] of Object.entries(raw.outbox)) {
      if (o.done) continue;
      const cal = 'primary';
      if (o.op === 'create') {
        const ev = o.event;
        const day = ev.day;
        const off = Math.round((new Date(day + 'T00:00') - T) / 86400000); // whole days from today (noon would round up a day)
        add(o.person, ev.calKey || cal, ev.title, off, ev.allDay ? null : ev.start, ev.allDay ? null : ev.end, { tag: o.tag, b: ev.busyOnly ? 1 : 0 });
      } else if (o.op === 'update' || o.op === 'edit') {
        const ch = o.changes || o.event || {};
        for (const e of evs) {
          const hit = o.op === 'update' ? (e.owner === o.person && e.tag === o.tag) : (e.owner === o.person && e.id === o.gid);
          if (!hit) continue;
          if (ch.title) e.t = ch.title;
          if (ch.day && !e.ad) {
            const len = e.e - e.s;
            const s0 = atTime(ch.day, ch.start || new Date(e.s).toTimeString().slice(0, 5));
            e.s = s0.getTime(); e.e = ch.end ? atTime(ch.endDay || ch.day, ch.end).getTime() : e.s + len;
          }
        }
      } else if (o.op === 'delete' || o.op === 'remove') {
        for (let i = evs.length - 1; i >= 0; i--) {
          const e = evs[i];
          if (o.op === 'delete' ? (e.owner === o.person && e.tag === o.tag) : (e.owner === o.person && e.id === o.gid)) evs.splice(i, 1);
        }
      }
      o.done = true; changed = true;
    }
    for (const s of Object.values(raw.status)) if (s.person === me) s.lastRun = Date.now();
    if (changed) publish();
  }

  function at(path) {
    if (path === '') return { obj: raw, key: 'household' };
    const [coll, id] = path.split('/');
    raw[coll] = raw[coll] || {};
    return { obj: raw[coll], key: id };
  }

  const backend = {
    demo: true,
    async init() { publish(); },
    async set(path, data) { const { obj, key } = at(path); obj[key] = JSON.parse(JSON.stringify(data)); publish(); },
    async update(path, patch) { const { obj, key } = at(path); obj[key] = deepMerge(obj[key] || {}, JSON.parse(JSON.stringify(patch))); publish(); },
    async unset(path, field) {
      const { obj, key } = at(path);
      const parts = field.split('.');
      let o = obj[key];
      for (let i = 0; o && i < parts.length - 1; i++) o = o[parts[i]];
      if (o) delete o[parts[parts.length - 1]];
      publish();
    },
    async add(coll, data) { const id = uid(); raw[coll] = raw[coll] || {}; raw[coll][id] = JSON.parse(JSON.stringify(data)); publish(); return id; },
    async del(path) { const { obj, key } = at(path); delete obj[key]; publish(); },
    async commit(ops) {
      for (const o of ops) {
        if (o.type === 'set') { const { obj, key } = at(o.path); obj[key] = JSON.parse(JSON.stringify(o.data)); }
        else if (o.type === 'update') { const { obj, key } = at(o.path); obj[key] = deepMerge(obj[key] || {}, JSON.parse(JSON.stringify(o.data))); }
        else if (o.type === 'add') { raw[o.path] = raw[o.path] || {}; raw[o.path][uid()] = JSON.parse(JSON.stringify(o.data)); }
        else if (o.type === 'delete') { const { obj, key } = at(o.path); delete obj[key]; }
        else if (o.type === 'unset') {
          const { obj, key } = at(o.path);
          const parts = o.field.split('.');
          let x = obj[key];
          for (let i = 0; x && i < parts.length - 1; i++) x = x[parts[i]];
          if (x) delete x[parts[parts.length - 1]];
        }
      }
      publish();
    },
    ping() { setTimeout(runSync, 700); return Promise.resolve(true); },
    async enableNotifications() { return { ok: false, reason: 'demo' }; },
    async signIn() {},
    async signOut() { location.href = location.pathname; },
    async createHousehold() {}
  };
  setPhase('loading');
  return backend;
}
// Firestore's merge: maps merge, everything else is replaced
function deepMerge(a, b) {
  const out = Object.assign({}, a);
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k]) ? deepMerge(a[k], v) : v;
  }
  return out;
}

// Sample Peckish dinners and Budgie paydays for the demo
export function demoLinked() {
  const T = startOfDay(new Date());
  const k = (n) => dayKey(addDays(T, n));
  const meals = ['Chicken fajitas', 'Mushroom risotto', 'Smash burgers', 'Thai green curry', 'Sausage and mash', 'Salmon traybake', 'Pizza night'];
  const days = {};
  for (let i = -1; i < 8; i++) days[k(i)] = { title: meals[(i + 7) % 7], time: 30, takeaway: i === 4 };
  let payday = 0;
  for (let i = 0; i < 40; i++) { const d = addDays(T, i); if (d.getDay() === 5 && addDays(d, 7).getMonth() !== d.getMonth()) { payday = i; break; } }
  const money = {};
  money[k(payday)] = [{ name: 'Payday', sub: '', pay: true }];
  money[k(3)] = [{ name: 'Phone', sub: 'Bill, £18', pay: false }];
  return { peckish: { found: true, days }, budgie: { found: true, days: money, fun: { left: 64.5, names: ['Fun'], until: k(payday) } } };
}
