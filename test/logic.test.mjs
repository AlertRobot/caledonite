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
async function loadSw({ cacheKeys = [], fetchRes = null, fetchFails = false, own = {}, other = {} } = {}) {
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
  sandbox.self = Object.assign(sandbox, { addEventListener: (n, fn) => { handlers[n] = fn; }, clients: { claim: async () => {} }, skipWaiting: () => {}, registration: {} });
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
  assert.match(cal, /changed\(\)\.hasOnly\(\['show', 'share', 'role', 'layer', 'userSet'\]\)/);
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

test("the rules: a request's asker, who it's for and whether it's just for one of you can't be changed or forged", async () => {
  const { readFileSync } = await import('node:fs');
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const rq = rules.slice(rules.indexOf('match /requests/{id}'), rules.indexOf('match /outbox/{id}'));
  assert.match(rq, /allow create: if member\(\) && personEmail\(request\.resource\.data\.from\) == myEmail\(\);/);
  assert.match(rq, /allow update: if member\(\) && !changed\(\)\.hasAny\(\['from', 'to', 'type', 'own', 'people'\]\);/);
  assert.match(rq, /allow delete: if false;/);
  // and the catch-all for shared lists no longer lets requests through
  const generic = rules.slice(rules.indexOf('match /{coll}/{id}'));
  assert.doesNotMatch(generic, /'requests'/);
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

test('offline, the service worker answers only from Caledonite’s own saved copies, and the app page only for a page', async () => {
  const lib = 'https://alertrobot.github.io/es-kitchen/data/library.json';
  const { handlers } = await loadSw({ fetchFails: true, own: { './index.html': 'APP PAGE' }, other: { [lib]: 'PECKISH COPY', './index.html': 'SOMEONE ELSE' } });
  const ask = async (url, mode) => { let p; handlers.fetch({ request: { method: 'GET', url, mode }, respondWith: (x) => { p = x; } }); return p; };
  assert.equal(await ask(lib, 'cors'), 'network error', 'not another app’s copy, and not the app page as a JSON file');
  assert.equal(await ask('https://alertrobot.github.io/caledonite/', 'navigate'), 'APP PAGE');
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
