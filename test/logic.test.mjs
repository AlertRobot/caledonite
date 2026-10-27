// Checks of the app's own logic (no browser): node --test test/logic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.self = globalThis; // js/ops.js is a plain script that hangs itself on `self`
const { setRaw, store, whenLabel, actions } = await import('../js/store.js');
const L = await import('../js/logic.js');
const { dayKey, addDays, atTime, startOfDay } = await import('../js/util.js');
await import('../js/ops.js');
const Ops = globalThis.CaledoniteOps;

const T = startOfDay(new Date());
const k = (n) => dayKey(addDays(T, n));
// Ethan works 9 to 6 on weekdays; Sophie works shifts. Dinner at 7.
function load({ events = [], outbox = {}, requests = {}, ethan = {}, sophie = {} } = {}) {
  const feeds = {};
  for (const e of events) (feeds[`${e.owner}|${e.calKey}`] = feeds[`${e.owner}|${e.calKey}`] || { owner: e.owner, calKey: e.calKey, private: e.owner === 'ethan', events: [] }).events.push(e);
  setRaw({
    household: { dinnerTime: '19:00', moveDinner: true },
    people: {
      ethan: { name: 'Ethan', email: 'e@x.com', settings: Object.assign({ workStart: '09:00', workEnd: '18:00', workDays: [1, 2, 3, 4, 5], hasShifts: false }, ethan) },
      sophie: { name: 'Sophie', email: 's@x.com', settings: Object.assign({ workDays: [], hasShifts: true, travelMins: 30 }, sophie) }
    },
    calendars: {
      ethan__primary: { owner: 'ethan', calKey: 'primary', name: 'Personal', share: 'all', primary: true, canWrite: true },
      sophie__primary: { owner: 'sophie', calKey: 'primary', name: 'Personal', share: 'all' },
      sophie__rota: { owner: 'sophie', calKey: 'rota', name: 'Rota', share: 'all', role: 'rota' }
    },
    feeds: Object.values(feeds), shifts: {}, requests, notes: {}, outbox, jobs: {}, ideas: {}, status: {}
  }, { phase: 'ready', demo: true, me: 'ethan', user: { email: 'e@x.com', name: 'Ethan' } });
  return store.state;
}
const timed = (owner, calKey, day, s, e, extra = {}) => Object.assign({ owner, calKey, id: `${owner}${day}${s}`, t: 'Thing', s: atTime(day, s).getTime(), e: atTime(day, e).getTime() }, extra);
const freeAt = (st, day, hm) => L.buildDay(st, day).bothFree.some(([a, b]) => a <= atTime(day, hm).getTime() && b > atTime(day, hm).getTime());
// a Saturday a week or two ahead, so work and "from now" don't get in the way
const sat = (() => { for (let i = 7; i < 14; i++) if (addDays(T, i).getDay() === 6) return k(i); })();

test('an event added in the app (tagged) makes that person busy', () => {
  let st = load();
  assert.equal(freeAt(st, sat, '15:00'), true, 'both free on an empty Saturday afternoon');
  st = load({ events: [timed('ethan', 'primary', sat, '14:00', '17:00', { tag: 'add:abc', t: 'Dentist' })] });
  assert.equal(freeAt(st, sat, '15:00'), false, 'Ethan is at the dentist');
  assert.ok(L.dayList(st, sat).some((it) => it.title === 'Dentist'));
});

test('something just added, still waiting to sync, makes that person busy too', () => {
  const st = load({ outbox: { o1: { person: 'ethan', op: 'create', tag: 'add:xyz', done: false, event: { title: 'Gym', day: sat, start: '18:30', end: '20:00', allDay: false } } } });
  assert.equal(freeAt(st, sat, '19:00'), false);
  const din = L.buildDay(st, sat).together.find((t) => t.auto);
  assert.ok(!din || !(din.start <= atTime(sat, '19:00') && din.end > atTime(sat, '19:00')), 'no dinner together while Ethan is at the gym');
});

test('a favour Ethan said yes to (not synced yet) makes him busy', () => {
  const st = load({ requests: { r1: { from: 'sophie', to: 'ethan', type: 'favour', title: 'Pick up a parcel', when: { day: sat, start: '11:00', end: '12:00', allDay: false }, status: 'yes', created: Date.now() } } });
  assert.equal(freeAt(st, sat, '11:30'), false);
});

test('a week of leave on the rota counts on every day, not just the first', () => {
  const st = load({ events: [{ owner: 'sophie', calKey: 'rota', id: 'al', t: 'Annual leave', ad: 1, sd: k(8), ed: k(13) }] });
  for (let i = 8; i < 13; i++) assert.equal((L.shiftFor(st, 'sophie', k(i)) || {}).type, 'leave', `day ${i}`);
  assert.equal(L.shiftFor(st, 'sophie', k(13)), null, 'the end date is the day after');
});

test('a night shift: busy overnight, then asleep until the set time', () => {
  const st = load({ events: [timed('sophie', 'rota', k(8), '19:30', '19:30', { t: 'Night', e: atTime(k(9), '08:00').getTime() })], sophie: { sleepUntil: '14:00' } });
  const next = L.buildDay(st, k(9));
  assert.ok(next.persons.sophie.sleep, 'sleeping the morning after');
  assert.equal(next.persons.sophie.sleep.end.getHours(), 14);
  assert.equal(freeAt(st, k(9), '11:00'), false);
});

test('monthly jobs keep their day of the month', () => {
  const job = { day: '2027-01-31', repeat: { unit: 'month', every: 1 } };
  assert.equal(L.nextJobDay(job, '2027-01-31'), '2027-02-28');
  assert.equal(L.nextJobDay({ day: '2027-03-15', repeat: { unit: 'month', every: 1 } }, '2027-03-15'), '2027-04-15');
  assert.equal(L.nextJobDay({ day: '2027-03-01', repeat: { unit: 'week', every: 2 } }, '2027-03-01'), '2027-03-15');
});

test('an hour later never wraps round or equals the start', () => {
  assert.equal(Ops.plusHour('19:00'), '20:00');
  assert.equal(Ops.plusHour('19:45'), '20:45');
  assert.equal(Ops.plusHour('23:30'), '23:59');
  const ev = Ops.evFromWhen('Late one', { day: sat, start: '23:15', allDay: false });
  assert.ok(ev.end > ev.start);
});

test('answering carries the phone time zone to the calendar sync', () => {
  const r = { from: 'sophie', to: 'ethan', type: 'plan', title: 'Cinema', when: { day: sat, start: '19:00', end: '21:00', allDay: false }, status: 'waiting' };
  const res = Ops.buildAnswer({ req: r, id: 'r1', answer: 'yes', me: 'ethan', byEmail: 'e@x.com', names: { ethan: 'Ethan', sophie: 'Sophie' }, tz: 'Europe/Madrid' });
  assert.equal(res.outbox.length, 2);
  assert.ok(res.outbox.every((o) => o.tz === 'Europe/Madrid' && o.op === 'create'));
});

test('labels say Today and Tomorrow relative to now, so saved ones must not be shown later', () => {
  assert.match(whenLabel({ day: k(1), start: '19:00', end: '21:00' }), /^Tomorrow, 7pm to 9pm$/);
  assert.doesNotMatch(whenLabel({ day: k(-2), start: '19:00' }), /Tomorrow|Today/);
});

test('adding an event saves the phone time zone with it', async () => {
  load();
  const seen = [];
  store.backend = { commit: async (ops) => { seen.push(...ops); }, ping() {} };
  await actions.addEvent({ who: 'me', title: 'Dentist', day: sat, start: '10:00', end: '11:00', allDay: false });
  const o = seen.find((x) => x.path === 'outbox');
  assert.ok(o && o.data.tz, 'has a time zone');
  assert.equal(o.data.byEmail, 'e@x.com');
});

// ---------- the service worker, run outside a browser with a stand-in for its surroundings ----------
async function loadSw({ cacheKeys = [], fetchRes = null, fetchFails = false, own = {}, other = {}, windows = [], opened = [], shown = [], extra = {} } = {}) {
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  const handlers = {}; const deleted = []; const puts = [];
  const cacheObj = { match: async (req) => own[String(req.url || req)], put: async (req) => { puts.push(String(req.url || req)); }, add: async () => {}, addAll: async () => {} };
  const sandbox = {
    URL, Promise, console, Request: class { constructor(u) { this.url = u; } },
    caches: { keys: async () => cacheKeys, delete: async (k) => { deleted.push(k); return true; }, open: async () => cacheObj, match: async (req) => other[String(req.url || req)] },
    Response: { error: () => 'network error' },
    fetch: async () => { if (fetchFails) throw new TypeError('offline'); return fetchRes; }, location: { origin: 'https://alertrobot.github.io' }
  };
  Object.assign(sandbox, extra);
  sandbox.self = Object.assign(sandbox, { addEventListener: (n, fn) => { handlers[n] = fn; }, clients: { claim: async () => {}, matchAll: async () => windows, openWindow: async (u) => { opened.push(u); return null; } }, skipWaiting: () => {}, registration: { scope: 'https://alertrobot.github.io/caledonite/', showNotification: async (t, o) => { shown.push([t, o]); } } });
  sandbox.importScripts = (p) => vm.runInContext(readFileSync(new URL(`../${p.replace('./', '')}`, import.meta.url), 'utf8'), ctx);
  const ctx = vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../sw.js', import.meta.url), 'utf8'), ctx);
  return { handlers, deleted, puts };
}

test('the service worker clears only its own old copies, never Peckish’s on the same website', async () => {
  const { handlers, deleted } = await loadSw({ cacheKeys: ['caledonite-v1', 'caledonite-sdk-11.0.0', 'peckish-v7', 'esk-shell', 'workbox-precache-v2'] });
  let p; handlers.activate({ waitUntil: (x) => { p = x; } });
  await p;
  assert.deepEqual(deleted.sort(), ['caledonite-sdk-11.0.0', 'caledonite-v1']);
});

test('the service worker never keeps a failed download of the Firebase library', async () => {
  const bad = { ok: false, status: 404, clone() { return this; } };
  const { handlers, puts } = await loadSw({ fetchRes: bad });
  let p; handlers.fetch({ request: { method: 'GET', url: 'https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js' }, respondWith: (x) => { p = x; } });
  assert.equal(await p, bad);
  assert.deepEqual(puts, []);
});

// what Firestore's REST API hands the service worker for a document
const restDoc = (o) => ({ fields: Object.fromEntries(Object.entries(o).map(([key, v]) => [key, v === null ? { nullValue: null } : typeof v === 'number' ? { integerValue: String(v) } : typeof v === 'object' ? restDoc(v).fields && { mapValue: restDoc(v) } : { stringValue: v }])) });
test("a notification's Yes on a request whose time went by while it waited adds nothing", async () => {
  const past = dayKey(addDays(T, -2));
  const answerWith = async (req, action = 'yes') => {
    const calls = []; const shown = [];
    const idb = { open: () => { const r = { result: { close() {}, transaction: () => ({ objectStore: () => ({ get: () => { const q = {}; setTimeout(() => { q.result = { value: { email: 'e@x.com', stsTokenManager: { accessToken: 't', expirationTime: Date.now() + 3600e3 } } }; q.onsuccess(); }); return q; } }) }) } }; setTimeout(() => r.onsuccess()); return r; } };
    const fetch = async (url, o = {}) => {
      calls.push([o.method || 'GET', String(url)]);
      const body = /requests\/r1$/.test(url) ? restDoc(req) : /people/.test(url) ? { documents: [{ name: 'x/people/ethan', ...restDoc({ email: 'e@x.com', name: 'Ethan' }) }, { name: 'x/people/sophie', ...restDoc({ email: 's@x.com', name: 'Sophie' }) }] } : {};
      return { ok: true, json: async () => body };
    };
    const { handlers } = await loadSw({ shown, extra: { indexedDB: idb, fetch, crypto: globalThis.crypto, Intl } });
    let p; handlers.notificationclick({ action, notification: { data: { reqId: 'r1' }, close() {} }, waitUntil: (x) => { p = x; } });
    await p;
    return { saved: calls.some(([m, u]) => m === 'POST' && /:commit$/.test(u)), text: shown.map(([, o]) => o.body).join(' ') };
  };
  const req = { from: 'sophie', to: 'ethan', type: 'plan', title: 'IKEA', status: 'waiting', hold: 0, created: 1, when: { day: past, start: '10:00', end: '12:00' } };
  let r = await answerWith(req);
  assert.equal(r.saved, false);
  assert.match(r.text, /passed/);
  // still in time: answered as before
  r = await answerWith(Object.assign({}, req, { when: { day: dayKey(addDays(T, 2)), start: '10:00', end: '12:00' } }));
  assert.equal(r.saved, true);
  assert.match(r.text, /You said yes/);
  // called off meanwhile: said so, not "you already answered"
  r = await answerWith(Object.assign({}, req, { status: 'cancelled' }));
  assert.equal(r.saved, false);
  assert.match(r.text, /called off/);
});

test("a request whose time went by while it waited isn't waiting for an answer any more", () => {
  const past = dayKey(addDays(T, -1));
  const st = load({ requests: {
    old: { from: 'sophie', to: 'ethan', type: 'plan', title: 'IKEA', status: 'waiting', hold: true, created: Date.now() - 3 * 864e5, when: { day: past, start: '10:00', end: '12:00', allDay: false } },
    soon: { from: 'sophie', to: 'ethan', type: 'plan', title: 'Later', status: 'waiting', created: Date.now(), when: { day: k(1), start: '08:00', end: '09:00', allDay: false } },
    trip: { from: 'sophie', to: 'ethan', type: 'leave', title: 'Spain', status: 'waiting', created: Date.now(), people: ['sophie', 'ethan'], when: { day: past, endDay: k(0), allDay: true } },
    countered: { from: 'ethan', to: 'sophie', type: 'plan', title: 'Film', status: 'other', created: Date.now(), when: { day: k(3), start: '19:00', end: '21:00' }, counter: { day: past, start: '19:00', end: '21:00' } }
  } });
  assert.equal(Ops.requestPassed(st.requests.find((r) => r.id === 'old')), true);
  assert.equal(Ops.requestPassed(st.requests.find((r) => r.id === 'soon')), false);
  assert.equal(Ops.requestPassed(st.requests.find((r) => r.id === 'trip')), false, 'a holiday still on its last day');
  assert.equal(Ops.requestPassed(st.requests.find((r) => r.id === 'countered')), true, 'the other time suggested has gone by');
});

test("your partner's own holiday has no Change or Delete for you", async () => {
  const { canChange } = await import('../js/views-event.js');
  const st = load({ requests: { lv: { from: 'sophie', to: 'ethan', type: 'leave', own: true, people: ['sophie'], status: 'yes', when: { day: sat, endDay: sat, allDay: true }, created: Date.now() }, pl: { from: 'sophie', to: 'ethan', type: 'plan', status: 'yes', created: Date.now() } } });
  assert.equal(canChange(st, { owner: 'sophie', tag: 'req:lv' }, {}), false);
  assert.equal(canChange(st, { owner: 'sophie', tag: 'req:pl' }, {}), true);
  assert.equal(canChange(st, { owner: 'sophie', tag: 'add:x' }, {}), false);
  assert.equal(canChange(st, { owner: 'ethan', tag: 'add:x' }, {}), true);
});

test('first-time setup makes the household and both records together, with two different emails', async () => {
  const { setupOps } = await import('../js/store.js');
  const ops = setupOps('Ethan@X.com', { myName: 'Ethan', partnerName: 'Sophie', partnerEmail: ' S@x.com ', partnerShifts: true });
  assert.deepEqual(ops.map((o) => o.path), ['', 'people/ethan', 'people/sophie']);
  assert.deepEqual(ops[0].data.emails, ['ethan@x.com', 's@x.com']);
  assert.equal(ops[2].data.joined, undefined);
  const same = setupOps('e@x.com', { myName: 'Ethan', partnerName: 'Sophie', partnerEmail: 'E@x.com' });
  assert.deepEqual(same[0].data.emails, ['e@x.com']);
  assert.equal(same[2].data.email, '');
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(new URL('../js/firebase.js', import.meta.url), 'utf8'), /writeBatch\(db\);\s*for \(const o of setupOps/);
});

test('the rules: no new person records once the household exists, and your other accounts are never the main ones', async () => {
  const { readFileSync } = await import('node:fs');
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const people = rules.slice(rules.indexOf('match /people/{pid}'), rules.indexOf('match /tokens/'));
  const create = people.slice(people.indexOf('allow create'), people.indexOf('allow update'));
  assert.match(create, /!exists\(\/databases\/\$\(database\)\/documents\/households\/main\)/);
  assert.doesNotMatch(create, /member\(\)/);
  assert.match(people, /linked', \[\]\)\.hasAny\(household\(\)\.emails\)/);
});

test("your partner's own things waiting to sync never show their names to you", () => {
  const st = load({ outbox: {
    o1: { person: 'sophie', op: 'create', tag: 'add:p1', byEmail: 's@x.com', done: false, event: { title: 'Job interview', day: sat, start: '10:00', end: '11:00', allDay: false, busyOnly: true } },
    o2: { person: 'ethan', op: 'create', tag: 'add:p2', byEmail: 'e@x.com', done: false, event: { title: 'Gym', day: sat, start: '12:00', end: '13:00', allDay: false } }
  } });
  const titles = L.dayList(st, sat).map((it) => it.title);
  assert.ok(!titles.includes('Job interview'));
  assert.ok(titles.includes('Gym'));
});

test('the rules: you read only your own outbox, and the app asks only for that', async () => {
  const { readFileSync } = await import('node:fs');
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const ob = rules.slice(rules.indexOf('match /outbox/{id}'), rules.indexOf('match /notify/{id}'));
  assert.match(ob, /allow read: if member\(\) && resource\.data\.byEmail == myEmail\(\);/);
  assert.match(readFileSync(new URL('../js/firebase.js', import.meta.url), 'utf8'), /c\('outbox'\), fs\.where\('byEmail', '==', email\)/);
});

test('a countdown to something private shows only on your own Today', () => {
  const st = load({ events: [timed('ethan', 'primary', sat, '10:00', '11:00', { t: 'Party' })] });
  st.calendars.ethan__secret = { owner: 'ethan', calKey: 'secret', name: 'Private', share: 'busy', role: 'normal', layer: 'own' };
  st.calendars.ethan__work = { owner: 'ethan', calKey: 'work', name: 'Work', share: 'hours', role: 'work', layer: 'own' };
  assert.equal(L.countdownShared(st, { owner: 'ethan', calKey: 'primary', title: 'Party' }), true);
  assert.equal(L.countdownShared(st, { owner: 'ethan', calKey: 'secret', title: 'Job interview' }), false);
  assert.equal(L.countdownShared(st, { owner: 'ethan', calKey: 'work', title: 'Big launch' }), false);
  assert.equal(L.countdownShared(st, { owner: 'ethan', calKey: 'secret', tag: 'both:x', title: 'Trip' }), true);
  assert.equal(L.countdownShared(st, { owner: 'sophie', calKey: 'primary', title: 'Her thing' }), true);
  // and Sophie's Today leaves out one that isn't shared
  st.people.ethan.countdowns = { c1: { title: 'Job interview', date: sat, shared: false }, c2: { title: 'Party', date: sat, shared: true } };
  const asSophie = Object.assign({}, st, { me: 'sophie', partner: 'ethan' });
  const titles = L.countdowns(asSophie).map((c) => c.title);
  assert.ok(titles.includes('Party') && !titles.includes('Job interview'));
});

test("a contact's birthday in a rota kept in your main calendar is never taken as that day's shift", () => {
  // the sync marks a contact's birthday (np) in your own copy; it's listed before the night shift that day
  const bday = { owner: 'ethan', calKey: 'rota', id: 'b1', t: "Jo's birthday", ad: 1, sd: sat, ed: dayKey(addDays(new Date(`${sat}T12:00`), 1)), np: 1 };
  const night = timed('ethan', 'rota', sat, '19:30', '23:59', { t: 'Night' });
  night.e = atTime(dayKey(addDays(new Date(`${sat}T12:00`), 1)), '08:00').getTime();
  const st = load({ events: [bday, night], ethan: { hasShifts: true, workDays: [] } });
  st.calendars.ethan__rota = { owner: 'ethan', calKey: 'rota', name: 'Main', share: 'all', role: 'rota', layer: 'own', key: 'ethan__rota' };
  L.clearDayCache();
  assert.equal(st.events.find((e) => e.id === 'b1').np, true);
  assert.equal(L.shiftFor(st, 'ethan', sat).type, 'night');
  // and the morning after, the sleep after nights is there
  const sun = dayKey(addDays(new Date(`${sat}T12:00`), 1));
  assert.ok(L.buildDay(st, sun).persons.ethan.sleep, 'asleep after the night shift');
  // without the mark (an older sync), nothing changes: the entry is read as before
  const st2 = load({ events: [Object.assign({}, bday, { np: undefined })] });
  assert.equal(st2.events[0].np, false);
});

test("a countdown to a contact's birthday (only in your own copy) stays on your own Today", () => {
  const bday = { owner: 'ethan', calKey: 'primary', id: 'b1', t: "Jo's birthday", ad: 1, sd: sat, ed: dayKey(addDays(new Date(`${sat}T12:00`), 1)), np: 1 };
  const st = load({ events: [bday] });
  assert.equal(L.countdownShared(st, st.events[0]), false);
  // what the event's page hands over: the row from that day, with its event
  assert.equal(L.countdownShared(st, L.dayList(st, sat).find((it) => it.title === "Jo's birthday").src), false);
  // a birthday you put in yourself, in a calendar shared as Everything, is shared as before
  const st2 = load({ events: [Object.assign({}, bday, { np: undefined })] });
  assert.equal(L.countdownShared(st2, st2.events[0]), true);
});

test('a request with times that runs over several days has passed only once its last day ends', () => {
  const now = atTime(k(0), '12:00').getTime();
  // Friday 6pm to Sunday 4pm, and it's the Saturday in between
  const w = { day: k(-1), endDay: k(1), start: '18:00', end: '16:00', allDay: false };
  assert.equal(Ops.whenPassed(w, now), false);
  assert.equal(Ops.whenPassed(w, atTime(k(1), '16:00').getTime()), true);
  // one day, as before: over at its end, or an hour after it starts with no end
  assert.equal(Ops.whenPassed({ day: k(0), start: '10:00', end: '11:00', allDay: false }, now), true);
  assert.equal(Ops.whenPassed({ day: k(0), start: '11:30', end: '', allDay: false }, now), false);
  assert.equal(Ops.whenPassed({ day: k(0), start: '13:00', end: '12:30', allDay: false }, now), false, 'an end before the start on one day: an hour after it starts');
});

test('a countdown follows its event when the event is moved to another day', () => {
  // set on the trip when it was on the Saturday; since moved (in Google Calendar) to the Monday after
  const mon = dayKey(addDays(new Date(`${sat}T12:00`), 2));
  const trip = { owner: 'ethan', calKey: 'primary', id: 'trip1', uid: 'trip1', t: 'Trip to York', ad: 1, sd: mon, ed: dayKey(addDays(new Date(`${mon}T12:00`), 1)) };
  const st = load({ events: [trip] });
  const ref = L.evRef(st.events[0]);
  st.people.ethan.countdowns = { c1: { title: 'Trip to York', date: sat, ref, shared: true } };
  assert.equal(L.countdowns(st).find((c) => c.title === 'Trip to York').date, mon);
  // something that repeats (every time has the same name), or one not in the calendars here: as it was saved
  const st2 = load({ events: [Object.assign({}, trip, { sid: 'trip1' })] });
  st2.people.ethan.countdowns = { c1: { title: 'Trip to York', date: sat, ref, shared: true } };
  assert.equal(L.countdowns(st2).find((c) => c.title === 'Trip to York').date, sat);
  const st3 = load();
  st3.people.ethan.countdowns = { c1: { title: 'Trip to York', date: sat, ref, shared: true } };
  assert.equal(L.countdowns(st3).find((c) => c.title === 'Trip to York').date, sat);
});

test('a countdown to something your partner sees only as "Busy" stays on your own Today', () => {
  // added with "Sophie sees Busy", still waiting to sync: it's private, whichever calendar it goes in
  const st = load({ outbox: { o1: { person: 'ethan', op: 'create', tag: 'add:ji', byEmail: 'e@x.com', done: false, event: { title: 'Job interview', day: sat, start: '10:00', end: '11:00', allDay: false, busyOnly: true } } } });
  const pending = L.dayList(st, sat).find((it) => it.title === 'Job interview');
  assert.equal(L.countdownShared(st, pending), false);
  // the same, synced (the sync marks it in your own copy), or marked Private in Google Calendar
  const st2 = load({ events: [timed('ethan', 'primary', sat, '10:00', '11:00', { t: 'Job interview', tag: 'add:ji', pb: 1 })] });
  assert.equal(L.countdownShared(st2, st2.events[0]), false);
  // a calendar not known (yet) isn't taken to be shared as Everything
  assert.equal(L.countdownShared(st2, { owner: 'ethan', calKey: 'newcal', title: 'Therapy' }), false);
  // something waiting to sync to your main calendar, shared as Everything, still counts down for you both
  const st3 = load({ outbox: { o1: { person: 'ethan', op: 'create', tag: 'add:p', byEmail: 'e@x.com', done: false, event: { title: 'Party', day: sat, start: '10:00', end: '11:00', allDay: false } } } });
  assert.equal(L.countdownShared(st3, L.dayList(st3, sat).find((it) => it.title === 'Party')), true);
});

test("with tonight's meal from Peckish, dinner moved earlier for a night shift still says why", () => {
  store.linked = { peckish: { found: true, days: { [sat]: { title: 'Chicken fajitas', time: 30 } } } };
  try {
    const night = timed('sophie', 'rota', sat, '19:30', '08:00', { t: 'Night', e: atTime(dayKey(addDays(new Date(sat + 'T12:00'), 1)), '08:00').getTime() });
    const st = load({ events: [night] });
    const din = L.buildDay(st, sat).together.find((t) => t.auto);
    assert.equal(din.title, 'Early dinner: Chicken fajitas');
    assert.match(din.sub, /Moved from your usual 7pm, as Sophie leaves for work/);
    // on a usual night, the meal's own line
    const plain = L.buildDay(load(), sat).together.find((t) => t.auto);
    assert.equal(plain.title, 'Dinner: Chicken fajitas');
    assert.equal(plain.sub, '30 minutes, from Peckish.');
  } finally { store.linked = {}; }
});

test('bank holidays are known for every year, so a holiday booked for 2029 or later still skips them', () => {
  // as gov.uk lists them
  assert.deepEqual([2026, 2027, 2028].flatMap((y) => L.bankHolidays(y)).sort(), [
    '2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28',
    '2027-01-01', '2027-03-26', '2027-03-29', '2027-05-03', '2027-05-31', '2027-08-30', '2027-12-27', '2027-12-28',
    '2028-01-03', '2028-04-14', '2028-04-17', '2028-05-01', '2028-05-29', '2028-08-28', '2028-12-25', '2028-12-26']);
  assert.deepEqual(L.bankHolidays(2022).slice().sort().slice(-2), ['2022-12-26', '2022-12-27'], 'Christmas on a Sunday');
  // Ethan, Monday to Friday: the weeks of Good Friday (30 March 2029) and Easter Monday (2 April) take 4 days each, not 5
  const st = load();
  assert.equal(L.leaveDaysFor(st, 'ethan', '2029-03-26', '2029-03-30'), 4);
  assert.equal(L.leaveDaysFor(st, 'ethan', '2029-04-02', '2029-04-06'), 4);
});

test('a late shift that ends at midnight is not a night: no sleeping the next morning', () => {
  const st = load({ events: [timed('sophie', 'rota', k(8), '16:00', '16:00', { t: 'Shift', e: atTime(k(9), '00:00').getTime() })] });
  assert.equal(L.shiftFor(st, 'sophie', k(8)).type, 'late');
  assert.equal(L.buildDay(st, k(9)).persons.sophie.sleep, null);
});

test('changing the day of something overnight or over several days keeps its end', () => {
  const night = { start: atTime(k(3), '22:00'), end: atTime(k(4), '01:00') };
  assert.deepEqual(L.editTimes(night, { day: k(5) }), { day: k(5), start: '22:00', end: '01:00', endDay: k(6) });
  const conf = { start: atTime(k(3), '09:00'), end: atTime(k(5), '17:00') };
  assert.deepEqual(L.editTimes(conf, { day: k(10) }), { day: k(10), start: '09:00', end: '17:00', endDay: k(12) });
  const toMidnight = { start: atTime(k(3), '20:00'), end: atTime(k(4), '00:00') };
  assert.equal(L.editTimes(toMidnight, { start: '21:00' }).endDay, k(4));
  // an overnight one can become a same-day one
  assert.equal(L.editTimes(night, { end: '23:30' }).endDay, undefined);
  // a same-day one still can't end before it starts
  const dentist = { start: atTime(k(3), '16:30'), end: atTime(k(3), '17:15') };
  assert.match(L.editTimes(dentist, { end: '09:00' }).error, /end needs to be after/);
  assert.deepEqual(L.editTimes(dentist, { day: k(4) }), { day: k(4), start: '16:30', end: '17:15' });
});

test('the middle day of something over several days says All day, not when it ends', () => {
  const st = load({ events: [timed('ethan', 'primary', k(8), '09:00', '09:00', { t: 'Conference', e: atTime(k(10), '17:00').getTime() })] });
  const it = (day) => L.dayList(st, day).find((x) => x.title === 'Conference');
  assert.equal(L.itemTime(it(k(9)), k(9)), 'All day');
  assert.equal(L.itemTime(it(k(10)), k(10)), 'Until 5pm');
});

test('a reminder to answer comes with the Yes and Can’t buttons', async () => {
  load({ requests: { r9: { from: 'ethan', to: 'sophie', type: 'plan', title: 'Walk', when: { day: sat, start: '10:00', end: '11:00', allDay: false }, status: 'waiting', created: Date.now() } } });
  const seen = [];
  store.backend = { commit: async (ops) => { seen.push(...ops); }, ping() {} };
  await actions.answerRequest('r9', 'remind');
  const n = seen.find((o) => o.path === 'notify');
  assert.equal(n.data.reqId, 'r9');
  assert.equal(n.data.ask, '1');
});

test('the rules: on a calendar record you can change only what you see and share', async () => {
  const { readFileSync } = await import('node:fs');
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const cal = rules.slice(rules.indexOf('match /calendars/{id}'), rules.indexOf('match /people/{pid}'));
  assert.match(cal, /changed\(\)\.hasOnly\(\['show', 'share', 'role', 'layer', 'userSet', 'shareSet', 'roleSet'\]\)/);
});

test('a family calendar you both have shows its events once', () => {
  const lunch = (owner) => ({ owner, calKey: 'fam', id: `${owner}l`, uid: 'sameUID', t: 'Sunday lunch', s: atTime(sat, '13:00').getTime(), e: atTime(sat, '16:00').getTime() });
  const st = load({ events: [lunch('ethan'), lunch('sophie')] });
  st.calendars.ethan__fam = { owner: 'ethan', calKey: 'fam', name: 'Family', share: 'all', role: 'normal', layer: 'family', show: true };
  st.calendars.sophie__fam = { owner: 'sophie', calKey: 'fam', name: 'Family', share: 'all', role: 'normal', layer: 'family', show: true };
  L.clearDayCache();
  const rows = L.dayList(st, sat).filter((it) => it.title === 'Sunday lunch');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].who, 'ethan:family');
});

test('signing out takes this phone off your notifications first', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../js/firebase.js', import.meta.url), 'utf8');
  const so = src.slice(src.indexOf('async signOut()'), src.indexOf('fa.signOut(auth)'));
  assert.match(so, /fs\.deleteDoc\(ref\(`people\/\$\{me\}\/tokens\/\$\{id\}`\)\)/);
  assert.match(so, /removeItem\('caledonite\.push'\)/);
});

// The rules, run by a small stand-in for Firestore's rules engine (there's no emulator here)
const { loadRules } = await import('./rules-eval.mjs');
const RULES = loadRules((await import('node:fs')).readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'));
const HH = 'households/main';
const EM = { ethan: 'ethan@gmail.com', sophie: 'sophie@gmail.com' };
function rulesDb(extra = {}) {
  return Object.assign({
    [HH]: { emails: [EM.ethan, EM.sophie], emailsLocked: true, pingSecret: 's' },
    [`${HH}/people/ethan`]: { email: EM.ethan, name: 'Ethan', joined: true, settings: {} },
    [`${HH}/people/sophie`]: { email: EM.sophie, name: 'Sophie', joined: true, settings: {} }
  }, extra);
}
// Firestore's merge (set with merge: maps merge, everything else is replaced)
function merged(a, b) {
  const out = Object.assign({}, a);
  for (const [key, v] of Object.entries(b)) out[key] = v && typeof v === 'object' && !Array.isArray(v) && a[key] && typeof a[key] === 'object' && !Array.isArray(a[key]) ? merged(a[key], v) : v;
  return out;
}
// can `who` save this change (merged into what's there) to requests/{id}?
function canPatch(who, id, doc, patch) {
  const db = rulesDb({ [`${HH}/requests/${id}`]: doc });
  return RULES.allowed({ method: 'update', path: `${HH}/requests/${id}`, email: EM[who], db, data: merged(doc, patch) });
}
const ask = (extra = {}) => Object.assign({ from: 'ethan', to: 'sophie', type: 'plan', title: 'Cinema', note: '', hold: false, status: 'waiting', created: 1, when: { day: '2026-11-07', start: '19:00', end: '21:00', allDay: false, label: '' } }, extra);
const answer = (req, a, me, when) => Ops.buildAnswer({ req, id: 'r1', answer: a, me, byEmail: EM[me], names: { ethan: 'Ethan', sophie: 'Sophie' }, when, now: 5 }).patch;

test("the rules: a request's asker, who it's for and whether it's just for one of you can't be changed or forged", () => {
  const create = (who, data) => RULES.allowed({ method: 'create', path: `${HH}/requests/n1`, email: EM[who], db: rulesDb(), data });
  assert.equal(create('ethan', ask()), true);
  assert.equal(create('sophie', ask()), false, 'not in your partner\'s name');
  for (const f of [{ from: 'sophie' }, { to: 'ethan' }, { type: 'favour' }, { own: true }, { people: ['ethan'] }, { title: 'x' }, { hold: true }]) {
    assert.equal(canPatch('sophie', 'r1', ask(), f), false, JSON.stringify(f));
    assert.equal(canPatch('ethan', 'r1', ask(), f), false, JSON.stringify(f));
  }
  assert.equal(RULES.allowed({ method: 'delete', path: `${HH}/requests/r1`, email: EM.ethan, db: rulesDb({ [`${HH}/requests/r1`]: ask() }) }), false);
  // and the catch-all for shared lists doesn't let requests through
  assert.equal(RULES.allowed({ method: 'update', path: `${HH}/requests/r1`, email: EM.ethan, db: rulesDb({ [`${HH}/requests/r1`]: ask() }), data: ask({ from: 'sophie' }) }), false);
});

test("the rules: only the one it's for answers a request, and a holiday booked just for one of you is theirs alone", () => {
  // every answer the app (and a notification's buttons) saves still goes through
  for (const a of ['yes', 'no', 'maybe', 'other']) {
    const when = a === 'other' ? { day: '2026-11-08', start: '18:00', end: '20:00', allDay: false, label: 'Sunday' } : undefined;
    assert.equal(canPatch('sophie', 'r1', ask(), answer(ask(), a, 'sophie', when)), true, a);
    // but never by the one who asked
    assert.equal(canPatch('ethan', 'r1', ask(), answer(ask(), a, 'ethan', when)), false, `${a} by the asker`);
  }
  const heads = ask({ type: 'heads', when: null, status: 'sent' });
  assert.equal(canPatch('sophie', 'r1', heads, answer(heads, 'seen', 'sophie')), true);
  assert.equal(canPatch('ethan', 'r1', heads, answer(heads, 'seen', 'ethan')), false);
  // the asker can remind, cancel, and say yes to the other time that was suggested (and only that time)
  assert.equal(canPatch('ethan', 'r1', ask(), answer(ask(), 'remind', 'ethan')), true);
  assert.equal(canPatch('ethan', 'r1', ask(), answer(ask(), 'cancel', 'ethan')), true);
  const other = ask({ status: 'other', counter: { day: '2026-11-08', start: '18:00', end: '20:00', allDay: false, label: 'Sunday' } });
  const accept = answer(other, 'accept-counter', 'ethan');
  assert.equal(canPatch('ethan', 'r1', other, accept), true);
  assert.equal(canPatch('sophie', 'r1', other, accept), false, 'the one who suggested it can\'t agree to it for them');
  assert.equal(canPatch('ethan', 'r1', other, Object.assign({}, accept, { when: { day: '2026-12-25', start: '10:00', end: '11:00', allDay: false, label: '' } })), false, 'only the time suggested');
  // the time of something can't be changed otherwise, by either of you
  for (const who of ['ethan', 'sophie']) assert.equal(canPatch(who, 'r1', ask({ status: 'yes' }), { when: { day: '2027-01-01', allDay: true } }), false, who);
  // either of you can call off something between you (deleting it from the calendar does)
  assert.equal(canPatch('sophie', 'r1', ask({ status: 'yes' }), { status: 'cancelled', answeredAt: 5 }), true);
  // a holiday Sophie booked just for herself: Ethan can't cancel it or move it, Sophie can cancel it
  const own = { from: 'sophie', to: 'ethan', type: 'leave', title: 'Spain', note: '', hold: false, status: 'yes', own: true, people: ['sophie'], days: { sophie: 5 }, created: 1, when: { day: '2026-11-09', endDay: '2026-11-13', allDay: true, label: '' } };
  assert.equal(canPatch('ethan', 'r2', own, { status: 'cancelled', answeredAt: 5 }), false);
  assert.equal(canPatch('ethan', 'r2', own, { when: { day: '2027-03-01', endDay: '2027-03-05', allDay: true } }), false);
  assert.equal(canPatch('sophie', 'r2', own, { status: 'cancelled', answeredAt: 5 }), true);
  // and nothing can be made already agreed, except your own holiday booked just for you
  const create = (who, data) => RULES.allowed({ method: 'create', path: `${HH}/requests/n1`, email: EM[who], db: rulesDb(), data });
  assert.equal(create('ethan', ask({ type: 'leave', status: 'yes', people: ['ethan', 'sophie'] })), false);
  assert.equal(create('ethan', ask({ status: 'yes' })), false);
  assert.equal(create('ethan', ask({ type: 'leave', status: 'yes', own: true, people: ['sophie'] })), false, 'not "your own" holiday for your partner');
  assert.equal(create('ethan', ask({ type: 'heads', when: null, status: 'sent' })), true);
  assert.equal(create('ethan', { from: 'ethan', to: 'sophie', type: 'leave', title: 'Spain', when: { day: '2026-11-09', endDay: '2026-11-13', allDay: true, label: '' }, hold: false, status: 'yes', own: true, days: { ethan: 5 }, people: ['ethan'], note: '', created: 1, answeredAt: 1 }), true);
  // stale: once answered, an answer saved offline can't change it, but it can still be called off
  assert.equal(canPatch('sophie', 'r1', ask({ status: 'cancelled' }), answer(ask(), 'yes', 'sophie')), false);
  assert.equal(canPatch('sophie', 'r1', ask({ status: 'no' }), answer(ask(), 'yes', 'sophie')), false);
});

test("the rules: a request is always to your partner, and yes to the other time they suggested is that time", () => {
  const create = (who, data) => RULES.allowed({ method: 'create', path: `${HH}/requests/n1`, email: EM[who], db: rulesDb(), data });
  // one "for" yourself you could then answer yourself: a holiday "agreed" by both of you that Sophie never saw
  assert.equal(create('ethan', ask({ to: 'ethan' })), false);
  assert.equal(create('ethan', ask({ type: 'leave', to: 'ethan', people: ['ethan', 'sophie'] })), false);
  assert.equal(create('ethan', ask({ to: 'nobody' })), false, 'not someone who isn\'t one of you');
  assert.equal(create('ethan', ask()), true);
  // Sophie couldn't do the first time and suggested another: Ethan can only say yes to hers
  const other = ask({ status: 'other', counter: { day: '2026-11-08', start: '18:00', end: '20:00', allDay: false, label: 'Sunday' } });
  assert.equal(canPatch('ethan', 'r1', other, { status: 'yes', answeredAt: 5 }), false, 'yes at the time she said she couldn\'t do');
  assert.equal(canPatch('ethan', 'r1', other, answer(other, 'accept-counter', 'ethan')), true);
});

test('the page only loads pictures from Caledonite itself, so injected markup or styles have nowhere to send things', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /img-src 'self' data:;/);
  assert.doesNotMatch(html, /script-src[^;]*'unsafe-inline'/);
});

test('changing or deleting just one occurrence of something repeating sends which one', async () => {
  load();
  const seen = [];
  store.backend = { commit: async (ops) => { seen.push(...ops); }, ping() {} };
  const ev = { owner: 'ethan', calKey: 'primary', tag: 'both:wk', title: 'Date night', gid: 'abc123_20261113T190000Z', rid: 'abc123', start: new Date(), end: new Date() };
  await actions.removeEvent({ ev, scope: 'one' });
  assert.ok(seen.filter((o) => o.path === 'outbox').every((o) => o.data.inst === '20261113T190000Z'));
  seen.length = 0;
  await actions.removeEvent({ ev, scope: 'all' });
  assert.ok(seen.filter((o) => o.path === 'outbox').every((o) => !o.data.inst));
  seen.length = 0;
  await actions.editEvent({ ev, changes: { start: '20:00' }, scope: 'one' });
  assert.ok(seen.filter((o) => o.path === 'outbox').every((o) => o.data.inst === '20261113T190000Z'));
});

test('reminders and private countdowns are kept where your partner can’t read them, and older ones move there', async () => {
  const seen = [];
  store.backend = { commit: async (ops) => { seen.push(...ops); }, ping() {} };
  setRaw({
    household: {}, private: {},
    people: {
      ethan: { name: 'Ethan', email: 'e@x.com', reminders: { r1: { ref: 'e:ethan:primary:x', owner: 'ethan', title: 'Ring shop', times: ['d1'] } },
        countdowns: { c1: { title: 'Ring shop', date: sat, shared: false }, c2: { title: 'Party', date: sat, shared: true } } },
      sophie: { name: 'Sophie', email: 's@x.com' }
    },
    calendars: {}, feeds: [], shifts: {}, requests: {}, notes: {}, outbox: {}, jobs: {}, ideas: {}, status: {}
  }, { phase: 'ready', me: 'ethan', user: { email: 'e@x.com' } });
  await actions.movePrivate();
  const up = seen.find((o) => o.type === 'update');
  assert.equal(up.path, 'people/ethan/private/main');
  assert.deepEqual(Object.keys(up.data.reminders), ['r1']);
  assert.deepEqual(Object.keys(up.data.countdowns), ['c1']);
  assert.ok(seen.some((o) => o.type === 'unset' && o.path === 'people/ethan' && o.field === 'reminders'));
  assert.ok(seen.some((o) => o.type === 'unset' && o.path === 'people/ethan' && o.field === 'countdowns.c1'));
  assert.ok(!seen.some((o) => o.field === 'countdowns.c2'), 'a shared countdown stays where you both see it');
  seen.length = 0;
  await actions.setCountdown({ id: 'c3', title: 'Interview', date: sat, shared: false });
  assert.equal(seen[0].path, 'people/ethan/private/main');
  seen.length = 0;
  await actions.setReminder({ ref: 'e:ethan:primary:y', owner: 'ethan', title: 'Interview', times: ['d1'] });
  assert.ok(seen.every((o) => o.path === 'people/ethan/private/main'));
  // what's in the private place counts as yours
  setRaw(Object.assign({}, store.raw, { private: { reminders: { r9: { ref: 'e:ethan:primary:z', owner: 'ethan', times: ['d0'] } } } }), { phase: 'ready', me: 'ethan', user: { email: 'e@x.com' } });
  assert.ok(store.state.people.ethan.reminders.r9 && store.state.people.ethan.reminders.r1);
});

test("older reminders and the rota link move only once what's in the private place is known from the server", async () => {
  const seen = [];
  store.backend = { commit: async (ops) => { seen.push(...ops); }, ping() {} };
  const base = {
    household: {}, private: {}, privateFromServer: false,
    people: { ethan: { name: 'Ethan', email: 'e@x.com', settings: { rotaUrl: 'https://loop.example/old.ics' }, reminders: { r1: { ref: 'e:ethan:primary:a', times: ['d0'] } } }, sophie: { name: 'Sophie', email: 's@x.com' } },
    calendars: {}, feeds: [], shifts: {}, requests: {}, notes: {}, outbox: {}, jobs: {}, ideas: {}, status: {}
  };
  // offline, with nothing of it saved on this phone: it might already hold a newer link
  setRaw(base, { phase: 'ready', me: 'ethan', user: { email: 'e@x.com' } });
  assert.equal(store.state.privateReady, false);
  await actions.movePrivate();
  assert.equal(seen.length, 0);
  setRaw(Object.assign({}, base, { privateFromServer: true }), { phase: 'ready', me: 'ethan', user: { email: 'e@x.com' } });
  assert.equal(store.state.privateReady, true);
  await actions.movePrivate();
  assert.ok(seen.some((o) => o.path === 'people/ethan/private/main'));
});

test('your rota link is kept where your partner can’t read it, and one on your record moves there', async () => {
  const seen = [];
  store.backend = { commit: async (ops) => { seen.push(...ops); }, ping() {} };
  const base = {
    household: {}, private: {},
    people: { ethan: { name: 'Ethan', email: 'e@x.com', settings: { rotaUrl: 'https://loop.example/old.ics', remindAt: '08:00' } }, sophie: { name: 'Sophie', email: 's@x.com' } },
    calendars: {}, feeds: [], shifts: {}, requests: {}, notes: {}, outbox: {}, jobs: {}, ideas: {}, status: {}
  };
  setRaw(base, { phase: 'ready', me: 'ethan', user: { email: 'e@x.com' } });
  await actions.movePrivate();
  const up = seen.find((o) => o.type === 'update' && o.path === 'people/ethan/private/main');
  assert.equal(up.data.rotaUrl, 'https://loop.example/old.ics');
  assert.ok(seen.some((o) => o.type === 'unset' && o.path === 'people/ethan' && o.field === 'settings.rotaUrl'));
  // saving a new one: only in the private place, and never on your record
  seen.length = 0;
  await actions.updateMySettings({ rotaUrl: 'https://loop.example/new.ics', remindAt: '09:00' });
  assert.deepEqual(seen.find((o) => o.path === 'people/ethan/private/main').data, { rotaUrl: 'https://loop.example/new.ics' });
  assert.ok(!seen.some((o) => o.path === 'people/ethan' && o.type === 'update' && 'rotaUrl' in ((o.data || {}).settings || {})));
  assert.equal(seen.find((o) => o.path === 'people/ethan' && o.type === 'update').data.settings.remindAt, '09:00');
  // and the screens show the one in the private place (taken out counts too)
  setRaw(Object.assign({}, base, { private: { rotaUrl: 'https://loop.example/new.ics' } }), { phase: 'ready', me: 'ethan', user: { email: 'e@x.com' } });
  assert.equal(store.state.people.ethan.settings.rotaUrl, 'https://loop.example/new.ics');
  setRaw(Object.assign({}, base, { private: { rotaUrl: '' } }), { phase: 'ready', me: 'ethan', user: { email: 'e@x.com' } });
  assert.equal(store.state.people.ethan.settings.rotaUrl, '');
  // once moved, it isn't moved again
  seen.length = 0;
  setRaw(Object.assign({}, base, { people: { ethan: { name: 'Ethan', email: 'e@x.com', settings: {} }, sophie: base.people.sophie }, private: { rotaUrl: 'x' } }), { phase: 'ready', me: 'ethan', user: { email: 'e@x.com' } });
  await actions.movePrivate();
  assert.equal(seen.length, 0);
});

test('offline, the service worker answers only from Caledonite’s own saved copies, and the app page only for a page', async () => {
  const lib = 'https://alertrobot.github.io/es-kitchen/data/library.json';
  const { handlers } = await loadSw({ fetchFails: true, own: { './index.html': 'APP PAGE' }, other: { [lib]: 'PECKISH COPY', './index.html': 'SOMEONE ELSE' } });
  const ask = async (url, mode) => { let p; handlers.fetch({ request: { method: 'GET', url, mode }, respondWith: (x) => { p = x; } }); return p; };
  assert.equal(await ask(lib, 'cors'), 'network error', 'not another app’s copy, and not the app page as a JSON file');
  assert.equal(await ask('https://alertrobot.github.io/caledonite/', 'navigate'), 'APP PAGE');
});

test("the service worker never saves another app's files from this website (Peckish's recipes) as its own", async () => {
  const ok = { ok: true, status: 200, clone() { return this; } };
  const fetchOf = async (url) => { const sw = await loadSw({ fetchRes: ok }); let p; sw.handlers.fetch({ request: { method: 'GET', url, mode: 'cors' }, respondWith: (x) => { p = x; } }); await p; await new Promise((r) => setTimeout(r, 0)); return sw.puts; };
  assert.deepEqual(await fetchOf('https://alertrobot.github.io/es-kitchen/data/library.json'), []);
  assert.equal((await fetchOf('https://alertrobot.github.io/caledonite/js/app.js')).length, 1);
});

test('opening the second day of something repeating that runs overnight changes that occurrence, not another', async () => {
  const { findEvent } = await import('../js/views-event.js');
  const sat2 = dayKey(addDays(new Date(sat + 'T12:00'), 7));
  const night = (day, n) => timed('ethan', 'primary', day, '22:00', '23:59', { id: `late${n}`, t: 'Late film', uid: 'u-late', sid: 's-late', rid: 'g-late', gid: `g-late_${day.replace(/-/g, '')}T220000Z`, e: atTime(dayKey(addDays(new Date(day + 'T12:00'), 1)), '01:00').getTime() });
  const st = load({ events: [night(sat, 1), night(sat2, 2)] });
  const ref = 'e:ethan:primary:u-late';
  const nextMorning = dayKey(addDays(new Date(sat2 + 'T12:00'), 1));
  const { ev } = findEvent(st, ref, nextMorning);
  assert.equal(ev.id, 'late2', 'the occurrence shown on that morning');
  assert.equal(findEvent(st, ref, sat2).ev.id, 'late2');
  assert.equal(findEvent(st, ref, sat).ev.id, 'late1');
});

test('a holiday one of you booked just for themselves is theirs on the calendar, not something together', () => {
  const lv = { from: 'sophie', to: 'ethan', type: 'leave', title: '', own: true, people: ['sophie'], status: 'yes', when: { day: sat, endDay: sat, allDay: true }, created: Date.now() };
  // not in the calendars yet
  let st = load({ requests: { lv } });
  let it = L.dayList(st, sat).find((x) => x.pending);
  assert.equal(it.who, 'sophie');
  assert.equal(it.title, 'Holiday');
  assert.ok(!L.buildDay(st, sat).together.some((x) => !x.auto));
  // and once it's in Sophie's calendar
  st = load({ requests: { lv }, events: [{ owner: 'sophie', calKey: 'primary', id: 'h1', t: 'Holiday', ad: 1, sd: sat, ed: dayKey(addDays(new Date(sat + 'T12:00'), 1)), tag: 'req:lv' }] });
  it = L.dayList(st, sat).find((x) => x.tag === 'req:lv');
  assert.equal(it.who, 'sophie');
  assert.equal(it.kind, 'event');
});

// a window on this website, as the service worker sees it. A window belonging to another app's service worker
// (Peckish) can be focused but not navigated.
function fakeWindow(url, ours = true) {
  const w = { url, focused: 0, went: [], focus: async () => { w.focused++; return w; }, navigate: async (u) => { if (!ours) throw new TypeError('not controlled'); w.went.push(u); w.url = u; return w; } };
  return w;
}
test("tapping a notification opens Caledonite, never a Peckish window that's open on the same website", async () => {
  const tap = async (opts, link) => {
    const { handlers } = await loadSw(opts);
    let p; handlers.notificationclick({ action: '', notification: { data: { link }, close() {} }, waitUntil: (x) => { p = x; } });
    await p;
  };
  // only Peckish is open: Caledonite opens in a window of its own
  const peckish = fakeWindow('https://alertrobot.github.io/es-kitchen/#plan', false);
  const opened = [];
  await tap({ windows: [peckish], opened }, '#requests');
  assert.equal(peckish.focused, 0);
  assert.deepEqual(peckish.went, []);
  assert.deepEqual(opened, ['https://alertrobot.github.io/caledonite/#requests']);
  // Caledonite is open too: that window goes to the link
  const cal = fakeWindow('https://alertrobot.github.io/caledonite/#today');
  const opened2 = [];
  await tap({ windows: [peckish, cal], opened: opened2 }, '#requests');
  assert.equal(peckish.focused, 0);
  assert.equal(cal.focused, 1);
  assert.deepEqual(cal.went, ['https://alertrobot.github.io/caledonite/#requests']);
  assert.deepEqual(opened2, []);
  // a Peckish meal reminder: Peckish's window comes up, and Caledonite's isn't taken away from it
  const cal2 = fakeWindow('https://alertrobot.github.io/caledonite/#today');
  const pk = fakeWindow('https://alertrobot.github.io/es-kitchen/', false);
  const opened3 = [];
  await tap({ windows: [cal2, pk], opened: opened3 }, '../es-kitchen/');
  assert.deepEqual(cal2.went, []);
  assert.equal(pk.focused, 1);
  assert.deepEqual(opened3, []);
});

test("fonts come from Caledonite's own saved copies, never another app's, and a failed download isn't kept", async () => {
  const font = 'https://fonts.gstatic.com/s/atkinson/v1/a.woff2';
  const good = { ok: true, status: 200, type: 'cors', clone() { return this; } };
  const ask = async (opts) => { const sw = await loadSw(opts); let p; sw.handlers.fetch({ request: { method: 'GET', url: font }, respondWith: (x) => { p = x; } }); return { res: await p, puts: sw.puts }; };
  assert.equal((await ask({ fetchRes: good, other: { [font]: 'PECKISH COPY' } })).res, good);
  const bad = { ok: false, status: 500, type: 'cors', clone() { return this; } };
  const r = await ask({ fetchRes: bad });
  await new Promise((res) => setTimeout(res, 10));
  assert.deepEqual(r.puts, []);
});

test('"Not tonight" works for quiet hours that start after midnight, tapped in the evening', () => {
  const s = { quiet: { on: true, from: '00:30', to: '07:00', skip: null } };
  const evening = atTime(sat, '22:00');
  const sun = dayKey(addDays(new Date(sat + 'T12:00'), 1));
  assert.equal(L.quietNight(s, evening), sun, 'the quiet hours coming next start on Sunday');
  const skipped = { quiet: Object.assign({}, s.quiet, { skip: L.quietNight(s, evening) }) };
  assert.equal(L.inQuietHours(skipped, atTime(sun, '01:00')), false);
  // the usual 11pm to 7am still means tonight, in the evening and in the small hours
  const usual = { quiet: { on: true, from: '23:00', to: '07:00' } };
  assert.equal(L.quietNight(usual, evening), sat);
  assert.equal(L.quietNight(usual, atTime(sun, '02:00')), sat);
  assert.equal(L.quietNight(s, atTime(sun, '00:10')), sun, 'before they start that night');
  assert.equal(L.quietNight(s, atTime(sun, '03:00')), sun, 'while they are on');
});

test("shift times and travel your partner saved are kept to ones that make sense", () => {
  const st = load({ sophie: { travelMins: 1e9, sleepUntil: '99:99', shiftTypes: { night: { label: 'Night', start: '25:00', end: '08:00' } } } });
  const s = L.settingsOf(st, 'sophie');
  assert.equal(s.travelMins, 240);
  assert.equal(s.sleepUntil, '14:00');
  assert.equal(s.shiftTypes.night.start, '19:30');
});

test("Peckish's recipe names come back after a failed download, without reloading the app", async () => {
  const mem = { 'esk-wk:h1:2026-11-02': JSON.stringify({ days: [{ r: 'fajitas' }] }) };
  globalThis.localStorage = { get length() { return Object.keys(mem).length; }, key: (i) => Object.keys(mem)[i], getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
  globalThis.location = { href: 'https://alertrobot.github.io/caledonite/index.html' };
  let online = false;
  globalThis.fetch = async (url) => {
    if (!online) throw new TypeError('offline');
    assert.equal(url, 'https://alertrobot.github.io/es-kitchen/data/library.json');
    return { ok: true, json: async () => ({ recipes: [{ id: 'fajitas', title: 'Chicken fajitas', time: 30 }] }) };
  };
  const { loadPeckish } = await import('../js/linked.js');
  assert.equal((await loadPeckish()).days['2026-11-02'].title, 'dinner planned in Peckish');
  online = true;
  assert.equal((await loadPeckish()).days['2026-11-02'].title, 'Chicken fajitas');
});

test("the rules: once sent, a request's name, note, holiday days and pencilling-in are fixed; answering still works", async () => {
  const { readFileSync } = await import('node:fs');
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const rq = rules.slice(rules.indexOf('match /requests/{id}'), rules.indexOf('match /outbox/{id}'));
  const fixed = JSON.parse(rq.match(/allow update: if member\(\) && !changed\(\)\.hasAny\((\[[^\]]+\])\)/)[1].replace(/'/g, '"'));
  for (const f of ['from', 'to', 'type', 'own', 'people', 'title', 'note', 'days', 'hold', 'created']) assert.ok(fixed.includes(f), f);
  // everything answering, cancelling or reminding writes is still allowed (the app, the notification buttons and the sync)
  const req = { from: 'ethan', to: 'sophie', type: 'plan', title: 'Film', hold: true, when: { day: sat, start: '19:00', end: '21:00' }, counter: { day: sat, start: '20:00', end: '22:00', label: 'x' } };
  const written = new Set(['status', 'answeredAt', 'autoNudged']);
  for (const answer of ['yes', 'no', 'maybe', 'seen', 'other', 'accept-counter', 'cancel', 'remind', 'undo']) {
    for (const k of Object.keys(Ops.buildAnswer({ req, id: 'r1', answer, me: 'sophie', byEmail: 's@x.com', names: {}, when: req.counter }).patch)) written.add(k);
  }
  for (const k of written) assert.ok(!fixed.includes(k), k);
});

test('a holiday over several days, not in the calendars yet, shows on every one of its days', () => {
  const day2 = dayKey(addDays(new Date(sat + 'T12:00'), 2));
  const day1 = dayKey(addDays(new Date(sat + 'T12:00'), 1));
  const st = load({
    requests: { lv: { from: 'ethan', to: 'sophie', type: 'leave', title: 'Lisbon', people: ['ethan', 'sophie'], status: 'yes', when: { day: sat, endDay: day2, allDay: true }, created: Date.now() } },
    outbox: { o1: { person: 'ethan', op: 'create', tag: 'add:camp', byEmail: 'e@x.com', done: false, event: { title: 'Camping', day: sat, endDay: day2, allDay: true } } }
  });
  for (const k of [sat, day1, day2]) {
    const titles = L.dayList(st, k).map((it) => it.title);
    assert.ok(titles.includes('Holiday: Lisbon'), k);
    assert.ok(titles.includes('Camping'), k);
  }
  assert.ok(!L.dayList(st, dayKey(addDays(new Date(sat + 'T12:00'), 3))).some((it) => it.pending));
});

test("just this one, from your partner's copy of something repeating you share, never changes or deletes every time", async () => {
  // Sophie's copy, as it reaches Ethan: it repeats (sid), but has none of Google's ids (gid, rid)
  const start = atTime(sat, '19:00');
  const ev = { owner: 'sophie', calKey: 'primary', tag: 'both:wk', title: 'Date night', sid: 'u-wk', uid: 'u-wk', start, end: atTime(sat, '21:00') };
  load({ events: [{ owner: 'sophie', calKey: 'primary', id: 'x1', t: 'Date night', tag: 'both:wk', sid: 'u-wk', uid: 'u-wk', s: start.getTime(), e: atTime(sat, '21:00').getTime() }] });
  const seen = [];
  store.backend = { commit: async (ops) => { seen.push(...ops); }, ping() {} };
  const stamp = start.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  await actions.removeEvent({ ev, scope: 'one' });
  let out = seen.filter((o) => o.path === 'outbox');
  assert.equal(out.length, 2);
  assert.ok(out.every((o) => o.data.inst === stamp), 'only that occurrence, in both copies');
  seen.length = 0;
  await actions.editEvent({ ev, changes: { start: '20:00' }, scope: 'one' });
  out = seen.filter((o) => o.path === 'outbox');
  assert.ok(out.length && out.every((o) => o.data.inst === stamp));
  seen.length = 0;
  await actions.removeEvent({ ev, scope: 'all' });
  assert.ok(seen.filter((o) => o.path === 'outbox').every((o) => !o.data.inst), 'every time, when asked');
  // all day: the date, as Google writes it
  seen.length = 0;
  await actions.removeEvent({ ev: Object.assign({}, ev, { allDay: true, startKey: sat }), scope: 'one' });
  assert.ok(seen.filter((o) => o.path === 'outbox').every((o) => o.data.inst === sat.replace(/-/g, '')));
  // and its page asks which ones
  const { viewEvent } = await import('../js/views-event.js');
  const { ui } = await import('../js/uistate.js');
  Object.assign(ui.ev, { ref: 't:both:wk', day: sat, confirmDelete: true, editing: false, scope: 'one' });
  assert.match(viewEvent(store.state), /Just this one/);
  Object.assign(ui.ev, { confirmDelete: false });
});

test("the rules: an answer saved offline can't bring back a request already called off; cancelling clears both calendars", async () => {
  // once agreed (or turned down, or seen), only cancelling is left
  for (const st of ['yes', 'no', 'seen', 'cancelled']) {
    assert.equal(canPatch('sophie', 'r1', ask({ status: st }), answer(ask(), 'maybe', 'sophie')), false, st);
    assert.equal(canPatch('ethan', 'r1', ask({ status: st }), answer(ask(), 'cancel', 'ethan')), true, st);
  }
  const req = { from: 'ethan', to: 'sophie', type: 'plan', title: 'Film', hold: false, when: { day: sat, start: '19:00', end: '21:00' }, counter: { day: sat, start: '20:00', end: '22:00', label: 'x' } };
  // cancelling one this phone still thought was waiting (it had been agreed meanwhile): what was added goes too
  const c = Ops.buildAnswer({ req, id: 'r1', answer: 'cancel', me: 'ethan', byEmail: 'e@x.com', names: {} });
  assert.deepEqual(c.outbox.map((o) => [o.person, o.op, o.tag]), [['ethan', 'delete', 'req:r1'], ['sophie', 'delete', 'req:r1']]);
});

test('something agreed and then moved to another day is only on its new day, not still "saving" on the old one', () => {
  const sun = dayKey(addDays(new Date(sat + 'T12:00'), 1));
  const agreed = { from: 'ethan', to: 'sophie', type: 'plan', title: 'Cinema', status: 'yes', when: { day: sat, start: '19:00', end: '21:00', allDay: false }, created: Date.now() - 2 * 86400000, answeredAt: Date.now() - 86400000 };
  const copy = (owner) => timed(owner, 'primary', sun, '19:00', '21:00', { t: 'Cinema', tag: 'req:cin', id: `${owner}cin` });
  let st = load({ requests: { cin: agreed }, events: [copy('ethan'), copy('sophie')] });
  assert.ok(!L.dayList(st, sat).some((it) => it.title === 'Cinema'), 'not left behind on Saturday');
  assert.equal(freeAt(st, sat, '20:00'), true, 'and Saturday evening is free again');
  assert.equal(L.dayList(st, sun).filter((it) => it.title === 'Cinema').length, 1);
  // taken out in Google Calendar, after the sync has run: gone, not "saving" for ever
  st = load({ requests: { cin: agreed } });
  st.status = { a: { person: 'ethan', ok: true, lastRun: Date.now() - 60000 } };
  L.clearDayCache();
  assert.ok(!L.dayList(st, sat).some((it) => it.title === 'Cinema'));
  // just agreed, not synced yet: still shows, as saving
  st = load({ requests: { cin: Object.assign({}, agreed, { answeredAt: Date.now() - 60000 }) } });
  assert.ok(L.dayList(st, sat).some((it) => it.title === 'Cinema' && it.pending));
  // further ahead than the sync copies: shown from the request, and not "saving"
  const far = k(200);
  st = load({ requests: { cin: Object.assign({}, agreed, { when: { day: far, start: '19:00', end: '21:00', allDay: false } }) } });
  st.status = { a: { person: 'ethan', ok: true, lastRun: Date.now() - 60000 } };
  L.clearDayCache();
  const it = L.dayList(st, far).find((x) => x.title === 'Cinema');
  assert.ok(it && !it.pending && !/Saving/.test(it.sub));
});

test('the app icon reaches phones: every icon the page, the manifest and notifications use is saved for offline, and the service worker changes when one does', async () => {
  const { readFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const sw = read('sw.js');
  const shell = JSON.parse(sw.slice(sw.indexOf('const SHELL = [') + 14, sw.indexOf('];', sw.indexOf('const SHELL = [')) + 1).replace(/'/g, '"').replace(/\s+/g, ''));
  const used = new Set([
    ...JSON.parse(read('manifest.webmanifest')).icons.map((i) => i.src),
    ...[...read('index.html').matchAll(/href="(icons\/[^"]+)"/g)].map((m) => m[1]),
    ...[...sw.matchAll(/'(icons\/[^']+)'/g)].map((m) => m[1])
  ]);
  for (const u of used) assert.ok(shell.includes(`./${u}`), u);
  // a new icon only replaces the saved one when sw.js itself changes (a new VERSION): it must have changed since
  let log;
  try { log = (f) => Number(execFileSync('git', ['log', '-1', '--format=%ct', '--', f], { cwd: new URL('..', import.meta.url) }).toString().trim() || 0); log('sw.js'); } catch (e) { return; }
  const icons = Math.max(...[...used].map(log));
  const versionChanged = Number(execFileSync('git', ['log', '-1', '--format=%ct', '-G', "const VERSION = ", '--', 'sw.js'], { cwd: new URL('..', import.meta.url) }).toString().trim() || 0);
  const uncommitted = execFileSync('git', ['diff', 'HEAD', '--', 'sw.js'], { cwd: new URL('..', import.meta.url) }).toString().includes('const VERSION');
  assert.ok(uncommitted || versionChanged >= icons, 'sw.js VERSION was not changed after the icons were');
});

test('notifications name the date, not "Tomorrow": they can arrive after quiet hours, or be read the next day', async () => {
  const tomorrow = k(1);
  const w = { day: tomorrow, start: '19:00', end: '21:00', allDay: false, label: whenLabel({ day: tomorrow, start: '19:00', end: '21:00' }) };
  assert.match(w.label, /^Tomorrow/);
  const d = new Date(tomorrow + 'T12:00');
  const date = `${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()]} ${d.getDate()} `;
  load();
  const seen = [];
  store.backend = { commit: async (ops) => { seen.push(...ops.filter(Boolean)); }, ping() {} };
  await actions.createRequest({ type: 'plan', title: 'Cinema', when: w, hold: false });
  await actions.addEvent({ who: 'both', title: 'Swim', day: tomorrow, start: '10:00', end: '11:00', allDay: false });
  await actions.addJob({ title: 'Bins', who: 'sophie', day: tomorrow });
  const bodies = seen.filter((o) => o.path === 'notify').map((o) => o.data.body);
  assert.equal(bodies.length, 3);
  for (const b of bodies) { assert.doesNotMatch(b, /Today|Tomorrow/, b); assert.ok(b.includes(date), b); }
  assert.match(bodies[0], /7pm to 9pm/);
  // and the answers: another time suggested, and yes to it
  const req = { from: 'ethan', to: 'sophie', type: 'plan', title: 'Cinema', when: w, counter: w };
  for (const a of ['other', 'accept-counter']) {
    const n = Ops.buildAnswer({ req: Object.assign({}, req, { status: a === 'other' ? 'waiting' : 'other' }), id: 'r1', answer: a, me: a === 'other' ? 'sophie' : 'ethan', names: {}, when: w }).notify;
    assert.doesNotMatch(n.body, /Tomorrow/, a);
    assert.ok(n.body.includes(date), a);
  }
});

test('ticking off a job (or using an idea) your partner has just removed never brings it back as a blank one', async () => {
  load();
  // what the server has: the job and the idea are gone, removed on the other phone
  const server = { 'notes/n1': { text: 'hi' } };
  store.backend = {
    ping() {},
    async commit(ops) {
      for (const o of ops.filter(Boolean)) {
        if (o.type === 'update') server[o.path] = Object.assign({}, server[o.path] || {}, o.data); // Firestore's set with merge makes it
        else if (o.type === 'patch') { if (!server[o.path]) throw new Error('not-found'); Object.assign(server[o.path], o.data); }
        else if (o.type === 'set') server[o.path] = o.data;
      }
    }
  };
  await assert.rejects(actions.jobDone({ id: 'j1', title: 'Bins', who: 'ethan', day: k(0), repeat: { unit: 'week', every: 1 } }));
  await assert.rejects(actions.jobDone({ id: 'j2', title: 'Hoover', who: 'ethan', day: k(0) }));
  await assert.rejects(actions.updateJob('j2', { done: false }));
  await assert.rejects(actions.updateIdea('i1', { used: 1, lastUsed: 5 }));
  assert.deepEqual(Object.keys(server), ['notes/n1']);
  await actions.noteSeen('n1');
  assert.equal(server['notes/n1'].seen, true);
  // the real backend saves these as a change to what's there (which fails if it's gone), not a set with merge
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(new URL('../js/firebase.js', import.meta.url), 'utf8'), /o\.type === 'patch'\) b\.update\(ref\(o\.path\), o\.data\)/);
});

test("the rules: before you've both joined, the partner can't take the one who set it up off the list", () => {
  const db = rulesDb(); db[HH] = { emails: [EM.ethan, EM.sophie], emailsLocked: false };
  db[`${HH}/people/sophie`] = { email: EM.sophie, name: 'Sophie', settings: {} };
  const upd = (who, emails) => RULES.allowed({ method: 'update', path: HH, email: EM[who], db, data: Object.assign({}, db[HH], { emails }) });
  // Ethan set it up and can still correct Sophie's email
  assert.equal(upd('ethan', [EM.ethan, 'sophie2@gmail.com']), true);
  // Sophie (with the browser's developer tools) can't swap Ethan out for someone else
  assert.equal(upd('sophie', [EM.sophie, 'someone@gmail.com']), false);
  assert.equal(upd('sophie', ['someone@gmail.com', EM.sophie]), false);
  assert.equal(upd('sophie', [EM.sophie]), false);
});

test('dinner moved for your own shift says "you", not your own name', () => {
  const night = timed('sophie', 'rota', sat, '19:30', '08:00', { t: 'Night', e: atTime(dayKey(addDays(new Date(sat + 'T12:00'), 1)), '08:00').getTime() });
  const st = load({ events: [night] });
  const asSophie = (s) => Object.assign({}, s, { me: 'sophie', partner: 'ethan', rev: s.rev + 100000 });
  assert.match(L.buildDay(st, sat).together.find((t) => t.auto).sub, /as Sophie leaves for work/);
  assert.match(L.buildDay(asSophie(st), sat).together.find((t) => t.auto).sub, /as you leave for work/);
  // a late shift: dinner when they're home
  const late = timed('sophie', 'rota', sat, '12:30', '20:00', { t: 'Late' });
  const st2 = load({ events: [late] });
  const d1 = L.buildDay(st2, sat).together.find((t) => t.auto);
  assert.equal(d1.title, 'Dinner when Sophie is home');
  const d2 = L.buildDay(asSophie(st2), sat).together.find((t) => t.auto);
  assert.equal(d2.title, 'Dinner when you’re home');
  assert.match(d2.sub, /^You finish at 8pm/);
});

test('a birthday reminder that was ticked off can still be changed for that birthday', async () => {
  const priv = {};
  const loadB = () => setRaw({
    household: {}, people: { ethan: { name: 'Ethan', email: 'e@x.com', settings: { autoRemind: { birthdays: ['d0'] } } }, sophie: { name: 'Sophie', email: 's@x.com' } },
    calendars: { ethan__primary: { owner: 'ethan', calKey: 'primary', share: 'all', primary: true } },
    feeds: [{ owner: 'ethan', calKey: 'primary', private: true, events: [{ id: 'b1', uid: 'b1', t: "Mum's birthday", ad: 1, sd: k(0), ed: k(1) }] }],
    private: priv, privateFromServer: true, shifts: {}, requests: {}, notes: {}, outbox: {}, jobs: {}, ideas: {}, status: {}
  }, { phase: 'ready', demo: true, me: 'ethan', user: { email: 'e@x.com' } });
  // Firestore's set with merge: maps merge, so a field left out of a change stays as it was
  const merge = (a, b) => { const o = Object.assign({}, a); for (const [x, v] of Object.entries(b)) o[x] = v && typeof v === 'object' && !Array.isArray(v) && a[x] && typeof a[x] === 'object' ? merge(a[x], v) : v; return o; };
  store.backend = { ping() {}, async commit(ops) { for (const o of ops.filter(Boolean)) if (o.type === 'update' && o.path.endsWith('/private/main')) Object.assign(priv, merge(priv, o.data)); loadB(); } };
  loadB();
  const ev = store.state.events[0]; const ref = L.evRef(ev);
  assert.deepEqual(L.reminderFor(store.state, ref, ev).times, ['d0']);
  await actions.reminderDone(ref, `${ref}@${k(0)}`, "Mum's birthday");
  await actions.setReminder({ ref, owner: 'ethan', title: "Mum's birthday", times: ['w1', 'd0'], note: '' });
  const r = L.reminderFor(store.state, ref, ev);
  assert.deepEqual(r.times, ['w1', 'd0']);
  assert.equal(r.auto, false);
  assert.ok(Object.keys(r.done).length, 'and it stays ticked off for this year');
});
