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
  assert.match(ctx.syncAll.toString(), /if \(me\.main\) stage\('rota link', function \(\) \{ var url = rotaUrlOf_\(me, ctx\); if \(url\) syncRotaLink_\(me, ctx, url\); else dropRotaLink_\(me\); \}\)/);
});

test('the rota link is read from where only its owner can read it, and from their record until it has moved', () => {
  const me = { person: 'sophie', main: true };
  const priv = (p) => { ctx.fsGet_ = (path) => (path === 'households/main/people/sophie/private/main' ? p : null); };
  priv({ rotaUrl: 'https://loop.example/new.ics' });
  assert.equal(ctx.rotaUrlOf_(me, { settings: { rotaUrl: 'https://loop.example/old.ics' } }), 'https://loop.example/new.ics');
  // taken out (saved empty in the private place): not the old one on the record
  priv({ rotaUrl: '' });
  assert.equal(ctx.rotaUrlOf_(me, { settings: { rotaUrl: 'https://loop.example/old.ics' } }), '');
  // not moved yet
  priv(null);
  assert.equal(ctx.rotaUrlOf_(me, { settings: { rotaUrl: 'https://loop.example/old.ics' } }), 'https://loop.example/old.ics');
  priv({ reminders: {} });
  assert.equal(ctx.rotaUrlOf_(me, { settings: {} }), '');
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
  // nor every shift ever put in by hand: from yesterday on
  assert.ok(!asked.some((a) => a[0] === 'list' && a[1].endsWith('/shifts')));
  const sh = asked.find((a) => a[1] === 'shifts');
  assert.ok(sh && JSON.parse(sh[2])[0][2] === '>=', 'shifts from a day on');
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

test("yes to the other time: the agreed event is added even if Google's search still lists the pencilled-in one just deleted", () => {
  const calendar = fakeCalendar([{ id: 'hold1', calId: 'primary@x', tag: 'req:r7', summary: 'Pencilled in: Walk' }]);
  const gone = new Set();
  // the search lags: what was deleted a moment ago is still found by its tag
  const list = calendar.Events.list;
  calendar.Events.remove = (calId, id) => { gone.add(id); };
  calendar.Events.list = (calId, q) => list(calId, q);
  runOutbox([
    { person: 'ethan', op: 'delete', tag: 'req:r7', byEmail: 'e@x.com', done: false, created: 5, seq: 0 },
    { person: 'ethan', op: 'create', tag: 'req:r7', byEmail: 'e@x.com', done: false, created: 5, seq: 1, event: { title: 'Walk', day: '2026-11-07', start: '10:00', end: '11:00' } }
  ], { calendar });
  assert.ok(gone.has('hold1'));
  assert.ok(calendar.events.some((e) => e.summary === 'Walk'), 'the agreed one was added');
});

// ---------- round 6 checks ----------
test('finding an event by its tag reads every page Google hands back, even an empty first one', () => {
  // Google may return a page with no matches and a nextPageToken, with the match on the next page
  const calls = [];
  const calendar = { Events: {
    list(calId, q) {
      calls.push(q.pageToken || null);
      if (q.privateExtendedProperty && !q.pageToken) return { items: [], nextPageToken: 'p2' };
      if (q.privateExtendedProperty && q.pageToken === 'p2') return { items: [{ id: 'ev1', status: 'confirmed' }] };
      return { items: [] };
    },
    insert() { throw new Error('should not add a second copy'); },
    remove() {}, patch() {}, get() { return {}; }
  } };
  const writes = runOutbox([{ person: 'ethan', op: 'create', tag: 'add:x1', byEmail: 'e@x.com', done: false, created: 1, event: { title: 'Gym', day: '2026-11-07', start: '10:00', end: '11:00' } }], { calendar });
  assert.ok(calls.includes('p2'), 'the second page was read');
  assert.equal(writes[0].update.fields.done.booleanValue, true);
  assert.equal(writes[0].update.fields.result.mapValue.fields.eventId.stringValue, 'ev1');
});

test('a rota link that sends a sign-in page instead of a calendar leaves the shifts as they were', () => {
  withDigest();
  const { store, api } = fakeProps({ h_rotalink: JSON.stringify({ 'households/main/privateFeeds/sophie__rotalink__2026-11': 'h' }) });
  ctx.PropertiesService = { getUserProperties: () => api };
  const writes = [];
  ctx.fsCommit_ = (w) => writes.push(...w);
  ctx.docName_ = (p) => p;
  for (const body of ['<html><body>Please sign in</body></html>', '']) {
    ctx.UrlFetchApp = { fetch: () => ({ getResponseCode: () => 200, getContentText: () => body }) };
    assert.throws(() => ctx.syncRotaLink_({ person: 'sophie', email: 's@x.com', main: true }, { calDocs: { rotalink: { share: 'all', role: 'rota', lastSeen: Date.now() } }, people: { sophie: {}, ethan: {} }, appEmail: 's@x.com' }, 'https://loop.example/r.ics'), /did not send a calendar/);
  }
  assert.equal(writes.length, 0, 'nothing deleted, no notification');
  assert.ok(store.h_rotalink.includes('2026-11'));
  // an empty calendar is a real answer
  ctx.UrlFetchApp = { fetch: () => ({ getResponseCode: () => 200, getContentText: () => 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' }) };
  ctx.syncRotaLink_({ person: 'sophie', email: 's@x.com', main: true }, { calDocs: { rotalink: { share: 'all', role: 'rota', lastSeen: Date.now() } }, people: { sophie: {}, ethan: {} }, appEmail: 's@x.com' }, 'https://loop.example/r.ics');
  assert.ok(writes.some((w) => w.delete === 'households/main/privateFeeds/sophie__rotalink__2026-11'));
});

test('a long list of changes is left for the next run once time is short, and what was done is marked done', () => {
  const calendar = fakeCalendar([]);
  let clock = Date.now();
  // each change takes 30 seconds of a run that started just now
  const insert = calendar.Events.insert;
  calendar.Events.insert = (res, calId) => { clock += 30e3; return insert(res, calId); };
  ctx.Date = class extends Date { static now() { return clock; } };
  ctx.RUN_STARTED_ = clock;
  const items = Array.from({ length: 20 }, (_, i) => ({ person: 'ethan', op: 'create', tag: `add:n${i}`, byEmail: 'e@x.com', done: false, created: i, event: { title: `E${i}`, day: '2026-11-07', start: '10:00', end: '11:00' } }));
  const writes = runOutbox(items, { calendar });
  delete ctx.Date; ctx.RUN_STARTED_ = 0;
  const done = writes.filter((w) => w.update.fields.done && w.update.fields.done.booleanValue);
  assert.ok(done.length > 0 && done.length < 20, `some done (${done.length}), the rest left`);
  assert.equal(calendar.events.length, done.length);
});

test('notifications are left unsent for the next run once time is short', () => {
  const sent = [];
  ctx.UrlFetchApp = { fetch: (url, opt) => { sent.push(opt.payload); return { getResponseCode: () => 200 }; } };
  const realToken = ctx.saToken_, realProp = ctx.prop_;
  ctx.saToken_ = () => 't'; ctx.prop_ = () => 'proj';
  ctx.fsQuery_ = (coll) => (coll === 'notify' ? [{ id: 'n1', data: { to: 'sophie', kind: 'notes', title: 'x', sendAfter: 0, sent: false }, updateTime: 't' }] : []);
  ctx.fsList_ = () => [{ id: 't1', data: { token: 'tok' } }];
  const writes = [];
  ctx.fsCommit_ = (w) => writes.push(...w);
  ctx.docName_ = (p) => p;
  ctx.RUN_STARTED_ = Date.now() - 5.5 * 60e3;
  ctx.processNotify_({ people: { sophie: { settings: { quiet: { on: false } } } } });
  ctx.RUN_STARTED_ = 0;
  ctx.saToken_ = realToken; ctx.prop_ = realProp;
  assert.equal(sent.length, 0);
  assert.equal(writes.length, 0, 'not claimed either');
});

test('something repeating split in Google Calendar ("this and following"): every time, and just one time, reach the later part too', () => {
  // the original series ends before 13 November; from then on it's a series of its own, with one time changed
  const evs = [
    { id: 'abc', calId: 'primary@x', tag: 'both:wk', recurrence: ['RRULE:FREQ=WEEKLY;UNTIL=20261112T235959Z'] },
    { id: 'abc_R20261113T190000', calId: 'primary@x', tag: 'both:wk', recurrence: ['RRULE:FREQ=WEEKLY'] },
    { id: 'abc_R20261113T190000_20261127T190000Z', calId: 'primary@x', tag: 'both:wk' }
  ];
  const has = (id) => id === 'abc_20261106T190000Z' || id.startsWith('abc_R20261113T190000_') || evs.some((e) => e.id === id);
  const removed = [], patched = [];
  const calendar = { Events: {
    list: (calId, q) => ({ items: evs.filter((e) => q.privateExtendedProperty === 'caledonite=' + e.tag).map((e) => ({ id: e.id, status: 'confirmed', recurrence: e.recurrence })) }),
    get: (calId, id) => { if (!has(id)) throw new Error('API call to calendar.events.get failed with error: Not Found'); return { status: 'confirmed', start: { dateTime: '2026-11-20T19:00:00Z' }, end: { dateTime: '2026-11-20T21:00:00Z' } }; },
    remove: (calId, id) => { if (!has(id)) throw new Error('API call to calendar.events.delete failed with error: Not Found'); removed.push(id); },
    patch: (p, calId, id) => { patched.push([id, Object.keys(p)]); }
  } };
  // just the time on 20 November (in the later part)
  runOutbox([{ person: 'ethan', op: 'delete', tag: 'both:wk', inst: '20261120T190000Z', byEmail: 'e@x.com', done: false, created: 1 }], { calendar });
  assert.deepEqual(removed, ['abc_R20261113T190000_20261120T190000Z']);
  // every time: both parts go (and the changed time with its own part)
  removed.length = 0;
  runOutbox([{ person: 'ethan', op: 'delete', tag: 'both:wk', byEmail: 'e@x.com', done: false, created: 2 }], { calendar });
  assert.deepEqual(removed.sort(), ['abc', 'abc_R20261113T190000']);
});

test('a new time sent for every time of something repeating only renames it, never moves the whole series to one day', () => {
  const patched = [];
  const calendar = { Events: {
    list: () => ({ items: [{ id: 'ser1', status: 'confirmed', recurrence: ['RRULE:FREQ=WEEKLY'] }] }),
    get: () => ({ start: { dateTime: '2026-11-06T19:00:00Z' }, end: { dateTime: '2026-11-06T21:00:00Z' } }),
    patch: (p, calId, id) => { patched.push([id, p]); }, remove() {}
  } };
  runOutbox([{ person: 'ethan', op: 'update', tag: 'both:wk', changes: { title: 'Film night', day: '2026-11-20', start: '20:00', end: '22:00' }, byEmail: 'e@x.com', done: false, created: 1 }], { calendar });
  assert.equal(JSON.stringify(patched), JSON.stringify([['ser1', { summary: 'Film night' }]]));
  // something that doesn't repeat still moves
  patched.length = 0;
  calendar.Events.list = () => ({ items: [{ id: 'one1', status: 'confirmed' }] });
  runOutbox([{ person: 'ethan', op: 'update', tag: 'add:x', changes: { day: '2026-11-20', start: '20:00', end: '22:00' }, byEmail: 'e@x.com', done: false, created: 2 }], { calendar });
  assert.equal(patched[0][1].start.dateTime, '2026-11-20T20:00:00');
});

function notifyHarness(codeFor) {
  const cache = fakeCache();
  const sent = [];
  ctx.UrlFetchApp = { fetch: (url, opt) => { const c = codeFor(sent.length); sent.push(opt.payload); if (c === 'throw') throw new Error('Address unavailable'); return { getResponseCode: () => c }; } };
  ctx.saToken_ = () => 't'; ctx.prop_ = () => 'proj';
  const writes = [];
  ctx.fsCommit_ = (w) => writes.push(...w);
  ctx.docName_ = (p) => p;
  return { cache, sent, writes };
}
test('a notification Firebase could not take (or the network failed) is tried again, not lost', () => {
  const realToken = ctx.saToken_, realProp = ctx.prop_;
  for (const fail of [503, 429, 'throw']) {
    const { writes } = notifyHarness(() => fail);
    ctx.fsQuery_ = (coll) => (coll === 'notify' ? [{ id: 'pk-n1', data: { to: 'sophie', kind: 'reminders', title: 'Dinner', sendAfter: 0, sent: false, created: 1 }, updateTime: 't' }] : []);
    ctx.fsList_ = () => [{ id: 't1', data: { token: 'tok' } }];
    ctx.processNotify_({ people: { sophie: { settings: { quiet: { on: false } } } } });
    const back = writes.find((w) => w.update && w.update.fields.sent && w.update.fields.sent.booleanValue === false);
    assert.ok(back, `put back to wait (${fail})`);
    assert.deepEqual([...back.updateMask.fieldPaths], ['sent', 'sendAfter', 'sentAt'], 'nothing of its own added');
    assert.equal(JSON.stringify(back.currentDocument), '{"exists":true}');
  }
  // one phone has it: never sent again
  const { writes } = notifyHarness((i) => (i === 0 ? 200 : 503));
  ctx.fsList_ = () => [{ id: 't1', data: { token: 'a' } }, { id: 't2', data: { token: 'b' } }];
  ctx.processNotify_({ people: { sophie: { settings: { quiet: { on: false } } } } });
  assert.ok(!writes.some((w) => w.update && w.update.fields.sent && w.update.fields.sent.booleanValue === false));
  ctx.saToken_ = realToken; ctx.prop_ = realProp;
});
test('holding a notification for quiet hours never makes again one that was just taken back', () => {
  const writes = [];
  ctx.fsQuery_ = (coll) => (coll === 'notify' ? [{ id: 'pk-n2', data: { to: 'sophie', kind: 'reminders', title: 'x', sendAfter: 0, sent: false }, updateTime: '2026-10-26T10:00:00.1Z' }] : []);
  ctx.fsCommit_ = (w) => writes.push(...w);
  ctx.docName_ = (p) => p;
  const realQuiet = ctx.quietUntil_;
  ctx.quietUntil_ = () => Date.now() + 3600e3;
  ctx.processNotify_({ people: { sophie: { settings: {} } } });
  ctx.quietUntil_ = realQuiet;
  assert.equal(writes.length, 1);
  assert.equal(writes[0].currentDocument.updateTime, '2026-10-26T10:00:00.1Z');
});

test('a very full rota calendar with long names still remembers its shifts (a saved value is at most 9 KB)', () => {
  const now = Date.now();
  const { store, api } = smallProps();
  ctx.PropertiesService = { getUserProperties: () => api };
  const writes = [];
  ctx.fsCommit_ = (w) => writes.push(...w);
  ctx.docName_ = (p) => p;
  const c = { person: { name: 'Sophie' }, people: { sophie: {}, ethan: {} } };
  const evs = (name) => Array.from({ length: 120 }, (_, i) => ({ t: name + ' '.repeat(10) + 'x'.repeat(200), s: now + 3600e3 + i * 4 * 3600e3, e: now + 2 * 3600e3 + i * 4 * 3600e3 }));
  ctx.rotaChanged_({ person: 'sophie' }, c, 'rota', evs('Ward'), api, { share: 'all' });
  assert.ok(store.rota_rota && store.rota_rota.length <= 9216, 'saved');
  // the same again: nothing to tell
  ctx.rotaChanged_({ person: 'sophie' }, c, 'rota', evs('Ward'), api, { share: 'all' });
  assert.equal(writes.length, 0);
});

test("a rota calendar that isn't read (not shown, shared as Nothing) doesn't forget its shifts", () => {
  withDigest();
  const calId = 'rota@group.calendar.google.com';
  const key = ctx.shortKey_(calId);
  const { store, api } = fakeProps({ [`h_${key}`]: '{}', [`rota_${key}`]: '{"from":1,"to":2,"map":{"2026-11-10":[1,2,"Long day"]}}' });
  ctx.PropertiesService = { getUserProperties: () => api };
  ctx.CalendarApp = { getAllCalendars: () => [{ getId: () => calId, getName: () => 'Rota', getColor: () => '#1', isOwnedByMe: () => true }], getDefaultCalendar: () => ({ getId: () => 'e@x.com' }) };
  ctx.Calendar = { Events: { list: () => { throw new Error('should not be read'); } } };
  ctx.fsCommit_ = () => {};
  ctx.docName_ = (p) => p;
  ctx.syncCalendars_({ email: 's@x.com', person: 'sophie', main: true, people: [] }, { appEmail: 's@x.com', hh: {}, people: {}, calDocs: {
    [key]: { owner: 'sophie', calKey: key, calId, name: 'Rota', color: '#1', canWrite: true, primary: false, account: 's@x.com', lastSeen: Date.now(), show: false, share: 'none', role: 'rota', layer: 'own' }
  } }, []);
  assert.match(store[`rota_${key}`], /Long day/);
});

test('a "from this day on" query asks Firestore for just that', () => {
  // a fresh copy of the script (other checks stand in for fsQuery_ itself)
  const c2 = vm.createContext({ Utilities, Logger: { log() {} } });
  vm.runInContext(readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8'), c2);
  let body = null;
  c2.call_ = (m, url, b) => { body = b; return []; };
  c2.prop_ = () => 'proj';
  c2.fsQuery_('shifts', [['day', '2026-10-25', '>=']]);
  assert.equal(body.structuredQuery.where.fieldFilter.op, 'GREATER_THAN_OR_EQUAL');
  assert.equal(body.structuredQuery.where.fieldFilter.value.stringValue, '2026-10-25');
});

test('a ping that waited while "Stop syncing" finished writes nothing back', () => {
  asUser('e@x.com');
  fakeCache();
  ctx.LockService = { getUserLock: () => ({ tryLock: () => true, releaseLock() {} }), getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) };
  ctx.ScriptApp = { getProjectTriggers: () => [] };
  let read = 0;
  ctx.fsList_ = () => { read++; return [{ id: 'ethan', data: { email: 'e@x.com' } }]; };
  assert.equal(ctx.syncAll({ fromPing: true }), 'not connected');
  assert.equal(read, 0);
});

test('reminder times that are not a list never stop the reminders', () => {
  const now = Date.now();
  const { api } = smallProps();
  ctx.PropertiesService = { getUserProperties: () => api };
  const writes = [];
  ctx.fsCommit_ = (w) => writes.push(...w);
  ctx.docName_ = (p) => p;
  ctx.fsGet_ = (path) => (path === 'households/main/people/ethan/private/main'
    ? { reminders: { bad: { ref: 'e:ethan:primary:u0', owner: 'ethan', times: 'h1' }, r1: { ref: 'e:ethan:primary:u1', owner: 'ethan', times: ['h1'] } } } : null);
  const me = { person: 'ethan', email: 'e@x.com', main: true, people: [{ id: 'ethan', data: { settings: { autoRemind: { birthdays: 'd0' } } } }] };
  const ev = (uid) => ({ calKey: 'primary', shown: true, share: 'all', doc: { share: 'all' }, ev: { id: uid, uid, t: 'Dentist ' + uid, ad: 0, s: now + 30 * 60e3, e: now + 90 * 60e3 } });
  ctx.fireReminders_(me, {}, [ev('u0'), ev('u1')]);
  assert.equal(writes.length, 1);
});

test("an extra account isn't synced while its person's email is also someone else's", () => {
  ctx.fsGet_ = () => ({});
  ctx.fsQuery_ = () => [];
  const people = [{ id: 'ethan', data: { email: 'e@x.com' } }, { id: 'sophie', data: { email: 'E@x.com', linked: ['s.work@x.com'] } }];
  assert.throws(() => ctx.loadCtx_({ email: 's.work@x.com', person: 'sophie', main: false, people }), /more than one person/);
  people[1].data.email = 's@x.com';
  assert.equal(ctx.loadCtx_({ email: 's.work@x.com', person: 'sophie', main: false, people }).appEmail, 's@x.com');
});

test("someone who isn't one of you, trying again and again, reads the household once every couple of minutes at most", () => {
  fakeCache();
  let reads = 0;
  ctx.fsList_ = () => { reads++; return [{ id: 'ethan', data: { email: 'e@x.com' } }]; };
  ctx.fsGet_ = () => ({});
  asUser('stranger@x.com');
  for (let i = 0; i < 5; i++) assert.throws(() => ctx.whoAmI_(), /not part of Caledonite/);
  assert.equal(reads, 1);
  // and only the first one can count as "taken out" (so tidying up happens once)
  let err; try { ctx.whoAmI_(); } catch (e) { err = e; }
  assert.equal(err.notMember, false);
  // a member is never held back by it
  asUser('e@x.com');
  assert.equal(ctx.whoAmI_().person, 'ethan');
});

// ---------- round 7 ----------
test("the rota link never appears in what went wrong (your partner's phone reads this account's status)", () => {
  withDigest();
  const { api } = fakeProps();
  ctx.PropertiesService = { getUserProperties: () => api };
  ctx.fsCommit_ = () => {};
  ctx.docName_ = (p) => p;
  const link = 'https://rota.example/feed/s3cr3t-token.ics';
  const c = { calDocs: { rotalink: { share: 'busy', role: 'rota', lastSeen: Date.now() } }, people: { sophie: {}, ethan: {} }, appEmail: 's@x.com' };
  for (const fail of ['DNS error: ' + link, 'Address unavailable: ' + link, 'Timeout: ' + link]) {
    ctx.UrlFetchApp = { fetch: () => { throw new Error(fail); } };
    let err; try { ctx.syncRotaLink_({ person: 'sophie', email: 's@x.com', main: true }, c, link); } catch (e) { err = e; }
    assert.ok(err, 'still an error');
    assert.ok(!String(err.message).includes('s3cr3t'), err.message);
    assert.ok(!String(err.message).includes('rota.example'), err.message);
  }
});

test("one of your extra accounts, taken off your list and put on your partner's, is never synced as theirs", () => {
  asUser('work@x.com');
  fakeCache();
  ctx.LockService = { getUserLock: () => ({ tryLock: () => true, releaseLock() {} }), getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) };
  ctx.ScriptApp = { getProjectTriggers: () => [{ getHandlerFunction: () => 'syncAll' }], deleteTrigger() {} };
  const people = [{ id: 'ethan', data: { email: 'e@x.com', linked: [] } }, { id: 'sophie', data: { email: 's@x.com', linked: ['work@x.com'] } }];
  ctx.fsList_ = () => people;
  ctx.fsGet_ = () => ({});
  let queried = 0;
  ctx.fsQuery_ = () => { queried++; return []; };
  const writes = [];
  ctx.fsCommit_ = (w) => writes.push(...w);
  ctx.docName_ = (p) => p;
  const { store, api } = fakeProps({ me_person: 'ethan', h_abc: JSON.stringify({ 'households/main/privateFeeds/ethan__abc__2026-11': 'h' }) });
  ctx.PropertiesService = { getUserProperties: () => api };
  assert.throws(() => ctx.syncAll(), /connected as ethan/);
  assert.equal(queried, 0, 'none of its calendars read or written');
  assert.deepEqual(writes.map((w) => w.update && w.update.name), ['households/main/status/work_x_com'], 'only its status, saying why');
  assert.equal(writes[0].update.fields.person.stringValue, 'ethan');
  assert.equal(store.me_person, 'ethan');
  // an account connected before this was remembered: remembered from its next run
  const fresh = fakeProps();
  ctx.PropertiesService = { getUserProperties: () => fresh.api };
  people[1].data.linked = [];
  people[0].data.linked = ['work@x.com'];
  try { ctx.syncAll(); } catch (e) { /* the rest of the run isn't stood in for here */ }
  assert.equal(fresh.store.me_person, 'ethan');
});
test('connecting it again on the connect page (which says whose it is) moves it on purpose', () => {
  asUser('work@x.com');
  fakeCache();
  ctx.ScriptApp = { getProjectTriggers: () => [], deleteTrigger() {}, newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create() {} }) }) }) };
  ctx.fsList_ = () => [{ id: 'ethan', data: { email: 'e@x.com', linked: [] } }, { id: 'sophie', data: { email: 's@x.com', linked: ['work@x.com'] } }];
  ctx.fsGet_ = () => ({});
  const { store, api } = fakeProps({ me_person: 'ethan' });
  ctx.PropertiesService = { getUserProperties: () => api };
  const realSync = ctx.syncAll;
  let seenAs = '';
  ctx.syncAll = () => { seenAs = store.me_person; return 'Synced 1 calendars.'; };
  ctx.connectFromPage();
  ctx.syncAll = realSync;
  assert.equal(seenAs, 'sophie');
});

test('stopping or losing an account never deletes the copies another of your accounts took over from it', () => {
  // the shared calendar "abc" went quiet on work@x.com for a while; e@x.com took it over (same addresses)
  const props = () => ({ h_abc: JSON.stringify({ 'households/main/privateFeeds/ethan__abc__2026-11': 'h', 'households/main/sharedFeeds/ethan__abc__2026-11': 'h' }), h_own: JSON.stringify({ 'households/main/privateFeeds/ethan__own__2026-11': 'h' }), rota_abc: '{}' });
  ctx.fsGet_ = (path) => ({ 'households/main/calendars/ethan__abc': { account: 'e@x.com' }, 'households/main/calendars/ethan__own': { account: 'work@x.com' } })[path] || null;
  const writes = [];
  ctx.fsCommit_ = (w) => writes.push(...w);
  ctx.docName_ = (p) => p;
  // 1. "Stop syncing this account" on the connect page
  asUser('work@x.com');
  fakeCache();
  ctx.LockService = { getUserLock: () => ({ tryLock: () => true, releaseLock() {} }), getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) };
  ctx.ScriptApp = { getProjectTriggers: () => [{ getHandlerFunction: () => 'syncAll' }], deleteTrigger() {} };
  let p = fakeProps(props());
  ctx.PropertiesService = { getUserProperties: () => p.api };
  ctx.disconnectFromPage();
  assert.deepEqual(writes.map((w) => w.delete).sort(), ['households/main/privateFeeds/ethan__own__2026-11', 'households/main/status/work_x_com']);
  // 2. the account comes back but can't see that calendar any more
  writes.length = 0;
  withDigest();
  p = fakeProps(props());
  ctx.PropertiesService = { getUserProperties: () => p.api };
  ctx.CalendarApp = { getAllCalendars: () => [{ getId: () => 'w@x', getName: () => 'Work', getColor: () => '#1', isOwnedByMe: () => true }], getDefaultCalendar: () => ({ getId: () => 'w@x' }) };
  ctx.Calendar = { Events: { list: () => ({ items: [] }) } };
  ctx.fsQuery_ = () => [];
  ctx.syncCalendars_({ email: 'work@x.com', person: 'ethan', main: false, people: [] }, { appEmail: 'e@x.com', hh: {}, people: {}, calDocs: {
    abc: { account: 'e@x.com', lastSeen: Date.now() }, own: { account: 'work@x.com', lastSeen: Date.now() - 864e5 }
  } }, []);
  const gone = writes.map((w) => w.delete).filter(Boolean);
  assert.ok(gone.includes('households/main/privateFeeds/ethan__own__2026-11'), 'its own calendar that went is still taken out');
  assert.ok(!gone.some((x) => x.includes('ethan__abc__')), 'the one taken over is left alone');
  assert.equal(p.store.h_abc, undefined, 'and forgotten here');
  assert.equal(p.store.rota_abc, undefined);
});

test("your partner's change to something for you both reaches your copy, even in one of your other accounts' calendars", () => {
  ctx.fsGet_ = () => null;
  const item = { person: 'ethan', op: 'delete', tag: 'both:t1', byEmail: 's@x.com', done: false, created: 1 };
  const feeds = { 'work@x.com': [{ id: 'ethan__wk__2026-11', data: { calKey: 'wk', events: [{ id: 'x', tag: 'both:t1', t: 'Tea' }] } }] };
  const calDocs = { wk: { account: 'work@x.com', canWrite: true, calId: 'w@x' }, prim: { account: 'e@x.com', canWrite: true, calId: 'primary@x' } };
  const run = (email, main, items, calendar, calId) => {
    const writes = [];
    ctx.Calendar = calendar;
    ctx.CalendarApp = { getAllCalendars: () => [{ getId: () => calId, isOwnedByMe: () => true }], getDefaultCalendar: () => ({ getId: () => calId }) };
    ctx.fsQuery_ = (coll, eqs) => (coll === 'outbox' ? items.map((data, i) => ({ id: `o${i}`, data })) : coll === 'privateFeeds' ? (feeds[eqs[1][1]] || []) : []);
    ctx.fsCommit_ = (w) => writes.push(...w);
    ctx.docName_ = (p) => p;
    ctx.processOutbox_({ email, person: 'ethan', main }, { appEmail: 'e@x.com', calDocs });
    return writes;
  };
  // your main account hasn't got it: handed to work@x.com, not marked done
  let writes = run('e@x.com', true, [item], fakeCalendar([]), 'primary@x');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].update.fields.account.stringValue, 'work@x.com');
  assert.ok(!writes[0].update.fields.done);
  // the work account does it
  const work = fakeCalendar([{ id: 'w1', calId: 'w@x', tag: 'both:t1', summary: 'Tea' }]);
  writes = run('work@x.com', false, [Object.assign({}, item, { account: 'work@x.com' })], work, 'w@x');
  assert.equal(work.events.length, 0, 'deleted there');
  assert.equal(writes[0].update.fields.done.booleanValue, true);
  // but your partner can never have anything added to (or edited in) your other accounts' calendars
  const add = { person: 'ethan', op: 'create', tag: 'both:t2', account: 'work@x.com', byEmail: 's@x.com', done: false, created: 2, event: { title: 'X', day: '2026-11-07' } };
  const mine = { person: 'ethan', op: 'edit', account: 'work@x.com', calId: 'w@x', gid: 'w1', byEmail: 's@x.com', done: false, created: 3, changes: { title: 'Y' } };
  const w2 = fakeCalendar([]);
  writes = run('work@x.com', false, [add, mine], w2, 'w@x');
  assert.equal(writes.length, 0);
  assert.equal(w2.events.length, 0);
  // nothing anywhere else: done, as before
  writes = run('e@x.com', true, [Object.assign({}, item, { tag: 'both:gone' })], fakeCalendar([]), 'primary@x');
  assert.equal(writes[0].update.fields.done.booleanValue, true);
  assert.ok(!('none' in writes[0].update.fields.result.mapValue.fields));
});

test('a rota link: alarms inside a shift, shifts marked private, and a daily entry begun years ago', () => {
  withDigest();
  const day = (ms) => ctx.Utilities.formatDate(new Date(ms), 'Europe/London', 'yyyy-MM-dd').replace(/-/g, '');
  const soon = day(Date.now() + 3 * 864e5);
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'UID:a1', 'SUMMARY:Long day', `DTSTART;TZID=Europe/London:${soon}T073000`, `DTEND;TZID=Europe/London:${soon}T200000`,
    'BEGIN:VALARM', 'ACTION:EMAIL', 'SUMMARY:Shift reminder', 'TRIGGER:-PT1H', 'DURATION:PT15M', 'REPEAT:2', 'END:VALARM',
    'END:VEVENT',
    'BEGIN:VEVENT', 'UID:a2', 'SUMMARY:Appraisal', 'CLASS:PRIVATE', `DTSTART;TZID=Europe/London:${soon}T210000`, `DTEND;TZID=Europe/London:${soon}T220000`, 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:a3', 'SUMMARY:Handover', 'DTSTART;TZID=Europe/London:20150105T070000', 'DTEND;TZID=Europe/London:20150105T071500', 'RRULE:FREQ=DAILY', 'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
  const evs = ctx.parseIcs_(ics);
  const long = evs.find((e) => e.t === 'Long day' || e.t === 'Shift reminder');
  assert.equal(long.t, 'Long day', "the alarm's name isn't the shift's");
  assert.equal(long.e - long.s, 12.5 * 3600e3, "nor its length");
  const appr = evs.find((e) => e.t === 'Appraisal');
  assert.equal(appr.pb, 1);
  assert.equal(ctx.shareFilter_({ share: 'all' }, [appr])[0].t, 'Busy');
  const hand = evs.filter((e) => e.t === 'Handover');
  assert.ok(hand.length > 100, `every day in the window (${hand.length})`);
});

test('"Stop syncing" from someone who never connected writes nothing (not even taking out a status that looks like theirs)', () => {
  asUser('e.d@x.com');
  fakeCache();
  ctx.LockService = { getUserLock: () => ({ tryLock: () => true, releaseLock() {} }), getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) };
  ctx.ScriptApp = { getProjectTriggers: () => [], deleteTrigger() {} };
  const { api } = fakeProps();
  ctx.PropertiesService = { getUserProperties: () => api };
  const writes = [];
  ctx.fsCommit_ = (w) => writes.push(...w);
  ctx.docName_ = (p) => p;
  ctx.disconnectFromPage();
  assert.equal(writes.length, 0, 'e-d@x.com has the same status address, e_d_x_com');
});

test('a service account key pasted in wrong never shows any of itself in an error', () => {
  const c2 = vm.createContext({ Utilities, Logger: { log() {} } });
  vm.runInContext(readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8'), c2);
  c2.CacheService = { getScriptCache: () => ({ get: () => null, put() {} }) };
  c2.PropertiesService = { getScriptProperties: () => ({ getProperty: () => 'MIIEvQSECRETKEYBYTESxyzxyzxyz' }) }; // part of the key, not the whole file
  let err; try { c2.saToken_(); } catch (e) { err = e; }
  assert.ok(err);
  assert.ok(!/MIIE|SECRET/.test(err.message), err.message);
});

test('a request answered or called off just as the nudge goes out is not nudged', () => {
  withDigest();
  const old = Date.now() - 2 * 864e5;
  ctx.fsQuery_ = () => [
    { id: 'r1', data: { from: 'ethan', to: 'sophie', title: 'Cinema', status: 'waiting', created: old }, updateTime: 'T1' },
    { id: 'r2', data: { from: 'ethan', to: 'sophie', title: 'Walk', status: 'waiting', created: old }, updateTime: 'T2' }
  ];
  const commits = [];
  ctx.fsCommit_ = (w) => {
    if (w.some((x) => x.currentDocument && x.currentDocument.updateTime === 'T1')) throw new Error('Firestore 400: {"error":{"status":"FAILED_PRECONDITION"}}');
    commits.push(w);
  };
  ctx.docName_ = (p) => p;
  ctx.nudgeRequests_({ person: 'ethan' }, { hh: {}, person: { name: 'Ethan' } });
  assert.equal(commits.length, 1, 'only the one still waiting');
  assert.equal(commits[0][0].update.fields.body.stringValue, 'Walk');
  assert.equal(commits[0][1].currentDocument.updateTime, 'T2');
});

test('after slow changes, the calendars are not all read again when the run is short of time', () => {
  const c2 = vm.createContext({ Utilities, Logger: { log() {} } });
  vm.runInContext(readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8'), c2);
  const cache = {};
  c2.CacheService = { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; }, remove: (k) => { delete cache[k]; } }) };
  c2.LockService = { getUserLock: () => ({ tryLock: () => true, releaseLock() {} }), getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) };
  c2.Session = { getEffectiveUser: () => ({ getEmail: () => 'e@x.com' }) };
  const { api } = fakeProps({ me_person: 'ethan' });
  c2.PropertiesService = { getUserProperties: () => api };
  c2.whoAmI_ = () => ({ email: 'e@x.com', person: 'ethan', main: false, people: [] });
  c2.loadCtx_ = () => ({ calDocs: {} });
  c2.loadCalDocs_ = () => ({});
  let reads = 0, slow = 0;
  c2.syncCalendars_ = () => { reads++; return { count: 1, seen: [] }; };
  c2.processOutbox_ = () => { c2.RUN_STARTED_ -= slow; return true; };
  for (const n of ['fireReminders_', 'processNotify_', 'writeStatus_']) c2[n] = () => {};
  c2.syncAll();
  assert.equal(reads, 2, 'caught up straight away');
  reads = 0; slow = 200e3;
  c2.syncAll();
  assert.equal(reads, 1, 'left for the next run');
});

test('one odd event from Google never sends the whole calendar the slow way', () => {
  withDigest();
  const s = Date.now() + 864e5;
  ctx.Calendar = { Events: { list: () => ({ items: [
    { id: 'ok1', iCalUID: 'ok1@x', summary: 'Tea', start: { dateTime: new Date(s).toISOString() }, end: { dateTime: new Date(s + 3600e3).toISOString() } },
    { id: 'odd', iCalUID: 'odd@x', summary: 'No end', start: { dateTime: new Date(s).toISOString() } }
  ] }) } };
  let slow = 0;
  const cal = { getEvents: () => { slow++; return []; } };
  const evs = ctx.readEvents_(cal, 'c@x', new Date(), new Date(Date.now() + 5 * 864e5));
  assert.equal(slow, 0);
  assert.equal(JSON.stringify(evs.map((e) => e.t)), '["Tea"]');
});

// ---------- round 8 ----------
test("your contacts' birthdays (which Google now puts in your own calendar) never reach your partner's copy", () => {
  withDigest();
  const bday = (type) => ctx.normApi_({ id: 'b1', iCalUID: 'b1@google.com', summary: "Jane Doe's birthday", eventType: 'birthday', birthdayProperties: { type }, start: { date: '2026-11-06' }, end: { date: '2026-11-07' } });
  const tea = ctx.normApi_({ id: 't1', iCalUID: 't1@google.com', summary: 'Tea', start: { dateTime: '2026-11-06T10:00:00Z' }, end: { dateTime: '2026-11-06T11:00:00Z' } });
  for (const share of ['all', 'busy']) {
    const shared = ctx.shareFilter_({ share }, [bday('birthday'), bday('anniversary'), tea]);
    assert.equal(shared.length, 1, share);
    assert.ok(!('np' in shared[0]));
  }
  // your own birthday is yours to share
  assert.equal(ctx.shareFilter_({ share: 'all' }, [bday('self')]).length, 1);
  // still in your own copy
  const { api } = fakeProps();
  const w = ctx.feedWrites_({ person: 'ethan', email: 'e@x.com' }, { appEmail: 'e@x.com' }, 'k', { share: 'all' }, [bday('birthday')], api).writes;
  const priv = w.find((x) => x.update.name.includes('/privateFeeds/'));
  const shared = w.find((x) => x.update.name.includes('/sharedFeeds/'));
  assert.equal(priv.update.fields.events.arrayValue.values.length, 1);
  assert.equal((shared.update.fields.events.arrayValue.values || []).length, 0);
  // and the slow way (CalendarApp) too
  ctx.CalendarApp = { Visibility: { PRIVATE: 'P', CONFIDENTIAL: 'C' }, GuestStatus: { NO: 'NO' }, EventType: { BIRTHDAY: 'BIRTHDAY' } };
  const old = { getMyStatus: () => null, getDescription: () => '', getStartTime: () => new Date('2026-11-06T00:00:00Z'), getId: () => 'b@google.com', getTitle: () => "Jane's birthday", isRecurringEvent: () => true, isAllDayEvent: () => true, getAllDayStartDate: () => new Date('2026-11-06T00:00:00Z'), getAllDayEndDate: () => new Date('2026-11-07T00:00:00Z'), getLocation: () => '', getVisibility: () => 'D', getEventType: () => 'BIRTHDAY' };
  assert.equal(ctx.shareFilter_({ share: 'all' }, [ctx.norm_(old)]).length, 0);
  // so your partner's reminder on it never goes off either
  const now = Date.now();
  const { api: a2 } = smallProps();
  ctx.PropertiesService = { getUserProperties: () => a2 };
  const writes = [];
  ctx.fsCommit_ = (x) => writes.push(...x);
  ctx.docName_ = (p) => p;
  ctx.fsGet_ = (path) => (path === 'households/main/people/sophie/private/main' ? { reminders: { r1: { ref: 'e:ethan:primary:u1', owner: 'ethan', times: ['h1'] } } } : null);
  const me = { person: 'ethan', email: 'e@x.com', main: true, people: [{ id: 'ethan', data: { settings: {} } }, { id: 'sophie', data: { settings: {} } }] };
  ctx.fireReminders_(me, {}, [{ calKey: 'primary', shown: true, share: 'all', doc: { share: 'all' }, ev: { id: 'e1', uid: 'u1', t: "Jane's birthday", np: 1, s: now + 30 * 60e3, e: now + 90 * 60e3 } }]);
  assert.equal(writes.length, 0);
});

test('your own copy keeps the "seen only as Busy" mark (the app uses it); your partner\'s copy never has it', () => {
  withDigest();
  const s = ctx.localTime_('2026-11-10', '09:00');
  const { api } = fakeProps();
  const w = ctx.feedWrites_({ person: 'ethan', email: 'e@x.com' }, { appEmail: 'e@x.com' }, 'k', { share: 'all' }, [{ id: 'a', t: 'Therapy', pb: 1, s, e: s + 3600e3 }], api).writes;
  const ev = (path) => w.find((x) => x.update.name.includes(path)).update.fields.events.arrayValue.values[0].mapValue.fields;
  assert.equal(ev('/privateFeeds/').pb.integerValue, '1');
  assert.equal(ev('/privateFeeds/').t.stringValue, 'Therapy');
  assert.ok(!('pb' in ev('/sharedFeeds/')));
  assert.equal(ev('/sharedFeeds/').t.stringValue, 'Busy');
});

test('no "Still waiting" nudge once the time asked about has gone by', () => {
  withDigest();
  const now = Date.now();
  const day = (n) => ctx.Utilities.formatDate(new Date(now + n * 864e5), 'Europe/London', 'yyyy-MM-dd');
  const old = now - 2 * 864e5;
  const req = (id, when) => ({ id, data: { from: 'ethan', to: 'sophie', title: id, status: 'waiting', created: old, when }, updateTime: 'T' + id });
  ctx.fsQuery_ = () => [
    req('past', { day: day(-1), start: '19:00', end: '21:00' }),
    req('pastAllDay', { day: day(-3), endDay: day(-1), allDay: true }),
    req('soon', { day: day(1), start: '19:00', end: '21:00' }),
    req('holidayOn', { day: day(-1), endDay: day(2), allDay: true }),
    req('noTime', null)
  ];
  const sent = [];
  ctx.fsCommit_ = (w) => sent.push(w[0].update.fields.body.stringValue);
  ctx.docName_ = (p) => p;
  ctx.nudgeRequests_({ person: 'ethan' }, { hh: {}, person: { name: 'Ethan' } });
  assert.deepEqual(sent.sort(), ['holidayOn', 'noTime', 'soon']);
  // an evening that runs past midnight is still on until it ends
  const L = (d, hm) => ctx.localTime_(d, hm);
  assert.equal(ctx.whenOver_({ day: '2026-11-06', start: '22:00', end: '01:00' }, L('2026-11-07', '00:30')), false);
  assert.equal(ctx.whenOver_({ day: '2026-11-06', start: '22:00', end: '01:00' }, L('2026-11-07', '01:00')), true);
  assert.equal(ctx.whenOver_({ day: '2026-11-06', start: '19:00' }, L('2026-11-06', '19:59')), false);
});

test('rota changes: an all-day entry is named as itself, never as a "night shift", and one your partner can\'t see is never mentioned', () => {
  const now = Date.now();
  const day = ctx.Utilities.formatDate(new Date(now + 3 * 864e5), 'Europe/London', 'yyyy-MM-dd');
  const run = (share, after) => {
    const { api } = smallProps();
    ctx.PropertiesService = { getUserProperties: () => api };
    ctx.Utilities.getUuid = () => 'u' + Math.random();
    const writes = [];
    ctx.fsCommit_ = (w) => writes.push(...w);
    ctx.docName_ = (p) => p;
    const c = { person: { name: 'Sophie' }, people: { sophie: {}, ethan: {} } };
    ctx.rotaChanged_({ person: 'sophie' }, c, 'rota', [], api, { share });
    ctx.rotaChanged_({ person: 'sophie' }, c, 'rota', after, api, { share });
    return writes.map((w) => w.update.fields.body.stringValue);
  };
  const leave = [{ ad: 1, sd: day, ed: ctx.keyPlus_(day, 1), t: 'Annual leave' }];
  const all = run('all', leave);
  assert.match(all[0], /Annual leave added/);
  assert.doesNotMatch(all[0], /night/);
  const busy = run('busy', leave);
  assert.match(busy[0], /an all-day entry added/);
  assert.doesNotMatch(busy[0], /Annual|night/);
  assert.deepEqual(run('hours', leave), [], 'not in the working hours your partner sees');
  // shifts are still told as before
  const s = ctx.localTime_(day, '07:30');
  assert.match(run('hours', [{ t: 'Ward 7', s, e: ctx.localTime_(day, '20:00') }])[0], /long day added/);
});

test("the weekly backup never copies your partner's rota link, reminders or private countdowns into your Drive", () => {
  const { api } = fakeProps({ backup_folder: 'f1' });
  ctx.PropertiesService = { getUserProperties: () => api };
  ctx.ScriptApp = { getOAuthToken: () => 'tok' };
  ctx.Utilities.getUuid = () => 'u1';
  ctx.fsList_ = (path) => (path.endsWith('/people') ? [
    { id: 'ethan', data: { name: 'Ethan', settings: { rotaUrl: 'https://mine.example/r.ics' }, reminders: { r1: { title: 'Mine' } } } },
    { id: 'sophie', data: { name: 'Sophie', settings: { rotaUrl: 'https://loop.example/s3cr3t.ics', hasShifts: true }, reminders: { r2: { title: 'Therapy' } }, countdowns: { c1: { title: 'Trip', shared: true }, c2: { title: 'Interview', shared: false } } } }
  ] : []);
  ctx.fsGet_ = () => ({});
  let uploaded = '';
  ctx.UrlFetchApp = { fetch: (url, opt) => {
    if (/upload/.test(url)) uploaded = opt.payload;
    return { getResponseCode: () => 200, getContentText: () => (/\/files\/f1/.test(url) ? '{"id":"f1"}' : '{"files":[]}') };
  } };
  ctx.backup_({ person: 'ethan' }, { hh: { emails: ['e@x.com'] } }, true);
  assert.ok(uploaded, 'uploaded');
  assert.ok(!/s3cr3t|Therapy|Interview/.test(uploaded));
  assert.match(uploaded, /Trip/);
  assert.match(uploaded, /mine\.example/, 'your own record is as it is');
});

test('a change Google keeps turning away for a moment is tried for a day, not dropped after five tries', () => {
  const run = (msg, createTime) => {
    const calendar = fakeCalendar([]);
    calendar.Events.insert = () => { throw new Error(msg); };
    ctx.Calendar = calendar;
    ctx.CalendarApp = { getAllCalendars: () => [{ getId: () => 'primary@x', isOwnedByMe: () => true }], getDefaultCalendar: () => ({ getId: () => 'primary@x' }) };
    const writes = [];
    ctx.fsQuery_ = () => [{ id: 'o1', createTime, data: { person: 'ethan', op: 'create', tag: 'add:z', byEmail: 'e@x.com', done: false, created: 1, tries: 4, event: { title: 'Gym', day: '2026-11-07', start: '10:00', end: '11:00' } } }];
    ctx.fsCommit_ = (w) => writes.push(...w);
    ctx.docName_ = (p) => p;
    ctx.processOutbox_({ email: 'e@x.com', person: 'ethan', main: true }, { appEmail: 'e@x.com', calDocs: {} });
    return writes[0].update.fields;
  };
  const recent = new Date(Date.now() - 3600e3).toISOString();
  for (const m of ['API call to calendar.events.insert failed with error: Backend Error', 'Rate Limit Exceeded', 'Service invoked too many times for one day: calendar.', 'Address unavailable: https://www.googleapis.com', 'API call to calendar.events.insert failed with error: Calendar usage limits exceeded.']) {
    const f = run(m, recent);
    assert.ok(!f.done, m);
    assert.equal(f.tries.integerValue, '5');
  }
  // a day on, it's given up on
  assert.equal(run('Backend Error', new Date(Date.now() - 25 * 3600e3).toISOString()).done.booleanValue, true);
  // something wrong with the change itself: after 5 tries, as before
  assert.equal(run('API call to calendar.events.insert failed with error: Invalid start time.', recent).done.booleanValue, true);
});

test('a rota shared as working hours, saved before all-day entries were left out of it, never says they were removed', () => {
  const now = Date.now();
  const day = ctx.Utilities.formatDate(new Date(now + 3 * 864e5), 'Europe/London', 'yyyy-MM-dd');
  const L = (hm) => ctx.localTime_(day, hm);
  // as an earlier version saved it: a study day (all day) listed first, then a long day
  const saved = { from: now - 864e5, to: now + 21 * 864e5, map: { [day]: [L('00:00'), ctx.localTime_(ctx.keyPlus_(day, 1), '00:00'), 'Study day'], [day + '+']: [L('07:30'), L('20:00'), 'Long day'] } };
  const { api } = smallProps({ rota_rota: JSON.stringify(saved) });
  ctx.PropertiesService = { getUserProperties: () => api };
  ctx.Utilities.getUuid = () => 'u' + Math.random();
  const writes = [];
  ctx.fsCommit_ = (w) => writes.push(...w);
  ctx.docName_ = (p) => p;
  const c = { person: { name: 'Sophie' }, people: { sophie: {}, ethan: {} } };
  const evs = [{ t: 'Long day', s: L('07:30'), e: L('20:00') }, { ad: 1, sd: day, ed: ctx.keyPlus_(day, 1), t: 'Study day' }];
  ctx.rotaChanged_({ person: 'sophie' }, c, 'rota', evs, api, { share: 'hours' });
  assert.deepEqual(writes.map((w) => w.update.fields.body.stringValue), []);
  // and the same shifts listed in another order are no change, whatever the sharing
  api.setProperty('rota_rota', JSON.stringify(Object.assign({}, saved, { map: { [day]: saved.map[day + '+'], [day + '+']: saved.map[day] } })));
  ctx.rotaChanged_({ person: 'sophie' }, c, 'rota', evs.slice().reverse(), api, { share: 'all' });
  ctx.rotaChanged_({ person: 'sophie' }, c, 'rota', evs, api, { share: 'all' });
  assert.equal(writes.length, 0);
});

test('a change to something still waiting to be added by another of your accounts is handed on to it, not lost', () => {
  ctx.fsGet_ = () => null;
  // you added "Tea" for you both, your copy in your work calendar; your partner's copy shows up first and they delete
  // it before your work account (which runs every 10 minutes, without the ping) has made yours
  const create = { person: 'ethan', op: 'create', tag: 'both:t9', both: true, account: 'work@x.com', byEmail: 'e@x.com', done: false, created: 1, event: { title: 'Tea', day: '2026-11-07', start: '16:00', end: '17:00' } };
  const del = { person: 'ethan', op: 'delete', tag: 'both:t9', byEmail: 's@x.com', done: false, created: 2 };
  const ownEdit = { person: 'ethan', op: 'update', tag: 'both:t9', byEmail: 'e@x.com', done: false, created: 3, changes: { title: 'Tea and cake' } };
  const writes = [];
  ctx.Calendar = fakeCalendar([]);
  ctx.CalendarApp = { getAllCalendars: () => [{ getId: () => 'primary@x', isOwnedByMe: () => true }], getDefaultCalendar: () => ({ getId: () => 'primary@x' }) };
  ctx.fsQuery_ = (coll) => (coll === 'outbox' ? [create, del, ownEdit].map((data, i) => ({ id: `o${i}`, data })) : []);
  ctx.fsCommit_ = (w) => writes.push(...w);
  ctx.docName_ = (p) => p;
  const me = { email: 'e@x.com', person: 'ethan', main: true, people: [{ id: 'ethan', data: { email: 'e@x.com', linked: ['work@x.com'] } }] };
  ctx.processOutbox_(me, { appEmail: 'e@x.com', calDocs: {}, hh: {} });
  // the delete goes to the work account; your own change after it waits its turn (and follows it there next run)
  assert.equal(writes.length, 1);
  assert.equal(writes[0].update.name, 'households/main/outbox/o1');
  assert.equal(writes[0].update.fields.account.stringValue, 'work@x.com');
  assert.ok(!writes[0].update.fields.done, 'not marked done here');
  writes.length = 0;
  ctx.fsQuery_ = () => [create, Object.assign({}, del, { account: 'work@x.com' }), ownEdit].map((data, i) => ({ id: `o${i}`, data }));
  ctx.processOutbox_(me, { appEmail: 'e@x.com', calDocs: {}, hh: {} });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].update.name, 'households/main/outbox/o2');
  assert.equal(writes[0].update.fields.account.stringValue, 'work@x.com');
  // never handed to an account that isn't yours
  writes.length = 0;
  ctx.fsQuery_ = () => [Object.assign({}, create, { account: 'stranger@x.com' }), del].map((data, i) => ({ id: `o${i}`, data }));
  ctx.processOutbox_(me, { appEmail: 'e@x.com', calDocs: {}, hh: {} });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].update.fields.done.booleanValue, true);
});

test('the morning summary says "Together" only for things you both do, as the app does', () => {
  const day = '2026-11-10';
  const L = (hm) => ctx.localTime_(day, hm);
  const reqs = {
    'households/main/requests/leave1': { type: 'leave', own: true, people: ['ethan'], status: 'yes' },
    'households/main/requests/fav1': { type: 'favour', from: 'sophie', to: 'ethan', status: 'yes' },
    'households/main/requests/plan1': { type: 'plan', from: 'ethan', to: 'sophie', status: 'yes' },
    'households/main/requests/off1': { type: 'plan', from: 'sophie', to: 'ethan', status: 'cancelled' }
  };
  ctx.fsGet_ = (p) => reqs[p] || null;
  const cal = { role: 'normal', layer: 'own' };
  ctx.fsList_ = () => [{ id: 'ethan__p', data: cal }, { id: 'sophie__p', data: cal }];
  const feeds = {
    privateFeeds: [{ id: 'ethan__p__2026-11', data: { calKey: 'p', events: [
      { id: '1', tag: 'req:leave1', t: 'Holiday: Spain', ad: 1, sd: day, ed: ctx.keyPlus_(day, 1) },
      { id: '2', tag: 'req:fav1', t: 'Pick up the parcel (for Sophie)', s: L('12:00'), e: L('13:00') },
      { id: '3', tag: 'req:plan1', t: 'Cinema', s: L('19:00'), e: L('21:00') },
      { id: '4', tag: 'req:off1', t: 'Pencilled in: Bowling', s: L('15:00'), e: L('16:00') },
      { id: '5', tag: 'both:tea', t: 'Tea at Mum\'s', s: L('17:00'), e: L('18:00') }
    ] } }],
    sharedFeeds: [{ id: 'sophie__p__2026-11', data: { calKey: 'p', events: [{ id: '6', tag: 'both:tea', t: 'Tea at Mum\'s', s: L('17:00'), e: L('18:00') }] } }]
  };
  ctx.fsQuery_ = (coll) => feeds[coll] || [];
  const data = ctx.digestData_({ person: 'ethan' }, { settings: {}, people: { ethan: { name: 'Ethan' }, sophie: { name: 'Sophie' } } });
  const text = ctx.morningText_(data, day);
  const together = (text.match(/Together: ([^.]*)/) || [])[1] || '';
  assert.match(together, /Cinema at 7pm/);
  assert.match(together, /Tea at Mum's at 5pm/);
  assert.doesNotMatch(together, /Holiday|parcel|Bowling/, text);
  // your own holiday is a day off; the favour is one of your things today; the called-off one isn't there at all
  assert.match(text, /You: on holiday/);
  assert.match(text, /Pick up the parcel \(for Sophie\) at 12pm/);
  assert.doesNotMatch(text, /Bowling/);
});

test('the morning summary is remembered as sent before it goes, so a run stopped just after never sends it twice', () => {
  const realNow = vm.runInContext('Date.now', ctx);
  const at = ctx.localTime_('2026-11-10', '07:40');
  ctx.__fakeNow = at;
  vm.runInContext('Date.now = function () { return __fakeNow; }', ctx);
  const realData = ctx.digestData_, realText = ctx.morningText_;
  ctx.digestData_ = () => ({});
  ctx.morningText_ = () => 'You: nothing planned.';
  try {
    const { store, api } = smallProps({});
    ctx.PropertiesService = { getUserProperties: () => api };
    ctx.docName_ = (p) => p;
    let seenAtCommit = null;
    ctx.fsCommit_ = () => { seenAtCommit = store.digest_morning || null; };
    const me = { person: 'ethan', main: true };
    const c = { settings: { morning: { on: true, at: '07:30' }, weekAhead: { on: false } }, people: { ethan: {} } };
    ctx.digests_(me, c);
    assert.equal(seenAtCommit, '2026-11-10', 'already remembered when it was sent');
    // and when it couldn't be saved, it's tried again next run
    delete store.digest_morning;
    ctx.fsCommit_ = () => { throw new Error('Firestore 503: unavailable'); };
    assert.throws(() => ctx.digests_(me, c), /503/);
    assert.equal(store.digest_morning, undefined);
  } finally {
    ctx.realNow = realNow;
    vm.runInContext('Date.now = realNow', ctx);
    ctx.digestData_ = realData; ctx.morningText_ = realText;
  }
});

test('each run reads only the notifications that are due, not every one waiting (with a sweep an hour, and without the index)', () => {
  const now = Date.now();
  const cache = {};
  ctx.CacheService = { getScriptCache: () => ({ get: (k) => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = String(v); }, remove: (k) => { delete cache[k]; } }) };
  const queries = [];
  const waiting = [
    { id: 'pk-later', data: { to: 'sophie', kind: 'reminders', title: 'Dinner Friday', sendAfter: now + 3 * 864e5, sent: false }, updateTime: 't' },
    { id: 'odd', data: { to: 'sophie', kind: 'notes', title: 'No time saved', sent: false }, updateTime: 't' }
  ];
  let indexed = true;
  ctx.fsQuery_ = (coll, eqs) => {
    queries.push(JSON.stringify(eqs));
    if (coll !== 'notify') return [];
    if (eqs.length > 1) {
      if (!indexed) throw new Error('Firestore 400: FAILED_PRECONDITION: The query requires an index. You can create it here: ...');
      return [];
    }
    return waiting;
  };
  const writes = [];
  ctx.fsCommit_ = (w) => writes.push(...w);
  ctx.fsList_ = () => [];
  ctx.docName_ = (p) => p;
  const c = () => ({ people: { sophie: { settings: { quiet: { on: false } } } } });
  // the first run in an hour reads everything waiting, and so finds one saved without a time
  ctx.processNotify_(c());
  assert.deepEqual(queries, ['[["sent",false]]']);
  assert.equal(writes.length, 1, 'the one with no time is sent');
  assert.match(JSON.stringify(writes[0]), /odd/);
  // the runs after it ask only for what's due: none of the week of meal reminders is read
  queries.length = 0; writes.length = 0;
  ctx.processNotify_(c());
  assert.equal(queries.length, 1);
  assert.deepEqual(JSON.parse(queries[0]), [['sent', false], ['sendAfter', JSON.parse(queries[0])[1][1], '<=']]);
  assert.ok(Math.abs(JSON.parse(queries[0])[1][1] - now) < 60e3);
  assert.equal(writes.length, 0);
  // without the index: everything, as before, and it isn't asked for again for a while
  indexed = false; queries.length = 0;
  ctx.processNotify_(c());
  ctx.processNotify_(c());
  assert.deepEqual(queries.filter((q) => q.includes('sendAfter')).length, 1);
  assert.equal(queries.filter((q) => q === '[["sent",false]]').length, 2);
  // and the database's own query for it
  const realCall = ctx.call_, realProp = ctx.prop_;
  ctx.call_ = (m, url, body) => { queries.push(JSON.stringify(body)); return []; };
  const realQuery = ctx.fsQuery_;
  delete ctx.fsQuery_;
  vm.runInContext(readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8').match(/function fsQuery_[\s\S]*?\n}\n/)[0], ctx);
  ctx.prop_ = () => 'proj';
  ctx.fsQuery_('notify', [['sent', false], ['sendAfter', 5, '<=']]);
  assert.match(queries.pop(), /"op":"LESS_THAN_OR_EQUAL","value":\{"integerValue":"5"\}/);
  ctx.fsQuery_ = realQuery; ctx.call_ = realCall; ctx.prop_ = realProp;
});

test('a travel time after nights beyond what the app allows never stops the sleep after a night shift', () => {
  const L = (day, hm) => ctx.localTime_(day, hm);
  const night = { ev: { t: 'Night', s: L('2026-11-09', '19:30'), e: L('2026-11-10', '08:00') }, cal: { role: 'rota' } };
  const p = (travelMins) => ({ id: 'sophie', settings: { hasShifts: true, sleepUntil: '14:00', travelMins }, items: [night], mine: false });
  const data = { overrides: {}, jobs: [] };
  assert.equal(ctx.sleepUntil_(p(1e9), data, L('2026-11-10', '13:00')), L('2026-11-10', '14:00'));
  assert.equal(ctx.sleepUntil_(p(-600), data, L('2026-11-10', '08:05')), L('2026-11-10', '14:00'));
});

test('a rota shared as working hours, then as everything: the leave already on it is never news', () => {
  const now = Date.now();
  const day = ctx.Utilities.formatDate(new Date(now + 4 * 864e5), 'Europe/London', 'yyyy-MM-dd');
  const L = (hm) => ctx.localTime_(day, hm);
  const { api } = smallProps({});
  ctx.PropertiesService = { getUserProperties: () => api };
  ctx.Utilities.getUuid = () => 'u' + Math.random();
  const writes = [];
  ctx.fsCommit_ = (w) => writes.push(...w);
  ctx.docName_ = (p) => p;
  const c = { person: { name: 'Sophie' }, people: { sophie: {}, ethan: {} } };
  const evs = [{ t: 'Long day', s: L('07:30'), e: L('20:00') }, { ad: 1, sd: ctx.keyPlus_(day, 1), ed: ctx.keyPlus_(day, 3), t: 'Annual leave' }];
  ctx.rotaChanged_({ person: 'sophie' }, c, 'rota', evs, api, { share: 'hours' });
  ctx.rotaChanged_({ person: 'sophie' }, c, 'rota', evs, api, { share: 'hours' });
  ctx.rotaChanged_({ person: 'sophie' }, c, 'rota', evs, api, { share: 'all' });
  assert.deepEqual(writes.map((w) => w.update.fields.body.stringValue), []);
  // a real change is still told, and under working hours never the leave
  ctx.rotaChanged_({ person: 'sophie' }, c, 'rota', [evs[1]], api, { share: 'hours' });
  assert.equal(writes.length, 1);
  assert.match(writes[0].update.fields.body.stringValue, /long day removed/);
  assert.doesNotMatch(writes[0].update.fields.body.stringValue, /leave|all-day/i);
});

test('a very full calendar never stops the others saving: big saves go in parts, and a month too full is left as it was', () => {
  withDigest();
  // the saves are split well under what Firestore takes in one request (10 MB, 500 writes)
  const sent = [];
  const realCall = ctx.call_, realProp = ctx.prop_;
  ctx.call_ = (m, url, body) => { sent.push(body.writes.length); return {}; };
  ctx.prop_ = () => 'proj';
  const realCommit = ctx.fsCommit_;
  vm.runInContext(readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8').match(/function fsCommit_[\s\S]*?\n}\n/)[0], ctx);
  const big = (i) => ({ update: { name: `d${i}`, fields: { x: { stringValue: 'x'.repeat(300e3) } } } });
  ctx.fsCommit_(Array.from({ length: 40 }, (_, i) => big(i)));
  assert.ok(sent.length >= 3, 'in parts');
  assert.equal(sent.reduce((a, b) => a + b, 0), 40);
  sent.length = 0;
  ctx.fsCommit_(Array.from({ length: 900 }, (_, i) => ({ delete: `d${i}` })));
  assert.deepEqual(sent, [400, 400, 100]);
  ctx.fsCommit_ = realCommit; ctx.call_ = realCall; ctx.prop_ = realProp;
  // one month with thousands of long events: that calendar says so, the others are saved
  const writes = [];
  ctx.fsCommit_ = (w) => writes.push(...w);
  ctx.docName_ = (p) => p;
  const store = {};
  ctx.PropertiesService = { getUserProperties: () => ({ getProperty: (k) => (k in store ? store[k] : null), getProperties: () => Object.assign({}, store), setProperties: (o) => Object.assign(store, o), setProperty: (k, v) => { store[k] = v; }, deleteProperty: (k) => { delete store[k]; } }) };
  const s0 = ctx.localTime_(ctx.Utilities.formatDate(new Date(Date.now() + 5 * 864e5), 'Europe/London', 'yyyy-MM-dd'), '09:00');
  const mk = (n, title) => Array.from({ length: n }, (_, i) => ({ id: `e${i}`, iCalUID: `e${i}@x`, summary: title, start: { dateTime: new Date(s0 + i * 60e3).toISOString() }, end: { dateTime: new Date(s0 + i * 60e3 + 30e3).toISOString() } }));
  const items = { 'team@x': mk(4000, 'Ward cover '.repeat(20)), 'p@x': mk(3, 'Dentist') };
  ctx.Calendar = { Events: { list: (id) => ({ items: items[id] }) } };
  const cal = (id, name) => ({ getId: () => id, getName: () => name, getColor: () => '', isOwnedByMe: () => true });
  ctx.CalendarApp = { getAllCalendars: () => [cal('team@x', 'Team'), cal('p@x', 'Main')], getDefaultCalendar: () => ({ getId: () => 'p@x' }) };
  const errors = [];
  const keyOf = (id) => ctx.shortKey_(id);
  const docs = { [keyOf('team@x')]: { account: 'e@x.com', lastSeen: Date.now(), name: 'Team', color: '', canWrite: true, primary: false, show: true, share: 'busy' }, [keyOf('p@x')]: { account: 'e@x.com', lastSeen: Date.now(), name: 'Main', color: '', canWrite: true, primary: true, show: true, share: 'all' } };
  store['h_' + keyOf('team@x')] = '{}'; store['h_' + keyOf('p@x')] = '{}';
  ctx.syncCalendars_({ email: 'e@x.com', person: 'ethan', main: true, people: [] }, { appEmail: 'e@x.com', calDocs: docs, hh: {} }, errors);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /calendar Team: It has too many events in \d{4}-\d{2}/);
  assert.ok(writes.some((w) => w.update && /ethan__.*__\d{4}-\d{2}$/.test(w.update.name) && w.update.name.includes(keyOf('p@x'))), 'the main calendar is saved');
  assert.ok(!writes.some((w) => w.update && w.update.name.includes(keyOf('team@x'))), 'the full one is left as it was');
});

test("a rota kept in your main calendar never tells your partner about your contacts' birthdays", () => {
  const now = Date.now();
  const day = ctx.Utilities.formatDate(new Date(now + 4 * 864e5), 'Europe/London', 'yyyy-MM-dd');
  const L = (hm) => ctx.localTime_(day, hm);
  const bday = { ad: 1, sd: day, ed: ctx.keyPlus_(day, 1), t: "Dave's birthday", np: 1 };
  const shift = { t: 'Long day', s: L('07:30'), e: L('20:00') };
  ctx.Utilities.getUuid = () => 'u' + Math.random();
  const writes = [];
  ctx.fsCommit_ = (w) => writes.push(...w);
  ctx.docName_ = (p) => p;
  const c = { person: { name: 'Sophie' }, people: { sophie: {}, ethan: {} } };
  // a new contact's birthday turning up is not news; nor is one going
  let { api } = smallProps({});
  ctx.rotaChanged_({ person: 'sophie' }, c, 'p', [shift], api, { share: 'all' });
  ctx.rotaChanged_({ person: 'sophie' }, c, 'p', [shift, bday], api, { share: 'all' });
  ctx.rotaChanged_({ person: 'sophie' }, c, 'p', [shift], api, { share: 'all' });
  assert.deepEqual(writes.map((w) => w.update.fields.body.stringValue), []);
  // saved by an earlier version, with the birthday in it: not "removed" either
  ({ api } = smallProps({}));
  ctx.rotaChanged_({ person: 'sophie' }, c, 'p', [shift, Object.assign({}, bday, { np: 0 })], api, { share: 'all' });
  ctx.rotaChanged_({ person: 'sophie' }, c, 'p', [shift, bday], api, { share: 'all' });
  assert.deepEqual(writes.map((w) => w.update.fields.body.stringValue), []);
});

test("a day off on one of your contacts' birthdays is told once, never again every run", () => {
  const now = Date.now();
  const day = ctx.Utilities.formatDate(new Date(now + 4 * 864e5), 'Europe/London', 'yyyy-MM-dd');
  const off = { ad: 1, sd: day, ed: ctx.keyPlus_(day, 1), t: 'Day off' };
  const bday = { ad: 1, sd: day, ed: ctx.keyPlus_(day, 1), t: "Dave's birthday", np: 1 };
  ctx.Utilities.getUuid = () => 'u' + Math.random();
  const writes = [];
  ctx.fsCommit_ = (w) => writes.push(...w);
  ctx.docName_ = (p) => p;
  const c = { person: { name: 'Sophie' }, people: { sophie: {}, ethan: {} } };
  const { api } = smallProps({});
  ctx.rotaChanged_({ person: 'sophie' }, c, 'p', [bday], api, { share: 'all' });
  for (let i = 0; i < 4; i++) ctx.rotaChanged_({ person: 'sophie' }, c, 'p', [off, bday], api, { share: 'all' });
  assert.deepEqual(writes.map((w) => w.update.fields.body.stringValue).map((b) => b.replace(/^\w+ \d+ \w+: /, '')), ['Day off added.']);
  // and a birthday saved by an earlier version still never comes up as removed
  writes.length = 0;
  const { api: a2 } = smallProps({});
  ctx.rotaChanged_({ person: 'sophie' }, c, 'p', [off, Object.assign({}, bday, { np: 0 })], a2, { share: 'all' });
  ctx.rotaChanged_({ person: 'sophie' }, c, 'p', [off, bday], a2, { share: 'all' });
  assert.deepEqual(writes, []);
});

test("the summaries never say your partner's working hours when every work calendar of theirs is shared as Nothing", () => {
  const day = '2026-11-10'; // a Tuesday
  ctx.fsGet_ = () => null;
  const feeds = { privateFeeds: [], sharedFeeds: [] };
  ctx.fsQuery_ = (coll) => feeds[coll] || [];
  const people = { ethan: { name: 'Ethan' }, sophie: { name: 'Sophie', settings: { workStart: '08:00', workEnd: '16:30' } } };
  const run = (share) => {
    ctx.fsList_ = () => [{ id: 'sophie__w', data: { owner: 'sophie', calKey: 'w', role: 'work', share } }, { id: 'sophie__p', data: { owner: 'sophie', calKey: 'p', role: 'normal', share: 'all' } }];
    const data = ctx.digestData_({ person: 'ethan' }, { settings: {}, people });
    return ctx.morningText_(data, day);
  };
  assert.match(run('hours'), /Sophie: working 8am to 4:30pm/);
  const hidden = run('none');
  assert.doesNotMatch(hidden, /8am|4:30pm/, hidden);
  assert.match(hidden, /Sophie: nothing planned/);
  // your own are always said
  assert.match(hidden, /You: working 9am to 6pm/);
});

test('a question that waited for quiet hours or sleep is not sent once it has been answered or its time has gone', () => {
  const realToken = ctx.saToken_, realProp = ctx.prop_;
  const day = (n) => ctx.Utilities.formatDate(new Date(Date.now() + n * 864e5), 'Europe/London', 'yyyy-MM-dd');
  const reqs = {
    'households/main/requests/rYes': { status: 'yes', when: { day: day(2), start: '19:00' } },
    'households/main/requests/rOver': { status: 'waiting', when: { day: day(-1), start: '12:00', end: '13:00' } },
    'households/main/requests/rOpen': { status: 'waiting', when: { day: day(2), start: '19:00' } },
    'households/main/requests/rMaybe': { status: 'maybe', when: null }
  };
  const { sent, writes } = notifyHarness(() => 200);
  ctx.fsGet_ = (p) => reqs[p] || null;
  const ask = (id, reqId) => ({ id, data: { to: 'sophie', kind: 'requests', title: 'Still waiting: Ethan asked you something', reqId, ask: '1', sendAfter: 0, sent: false }, updateTime: 't' });
  ctx.fsQuery_ = (coll) => (coll === 'notify' ? [ask('n1', 'rYes'), ask('n2', 'rOver'), ask('n3', 'rOpen'), ask('n4', 'rMaybe'),
    { id: 'n5', data: { to: 'sophie', kind: 'requests', title: 'Ethan said yes', reqId: 'rYes', sendAfter: 0, sent: false }, updateTime: 't' }] : []);
  ctx.fsList_ = () => [{ id: 't1', data: { token: 'tok' } }];
  ctx.processNotify_({ people: { sophie: { settings: { quiet: { on: false } } } } });
  assert.equal(sent.length, 3, 'the open ones, and the one that is not a question');
  const skipped = writes.filter((w) => w.update && w.update.fields.error).map((w) => w.update.name.split('/').pop());
  assert.deepEqual(skipped.sort(), ['n1', 'n2']);
  ctx.saToken_ = realToken; ctx.prop_ = realProp;
});

test('after nights, the sleep starts after the travel time home the app assumes (half an hour until it is set)', () => {
  const L = (day, hm) => ctx.localTime_(day, hm);
  const night = { ev: { t: 'Night', s: L('2026-11-09', '19:30'), e: L('2026-11-10', '08:00') }, cal: { role: 'rota' } };
  const p = (extra) => ({ id: 'sophie', settings: Object.assign({ hasShifts: true, sleepUntil: '14:00' }, extra), items: [night], mine: false });
  const data = { overrides: {}, jobs: [] };
  assert.equal(ctx.sleepUntil_(p({}), data, L('2026-11-10', '08:15')), 0, 'still on the way home');
  assert.equal(ctx.sleepUntil_(p({}), data, L('2026-11-10', '08:35')), L('2026-11-10', '14:00'));
  assert.equal(ctx.sleepUntil_(p({ travelMins: 0 }), data, L('2026-11-10', '08:05')), L('2026-11-10', '14:00'));
});

test("a contact's birthday in a rota kept in your main calendar never hides the night shift that day", () => {
  withDigest();
  const L = (day, hm) => ctx.localTime_(day, hm);
  const bday = ctx.normApi_({ id: 'b1', iCalUID: 'b1@google.com', summary: "Dave's birthday", eventType: 'birthday', birthdayProperties: { type: 'birthday' }, start: { date: '2026-11-09' }, end: { date: '2026-11-10' } });
  const night = ctx.normApi_({ id: 'n1', iCalUID: 'n1@google.com', summary: 'Night', start: { dateTime: new Date(L('2026-11-09', '19:30')).toISOString() }, end: { dateTime: new Date(L('2026-11-10', '08:00')).toISOString() } });
  // your own copy, as the sync saves it (all-day entries first)
  const { api } = fakeProps();
  const w = ctx.feedWrites_({ person: 'sophie', email: 's@x.com' }, { appEmail: 's@x.com' }, 'p', { share: 'all' }, [night, bday], api).writes;
  const saved = JSON.parse(JSON.stringify(w.find((x) => x.update.name.includes('/privateFeeds/')).update.fields.events.arrayValue.values.map((v) => ctx.fromValue_(v))));
  const p = { id: 'sophie', settings: { hasShifts: true, sleepUntil: '14:00', travelMins: 0 }, items: saved.map((ev) => ({ ev, cal: { role: 'rota' } })), mine: true };
  const data = { overrides: {}, jobs: [] };
  assert.match(ctx.dayWords_(ctx.personDay_(p, '2026-11-09', data)), /night shift from 7:30pm/);
  assert.equal(ctx.sleepUntil_(p, data, L('2026-11-10', '09:00')), L('2026-11-10', '14:00'), 'asleep after it');
});
