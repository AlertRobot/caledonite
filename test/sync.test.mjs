// Checks of a few parts of the calendar sync (apps-script/Code.gs), run outside Google with a
// small stand-in for Utilities: node --test test/sync.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);

// London wall-clock <-> instants, enough for parseDate/formatDate
function parts(d, tz) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const o = {}; for (const p of f.formatToParts(d)) o[p.type] = p.value; return o;
}
const Utilities = {
  parseDate(str, tz) {
    const [date, time = '00:00:00'] = str.split(' ');
    const [y, m, d] = date.split('-').map(Number); const [h, mi, s = 0] = time.split(':').map(Number);
    let guess = Date.UTC(y, m - 1, d, h, mi, s);
    for (let i = 0; i < 2; i++) { const p = parts(new Date(guess), tz); guess -= Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Date.UTC(y, m - 1, d, h, mi, s); }
    return new Date(guess);
  },
  formatDate(d, tz, fmt) {
    const p = parts(d, tz);
    if (fmt === 'H') return String(+p.hour);
    if (fmt === 'm') return String(+p.minute);
    return fmt.replace("'T'", 'T').replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute).replace('ss', p.second);
  }
};
const ctx = vm.createContext({ Utilities, Logger: { log() {} } });
vm.runInContext(readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8'), ctx);

test('event times use the phone time zone the app sent, and London otherwise', () => {
  assert.equal(ctx.tzOf_({ tz: 'Europe/Madrid' }), 'Europe/Madrid');
  assert.equal(ctx.tzOf_({ tz: 'America/Argentina/Buenos_Aires' }), 'America/Argentina/Buenos_Aires');
  assert.equal(ctx.tzOf_({ tz: 'UTC' }), 'UTC');
  assert.equal(ctx.tzOf_({}), 'Europe/London');
  assert.equal(ctx.tzOf_({ tz: '"><script>' }), 'Europe/London');
});

test('a week of leave on the rota counts in the summaries on every day', () => {
  const p = { id: 'sophie', settings: { hasShifts: true }, mine: false, items: [{ ev: { ad: 1, sd: '2026-11-09', ed: '2026-11-14', t: 'Annual leave' }, cal: { role: 'rota' } }] };
  const data = { overrides: {}, jobs: [] };
  for (const k of ['2026-11-09', '2026-11-11', '2026-11-13']) assert.equal(ctx.personDay_(p, k, data).off, 'holiday', k);
  assert.equal(ctx.personDay_(p, '2026-11-14', data).off, '');
});

test('the day keys stay right across the clocks going back', () => {
  assert.equal(ctx.keyPlus_('2026-10-24', 1), '2026-10-25');
  assert.equal(ctx.keyPlus_('2026-10-25', 1), '2026-10-26');
  assert.equal(ctx.localTime_('2026-10-25', '09:00') - ctx.localTime_('2026-10-24', '09:00'), 25 * 3600e3); // the clocks go back early on Sunday 25 October
});

// ---------- the outbox, against a pretend Google Calendar ----------
function fakeCalendar(events = []) {
  let n = 0;
  const cal = {
    events,
    Events: {
      list(calId, q) {
        const tag = (q.privateExtendedProperty || '').replace('caledonite=', '');
        return { items: cal.events.filter((e) => e.calId === calId && (!tag || e.tag === tag)).map((e) => ({ id: e.id, status: 'confirmed', description: e.description || '' })) };
      },
      insert(res, calId) { const e = { id: `new${++n}`, calId, tag: res.extendedProperties.private.caledonite, summary: res.summary, start: res.start, end: res.end }; cal.events.push(e); return e; },
      remove(calId, id) { cal.events = cal.events.filter((e) => !(e.calId === calId && e.id === id)); },
      patch(p, calId, id) { const e = cal.events.find((x) => x.calId === calId && x.id === id); Object.assign(e, p); return e; },
      get(calId, id) { return cal.events.find((x) => x.calId === calId && x.id === id); }
    }
  };
  return cal;
}
function runOutbox(items, { calendar, appEmail = 'e@x.com', person = 'ethan' } = {}) {
  const writes = [];
  ctx.Calendar = calendar;
  ctx.CalendarApp = { getAllCalendars: () => [{ getId: () => 'primary@x', isOwnedByMe: () => true }], getDefaultCalendar: () => ({ getId: () => 'primary@x' }) };
  ctx.fsQuery_ = () => items.map((data, i) => ({ id: `o${i}`, data }));
  ctx.fsCommit_ = (w) => writes.push(...w);
  ctx.docName_ = (p) => p;
  ctx.processOutbox_({ email: appEmail, person, main: true }, { appEmail, calDocs: {} });
  return writes;
}

test('saying yes to the other time: the pencilled-in event goes, then the agreed one is added', async () => {
  globalThis.self = globalThis;
  await import('../js/ops.js');
  const Ops = globalThis.CaledoniteOps;
  const r = { from: 'ethan', to: 'sophie', type: 'plan', title: 'Cinema', hold: true, when: { day: '2026-11-06', start: '19:00', end: '21:00' }, counter: { day: '2026-11-07', start: '19:00', end: '21:00', label: 'x' }, status: 'other' };
  const res = Ops.buildAnswer({ req: r, id: 'r1', answer: 'accept-counter', me: 'ethan', byEmail: 'e@x.com', names: { ethan: 'Ethan', sophie: 'Sophie' }, now: 1000 });
  // the outbox hands them back in any order (they're all made at the same moment)
  const mine = res.outbox.filter((o) => o.person === 'ethan').reverse();
  const calendar = fakeCalendar([{ id: 'hold1', calId: 'primary@x', tag: 'req:r1', summary: 'Pencilled in: Cinema' }]);
  runOutbox(mine, { calendar });
  assert.equal(calendar.events.length, 1, 'one event left');
  assert.equal(calendar.events[0].start.dateTime.slice(0, 10), '2026-11-07', 'at the agreed time');
});

test('the other time for something added for you goes in their calendar only', async () => {
  const Ops = globalThis.CaledoniteOps;
  const r = { from: 'ethan', to: 'sophie', type: 'add', title: 'Dentist', when: { day: '2026-11-06', start: '10:00', end: '11:00' }, counter: { day: '2026-11-07', start: '10:00', end: '11:00', label: 'x' }, status: 'other' };
  const res = Ops.buildAnswer({ req: r, id: 'r2', answer: 'accept-counter', me: 'ethan', byEmail: 'e@x.com', names: {}, now: 1000 });
  assert.deepEqual(res.outbox.map((o) => o.person), ['sophie']);
  assert.ok(!res.outbox[0].both);
});

test('a change that fails holds back later changes to the same event until the next run', () => {
  const calendar = fakeCalendar([{ id: 'hold1', calId: 'primary@x', tag: 'req:r3', summary: 'Pencilled in: Walk' }]);
  const remove = calendar.Events.remove;
  calendar.Events.remove = () => { throw new Error('Backend error'); };
  const writes = runOutbox([
    { person: 'ethan', op: 'delete', tag: 'req:r3', byEmail: 'e@x.com', done: false, created: 5, seq: 0 },
    { person: 'ethan', op: 'create', tag: 'req:r3', byEmail: 'e@x.com', done: false, created: 5, seq: 1, event: { title: 'Walk', day: '2026-11-07', start: '10:00', end: '11:00' } }
  ], { calendar });
  calendar.Events.remove = remove;
  assert.equal(writes.length, 1, 'only the failed one is written (with its error)');
  assert.ok(!writes[0].update.fields.done);
});

test("your partner can't change or delete something you added just for yourself", () => {
  const calendar = fakeCalendar([
    { id: 'a1', calId: 'primary@x', tag: 'add:dentist', summary: 'Dentist' },
    { id: 'b1', calId: 'primary@x', tag: 'both:tea', summary: 'Tea' },
    { id: 'h1', calId: 'primary@x', tag: 'req:myleave', summary: 'Holiday' },
    { id: 'p1', calId: 'primary@x', tag: 'req:plan1', summary: 'Cinema' }
  ]);
  ctx.fsGet_ = (p) => ({ 'households/main/requests/myleave': { type: 'leave', own: true, people: ['ethan'] }, 'households/main/requests/plan1': { type: 'plan', from: 'sophie', to: 'ethan' } })[p] || null;
  const byPartner = (op, tag) => ({ person: 'ethan', op, tag, byEmail: 's@x.com', done: false, created: 1, changes: { title: 'Changed' } });
  const writes = runOutbox([byPartner('delete', 'add:dentist'), byPartner('update', 'add:dentist'), byPartner('delete', 'req:myleave'), byPartner('delete', 'both:tea'), byPartner('delete', 'req:plan1')], { calendar });
  assert.deepEqual(calendar.events.map((e) => e.summary), ['Dentist', 'Holiday']);
  assert.equal(writes.filter((w) => JSON.stringify(w).includes('not yours')).length, 3);
});

test('an account listed for both of you is not synced as either', () => {
  const people = [
    { id: 'ethan', data: { email: 'e@x.com', linked: ['work@x.com'] } },
    { id: 'sophie', data: { email: 's@x.com', linked: ['work@x.com', 'sophie2@x.com'] } }
  ];
  ctx.fsList_ = () => people;
  ctx.fsGet_ = () => ({});
  const as = (email) => { ctx.Session = { getEffectiveUser: () => ({ getEmail: () => email }) }; return ctx.whoAmI_(); };
  assert.throws(() => as('work@x.com'), /more than one person/);
  assert.equal(as('sophie2@x.com').person, 'sophie');
  assert.equal(as('e@x.com').person, 'ethan');
  // a second record with the same main email: never pick one of them
  people.unshift({ id: 'aaa', data: { email: 'E@x.com' } });
  assert.throws(() => as('e@x.com'), /more than one person/);
});

test('after a night shift, the sync holds notifications until the person wakes', () => {
  const L = (day, hm) => ctx.localTime_(day, hm);
  const night = { ev: { t: 'Night', s: L('2026-11-09', '19:30'), e: L('2026-11-10', '08:00') }, cal: { role: 'rota' } };
  const late = { ev: { t: 'Shift', s: L('2026-11-09', '16:00'), e: L('2026-11-10', '00:00') }, cal: { role: 'rota' } };
  const p = (items, extra = {}) => ({ id: 'sophie', settings: Object.assign({ hasShifts: true, sleepUntil: '14:00', travelMins: 30 }, extra), items, mine: false });
  const data = { overrides: {}, jobs: [] };
  assert.equal(ctx.sleepUntil_(p([night]), data, L('2026-11-10', '10:00')), L('2026-11-10', '14:00'));
  assert.equal(ctx.sleepUntil_(p([night]), data, L('2026-11-10', '08:10')), 0, 'still on the way home');
  assert.equal(ctx.sleepUntil_(p([night]), data, L('2026-11-10', '14:30')), 0, 'awake');
  assert.equal(ctx.sleepUntil_(p([night], { notif: { quiet: false } }), data, L('2026-11-10', '10:00')), 0, 'turned off');
  assert.equal(ctx.sleepUntil_(p([late]), data, L('2026-11-10', '10:00')), 0, 'a late until midnight is not a night');
  // a night put in by hand, over the rota
  assert.equal(ctx.sleepUntil_(p([]), { overrides: { 'sophie|2026-11-09': { type: 'night' } }, jobs: [] }, L('2026-11-10', '11:00')), L('2026-11-10', '14:00'));
});

test('a reminder due while asleep after nights waits', () => {
  const now = Date.now();
  const writes = [];
  ctx.fsQuery_ = (coll) => (coll === 'notify' ? [{ id: 'n1', data: { to: 'sophie', kind: 'reminders', title: 'x', sendAfter: now - 1000, sent: false }, updateTime: 't' }] : []);
  ctx.fsCommit_ = (w) => writes.push(...w);
  ctx.fsList_ = () => [];
  ctx.docName_ = (p) => p;
  const realSleep = ctx.sleepUntil_;
  ctx.sleepUntil_ = () => now + 3600e3;
  ctx.processNotify_({ people: { sophie: { settings: { hasShifts: true, quiet: { on: false } } } } });
  ctx.sleepUntil_ = realSleep;
  assert.equal(writes.length, 1);
  assert.equal(JSON.stringify(writes[0].updateMask.fieldPaths), '["sendAfter"]');
});

test('changing the day of something overnight or over several days keeps its end', () => {
  const ev = (s, e) => ({ start: { dateTime: s }, end: { dateTime: e } });
  ctx.Calendar = { Events: { get: (cal, id) => ({
    night: ev('2026-11-06T22:00:00Z', '2026-11-07T01:00:00Z'),
    conf: ev('2026-11-09T09:00:00Z', '2026-11-11T17:00:00Z')
  })[id] } };
  // the app's change for "move the late film to Saturday"
  let p = ctx.patchFor_({ day: '2026-11-07', start: '22:00', end: '01:00', endDay: '2026-11-08' }, 'c', 'night', 'Europe/London');
  assert.equal(p.start.dateTime, '2026-11-07T22:00:00');
  assert.equal(p.end.dateTime, '2026-11-08T01:00:00');
  // a three-day conference moved a week on
  p = ctx.patchFor_({ day: '2026-11-16', start: '09:00', end: '17:00', endDay: '2026-11-18' }, 'c', 'conf', 'Europe/London');
  assert.equal(p.end.dateTime, '2026-11-18T17:00:00');
  // only a new start: it keeps its length, past midnight too
  p = ctx.patchFor_({ day: '2026-11-07', start: '23:00' }, 'c', 'night', 'Europe/London');
  assert.equal(p.end.dateTime, '2026-11-08T02:00:00');
  // a plain same-day change is as before
  p = ctx.patchFor_({ day: '2026-11-07', start: '10:00', end: '11:00' }, 'c', 'night', 'Europe/London');
  assert.equal(p.end.dateTime, '2026-11-07T11:00:00');
});

test("a calendar record moved to someone else's calendar is ignored", () => {
  ctx.fsQuery_ = () => [
    { id: 'ethan__Y', data: { owner: 'ethan', calKey: 'Y', share: 'none' } },
    { id: 'sophie__X', data: { owner: 'ethan', calKey: 'Y', share: 'all' } }
  ];
  assert.equal(ctx.loadCalDocs_({ person: 'ethan' }).Y.share, 'none');
});

test('taking the rota link out removes its shifts', () => {
  const store = { h_rotalink: JSON.stringify({ 'households/main/privateFeeds/sophie__rotalink__2026-11': 'a', 'households/main/sharedFeeds/sophie__rotalink__2026-11': 'b' }), rota_rotalink: '{}', h_other: '{}' };
  ctx.PropertiesService = { getUserProperties: () => ({ getProperty: (k) => (k in store ? store[k] : null), deleteProperty: (k) => { delete store[k]; }, setProperty: (k, v) => { store[k] = v; } }) };
  const writes = [];
  ctx.fsCommit_ = (w) => writes.push(...w);
  ctx.docName_ = (p) => p;
  ctx.dropRotaLink_({ person: 'sophie' });
  assert.deepEqual(writes.map((w) => w.delete).sort(), ['households/main/calendars/sophie__rotalink', 'households/main/privateFeeds/sophie__rotalink__2026-11', 'households/main/sharedFeeds/sophie__rotalink__2026-11']);
  assert.deepEqual(Object.keys(store), ['h_other']);
  writes.length = 0;
  ctx.dropRotaLink_({ person: 'sophie' });
  assert.equal(writes.length, 0, 'nothing to do the next time');
  // and the sync calls it when there's no link
  assert.match(ctx.syncAll.toString(), /else if \(me\.main\) stage\('rota link', function \(\) \{ dropRotaLink_\(me\); \}\)/);
});

test("a calendar that's gone from Google leaves Settings after a couple of days", () => {
  const writes = [];
  ctx.fsCommit_ = (w) => writes.push(...w);
  ctx.docName_ = (p) => p;
  ctx.PropertiesService = { getUserProperties: () => ({ getProperty: () => null, getProperties: () => ({}), setProperties() {}, deleteProperty() {} }) };
  // the account still has its main calendar (read with an error here, which is fine)
  ctx.CalendarApp = { getAllCalendars: () => [{ getId: () => 'p@x', getName: () => 'Main' }], getDefaultCalendar: () => ({ getId: () => 'p@x' }) };
  const old = Date.now() - 5 * 864e5;
  // work@x.com is another of your accounts, still in Caledonite: its records are its own to tidy up
  ctx.syncCalendars_({ email: 'e@x.com', person: 'ethan', main: true, people: [{ id: 'ethan', data: { email: 'e@x.com', linked: ['work@x.com'] } }] }, { calDocs: {
    gone: { account: 'e@x.com', lastSeen: old }, recent: { account: 'e@x.com', lastSeen: Date.now() - 3600e3 },
    other: { account: 'work@x.com', lastSeen: old }, rotalink: { account: 'Rota link', lastSeen: old }
  } }, []);
  assert.deepEqual(writes.map((w) => w.delete), ['households/main/calendars/ethan__gone']);
});

test('an account taken out in the app takes its calendars out and stops syncing', () => {
  const people = [{ id: 'ethan', data: { email: 'e@x.com', linked: [] } }];
  ctx.fsList_ = () => people;
  ctx.fsGet_ = () => ({});
  ctx.Session = { getEffectiveUser: () => ({ getEmail: () => 'Work@X.com' }) };
  const store = { h_abc: JSON.stringify({ 'households/main/privateFeeds/ethan__abc__2026-11': 'h', 'households/main/sharedFeeds/ethan__abc__2026-11': 'h' }), rem_fired: '{}' };
  ctx.PropertiesService = { getUserProperties: () => ({ getProperties: () => Object.assign({}, store), deleteAllProperties: () => { for (const k of Object.keys(store)) delete store[k]; } }) };
  ctx.LockService = { getUserLock: () => ({ tryLock: () => true, releaseLock() {} }), getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) };
  ctx.CacheService = { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) };
  const writes = []; let triggersRemoved = false;
  ctx.fsCommit_ = (w) => writes.push(...w);
  ctx.fsQuery_ = (coll, eq) => (coll === 'calendars' && eq[0][1] === 'work@x.com' ? [{ id: 'ethan__abc', data: {} }] : []);
  ctx.docName_ = (p) => p;
  ctx.ScriptApp = { getProjectTriggers: () => [{ getHandlerFunction: () => 'syncAll' }], deleteTrigger: () => { triggersRemoved = true; } };
  assert.throws(() => ctx.syncAll(), /not part of Caledonite/);
  assert.deepEqual(writes.map((w) => w.delete).sort(), ['households/main/calendars/ethan__abc', 'households/main/privateFeeds/ethan__abc__2026-11', 'households/main/sharedFeeds/ethan__abc__2026-11', 'households/main/status/work_x_com']);
  assert.ok(triggersRemoved);
  assert.deepEqual(Object.keys(store), []);
  // a household that can't be read at all is never taken as being taken out
  people.length = 0; writes.length = 0; triggersRemoved = false;
  assert.throws(() => ctx.syncAll(), /not part of Caledonite/);
  assert.equal(writes.length, 0);
  assert.equal(triggersRemoved, false);
});

test('"Just this one" of something repeating made in the app changes or deletes only that occurrence', () => {
  const calendar = fakeCalendar([{ id: 'm1', calId: 'primary@x', tag: 'both:wk', summary: 'Date night', start: { dateTime: '2026-11-06T19:00:00+00:00' }, end: { dateTime: '2026-11-06T21:00:00+00:00' } }]);
  const removed = []; const patched = [];
  calendar.Events.remove = (calId, id) => { removed.push(id); };
  calendar.Events.patch = (p, calId, id) => { patched.push(id); };
  calendar.Events.get = (calId, id) => ({ start: { dateTime: '2026-11-13T19:00:00+00:00' }, end: { dateTime: '2026-11-13T21:00:00+00:00' } });
  runOutbox([
    { person: 'ethan', op: 'delete', tag: 'both:wk', inst: '20261120T190000Z', byEmail: 'e@x.com', done: false, created: 1 },
    { person: 'ethan', op: 'update', tag: 'both:wk', inst: '20261113T190000Z', changes: { start: '20:00' }, byEmail: 'e@x.com', done: false, created: 2 }
  ], { calendar });
  assert.deepEqual(removed, ['m1_20261120T190000Z']);
  assert.deepEqual(patched, ['m1_20261113T190000Z']);
  // without it, the whole series, as before
  runOutbox([{ person: 'ethan', op: 'delete', tag: 'both:wk', byEmail: 'e@x.com', done: false, created: 3 }], { calendar });
  assert.deepEqual(removed, ['m1_20261120T190000Z', 'm1']);
});

test('an occurrence that has already gone is not an error', () => {
  const calendar = fakeCalendar([{ id: 'm2', calId: 'primary@x', tag: 'add:gym', summary: 'Gym' }]);
  calendar.Events.remove = () => { throw new Error('API call to calendar.events.delete failed with error: Resource has been deleted'); };
  const writes = runOutbox([{ person: 'ethan', op: 'delete', tag: 'add:gym', inst: '20261120', byEmail: 'e@x.com', done: false, created: 1 }], { calendar });
  assert.equal(writes[0].update.fields.done.booleanValue, true);
});

test('reminders kept where only their owner can read them still go off', () => {
  const now = Date.now();
  const props = {};
  ctx.PropertiesService = { getUserProperties: () => ({ getProperty: (k) => props[k] ?? null, setProperty: (k, v) => { props[k] = v; } }) };
  ctx.Utilities.getUuid = () => 'u' + Math.random();
  const writes = [];
  ctx.fsCommit_ = (w) => writes.push(...w);
  ctx.docName_ = (p) => p;
  ctx.fsGet_ = (path) => (path === 'households/main/people/ethan/private/main'
    ? { reminders: { r1: { ref: 'e:ethan:primary:u1', owner: 'ethan', times: ['h1'], note: '' } } } : null);
  const me = { person: 'ethan', email: 'e@x.com', main: true, people: [{ id: 'ethan', data: { settings: {} } }] };
  const seen = [{ calKey: 'primary', shown: true, share: 'all', doc: { share: 'all' }, ev: { id: 'e1', uid: 'u1', t: 'Dentist', s: now + 30 * 60e3, e: now + 90 * 60e3 } }];
  ctx.fireReminders_(me, {}, seen);
  const n = writes.map((w) => w.update.fields).find((f) => f.kind && f.kind.stringValue === 'reminders');
  assert.ok(n, 'the reminder was sent');
  assert.equal(n.title.stringValue, 'Dentist');
});

test('the rules: what is just for you (reminders, private countdowns) only you can read', async () => {
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const pv = rules.slice(rules.indexOf('match /private/{doc}'));
  assert.match(pv.slice(0, 200), /allow read, write: if member\(\) && personEmail\(pid\) == myEmail\(\);/);
  // and the app keeps reminders there, not on the record your partner can read
  const store = readFileSync(new URL('../js/store.js', import.meta.url), 'utf8');
  const sr = store.slice(store.indexOf('async setReminder('), store.indexOf('async removeReminder('));
  assert.match(sr, /path: privatePath\(\)/);
});

test("your partner's asks are done by your main account only, never one they pick (like your work account)", () => {
  const calendar = fakeCalendar([]);
  const item = { person: 'ethan', op: 'create', tag: 'both:x', byEmail: 's@x.com', account: 'ethan@work.com', done: false, created: 1, event: { title: 'Tea', day: '2026-11-07', start: '10:00', end: '11:00' } };
  ctx.Calendar = calendar;
  ctx.CalendarApp = { getAllCalendars: () => [{ getId: () => 'primary@x', isOwnedByMe: () => true }], getDefaultCalendar: () => ({ getId: () => 'primary@x' }) };
  ctx.fsQuery_ = () => [{ id: 'o1', data: item }];
  ctx.fsCommit_ = () => {};
  ctx.processOutbox_({ email: 'ethan@work.com', person: 'ethan', main: false }, { appEmail: 'e@x.com', calDocs: {} });
  assert.equal(calendar.events.length, 0, 'not by the work account');
  ctx.processOutbox_({ email: 'e@x.com', person: 'ethan', main: true }, { appEmail: 'e@x.com', calDocs: {} });
  assert.equal(calendar.events.length, 1, 'by the main one');
  // your own asks still go to the account you chose
  const own = Object.assign({}, item, { byEmail: 'e@x.com', tag: 'add:y' });
  ctx.fsQuery_ = () => [{ id: 'o2', data: own }];
  ctx.processOutbox_({ email: 'ethan@work.com', person: 'ethan', main: false }, { appEmail: 'e@x.com', calDocs: {} });
  assert.equal(calendar.events.length, 2);
});

test('a notification for someone who is not one of you is never sent', () => {
  const writes = []; const listed = [];
  ctx.fsQuery_ = (coll) => (coll === 'notify' ? [{ id: 'n1', data: { to: 'ethan/tokens/../../x', kind: 'test', title: 'x', sendAfter: 0, sent: false }, updateTime: 't' }] : []);
  ctx.fsCommit_ = (w) => writes.push(...w);
  ctx.fsList_ = (p) => { listed.push(p); return []; };
  ctx.docName_ = (p) => p;
  ctx.processNotify_({ people: { ethan: { settings: {} }, sophie: { settings: {} } } });
  assert.deepEqual(listed, []);
  assert.equal(writes[0].update.fields.sent.booleanValue, true);
});

test('Google returning no calendars at all does not empty your calendars in the app', () => {
  ctx.CalendarApp = { getAllCalendars: () => [], getDefaultCalendar: () => ({ getId: () => 'primary@x' }) };
  const writes = [];
  ctx.fsCommit_ = (w) => writes.push(...w);
  ctx.PropertiesService = { getUserProperties: () => ({ getProperties: () => ({ h_abc: JSON.stringify({ 'households/main/privateFeeds/ethan__abc__2026-11': 'h' }) }), getProperty: () => null, setProperties() {}, deleteProperty() {} }) };
  assert.throws(() => ctx.syncCalendars_({ person: 'ethan', email: 'e@x.com', main: true }, { calDocs: {} }, []), /no calendars/);
  assert.equal(writes.length, 0);
});

test("job reminders read only today's open jobs", () => {
  const asked = [];
  ctx.fsQuery_ = (coll, eqs) => { asked.push([coll, eqs]); return []; };
  ctx.fsList_ = () => { throw new Error('should not list every job'); };
  ctx.PropertiesService = { getUserProperties: () => ({ getProperty: () => null, setProperty() {} }) };
  ctx.processJobs_({ person: 'ethan', email: 'e@x.com', main: true }, { settings: {}, people: { ethan: {}, sophie: {} } });
  assert.equal(asked[0][0], 'jobs');
  assert.deepEqual(JSON.parse(JSON.stringify(asked[0][1].map((f) => f[0]))), ['done', 'day']);
});

test('a night shift put in by hand on the night the clocks change still ends at 8am', () => {
  // the clocks go forward early on Sunday 28 March 2027
  const p = { id: 'sophie', settings: { hasShifts: true }, items: [], mine: false };
  const data = { overrides: { 'sophie|2027-03-27': { type: 'night' } }, jobs: [] };
  const sh = ctx.personDay_(p, '2027-03-27', data).shift;
  assert.equal(sh.e, ctx.localTime_('2027-03-28', '08:00'));
});

// The rules for notifications, read as text (there's no Firestore emulator here): Peckish's meal reminders
// ("pk-" ids) can be checked, kept up to date and taken back while waiting; nothing else can be read or changed.
function notifyRules() {
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const block = rules.slice(rules.indexOf('match /notify/{id} {'));
  const fn = rules.slice(rules.indexOf('function okNotify(id) {'));
  return { block: block.slice(0, block.indexOf('\n      }\n')), fn: fn.slice(0, fn.indexOf('\n      }\n')) };
}
test("the rules let Peckish keep its own waiting reminders up to date, and nothing more", () => {
  const { block, fn } = notifyRules();
  const allow = (what) => (block.match(new RegExp(`allow ${what}: if ([^;]+);`)) || [])[1] || '';
  assert.match(allow('create'), /member\(\) && okNotify\(id\)/);
  // reading: one at a time, Peckish's only (Caledonite's own ids never start with "pk-"); never a list
  assert.match(allow('get'), /id\.matches\('pk-\.\*'\)/);
  assert.match(allow('list'), /^false$/);
  // changing or taking back: Peckish's only, only while waiting, for the same person, in the same shape
  for (const w of ['update', 'delete']) {
    assert.match(allow(w), /id\.matches\('pk-\.\*'\)/, w);
    assert.match(allow(w), /resource\.data\.sent == false/, w);
  }
  assert.match(allow('update'), /okNotify\(id\) && request\.resource\.data\.to == resource\.data\.to/);
  // what goes in: never already "sent"; only kinds the settings know; a test only for yourself;
  // Peckish's are always reminders, with just the fields Peckish writes
  assert.match(fn, /request\.resource\.data\.sent == false/);
  assert.match(fn, /kind in \['requests', 'rota', 'notes', 'reminders', 'jobs', 'summary', 'test'\]/);
  assert.match(fn, /kind != 'test' \|\| personEmail\(request\.resource\.data\.to\) == myEmail\(\)/);
  assert.match(fn, /!id\.matches\('pk-\.\*'\) \|\| \(request\.resource\.data\.kind == 'reminders'/);
  const fields = JSON.parse((fn.match(/keys\(\)\.hasOnly\((\[[^\]]+\])\)/) || [])[1].replace(/'/g, '"'));
  // exactly what Peckish's Store.cal.notify saves
  const peckish = { to: 'sophie', kind: 'reminders', title: 'Dinner tonight', body: '30 minutes.', link: '../es-kitchen/', sendAfter: 1, sent: false, created: 1 };
  assert.deepEqual(Object.keys(peckish).filter((k) => !fields.includes(k)), []);
  // and every kind the app and the service worker create is still allowed
  const kinds = JSON.parse(fn.match(/kind in (\[[^\]]+\])/)[1].replace(/'/g, '"'));
  const src = ['../js/store.js', '../js/ops.js'].map((f) => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
  for (const k of new Set([...src.matchAll(/kind: '([a-z]+)'/g)].map((m) => m[1]).concat([...src.matchAll(/'#[a-z/]+', '([a-z]+)'/g)].map((m) => m[1])))) assert.ok(kinds.includes(k), k);
});

// Script properties hold at most about 9 KB each
function smallProps(init = {}) {
  const store = Object.assign({}, init);
  return { store, api: { getProperty: (k) => (k in store ? store[k] : null), setProperty: (k, v) => { if (String(v).length > 9216) throw new Error('Argument too large: value'); store[k] = String(v); }, deleteProperty: (k) => { delete store[k]; } } };
}
test('a job reminder goes once, even after weeks of daily jobs, never again every 10 minutes', () => {
  const now = Date.now();
  const today = ctx.Utilities.formatDate(new Date(now), 'Europe/London', 'yyyy-MM-dd');
  // six weeks of four daily jobs already sent
  const old = {};
  for (let d = 1; d <= 38; d++) for (let j = 0; j < 4; j++) old[`ethan|job${j}xxxxxxxxxxxxxxxx|day-${d}`] = now - d * 864e5;
  const { store, api } = smallProps({ job_sent: JSON.stringify(old) });
  ctx.PropertiesService = { getUserProperties: () => api };
  ctx.Utilities.getUuid = () => 'u' + Math.random();
  const sent = [];
  ctx.fsCommit_ = (w) => sent.push(...w);
  ctx.docName_ = (p) => p;
  ctx.fsQuery_ = () => [{ id: 'bins', data: { title: 'Bins', who: 'ethan', day: today, done: false, time: '00:00' } }];
  const run = () => { try { ctx.processJobs_({ person: 'ethan', email: 'e@x.com', main: true }, { settings: {}, people: { ethan: {}, sophie: {} } }); } catch (e) { /* a stage error */ } };
  run(); run(); run();
  assert.equal(sent.length, 1, 'sent once');
  assert.ok(store.job_sent.length < 2000, 'only the last couple of days are kept');
  // and when the list can't be saved at all, nothing is sent (rather than the same one over and over)
  sent.length = 0;
  api.setProperty = () => { throw new Error('Argument too large: value'); };
  ctx.fsQuery_ = () => [{ id: 'hoover', data: { title: 'Hoover', who: 'ethan', day: today, done: false, time: '00:00' } }];
  run(); run();
  assert.equal(sent.length, 0);
});

test('a reminder whose notification could not be saved is tried again next time', () => {
  const now = Date.now();
  const { store, api } = smallProps();
  ctx.PropertiesService = { getUserProperties: () => api };
  let fail = true; const sent = [];
  ctx.fsCommit_ = (w) => { if (fail) throw new Error('Firestore 503'); sent.push(...w); };
  ctx.fsGet_ = (path) => (path === 'households/main/people/ethan/private/main' ? { reminders: { r1: { ref: 'e:ethan:primary:u1', owner: 'ethan', times: ['h1'], note: '' } } } : null);
  const me = { person: 'ethan', email: 'e@x.com', main: true, people: [{ id: 'ethan', data: { settings: {} } }] };
  const seen = [{ calKey: 'primary', shown: true, share: 'all', doc: { share: 'all' }, ev: { id: 'e1', uid: 'u1', t: 'Dentist', s: now + 30 * 60e3, e: now + 90 * 60e3 } }];
  assert.throws(() => ctx.fireReminders_(me, {}, seen), /503/);
  assert.equal(store.rem_fired, undefined, 'not marked as sent');
  fail = false;
  ctx.fireReminders_(me, {}, seen);
  ctx.fireReminders_(me, {}, seen);
  assert.equal(sent.length, 1);
});

test("rota change notifications show your partner only what the rota's sharing lets them see", () => {
  const now = Date.now();
  const L = (ms) => ctx.Utilities.formatDate(new Date(ms), 'Europe/London', 'yyyy-MM-dd');
  const day = L(now + 3 * 864e5);
  const shift = (t, s, e) => ({ t, s: ctx.localTime_(day, s), e: ctx.localTime_(day, e) });
  const run = (share, before, after) => {
    const { api } = smallProps();
    ctx.PropertiesService = { getUserProperties: () => api };
    ctx.Utilities.getUuid = () => 'u' + Math.random();
    const writes = [];
    ctx.fsCommit_ = (w) => writes.push(...w);
    ctx.docName_ = (p) => p;
    const c = { person: { name: 'Sophie' }, people: { sophie: {}, ethan: {} } };
    const me = { person: 'sophie' };
    ctx.rotaChanged_(me, c, 'rota', before, api, { share });
    ctx.rotaChanged_(me, c, 'rota', after, api, { share });
    return writes.map((w) => w.update.fields.body.stringValue);
  };
  const before = [shift('Ward 7 cover', '07:30', '20:00')];
  const moved = [shift('Ward 7 cover', '08:00', '20:00')];
  const renamed = [shift('Ward 9 cover', '07:30', '20:00')];
  assert.match(run('all', before, moved)[0], /long day changed/);
  assert.deepEqual(run('none', before, moved), [], 'shared as Nothing: no notification');
  const busy = run('busy', before, moved);
  assert.equal(busy.length, 1);
  assert.doesNotMatch(busy[0], /Ward/);
  assert.deepEqual(run('busy', before, renamed), [], 'a new name only is not news when shared as Busy');
});

test("a calendar two of your accounts can see: the one that isn't syncing it never deletes what the other wrote", () => {
  const U = ctx.Utilities;
  const crypto = require_('node:crypto');
  U.computeDigest = (alg, s) => [...crypto.createHash('md5').update(s, 'utf8').digest()];
  U.base64EncodeWebSafe = (b) => Buffer.from(b).toString('base64url');
  U.DigestAlgorithm = { MD5: 'md5' }; U.Charset = { UTF_8: 'utf8' };
  const calId = 'ethan@work.example';
  const key = ctx.shortKey_(calId);
  const paths = { [`households/main/privateFeeds/ethan__${key}__2026-11`]: 'h', [`households/main/sharedFeeds/ethan__${key}__2026-11`]: 'h' };
  const sync = (lastSeen) => {
    const store = { [`h_${key}`]: JSON.stringify(paths) };
    ctx.PropertiesService = { getUserProperties: () => ({ getProperty: (k) => store[k] ?? null, getProperties: () => Object.assign({}, store), setProperties: (o) => Object.assign(store, o), deleteProperty: (k) => { delete store[k]; } }) };
    ctx.CalendarApp = { getAllCalendars: () => [{ getId: () => calId, getName: () => 'Work', getColor: () => '#123456', isOwnedByMe: () => false }], getDefaultCalendar: () => ({ getId: () => 'e@x.com' }) };
    ctx.Calendar = { Events: { list: () => ({ items: [] }) } };
    const writes = [];
    ctx.fsCommit_ = (w) => writes.push(...w);
    ctx.docName_ = (p) => p;
    ctx.syncCalendars_({ email: 'e@x.com', person: 'ethan', main: true }, { appEmail: 'e@x.com', calDocs: {
      [key]: { owner: 'ethan', calKey: key, calId, name: 'Work', color: '#123456', canWrite: false, primary: false, account: 'ethan@work.example', lastSeen, show: true, share: 'none', role: 'work', layer: 'own', userSet: true }
    } }, []);
    return { writes, store };
  };
  // the work account synced it an hour ago: leave its copies alone, and stop remembering them here
  let r = sync(Date.now() - 3600e3);
  assert.deepEqual(r.writes.filter((w) => w.delete), []);
  assert.equal(r.store[`h_${key}`], undefined);
  // the work account hasn't seen it for half a day: this one takes over, keeping what you chose
  r = sync(Date.now() - 13 * 3600e3);
  const rec = r.writes.find((w) => w.update && w.update.name === `households/main/calendars/ethan__${key}`);
  assert.ok(rec, 'taken over');
  assert.equal(rec.update.fields.account.stringValue, 'e@x.com');
  assert.ok(!rec.updateMask.fieldPaths.includes('share'), 'its sharing choice is kept');
});

test('two changes to one of your own events: if the first fails, the second waits for it', () => {
  const patched = [];
  let fail = true;
  const calendar = { Events: {
    get: () => ({ start: { dateTime: '2026-11-06T10:00:00Z' }, end: { dateTime: '2026-11-06T11:00:00Z' } }),
    patch: (p, calId, id) => { if (fail) { fail = false; throw new Error('Rate Limit Exceeded'); } patched.push(p.start.dateTime); },
    list: () => ({ items: [] })
  } };
  const edit = (start, created) => ({ person: 'ethan', op: 'edit', calId: 'primary@x', gid: 'g1', changes: { day: '2026-11-06', start, end: '23:00' }, byEmail: 'e@x.com', done: false, created });
  runOutbox([edit('20:00', 1), edit('21:00', 2)], { calendar });
  assert.deepEqual(patched, [], 'the later change waits');
  runOutbox([edit('20:00', 1), edit('21:00', 2)], { calendar });
  assert.deepEqual(patched, ['2026-11-06T20:00:00', '2026-11-06T21:00:00'], 'then both, in order: the later one wins');
});

test('changes are done in the order they reached the database, whatever the phones’ clocks said', () => {
  const calendar = fakeCalendar([]);
  // Sophie's "can't" was saved after Ethan's request reached the database, but her phone's clock is behind
  const items = [
    { person: 'ethan', op: 'delete', tag: 'req:r9', byEmail: 'e@x.com', done: false, created: 900, seq: 0 },
    { person: 'ethan', op: 'create', tag: 'req:r9', byEmail: 'e@x.com', done: false, created: 1000, event: { title: 'Pencilled in: Walk', day: '2026-11-07', start: '10:00', end: '11:00' } }
  ];
  const times = ['2026-10-26T10:00:05.5Z', '2026-10-26T10:00:01.123456Z'];
  ctx.Calendar = calendar;
  ctx.CalendarApp = { getAllCalendars: () => [{ getId: () => 'primary@x', isOwnedByMe: () => true }], getDefaultCalendar: () => ({ getId: () => 'primary@x' }) };
  ctx.fsQuery_ = () => items.map((data, i) => ({ id: `o${i}`, data, createTime: times[i] }));
  ctx.fsCommit_ = () => {};
  ctx.docName_ = (p) => p;
  ctx.processOutbox_({ email: 'e@x.com', person: 'ethan', main: true }, { appEmail: 'e@x.com', calDocs: {} });
  assert.equal(calendar.events.length, 0, 'the pencilled-in event was added, then taken out');
});

// ---------- round 5 checks ----------
function withDigest() {
  const U = ctx.Utilities;
  const crypto = require_('node:crypto');
  U.computeDigest = (alg, s) => [...crypto.createHash('md5').update(s, 'utf8').digest()];
  U.base64EncodeWebSafe = (b) => Buffer.from(b).toString('base64url');
  U.DigestAlgorithm = { MD5: 'md5' }; U.Charset = { UTF_8: 'utf8' };
  U.getUuid = () => 'u' + Math.random();
}

test('an event marked Private in Google Calendar is only "Busy" in your partner\'s copy, even from a calendar shared as Everything', () => {
  withDigest();
  const ev = (visibility) => ctx.normApi_({ id: 'g1', iCalUID: 'g1@google.com', summary: 'Hospital appointment', location: 'Ward 7', visibility, start: { dateTime: '2026-11-06T10:00:00Z' }, end: { dateTime: '2026-11-06T11:00:00Z' } });
  for (const v of ['private', 'confidential']) {
    const shared = ctx.shareFilter_({ share: 'all' }, [ev(v)]);
    assert.equal(shared[0].t, 'Busy', v);
    assert.equal(shared[0].l, undefined, v);
  }
  assert.equal(ctx.shareFilter_({ share: 'all' }, [ev('default')])[0].t, 'Hospital appointment');
  // and the same when the slow way (CalendarApp) is used
  ctx.CalendarApp = { Visibility: { PRIVATE: 'P', CONFIDENTIAL: 'C', DEFAULT: 'D' }, GuestStatus: { NO: 'NO' } };
  const old = { getMyStatus: () => null, getDescription: () => '', getStartTime: () => new Date('2026-11-06T10:00:00Z'), getEndTime: () => new Date('2026-11-06T11:00:00Z'), getId: () => 'x@google.com', getTitle: () => 'Hospital appointment', isRecurringEvent: () => false, isAllDayEvent: () => false, getLocation: () => '', getVisibility: () => 'P' };
  assert.equal(ctx.shareFilter_({ share: 'all' }, [ctx.norm_(old)])[0].t, 'Busy');
});
test('a rota shift marked Private: a change to its name alone is not sent to your partner', () => {
  withDigest();
  const now = Date.now();
  const day = ctx.Utilities.formatDate(new Date(now + 3 * 864e5), 'Europe/London', 'yyyy-MM-dd');
  const { api } = smallProps();
  ctx.PropertiesService = { getUserProperties: () => api };
  const writes = [];
  ctx.fsCommit_ = (w) => writes.push(...w);
  ctx.docName_ = (p) => p;
  const sh = (t) => [{ t, pb: 1, s: ctx.localTime_(day, '07:30'), e: ctx.localTime_(day, '20:00') }];
  const c = { person: { name: 'Sophie' }, people: { sophie: {}, ethan: {} } };
  ctx.rotaChanged_({ person: 'sophie' }, c, 'rota', sh('Clinic A'), api, { share: 'all' });
  ctx.rotaChanged_({ person: 'sophie' }, c, 'rota', sh('Clinic B'), api, { share: 'all' });
  assert.equal(writes.length, 0);
});

function fakeProps(init = {}) {
  const store = Object.assign({}, init);
  return { store, api: { getProperty: (k) => (k in store ? store[k] : null), getProperties: () => Object.assign({}, store), setProperty: (k, v) => { store[k] = String(v); }, setProperties: (o) => Object.assign(store, o), deleteProperty: (k) => { delete store[k]; }, deleteAllProperties: () => { for (const k of Object.keys(store)) delete store[k]; } } };
}
function asUser(email, active = email) {
  ctx.Session = { getEffectiveUser: () => ({ getEmail: () => email }), getActiveUser: () => ({ getEmail: () => active }) };
}

test('"Stop syncing this account" takes its copies out too, so none are left that no longer follow your sharing', () => {
  asUser('work@x.com');
  const { store, api } = fakeProps({ h_abc: JSON.stringify({ 'households/main/privateFeeds/ethan__abc__2026-11': 'h', 'households/main/sharedFeeds/ethan__abc__2026-11': 'h' }), rota_abc: '{}', rem_fired: '{"k":1}' });
  ctx.PropertiesService = { getUserProperties: () => api };
  ctx.LockService = { getUserLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }), getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) };
  ctx.CacheService = { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) };
  let removed = 0;
  ctx.ScriptApp = { getProjectTriggers: () => [{ getHandlerFunction: () => 'syncAll' }], deleteTrigger: () => { removed++; } };
  const writes = [];
  ctx.fsCommit_ = (w) => writes.push(...w);
  ctx.docName_ = (p) => p;
  ctx.disconnectFromPage();
  assert.equal(removed, 1);
  assert.deepEqual(writes.map((w) => w.delete).sort(), ['households/main/privateFeeds/ethan__abc__2026-11', 'households/main/sharedFeeds/ethan__abc__2026-11', 'households/main/status/work_x_com']);
  assert.deepEqual(Object.keys(store), ['rem_fired'], 'what was already sent is still remembered');
});

test('a ping never syncs an account that has stopped syncing', () => {
  let synced = 0;
  const realSync = ctx.syncAll;
  ctx.syncAll = () => { synced++; return 'ok'; };
  const cache = {};
  ctx.CacheService = { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; }, remove: (k) => { delete cache[k]; } }) };
  ctx.fsGet_ = () => ({ pingSecret: 's3cret' });
  ctx.ContentService = { createTextOutput: (t) => ({ t, setMimeType() { return this; } }), MimeType: { TEXT: 'text' } };
  let triggers = [];
  ctx.ScriptApp = { getProjectTriggers: () => triggers };
  const post = () => ctx.doPost({ postData: { contents: JSON.stringify({ secret: 's3cret' }) } });
  post();
  assert.equal(synced, 0);
  delete cache.last_ping;
  triggers = [{ getHandlerFunction: () => 'syncAll' }];
  post();
  assert.equal(synced, 1);
  ctx.syncAll = realSync;
});

test('an account taken out in the app that can no longer run: your main account takes its calendars out', () => {
  withDigest();
  const { api } = fakeProps();
  ctx.PropertiesService = { getUserProperties: () => api };
  ctx.CalendarApp = { getAllCalendars: () => [{ getId: () => 'p@x', getName: () => 'Main' }], getDefaultCalendar: () => ({ getId: () => 'p@x' }) };
  const writes = [];
  ctx.fsCommit_ = (w) => writes.push(...w);
  ctx.docName_ = (p) => p;
  ctx.fsQuery_ = (coll, eqs) => {
    const calKey = (eqs.find((f) => f[0] === 'calKey') || [])[1];
    return ['privateFeeds', 'sharedFeeds'].includes(coll) && calKey ? [{ id: `ethan__${calKey}__2026-11`, data: {} }] : [];
  };
  const old = Date.now() - 3 * 864e5;
  const me = { email: 'e@x.com', person: 'ethan', main: true, people: [{ id: 'ethan', data: { email: 'e@x.com', linked: ['work@x.com'] } }] };
  ctx.syncCalendars_(me, { hh: {}, calDocs: {
    gone: { account: 'old@x.com', lastSeen: old },
    listed: { account: 'work@x.com', lastSeen: old },
    recent: { account: 'old2@x.com', lastSeen: Date.now() - 3600e3 }
  } }, []);
  assert.deepEqual(writes.map((w) => w.delete).filter(Boolean).sort(), ['households/main/calendars/ethan__gone', 'households/main/privateFeeds/ethan__gone__2026-11', 'households/main/sharedFeeds/ethan__gone__2026-11']);
  // only your main account does this
  writes.length = 0;
  ctx.syncCalendars_(Object.assign({}, me, { main: false, email: 'work@x.com' }), { hh: {}, calDocs: { gone: { account: 'old@x.com', lastSeen: old } } }, []);
  assert.deepEqual(writes.filter((w) => w.delete), []);
});

test('taking over a calendar from another of your accounts also takes out the months only that account had written', () => {
  withDigest();
  const calId = 'ethan@work.example';
  const key = ctx.shortKey_(calId);
  const { store, api } = fakeProps();
  ctx.PropertiesService = { getUserProperties: () => api };
  ctx.CalendarApp = { getAllCalendars: () => [{ getId: () => calId, getName: () => 'Work', getColor: () => '#123456', isOwnedByMe: () => false }], getDefaultCalendar: () => ({ getId: () => 'e@x.com' }) };
  const s = ctx.localTime_('2026-11-10', '09:00');
  ctx.Calendar = { Events: { list: () => ({ items: [{ id: 'g1', iCalUID: 'g1@x', summary: 'Standup', start: { dateTime: new Date(s).toISOString() }, end: { dateTime: new Date(s + 3600e3).toISOString() } }] }) } };
  const writes = [];
  ctx.fsCommit_ = (w) => writes.push(...w);
  ctx.docName_ = (p) => p;
  // what the work account had written: November, and a January with an event since deleted
  ctx.fsQuery_ = (coll, eqs) => (['privateFeeds', 'sharedFeeds'].includes(coll) ? ['2026-11', '2027-01'].map((m) => ({ id: `ethan__${key}__${m}`, data: {} })) : []);
  ctx.syncCalendars_({ email: 'e@x.com', person: 'ethan', main: true, people: [{ id: 'ethan', data: { email: 'e@x.com', linked: ['ethan@work.example'] } }] }, { appEmail: 'e@x.com', hh: {}, calDocs: {
    [key]: { owner: 'ethan', calKey: key, calId, name: 'Work', color: '#123456', canWrite: false, primary: false, account: 'ethan@work.example', lastSeen: Date.now() - 13 * 3600e3, show: true, share: 'all', role: 'work', layer: 'own', userSet: true }
  } }, []);
  assert.deepEqual(writes.map((w) => w.delete).filter(Boolean).sort(), [`households/main/privateFeeds/ethan__${key}__2027-01`, `households/main/sharedFeeds/ethan__${key}__2027-01`]);
  assert.ok(writes.some((w) => w.update && w.update.name === `households/main/sharedFeeds/ethan__${key}__2026-11`), 'November is written again');
  assert.ok(store[`h_${key}`]);
});

test('someone who was never part of Caledonite opening the connect page writes nothing', () => {
  ctx.fsList_ = () => [{ id: 'ethan', data: { email: 'e@x.com', linked: [] } }];
  ctx.fsGet_ = () => ({});
  asUser('stranger@x.com');
  const { api } = fakeProps();
  ctx.PropertiesService = { getUserProperties: () => api };
  ctx.LockService = { getUserLock: () => ({ tryLock: () => true, releaseLock() {} }), getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) };
  ctx.ScriptApp = { getProjectTriggers: () => [], deleteTrigger() {} };
  const writes = [];
  ctx.fsCommit_ = (w) => writes.push(...w);
  let queried = 0;
  ctx.fsQuery_ = () => { queried++; return []; };
  assert.throws(() => ctx.syncAll(), /not part of Caledonite/);
  assert.equal(writes.length, 0);
  assert.equal(queried, 0);
});

test('deleting every time of something repeating that had one time changed: done in one go, not an error', () => {
  // Google lists the changed time (an exception) next to the series; deleting the series takes it too
  const calendar = fakeCalendar([
    { id: 'm1', calId: 'primary@x', tag: 'both:wk', summary: 'Date night' },
    { id: 'm1_20261113T190000Z', calId: 'primary@x', tag: 'both:wk', summary: 'Date night (moved)' }
  ]);
  calendar.Events.remove = (calId, id) => {
    if (!calendar.events.some((e) => e.id === id)) throw new Error('API call to calendar.events.delete failed with error: Resource has been deleted');
    calendar.events = calendar.events.filter((e) => !(e.id === id || e.id.startsWith(id + '_')));
  };
  const patched = [];
  calendar.Events.patch = (p, calId, id) => { patched.push([id, Object.keys(p)]); };
  const writes = runOutbox([{ person: 'ethan', op: 'delete', tag: 'both:wk', byEmail: 'e@x.com', done: false, created: 1 }], { calendar });
  assert.equal(writes[0].update.fields.done.booleanValue, true);
  assert.equal(calendar.events.length, 0);
  // and a new name for every time renames the changed one too, but never moves it
  calendar.events.push({ id: 'm2', calId: 'primary@x', tag: 'both:x' }, { id: 'm2_20261113T190000Z', calId: 'primary@x', tag: 'both:x' });
  ctx.Calendar.Events.get = () => ({ start: { dateTime: '2026-11-06T19:00:00Z' }, end: { dateTime: '2026-11-06T21:00:00Z' } });
  runOutbox([{ person: 'ethan', op: 'update', tag: 'both:x', changes: { title: 'Film night', day: '2026-11-20', start: '19:00' }, byEmail: 'e@x.com', done: false, created: 2 }], { calendar });
  assert.deepEqual(patched.find((x) => x[0] === 'm2_20261113T190000Z')[1], ['summary']);
});

test('removing one of your own events that has already gone from Google Calendar is done, not tried again and again', () => {
  const calendar = fakeCalendar([]);
  calendar.Events.remove = () => { throw new Error('API call to calendar.events.delete failed with error: Not Found'); };
  const writes = runOutbox([{ person: 'ethan', op: 'remove', calId: 'primary@x', gid: 'gone1', byEmail: 'e@x.com', done: false, created: 1 }], { calendar });
  assert.equal(writes[0].update.fields.done.booleanValue, true);
});

function fakeCache() {
  const c = {};
  ctx.CacheService = { getScriptCache: () => ({ get: (k) => (k in c ? c[k] : null), put: (k, v) => { c[k] = String(v); }, remove: (k) => { delete c[k]; } }) };
  return c;
}
test('a sync of an account never runs twice at once, even when a ping and the 10-minute run arrive together', () => {
  asUser('e@x.com');
  const cache = fakeCache();
  // a lock that lets everything through (as Google's own lock might for the ping, which runs as no one)
  ctx.LockService = { getUserLock: () => ({ tryLock: () => true, releaseLock() {} }), getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) };
  let ran = 0;
  ctx.fsList_ = () => { ran++; return [{ id: 'ethan', data: { email: 'e@x.com' } }]; };
  ctx.fsGet_ = () => { throw new Error('stop here'); };
  // another run of this account is part way through
  cache.run_e_x_com = String(Date.now());
  assert.equal(ctx.syncAll(), 'already running');
  assert.equal(ran, 0);
  // once it has finished, the next one runs, and lets the one after it run too
  delete cache.run_e_x_com;
  assert.throws(() => ctx.syncAll(), /stop here/);
  assert.equal(ran, 1);
  assert.equal(cache.run_e_x_com, undefined);
});

test('connect, stop and the owner-only jobs only ever run as the person themselves', () => {
  // the ping deployment runs as Ethan for anyone at all: none of these may run there
  asUser('e@x.com', '');
  let removed = 0;
  ctx.ScriptApp = { getProjectTriggers: () => [{ getHandlerFunction: () => 'syncAll' }], deleteTrigger: () => { removed++; }, newTrigger() { throw new Error('no'); } };
  for (const fn of ['disconnectFromPage', 'connectFromPage', 'disconnectMe', 'connectMe', 'setupProject', 'backupNow']) {
    assert.throws(() => ctx[fn](), /signed in/, fn);
  }
  assert.equal(removed, 0);
});

test('a reminder on something your account sees twice (your copy, and your partner\'s calendar shared with you) goes once', () => {
  withDigest();
  const now = Date.now();
  const { api } = smallProps();
  ctx.PropertiesService = { getUserProperties: () => api };
  const writes = [];
  ctx.fsCommit_ = (w) => writes.push(...w);
  ctx.docName_ = (p) => p;
  ctx.fsGet_ = (path) => (path === 'households/main/people/ethan/private/main' ? { reminders: { r1: { ref: 't:both:tea', owner: 'ethan', times: ['h1'], note: '' } } } : null);
  const me = { person: 'ethan', email: 'e@x.com', main: true, people: [{ id: 'ethan', data: { settings: {} } }] };
  const ev = { tag: 'both:tea', t: 'Tea', s: now + 30 * 60e3, e: now + 90 * 60e3 };
  const seen = ['primary', 'sophiecal'].map((calKey) => ({ calKey, shown: true, share: 'all', doc: { share: 'all' }, ev: Object.assign({ id: calKey }, ev) }));
  ctx.fireReminders_(me, {}, seen);
  assert.equal(writes.filter((w) => w.update.fields.kind && w.update.fields.kind.stringValue === 'reminders').length, 1);
});

test('the same events listed in another order by Google are not written again', () => {
  withDigest();
  const s = ctx.localTime_('2026-11-10', '09:00');
  const a = { id: 'a', t: 'A', s, e: s + 3600e3 }, b = { id: 'b', t: 'B', s: s + 864e5, e: s + 864e5 + 3600e3 };
  const { api } = fakeProps();
  const me = { person: 'ethan', email: 'e@x.com' };
  const first = ctx.feedWrites_(me, { appEmail: 'e@x.com' }, 'k', { share: 'all' }, [a, b], api);
  api.setProperty(first.key, first.value);
  const again = ctx.feedWrites_(me, { appEmail: 'e@x.com' }, 'k', { share: 'all' }, [b, a], api);
  assert.equal(again.writes.length, 0);
});

test('a very long note still reaches the phone (cut short to fit what Firebase can send)', () => {
  const sent = [];
  ctx.UrlFetchApp = { fetch: (url, opt) => { sent.push(opt.payload); return { getResponseCode: () => 200 }; } };
  const realToken = ctx.saToken_, realProp = ctx.prop_;
  ctx.saToken_ = () => 't'; ctx.prop_ = () => 'proj';
  ctx.fsQuery_ = (coll) => (coll === 'notify' ? [{ id: 'n1', data: { to: 'sophie', kind: 'notes', title: 'A note from Ethan '.repeat(40), body: 'Ünïcödé 🙂 '.repeat(1500), sendAfter: 0, sent: false }, updateTime: 't' }] : []);
  ctx.fsList_ = () => [{ id: 't1', data: { token: 'tok' } }];
  ctx.fsCommit_ = () => {};
  ctx.docName_ = (p) => p;
  ctx.processNotify_({ people: { sophie: { settings: { quiet: { on: false } } } } });
  ctx.saToken_ = realToken; ctx.prop_ = realProp;
  assert.equal(sent.length, 1);
  const data = JSON.parse(sent[0]).message.data;
  assert.ok(Buffer.byteLength(JSON.stringify(data), 'utf8') < 4000, 'under the 4 KB limit');
  assert.match(data.body, /…$/);
});

test('events Google lists without their own calendar id still each have their own reminders', () => {
  withDigest();
  const ev = (id, h) => ctx.normApi_({ id, summary: '', start: { dateTime: `2026-11-06T${h}:00:00Z` }, end: { dateTime: `2026-11-06T${h}:30:00Z` } });
  assert.notEqual(ev('aaa', '10').uid, ev('bbb', '12').uid);
});

test('renaming one of your calendars to something with "family" in it never shares more of it', () => {
  withDigest();
  const calId = 'cal1@group.calendar.google.com';
  const key = ctx.shortKey_(calId);
  const { api } = fakeProps({ [`h_${key}`]: '{}' });
  ctx.PropertiesService = { getUserProperties: () => api };
  ctx.CalendarApp = { getAllCalendars: () => [{ getId: () => calId, getName: () => 'Family planning', getColor: () => '#1', isOwnedByMe: () => true }], getDefaultCalendar: () => ({ getId: () => 'e@x.com' }) };
  ctx.Calendar = { Events: { list: () => ({ items: [] }) } };
  const writes = [];
  ctx.fsCommit_ = (w) => writes.push(...w);
  ctx.docName_ = (p) => p;
  ctx.syncCalendars_({ email: 'e@x.com', person: 'ethan', main: true, people: [] }, { appEmail: 'e@x.com', hh: {}, calDocs: {
    [key]: { owner: 'ethan', calKey: key, calId, name: 'Gym', color: '#1', canWrite: true, primary: false, account: 'e@x.com', lastSeen: Date.now(), show: true, share: 'busy', role: 'normal', layer: 'own' }
  } }, []);
  const masks = writes.filter((w) => w.update && w.update.name.endsWith(`/calendars/ethan__${key}`)).flatMap((w) => w.updateMask.fieldPaths);
  assert.ok(!masks.includes('share'));
});

test('the morning summary reads only the jobs still to do, not every job ever done', () => {
  const asked = [];
  ctx.fsList_ = (p) => { asked.push(['list', p]); return []; };
  ctx.fsQuery_ = (coll, eqs) => { asked.push(['query', coll, JSON.stringify(eqs)]); return []; };
  ctx.digestData_({ person: 'ethan' }, { settings: {}, people: { ethan: {} } });
  assert.ok(!asked.some((a) => a[0] === 'list' && a[1].endsWith('/jobs')));
  assert.ok(asked.some((a) => a[1] === 'jobs' && a[2] === '[["done",false]]'));
});

test('when Google Calendar can only be read the slow way and time is running out, that calendar waits for the next run', () => {
  const realCal = ctx.Calendar;
  ctx.Calendar = undefined;
  ctx.RUN_STARTED_ = Date.now() - 4 * 60e3;
  const cal = { getEvents: () => { throw new Error('should not start'); } };
  assert.throws(() => ctx.readEvents_(cal, 'x', new Date(), new Date()), /next run/);
  ctx.RUN_STARTED_ = 0;
  ctx.Calendar = realCal;
});

test('your own copies follow a corrected email (set before you joined), not just changed events', () => {
  withDigest();
  const s = ctx.localTime_('2026-11-10', '09:00');
  const evs = [{ id: 'a', t: 'A', s, e: s + 3600e3 }];
  const { api } = fakeProps();
  const me = { person: 'sophie', email: 's@x.com' };
  const first = ctx.feedWrites_(me, { appEmail: 'sophy@x.com' }, 'k', { share: 'all' }, evs, api);
  api.setProperty(first.key, first.value);
  const again = ctx.feedWrites_(me, { appEmail: 's@x.com' }, 'k', { share: 'all' }, evs, api);
  const priv = again.writes.find((w) => w.update && w.update.name.includes('/privateFeeds/'));
  assert.ok(priv, 'written again');
  assert.equal(priv.update.fields.ownerEmail.stringValue, 's@x.com');
});
