// Playwright checks of the demo at phone size: node --test test/ui.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { serve } from './serve.mjs';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const PORT = 8841;
const URL = `http://localhost:${PORT}/index.html`;
let server; let browser;

before(async () => { server = await serve(PORT); browser = await chromium.launch(); });
after(async () => { await browser.close(); server.close(); });

async function open(who, hash = '#today') {
  const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'en-GB', timezoneId: 'Europe/London', bypassCSP: true });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.goto(`${URL}?demo=${who}${hash}`);
  await page.waitForSelector('.bottom-nav');
  return page;
}
const go = (page, hash) => page.evaluate((h) => { location.hash = h; }, hash).then(() => page.waitForTimeout(150));
// the app's own modules, the same copies the page is using
const mods = (page, fn, arg) => page.evaluate(async ([src, a]) => {
  const store = await import('./js/store.js'); const ui = (await import('./js/uistate.js')).ui;
  return (0, eval)(src)(store, ui, a);
}, [fn.toString(), arg]);

test('every screen draws for both of you, with no errors and nothing wider than the phone', async () => {
  for (const who of ['ethan', 'sophie']) {
    const page = await open(who);
    for (const h of ['#today', '#calendar', '#requests', '#ask', '#add', '#jobs', '#jar', '#settings', '#settings/calendars', '#settings/shifts', '#settings/routine', '#settings/notifications', '#settings/holidays', '#settings/apps', '#settings/account']) {
      await go(page, h);
      assert.doesNotMatch(await page.textContent('main'), /Something went wrong/, `${who} ${h}`);
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(wide <= 0, `${who} ${h} is ${wide}px too wide`);
    }
    await go(page, '#calendar');
    await page.click('[data-act="calView"][data-v="week"]');
    assert.equal(await page.locator('.wday').count(), 7);
    assert.deepEqual(page.errors, [], who);
    await page.context().close();
  }
});

test('a request shows its day afresh, not the "Tomorrow" saved when it was sent', async () => {
  const page = await open('ethan', '#requests');
  await mods(page, (store, ui, a) => {
    const d = new Date(); d.setDate(d.getDate() + 3);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return store.store.backend.commit([{ type: 'set', path: 'requests/r_old', data: { from: 'sophie', to: 'ethan', type: 'plan', title: 'Old one', when: { day, start: '19:00', end: '21:00', allDay: false, label: 'Tomorrow, 7pm to 9pm' }, status: 'waiting', created: Date.now() } }]);
  });
  await page.waitForTimeout(150);
  const card = page.locator('article', { hasText: 'Old one' });
  const text = await card.textContent();
  assert.doesNotMatch(text, /Tomorrow/);
  assert.match(text, /(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) \d+ \w+, 7pm to 9pm/);
  await page.context().close();
});

test('the free time you tapped is the one that gets sent, even if the list changes', async () => {
  const page = await open('ethan', '#ask');
  await page.fill('#ask-title', 'Cinema');
  const slots = page.locator('[data-act="askSlot"]');
  assert.ok(await slots.count() >= 3);
  await slots.nth(2).click();
  const picked = await mods(page, (s, ui) => ui.ask.pick);
  // something new fills the first free time, so the list moves up by one
  const first = await mods(page, (s, ui) => ui.ask.shown[0]);
  await mods(page, (store, ui, f) => store.actions.addEvent({ who: 'me', title: 'Gym', day: f.key, start: f.start, end: f.end, allDay: false }), first);
  await go(page, '#ask');
  await page.click('[data-act="askSend"]');
  await page.waitForSelector('.done-card');
  const sent = await mods(page, (store) => store.store.state.requests.find((r) => r.title === 'Cinema').when);
  assert.equal(sent.day, picked.key);
  assert.equal(sent.start, picked.start);
  await page.context().close();
});

test('a title with HTML in it shows as text', async () => {
  const page = await open('ethan', '#add');
  await page.fill('#add-title', '<img src=x onerror="window.__xss=1">Party');
  await page.click('[data-act="addAllDayT"]');
  await page.click('[data-act="addSave"]');
  await page.waitForSelector('.done-card');
  await go(page, '#today');
  await page.waitForTimeout(1000); // the demo's pretend sync
  await go(page, '#today');
  assert.match(await page.textContent('main'), /<img src=x onerror="window.__xss=1">Party/);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.equal(await page.locator('main img').count(), 0);
  await page.context().close();
});

test('"See the rest of the week" opens the week, with tomorrow open', async () => {
  const page = await open('sophie');
  await page.click('text=See the rest of the week');
  await page.waitForSelector('.wday');
  assert.equal(await page.locator('[data-act="weekOpen"][aria-expanded="true"]').count(), 1);
  const expected = await page.evaluate(() => { const d = new Date(); d.setDate(d.getDate() + 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  assert.equal(await page.getAttribute('[data-act="weekOpen"][aria-expanded="true"]', 'data-day'), expected);
  await page.context().close();
});

test('a birthday can be cleared again', async () => {
  const page = await open('ethan', '#settings/routine');
  await page.fill('#bd-ethan', '2000-03-14');
  await page.dispatchEvent('#bd-ethan', 'change');
  assert.equal(await mods(page, (store) => store.store.state.household.birthdays.ethan), '03-14');
  await page.fill('#bd-ethan', '');
  await page.dispatchEvent('#bd-ethan', 'change');
  assert.equal(await mods(page, (store) => store.store.state.household.birthdays.ethan), '');
  await page.evaluate(() => document.activeElement.blur()); // as tapping Today would
  await go(page, '#today');
  const list = await page.getAttribute('#cd-rot', 'data-list');
  assert.doesNotMatch(list, /Your birthday/);
  await page.context().close();
});

test('left open overnight, the calendar moves on to the new day', async () => {
  const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'en-GB', timezoneId: 'Europe/London', bypassCSP: true });
  const page = await ctx.newPage();
  await page.clock.install({ time: new Date('2026-11-30T23:58:00') });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.goto(`${URL}?demo=ethan#calendar`);
  await page.waitForSelector('.bottom-nav');
  assert.equal(await mods(page, (s, ui) => ui.calSel), '2026-11-30');
  await page.clock.runFor(3 * 60 * 1000);
  assert.equal(await mods(page, (s, ui) => ui.calSel), '2026-12-01');
  assert.equal(await mods(page, (s, ui) => ui.calMonth.getMonth()), 11);
  await ctx.close();
});

test("an event's page shows when it ends", async () => {
  const page = await open('ethan', '#calendar');
  const key = await page.evaluate(() => { const d = new Date(); d.setDate(d.getDate() + 2); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  await page.click(`[data-act="calSel"][data-day="${key}"]`);
  await page.click('button.ag-row:has-text("Dentist")');
  await page.waitForSelector('[data-act="evBack"]');
  assert.match(await page.textContent('main'), /4:30pm to 5:15pm/);
  await page.context().close();
});

test('Add: an end before the start is questioned, not quietly changed', async () => {
  const page = await open('ethan', '#add');
  await page.fill('#add-title', 'Late film');
  await page.fill('#add-start', '22:00');
  await page.fill('#add-end', '01:00');
  await page.click('[data-act="addSave"]');
  assert.match(await page.textContent('.toast'), /end needs to be after the start/);
  assert.equal(await page.locator('.done-card').count(), 0);
  await page.context().close();
});
