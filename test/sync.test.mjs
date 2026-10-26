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
