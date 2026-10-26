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
