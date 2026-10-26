// Checks of a few parts of the calendar sync (apps-script/Code.gs), run outside Google with a
// small stand-in for Utilities: node --test test/sync.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

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
    return fmt.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace(/^H$/, String(+p.hour)).replace(/^m$/, String(+p.minute));
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
