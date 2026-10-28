// Playwright checks of the demo at phone size: node --test test/ui.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { serve } from './serve.mjs';
import { useFakeFirebase } from './fake-firebase.mjs';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const PORT = Number(process.env.PORT) || 8841;
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

test('Ask: an end before the start is questioned, not quietly dropped', async () => {
  const page = await open('ethan', '#ask');
  await page.fill('#ask-title', 'Late walk');
  await page.click('[data-act="askCustom"]');
  await page.fill('#ask-start', '21:00');
  await page.fill('#ask-end', '20:00');
  await page.click('[data-act="askSend"]');
  assert.match(await page.textContent('.toast'), /end needs to be after the start/);
  assert.equal(await page.locator('.done-card').count(), 0);
  await page.context().close();
});

test('Ask, or Add for your partner: a time that has already gone is questioned, not sent to be turned down', async () => {
  const page = await open('ethan', '#ask');
  const y = await page.evaluate(() => { const d = new Date(); d.setDate(d.getDate() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  await page.fill('#ask-title', 'Walk');
  await page.click('[data-act="askCustom"]');
  await page.fill('#ask-day', y);
  await page.click('[data-act="askSend"]');
  assert.match(await page.textContent('.toast'), /already gone/);
  assert.equal(await page.locator('.done-card').count(), 0);
  await page.click('.back-link');
  await go(page, '#add');
  await page.click('[data-act="addWho"][data-v="partner"]');
  await page.fill('#add-title', 'Dentist');
  await page.click('[data-act="addDay"][data-v="pick"]');
  await page.fill('#add-date', y);
  await page.fill('#add-start', '10:00');
  await page.click('[data-act="addSave"]');
  assert.match(await page.textContent('.toast'), /already gone/);
  assert.equal(await page.locator('.done-card').count(), 0);
  // for yourself it's fine: it's your own calendar
  await page.click('[data-act="addWho"][data-v="me"]');
  await page.click('[data-act="addSave"]');
  assert.equal(await page.locator('.done-card').count(), 1);
  await page.context().close();
});

test("going back with the phone's Back while a box is still focused (keyboard closed) moves to the screen it says", async () => {
  const page = await open('ethan', '#today');
  await go(page, '#ask');
  await page.fill('#ask-title', 'Walk');
  // the text box keeps focus after the keyboard is closed: Back changes the address
  await page.evaluate(() => history.back());
  await page.waitForTimeout(250);
  assert.ok(await page.locator('.cd-strip, .page-head h1:text("Today")').count(), 'Today is showing');
  assert.equal(await page.locator('#ask-title').count(), 0);
  await page.context().close();
});

test("a partner's shift times can't break the Shifts page", async () => {
  const page = await open('ethan', '#settings/shifts');
  const p = await page.getAttribute('[data-act="shiftDay"]', 'data-p');
  assert.equal(p, 'sophie');
  const src = (await import('node:fs')).readFileSync(new globalThis.URL('../js/views-settings.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /data-p="\$\{who\}"/);
  await page.context().close();
});

test('an overnight event can be moved to another day, and still ends the next morning', async () => {
  const page = await open('ethan', '#calendar');
  const dk = (n) => page.evaluate((x) => { const d = new Date(); d.setDate(d.getDate() + x); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }, n);
  const day = await dk(3); const next = await dk(5); const after = await dk(6);
  await mods(page, (store, ui, d) => { store.store.backend.commit([{ type: 'add', path: 'outbox', data: { person: 'ethan', op: 'create', tag: 'add:late1', byEmail: 'ethan@example.com', done: false, created: Date.now(), event: { title: 'Late film', day: d, start: '22:00', end: '01:00', allDay: false } } }]); return store.store.backend.ping(); }, day);
  await page.waitForTimeout(1100);
  await page.click(`[data-act="calSel"][data-day="${day}"]`);
  await page.click('button.ag-row:has-text("Late film")');
  await page.click('[data-act="evEdit"]');
  await page.fill('#ed-day', next);
  await page.click('[data-act="evSave"]');
  assert.match(await page.textContent('.toast'), /Saving the change/);
  const ch = await mods(page, (store) => Object.values(store.store.raw.outbox).find((o) => o.op === 'update').changes);
  assert.equal(ch.day, next);
  assert.equal(ch.endDay, after);
  await page.context().close();
});

test("a shift your partner saved with HTML in its kind can't add anything to the page", async () => {
  const page = await open('sophie', '#settings/shifts');
  await mods(page, (store) => {
    const d = new Date(); const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return store.store.backend.commit([{ type: 'set', path: `shifts/sophie_${day}`, data: { person: 'sophie', day, type: '"><b id="pwn">x</b><span class="', by: 'ethan', updated: Date.now() } }]);
  });
  await page.waitForTimeout(200);
  await go(page, '#settings/shifts');
  assert.equal(await page.locator('#pwn').count(), 0);
  await go(page, '#today');
  assert.equal(await page.locator('#pwn').count(), 0);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('an odd record in a shared list (a request, job or shift) can’t break your screens', async () => {
  const page = await open('ethan');
  await mods(page, (store) => {
    const d = new Date(); const dk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return store.store.backend.commit([
      { type: 'set', path: 'requests/odd', data: { from: 'sophie', to: 'ethan', type: 'plan', title: 7, when: { day: dk, start: 7, end: { a: 1 } }, status: 'waiting', hold: true, created: Date.now() } },
      { type: 'add', path: 'jobs', data: { title: 5, who: 'ethan', day: dk, time: 9, done: false } },
      { type: 'set', path: 'shifts/sophie_odd', data: { person: 'sophie', day: dk, type: 'long', start: 7 } }
    ]);
  });
  await page.waitForTimeout(200);
  for (const h of ['#today', '#calendar', '#requests', '#jobs', '#settings/shifts']) {
    await go(page, h);
    assert.doesNotMatch(await page.textContent('main'), /Something went wrong/, h);
  }
  await page.context().close();
});

test('something added to a calendar in your other Google account goes to that account, and so do its changes', async () => {
  const page = await open('ethan', '#add');
  const items = await mods(page, async (store) => {
    const S = store.store;
    const d = new Date(); d.setDate(d.getDate() + 2);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const ping = S.backend.ping; S.backend.ping = () => Promise.resolve(true); // hold the pretend sync
    await store.actions.addEvent({ who: 'me', title: 'Gym', day, start: '07:00', end: '08:00', allDay: false, calKey: 'second' });
    await store.actions.addEvent({ who: 'both', title: 'Tea', day, start: '17:00', end: '18:00', allDay: false, calKey: 'second' });
    await store.actions.addEvent({ who: 'me', title: 'Shop', day, start: '12:00', end: '13:00', allDay: false, calKey: 'primary' });
    const made = Object.values(S.raw.outbox).filter((o) => !o.done).map((o) => ({ title: o.event.title, person: o.person, account: o.account || null }));
    // and a change to the gym, once it's in that calendar
    S.backend.ping = ping; await new Promise((r) => { ping(); setTimeout(r, 900); });
    const gym = S.state.events.find((e) => e.title === 'Gym');
    S.backend.ping = () => Promise.resolve(true);
    await store.actions.editEvent({ ev: gym, changes: { title: 'Gym class' } });
    const edit = Object.values(S.raw.outbox).find((o) => !o.done && o.op === 'update');
    return { made, edit: edit && edit.account };
  });
  assert.deepEqual(items.made.filter((o) => o.title === 'Gym').map((o) => o.account), ['Second Gmail']);
  assert.deepEqual(items.made.filter((o) => o.title === 'Tea').map((o) => [o.person, o.account]).sort(), [['ethan', 'Second Gmail'], ['sophie', null]]);
  assert.deepEqual(items.made.filter((o) => o.title === 'Shop').map((o) => o.account), ['Personal Gmail']);
  assert.equal(items.edit, 'Second Gmail');
  await page.context().close();
});

test('odd values in your partner’s record or the ideas jar can’t break your screens', async () => {
  const page = await open('ethan');
  await mods(page, (store) => store.store.backend.commit([
    { type: 'update', path: 'people/sophie', data: { name: 9, settings: { workDays: 5, sleepUntil: 14, travelMins: 'x', shiftTypes: { night: { label: 3, start: 7, end: { a: 1 } } } }, countdowns: { c1: { title: 'Trip', date: 5, shared: true } } } },
    { type: 'set', path: 'ideas/odd', data: { title: 3, cost: 'lots', where: 'out' } }
  ]));
  await page.waitForTimeout(200);
  for (const h of ['#today', '#calendar', '#requests', '#ask', '#jar', '#settings/shifts', '#settings/holidays']) {
    await go(page, h);
    assert.doesNotMatch(await page.textContent('main'), /Something went wrong/, h);
  }
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("your partner's holiday just for themselves doesn't say you said yes, or that it's in both calendars", async () => {
  const page = await open('ethan', '#requests');
  await mods(page, (store) => {
    const d = new Date(); d.setDate(d.getDate() + 20);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return store.store.backend.commit([{ type: 'set', path: 'requests/r_solo', data: { from: 'sophie', to: 'ethan', type: 'leave', title: 'Lisbon', own: true, people: ['sophie'], status: 'yes', hold: false, days: { sophie: 1 }, when: { day, endDay: day, allDay: true, label: '' }, note: '', created: Date.now(), answeredAt: Date.now() } }]);
  });
  await page.waitForTimeout(150);
  const text = await page.locator('article', { hasText: 'Lisbon' }).textContent();
  assert.doesNotMatch(text, /You said yes|both your calendars/);
  assert.match(text, /Sophie booked it/);
  await page.context().close();
});


// ---------- the real backend (js/firebase.js), with a stand-in for the Firebase SDK ----------
const H = 'households/main';
const HOUSE = { emails: ['e@x.com', 's@x.com'], dinnerTime: '19:00', favours: ['Put the bins out'], emailsLocked: true };
const PEOPLE = { ethan: { name: 'Ethan', email: 'e@x.com', joined: true, settings: { workDays: [1, 2, 3, 4, 5] } }, sophie: { name: 'Sophie', email: 's@x.com', joined: true, settings: { hasShifts: true, workDays: [] } } };
async function openReal(hash = '#today') {
  const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'en-GB', timezoneId: 'Europe/London', bypassCSP: true });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await useFakeFirebase(page, { email: 'e@x.com', displayName: 'Ethan Whitfield' });
  // the household asked for straight from the server's web address (past the saved copy): as page.restStatus says
  page.restStatus = 404;
  page.restCalls = 0;
  await page.route(/firestore\.googleapis\.com/, (r) => { page.restCalls++; return r.fulfill({ status: page.restStatus, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{}' }); });
  await page.goto(`${URL}${hash}`);
  await page.waitForFunction((p) => window.__fb && window.__fb.listening && window.__fb.listening(p), H);
  return page;
}
const fb = (page, fn, ...args) => page.evaluate(([src, a]) => (0, eval)(src)(window.__fb, ...a), [fn.toString(), args]);
const mainText = (page) => page.textContent('main');

test('opening the app: no "Not on the list" while your records are still on their way', async () => {
  const page = await openReal();
  await fb(page, (f, h, house) => f.emitDoc(h, house), H, HOUSE);
  await page.waitForTimeout(300);
  assert.doesNotMatch(await mainText(page), /Not on the list/);
  await fb(page, (f, h, people) => f.emitColl(`${h}/people`, people), H, PEOPLE);
  await page.waitForSelector('.bottom-nav');
  assert.match(await mainText(page), /Today/);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('signing out just as something arrives from the server never brings the calendars back up', async () => {
  const page = await openReal();
  await fb(page, (f, h, house) => f.emitDoc(h, house), H, HOUSE);
  await fb(page, (f, h, people) => f.emitColl(`${h}/people`, people), H, PEOPLE);
  await page.waitForSelector('.bottom-nav');
  // a change arrives, and in the same moment this phone is signed out
  await fb(page, (f, h, people) => { f.emitColl(`${h}/people`, people); f.authChanged(null); }, H, PEOPLE);
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.bottom-nav').count(), 0);
  assert.match(await mainText(page), /Sign in with Google/);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('opening the app offline for the first time shows it loading, not the first-time setup', async () => {
  const page = await openReal();
  await fb(page, (f, h) => f.emitDoc(h, null, { fromCache: true }), H);
  await page.waitForTimeout(200);
  assert.doesNotMatch(await mainText(page), /Set up/);
  // the server says there's no household yet: now it's the first-time setup
  await fb(page, (f, h) => f.emitDoc(h, null), H);
  await page.waitForTimeout(200);
  assert.match(await mainText(page), /Set up Caledonite/);
  await page.context().close();
});

test('opening the app offline with a change from last time still waiting to be sent: it opens, not stuck loading', async () => {
  const page = await openReal();
  // the phone's saved copy, with a settings change made offline before the app was closed
  await fb(page, (f, h, house) => f.emitDoc(h, Object.assign({}, house, { settingsRev: 5 }), { pending: true, fromCache: true }), H, HOUSE);
  await page.waitForFunction((p) => window.__fb.listening(`${p}/people`), H, { timeout: 2000 });
  await fb(page, (f, h, people) => f.emitColl(`${h}/people`, people), H, PEOPLE);
  await page.waitForSelector('.bottom-nav', { timeout: 2000 });
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('a change to the shared settings shows straight away, even before it reaches the server (offline)', async () => {
  const page = await openReal('#settings/requests');
  await fb(page, (f, h, house, people) => { f.emitDoc(h, house); f.emitColl(`${h}/people`, people); }, H, HOUSE, PEOPLE);
  await page.waitForSelector('.bottom-nav');
  await fb(page, (f, h, house) => f.emitDoc(h, Object.assign({}, house, { favours: ['Put the bins out', 'Walk to the shop'] }), { pending: true }), H, HOUSE);
  await page.waitForTimeout(250);
  assert.match(await mainText(page), /Walk to the shop/);
  await page.context().close();
});

test('the week strips put things at the right time on the day the clocks change', async () => {
  const page = await open('ethan', '#today');
  // Sunday 28 March 2027: the clocks go forward at 1am. Noon to 1pm sits a third of the way along (6am to midnight).
  await mods(page, (store) => { store.store.backend.commit([{ type: 'add', path: 'outbox', data: { person: 'ethan', op: 'create', tag: 'add:dst1', byEmail: 'ethan@example.com', done: false, created: Date.now(), event: { title: 'Brunch', day: '2027-03-28', start: '12:00', end: '13:00', allDay: false } } }]); return store.store.backend.ping(); });
  await page.waitForTimeout(1000);
  await mods(page, (store, ui) => { ui.calView = 'week'; ui.weekStart = new Date(2027, 2, 22); ui.weekOpen = null; });
  await go(page, '#calendar');
  const lefts = await page.locator('.wday').nth(6).locator('.strip').first().locator('.seg-bar').evaluateAll((els) => els.map((e) => e.style.left));
  assert.ok(lefts.includes('33.33%'), lefts.join(' '));
  await page.context().close();
});

test('a settings switch saves just that setting, so one changed on your other phone meanwhile is kept', async () => {
  const page = await open('ethan', '#settings/notifications');
  await mods(page, (store) => {
    const b = store.store.backend; const real = b.commit.bind(b);
    window.__sent = [];
    b.commit = (ops) => { window.__sent.push(...ops.filter((o) => o.path === 'people/ethan').map((o) => o.data.settings)); return real(ops); };
  });
  await page.click('[data-act="notifToggle"][data-f="notes"]');
  await page.click('[data-act="quietToggle"]');
  await page.click('[data-act="summaryToggle"][data-f="morning"]');
  await go(page, '#settings/holidays');
  await page.click('[data-act="leaveToggle"]');
  const sent = await page.evaluate(() => window.__sent);
  assert.deepEqual(sent, [{ notif: { notes: false } }, { quiet: { on: false, skip: null } }, { morning: { on: false } }, { leave: { bankHolsCount: true } }]);
  await page.context().close();
});

test("odd values in the household record (dinner time, favours, birthdays) can't break your screens", async () => {
  const page = await open('ethan');
  await mods(page, (store) => store.store.backend.commit([{ type: 'update', path: '', data: { dinnerTime: 1900, favours: 'bins', birthdays: 7 } }]));
  await page.waitForTimeout(200);
  for (const h of ['#today', '#calendar', '#ask', '#settings', '#settings/routine', '#settings/requests']) {
    await go(page, h);
    if (h === '#ask') await page.selectOption('#ask-type', 'favour');
    assert.doesNotMatch(await page.textContent('main'), /Something went wrong|NaN|undefined/, h);
  }
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("a birthday or your partner's shift time saves just that one, so one changed on the other phone meanwhile is kept", async () => {
  const page = await open('ethan', '#settings/routine');
  await mods(page, (store) => {
    const b = store.store.backend; const real = b.commit.bind(b);
    window.__sent = [];
    b.commit = (ops) => { window.__sent.push(...ops.map((o) => ({ path: o.path, data: o.data }))); return real(ops); };
    // what this phone last heard: Sophie's birthday, and her usual shift times
    return real([{ type: 'update', path: '', data: { birthdays: { sophie: '05-01' } } }]);
  });
  await page.fill('#bd-ethan', '2000-03-14');
  await page.dispatchEvent('#bd-ethan', 'change');
  await page.evaluate(() => document.activeElement.blur());
  await go(page, '#settings/shifts');
  await page.fill('#st-night', '20:00');
  await page.dispatchEvent('#st-night', 'change');
  const sent = await page.evaluate(() => window.__sent);
  assert.deepEqual(sent.find((o) => o.path === '').data, { birthdays: { ethan: '03-14' } });
  const sh = sent.find((o) => o.path === 'people/sophie').data.settings.shiftTypes;
  assert.deepEqual(Object.keys(sh), ['night']);
  assert.equal(sh.night.start, '20:00');
  assert.equal(sh.night.end, '08:00');
  await page.context().close();
});

test('a "not tonight" from a night that has passed no longer says quiet hours are off', async () => {
  const page = await open('ethan', '#settings/notifications');
  await mods(page, (store) => store.actions.updateMySettings({ quiet: { skip: '2026-01-03' } }));
  await go(page, '#settings/notifications');
  assert.doesNotMatch(await page.textContent('main'), /off for one night/);
  // tonight's still does
  await mods(page, async (store) => { const L = await import('./js/logic.js'); return store.actions.updateMySettings({ quiet: { skip: L.quietNight(L.settingsOf(store.store.state, store.store.state.me)) } }); });
  await go(page, '#settings/notifications');
  assert.match(await page.textContent('main'), /off for one night/);
  await page.context().close();
});

test('a request your partner isn\'t sure about can still be called off (and its pencilled-in time freed)', async () => {
  const page = await open('ethan', '#requests');
  await mods(page, (store) => store.store.backend.commit([{ type: 'update', path: 'requests/r_keep', data: { status: 'maybe' } }]));
  await page.click('[data-act="reqTab"][data-v="sent"]');
  const card = page.locator('article', { hasText: 'Keep the day free for me' });
  await card.locator('[data-act="answer"][data-a="cancel"]').click();
  await page.waitForTimeout(150);
  assert.equal(await mods(page, (store) => store.store.state.requests.find((r) => r.id === 'r_keep').status), 'cancelled');
  await page.context().close();
});

test('a request whose time went by while it waited no longer asks for an answer, and can be cleared away', async () => {
  const page = await open('ethan', '#requests');
  const before = await page.textContent('.bottom-nav .badge');
  await mods(page, (store) => {
    const d = new Date(); d.setDate(d.getDate() - 2);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return store.store.backend.commit([
      { type: 'set', path: 'requests/r_gone', data: { from: 'sophie', to: 'ethan', type: 'plan', title: 'Gone by', when: { day, start: '10:00', end: '12:00', allDay: false, label: '' }, hold: true, status: 'waiting', created: Date.now() - 3 * 864e5 } },
      { type: 'set', path: 'requests/r_mine', data: { from: 'ethan', to: 'sophie', type: 'plan', title: 'Mine gone by', when: { day, start: '19:00', end: '21:00', allDay: false, label: '' }, hold: false, status: 'waiting', created: Date.now() - 3 * 864e5 } }
    ]);
  });
  await page.waitForTimeout(150);
  assert.equal(await page.textContent('.bottom-nav .badge'), before, 'not counted as waiting for you');
  const card = page.locator('article', { hasText: 'Gone by' });
  assert.match(await card.textContent(), /This time has passed/);
  assert.equal(await card.locator('[data-a="yes"], [data-act="suggestOpen"], [data-a="maybe"]').count(), 0);
  await card.locator('[data-a="no"]').click();
  await page.waitForTimeout(150);
  assert.equal(await mods(page, (store) => store.store.raw.requests.r_gone.status), 'no');
  // what you asked: no reminder to send, just call it off
  await page.click('[data-act="reqTab"][data-v="sent"]');
  const mine = page.locator('article', { hasText: 'Mine gone by' });
  assert.equal(await mine.locator('[data-a="remind"]').count(), 0);
  assert.equal(await mine.locator('[data-a="cancel"]').count(), 1);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('the page runs under its own Content Security Policy: the theme script is allowed and nothing is blocked', async () => {
  const { readFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const html = readFileSync(new globalThis.URL('../index.html', import.meta.url), 'utf8');
  const inline = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.ok(html.includes(`'sha256-${createHash('sha256').update(inline).digest('base64')}'`), 'the CSP has the hash of the theme script as it is now');
  // with the policy enforced (the other checks skip it)
  const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'en-GB', timezoneId: 'Europe/London' });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('caledonite.look', JSON.stringify({ theme: 'dragonfire' }));
    window.__blocked = []; document.addEventListener('securitypolicyviolation', (e) => window.__blocked.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.goto(`${URL}?demo=sophie#today`);
  await page.waitForSelector('.bottom-nav');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.mode), 'dark', 'the theme script ran');
  for (const h of ['#calendar', '#requests', '#ask', '#add', '#jar', '#settings/theme']) await go(page, h);
  assert.deepEqual(await page.evaluate(() => window.__blocked), []);
  await ctx.close();
});

test('the times along the top of the week never run into each other on a small phone', async () => {
  const ctx = await browser.newContext({ viewport: { width: 320, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'en-GB', timezoneId: 'Europe/London', bypassCSP: true });
  const page = await ctx.newPage();
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.goto(`${URL}?demo=ethan#calendar`);
  await page.waitForSelector('.bottom-nav');
  await page.click('[data-act="calView"][data-v="week"]');
  const boxes = await page.$$eval('.scale > div span', (els) => els.map((e) => { const b = e.getBoundingClientRect(); return [b.left, b.right]; }));
  assert.equal(boxes.length, 4);
  for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i][0] >= boxes[i - 1][1], `label ${i} overlaps the one before`);
  await ctx.close();
});

test('an opened list of older requests or done jobs stays open when the screen redraws', async () => {
  const page = await open('ethan', '#requests');
  await mods(page, (store) => store.store.backend.commit([
    { type: 'set', path: 'requests/r_old', data: { from: 'sophie', to: 'ethan', type: 'plan', title: 'Long ago', when: null, status: 'no', created: Date.now() - 20 * 86400000, answeredAt: Date.now() - 20 * 86400000 } },
    { type: 'set', path: 'jobs/j_done', data: { title: 'Done one', who: 'ethan', day: '2026-01-01', done: true, doneAt: Date.now() } }
  ]));
  await page.waitForTimeout(150);
  await page.click('details.older summary');
  await page.waitForTimeout(100);
  // a redraw: something changed on the other phone
  await mods(page, (store) => store.store.backend.commit([{ type: 'update', path: '', data: { settingsRev: Date.now() } }]));
  await page.waitForTimeout(150);
  assert.equal(await page.locator('details.older').evaluate((d) => d.open), true);
  assert.ok(await page.locator('details.older', { hasText: 'Long ago' }).isVisible());
  await go(page, '#jobs');
  await page.click('details.older summary');
  await page.waitForTimeout(100);
  await mods(page, (store) => store.store.backend.commit([{ type: 'update', path: '', data: { settingsRev: Date.now() } }]));
  await page.waitForTimeout(150);
  assert.equal(await page.locator('details.older').evaluate((d) => d.open), true);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('a list being chosen from is never redrawn away under the picker, and the choice then shows', async () => {
  const page = await open('ethan', '#add');
  await page.click('[data-act="addMore"]');
  await page.focus('#add-repeat');
  await page.evaluate(() => { window.__sel = document.getElementById('add-repeat'); });
  // something changes on the other phone while the picker is open
  await mods(page, (store) => store.store.backend.commit([{ type: 'update', path: '', data: { settingsRev: Date.now() } }]));
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => document.getElementById('add-repeat') === window.__sel && document.activeElement === window.__sel), true);
  await page.selectOption('#add-repeat', 'WEEKLY:1');
  await page.waitForTimeout(150);
  assert.match(await page.textContent('.more-btn'), /Every week/);
  assert.equal(await page.inputValue('#add-repeat'), 'WEEKLY:1');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('a list left focused with nothing chosen holds the screen back only until the app is put away', async () => {
  const page = await open('ethan', '#add');
  await page.click('[data-act="addMore"]');
  await page.focus('#add-repeat');
  await page.evaluate(() => { window.__sel = document.getElementById('add-repeat'); });
  // the picker closed without a choice (no change), then something changes on the other phone
  await mods(page, (store) => store.store.backend.commit([{ type: 'update', path: '', data: { settingsRev: Date.now() } }]));
  await page.waitForTimeout(100);
  // the phone is put away, then the app opened again
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => document.getElementById('add-repeat') !== window.__sel), true, 'the screen has been redrawn');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('a message shows, and goes again, even while a box is still focused', async () => {
  const page = await open('ethan', '#add');
  // saved with no name: the name box is focused (keyboard up) with the message
  await page.click('[data-act="addSave"]');
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'add-title');
  assert.match(await page.textContent('.toast'), /Add what it is first/);
  await page.waitForTimeout(2900);
  assert.equal(await page.locator('.toast').count(), 0, 'not left over the screen while typing');
  // a date picked with the box still focused: "Saved." still shows
  await go(page, '#settings/routine');
  await page.focus('#bd-ethan');
  await page.evaluate(() => { const el = document.getElementById('bd-ethan'); el.value = '2000-03-14'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'bd-ethan');
  assert.match(await page.textContent('.toast'), /Saved/);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('something added for your partner says it went in their calendar, not both', async () => {
  const page = await open('ethan', '#requests');
  await mods(page, (store) => {
    const d = new Date(); d.setDate(d.getDate() + 3);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return store.store.backend.commit([
      { type: 'set', path: 'requests/r_add', data: { from: 'ethan', to: 'sophie', type: 'add', title: 'Dentist for Sophie', when: { day, start: '10:00', end: '11:00', allDay: false }, status: 'yes', created: Date.now(), answeredAt: Date.now() } },
      { type: 'set', path: 'requests/r_add2', data: { from: 'sophie', to: 'ethan', type: 'add', title: 'Optician for Ethan', when: { day, start: '12:00', end: '13:00', allDay: false }, status: 'waiting', created: Date.now() } }
    ]);
  });
  await page.click('[data-act="reqTab"][data-v="sent"]');
  await page.waitForTimeout(100);
  const sent = await page.locator('article', { hasText: 'Dentist for Sophie' }).textContent();
  assert.match(sent, /Added for Sophie/);
  assert.match(sent, /in Sophie’s calendar/);
  assert.doesNotMatch(sent, /both your calendars/);
  // Ethan says yes to the one Sophie added for him: it's saving to his calendar
  await page.click('[data-act="reqTab"][data-v="for"]');
  await page.waitForTimeout(100);
  await page.locator('article', { hasText: 'Optician for Ethan' }).locator('[data-a="yes"]').click();
  await page.waitForTimeout(100);
  assert.match(await page.textContent('.toast'), /Saving it to your calendar\./);
  await page.waitForTimeout(100);
  assert.match(await page.locator('article', { hasText: 'Optician for Ethan' }).textContent(), /It’s in your calendar\./);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('Today counts what needs you in words that read right: "1 request needs you"', async () => {
  const page = await open('sophie', '#today');
  // Ethan suggested another time for something Sophie asked: that's hers to answer now, and nothing else is
  await mods(page, (store) => {
    const d = new Date(); d.setDate(d.getDate() + 3);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return store.store.backend.commit([
      { type: 'update', path: 'requests/r_keep', data: { status: 'yes' } },
      { type: 'update', path: 'requests/r_ikea', data: { status: 'other', counter: { day, start: '10:00', end: '12:00', allDay: false } } }
    ]);
  });
  await page.waitForTimeout(150);
  assert.match(await page.textContent('.att'), /1 request needs you/);
  await page.context().close();
});

test("hiding a calendar from yourself stops your partner seeing it too, unless you chose its sharing", async () => {
  const page = await open('ethan', '#settings/calendars');
  const head = page.locator('.cal-head[data-k="ethan__second"]');
  await head.click();
  await page.locator('[data-act="calShow"][data-k="ethan__second"]').click();
  await page.waitForTimeout(200);
  const st = await mods(page, (store) => store.store.state.calendars.ethan__second);
  assert.equal(st.show, false);
  assert.equal(st.share, 'none');
  assert.match(await head.textContent(), /Hidden from you\. Sophie sees nothing/i);
  // chosen by hand: hiding leaves it
  await mods(page, (store) => store.store.backend.commit([{ type: 'update', path: 'calendars/ethan__second', data: { show: true, share: 'busy', shareSet: true } }]));
  await page.waitForTimeout(150);
  await page.locator('[data-act="calShow"][data-k="ethan__second"]').click();
  await page.waitForTimeout(200);
  const st2 = await mods(page, (store) => store.store.state.calendars.ethan__second);
  assert.equal(st2.show, false);
  assert.equal(st2.share, 'busy');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("a phone whose saved copy was just cleared is told the household isn't there: it asks the server again and opens it", async () => {
  const page = await openReal();
  await fb(page, (f, h, house) => { f.server[h] = house; f.emitDoc(h, null); }, H, HOUSE);
  await page.waitForFunction((p) => window.__fb.listening(`${p}/people`), H, { timeout: 2000 });
  await fb(page, (f, h, people) => f.emitColl(`${h}/people`, people), H, PEOPLE);
  await page.waitForSelector('.bottom-nav', { timeout: 2000 });
  assert.doesNotMatch(await mainText(page), /Set up Caledonite/);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('the first-time setup on a phone that already has a household opens it, never "That didn\'t save"', async () => {
  const page = await openReal();
  await fb(page, (f, h) => f.emitDoc(h, null), H);
  await page.waitForTimeout(200);
  assert.match(await mainText(page), /Set up Caledonite/);
  // meanwhile the household turns out to be there, and the rules turn the second one down
  await fb(page, (f, h, house) => { f.server[h] = house; f.failCommit = true; }, H, HOUSE);
  await mods(page, (store, ui) => { ui.setup.myName = 'Ethan'; ui.setup.partnerName = 'Sophie'; });
  await page.evaluate(() => { const b = [...document.querySelectorAll('[data-act="setupSave"]')][0]; b && b.click(); });
  await page.waitForTimeout(400);
  const toastText = await page.evaluate(() => (document.querySelector('#toast, .toast') || {}).textContent || '');
  assert.doesNotMatch(toastText, /didn.t save/);
  await page.waitForFunction((p) => window.__fb.listening(`${p}/people`), H, { timeout: 2000 });
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('the setup page says what the server said about this account, and can check again', async () => {
  const page = await openReal();
  await fb(page, (f, h) => f.emitDoc(h, null), H);
  await page.waitForTimeout(250);
  assert.match(await mainText(page), /household was not found on the server at \d\d:\d\d/);
  // it's there after all: Check again opens it
  await fb(page, (f, h, house) => { f.server[h] = house; }, H, HOUSE);
  await page.click('[data-act="setupRecheck"]');
  await page.waitForTimeout(100);
  await fb(page, (f, h) => f.emitDoc(h, null), H);
  await page.waitForFunction((p) => window.__fb.listening(`${p}/people`), H, { timeout: 2000 });
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("a phone whose saved copy is stuck after its data was cleared: the server is asked directly, the copy is cleared once by itself, and setup is never offered", async () => {
  const page = await openReal();
  page.restStatus = 200;
  // the saved copy says there's no household, and so does the SDK's own "ask the server" (it answers from that copy)
  const reloaded = page.waitForEvent('load', { timeout: 4000 });
  await fb(page, (f, h) => f.emitDoc(h, null), H);
  await reloaded;
  assert.equal(await page.evaluate(() => sessionStorage.getItem('fake.cleared')), '1');
  assert.ok(page.restCalls >= 1);
  // still stuck after the reload: it doesn't clear it again by itself, and says what to do instead of setup
  await page.waitForFunction((p) => window.__fb && window.__fb.listening && window.__fb.listening(p), H);
  await fb(page, (f, h) => f.emitDoc(h, null), H);
  await page.waitForSelector('[data-act="healCache"]', { timeout: 3000 });
  const t = await mainText(page);
  assert.doesNotMatch(t, /Set up Caledonite/);
  assert.match(t, /saved copy is stuck/);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('fake.cleared')), '1');
  // "Fix this phone" clears it on request
  const again = page.waitForEvent('load', { timeout: 4000 });
  await page.click('[data-act="healCache"]');
  await again;
  assert.equal(await page.evaluate(() => sessionStorage.getItem('fake.cleared')), '2');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("the server says this account can't open the household: Not on the list, never the first-time setup", async () => {
  const page = await openReal();
  page.restStatus = 403;
  await fb(page, (f, h) => f.emitDoc(h, null), H);
  await page.waitForTimeout(300);
  const t = await mainText(page);
  assert.match(t, /Not on the list yet/);
  assert.doesNotMatch(t, /Set up Caledonite/);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

// ---------- the usability pass (1.4.22) ----------
const dayAhead = (page, n) => page.evaluate((n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }, n);

test('Plan on Today: the free time is chosen, what it is gets the cursor, and Send stays in reach above the tabs', async () => {
  const page = await open('ethan');
  await page.click('a.btn.tog[data-act="askFrom"]');
  await page.waitForSelector('#ask-title');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ask-title');
  assert.equal(await page.locator('[data-act="askSlot"][aria-pressed="true"]').count(), 1);
  // the kind of request is one line to choose from, with the one chosen explained under it
  assert.equal(await page.locator('#ask-type option').count(), 5);
  assert.equal(await page.inputValue('#ask-type'), 'plan');
  assert.match(await page.textContent('main'), /A date, a trip, seeing people\./);
  await page.focus('#ask-type'); // (as a tap on it would: the box for what it is lets go)
  await page.selectOption('#ask-type', 'heads');
  await page.waitForTimeout(150);
  assert.match(await page.textContent('main'), /Just so you know\. No answer needed\./);
  assert.equal(await page.textContent('[data-act="askSend"]'), 'Send heads up');
  // Send sits in the bar above the tabs, so it's on screen before scrolling
  const box = await page.locator('[data-act="askSend"]').boundingBox();
  const vh = page.viewportSize().height;
  assert.ok(box.y + box.height <= vh, `Send is at ${box.y}, below the screen (${vh})`);
  await page.context().close();
});

test('the week: time you are both free is tapped to plan it, and an open day can have something added', async () => {
  const page = await open('sophie', '#calendar');
  await page.click('[data-act="calView"][data-v="week"]');
  const link = page.locator('a.wday-free').first();
  assert.ok(await link.count(), 'a free time in the week can be tapped');
  const day = await link.getAttribute('data-day');
  assert.ok(day >= await dayAhead(page, 0));
  await link.click();
  await page.waitForSelector('#ask-title');
  const when = await mods(page, (store, ui) => (ui.ask.custom ? { key: ui.ask.cday } : ui.ask.pick));
  assert.equal(when.key, day);
  await go(page, '#calendar');
  assert.ok(await page.locator('.wday-list [data-act="addFor"]').count(), 'Add on this day');
  await page.context().close();
});

test('a request for you: its answers sit in two rows, each on one line', async () => {
  const page = await open('ethan', '#requests');
  const card = page.locator('article', { hasText: 'IKEA' });
  const tops = async (sel) => new Set(await card.locator(sel).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)))).size;
  assert.equal(await tops('.row-even:not(.row-quiet) .btn'), 1);
  assert.equal(await tops('.row-quiet .btn'), 1);
  assert.equal(await card.locator('.btn').count(), 4);
  await page.context().close();
});

test('a shift: tapped on Today it opens that day in Settings, Shifts, and one more tap changes it', async () => {
  const page = await open('sophie');
  await page.click('.shift-card');
  await page.waitForSelector('[data-act="shiftSet"]');
  const today = await dayAhead(page, 0);
  assert.equal(await page.getAttribute('[data-act="shiftDay"][aria-expanded="true"]', 'data-day'), today);
  assert.ok(await page.evaluate(() => { const r = document.getElementById('shift-open').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), 'the opened day is on screen');
  // the six shifts sit in even rows of two, never four and two left over
  const tops = await page.$$eval('[data-act="shiftSet"]', (els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  assert.deepEqual([...new Set(tops)].map((t) => tops.filter((x) => x === t).length), [2, 2, 2]);
  await page.click('[data-act="shiftSet"][data-v="late"]');
  assert.equal(await mods(page, (store, ui, k) => store.store.state.shifts[`sophie|${k}`].type, today), 'late');
  assert.match(await page.textContent('.toast'), /^Late today\.$/);
  assert.equal(await page.getAttribute('a.back-link', 'href'), '#today');
  // and back to the rota again
  await page.click(`[data-act="shiftDay"][data-day="${today}"]`);
  await page.click('[data-act="clearShift"]');
  assert.equal(await mods(page, (store, ui, k) => store.store.state.shifts[`sophie|${k}`] || null, today), null);
  await page.context().close();
});

test("Ethan can tap Sophie's shift in the day too, and the one from last night opens yesterday", async () => {
  const page = await open('ethan');
  const rows = page.locator('.agenda [data-act="shiftEdit"]');
  assert.ok(await rows.count() >= 2);
  assert.equal(await rows.first().getAttribute('data-day'), await dayAhead(page, -1));
  assert.equal(await rows.first().getAttribute('data-p'), 'sophie');
  await page.context().close();
});

test('Add: the start and end times sit on one line beside "Time" on a 384px phone', async () => {
  const ctx = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 384, height: 832 }, locale: 'en-GB', timezoneId: 'Europe/London', bypassCSP: true });
  const page = await ctx.newPage();
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.goto(`${URL}?demo=ethan#add`);
  await page.waitForSelector('#add-start');
  const tops = await page.evaluate(() => ['label[for="add-start"]', '#add-start', '#add-end'].map((s) => { const r = document.querySelector(s).getBoundingClientRect(); return Math.round(r.top + r.height / 2); }));
  assert.ok(Math.max(...tops) - Math.min(...tops) <= 2, `on different lines: ${tops}`);
  await ctx.close();
});

test('a job: the done card goes to all the jobs, and Today points to the next one when none is due', async () => {
  const page = await open('ethan', '#add');
  await page.click('[data-act="addKind"][data-v="job"]');
  await page.fill('#job-title', 'Clean the oven');
  await page.click('[data-act="addJobSave"]');
  await page.waitForSelector('.done-card a[href="#jobs"]');
  await mods(page, (store) => Promise.all(store.store.state.jobs.filter((j) => j.day <= new Date().toISOString().slice(0, 10)).map((j) => store.actions.deleteJob(j.id))));
  await go(page, '#today');
  const next = page.locator('a.next-job');
  assert.equal(await next.count(), 1);
  assert.match(await next.textContent(), /Nothing due today/);
  await page.context().close();
});

test("an event's page doesn't say its calendar twice", async () => {
  const page = await open('ethan');
  await page.click('button.ag-row:has-text("Team stand-up")');
  await page.waitForSelector('[data-act="evBack"]');
  const card = await page.textContent('.card.pad');
  assert.equal((card.match(/Work/g) || []).length, 1, card);
  await page.context().close();
});

test('choosing what your partner sees of a calendar says so', async () => {
  const page = await open('ethan', '#settings/calendars');
  await page.click('[data-act="openCal"][data-k="ethan__family"]');
  await page.click('[data-act="calShare"][data-v="busy"]');
  assert.match(await page.textContent('.toast'), /Sophie now sees “Busy” from Family/);
  await page.context().close();
});

test("the week strips show \"Ethan's family\" in full, on two short lines, not cut short", async () => {
  const page = await open('sophie', '#calendar');
  await page.click('[data-act="calView"][data-v="week"]');
  await page.click('[data-act="weekNext"]');
  await page.click('[data-act="weekPrev"]');
  const labels = await page.$$eval('.strip-label', (els) => els.map((e) => ({ t: e.textContent, cut: e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1 })));
  const fam = labels.filter((l) => /family/.test(l.t));
  assert.ok(fam.length, 'a family row this week');
  for (const l of fam) assert.ok(!l.cut, `"${l.t}" is cut short`);
  await page.context().close();
});

test('each theme name stays inside its tile at 360 and 384 wide with larger text (115% and 130%)', async () => {
  for (const [w, z] of [[360, 1.15], [384, 1.3], [412, 1.3]]) {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: w, height: 800 }, locale: 'en-GB', timezoneId: 'Europe/London', bypassCSP: true });
    const page = await ctx.newPage();
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    await page.goto(`${URL}?demo=ethan#settings/theme`);
    await page.waitForSelector('.theme-tile');
    // larger text: every font size in the stylesheet scaled up, as the phone's text size setting does
    const bad = await page.evaluate((z) => {
      const scale = (v) => v.replace(/(\d*\.?\d+)px/g, (m, n) => `${(n * z).toFixed(2)}px`);
      const walk = (r) => { if (r.cssRules) for (const c of r.cssRules) walk(c); if (r.style && r.style.fontSize) r.style.fontSize = scale(r.style.fontSize); };
      for (const sh of document.styleSheets) { try { for (const r of sh.cssRules) walk(r); } catch (e) { /* another site's */ } }
      // (the name is sized to its tile, so even a wide font like Dragonfire's fits; the real fonts are checked by the crawler)
      return [...document.querySelectorAll('.theme-tile')].filter((t) => t.scrollWidth > t.clientWidth + 1
        || parseFloat(getComputedStyle(t.querySelector('.tt-name')).fontSize) > t.clientWidth * 0.13).map((t) => t.textContent.trim());
    }, z);
    assert.deepEqual(bad, [], `${w}px at ${z * 100}%`);
    await ctx.close();
  }
});

// every button, tab and chip on a screen: its text stays inside it, it stays inside its row or card, a one-line label stays
// on one line (a card button with parts is several), a row of buttons is never left ragged (two on a line and one under
// them), and nothing makes the page scroll sideways
function labelProblems() {
  const out = [];
  if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) out.push('the page scrolls sideways');
  const lines = (el) => {
    const rs = []; const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n;
    while ((n = tw.nextNode())) { if (!n.textContent.trim()) continue; const r = document.createRange(); r.selectNodeContents(n); for (const q of r.getClientRects()) if (q.width > 0.5) rs.push(q); }
    rs.sort((a, b) => a.top - b.top); let k = 0; let bottom = -1e9;
    for (const q of rs) { if ((q.top + q.bottom) / 2 > bottom) { k++; bottom = q.bottom; } else bottom = Math.max(bottom, q.bottom); }
    return k;
  };
  for (const x of document.querySelectorAll('main button, main a.btn, main .chip, main .pill, main .seg, main .tab-chip, main .layer-chip')) {
    if (!x.getClientRects().length) continue;
    const s = getComputedStyle(x); const say = `"${x.textContent.trim().replace(/\s+/g, ' ') || x.getAttribute('aria-label')}"`;
    if (s.textOverflow !== 'ellipsis' && x.clientWidth && x.scrollWidth > x.clientWidth + 1 && !/auto|scroll/.test(s.overflowX)) out.push(`${say} runs past its edge`);
    const p = x.parentElement; const r = x.getBoundingClientRect(); const pr = p.getBoundingClientRect();
    if (!/auto|scroll/.test(getComputedStyle(p).overflowX) && (r.right > pr.right + 1 || r.left < pr.left - 1)) out.push(`${say} sticks out of its row`);
    const card = [...x.querySelectorAll('*')].some((d) => !d.closest('svg') && /^(block|grid|flex)$/.test(getComputedStyle(d).display) && d.textContent.trim());
    if (!card && !x.matches('.seg') && lines(x) > 1) out.push(`${say} wraps onto ${lines(x)} lines`);
  }
  // a row of buttons is all on one line, or stacked one a line at the full width: never two with one left over
  for (const row of document.querySelectorAll('main *')) {
    const kids = [...row.children].filter((k) => k.getClientRects().length);
    if (kids.length < 2 || !kids.every((k) => k.classList.contains('btn'))) continue;
    const at = kids.map((k) => Math.round(k.getBoundingClientRect().top)); const ws = kids.map((k) => Math.round(k.getBoundingClientRect().width));
    const lineN = new Set(at).size;
    if (lineN > 1 && (lineN < kids.length || Math.max(...ws) - Math.min(...ws) > 1)) out.push(`buttons "${kids.map((k) => k.textContent.trim()).join('", "')}" sit ${lineN} lines for ${kids.length}`);
  }
  return out;
}

test('buttons, tabs and chips fit their labels on one line and button rows are never ragged, with your full names, at 360 and 412 wide and at 130% text zoom', async () => {
  // (Chrome's 130% text zoom lays a 412px phone out as if it were 317px wide)
  for (const [w, h] of [[360, 780], [412, 915], [317, 704]]) {
    for (const who of ['ethan', 'sophie']) {
      const ctx = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: w, height: h }, locale: 'en-GB', timezoneId: 'Europe/London', bypassCSP: true });
      const page = await ctx.newPage();
      await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
      await page.goto(`${URL}?demo=${who}#today`);
      await page.waitForSelector('.bottom-nav');
      await mods(page, async (store) => {
        await store.store.backend.update('people/ethan', { name: 'Ethan Whitfield' });
        await store.store.backend.update('people/sophie', { name: 'Sophie Marchetti' });
      });
      const bad = [];
      const look = async (name) => { for (const p of await page.evaluate(labelProblems)) bad.push(`${w}px ${who} ${name}: ${p}`); };
      const tap = async (sel) => { await page.evaluate((s) => { const b = document.querySelector(s); if (b) b.click(); }, sel); await page.waitForTimeout(150); };
      for (const hsh of ['#today', '#calendar', '#requests', '#ask', '#add', '#jobs', '#jar', '#settings', '#settings/calendars', '#settings/shifts', '#settings/routine', '#settings/requests', '#settings/notifications', '#settings/holidays', '#settings/theme', '#settings/apps', '#settings/account']) {
        await go(page, hsh); await look(hsh);
      }
      await go(page, '#calendar'); await tap('[data-act="calView"][data-v="week"]'); await look('calendar week');
      for (const k of ['event', 'job', 'leave', 'shift']) { await go(page, '#add'); await tap(`[data-act="addKind"][data-v="${k}"]`); await tap('[data-act="addMore"]'); await look(`add ${k}`); }
      await go(page, '#ask'); await page.selectOption('#ask-type', 'favour'); await page.waitForTimeout(150); await look('ask a favour');
      await go(page, '#settings/calendars'); await tap('[data-act="openCal"]'); await look('a calendar opened');
      await go(page, '#today'); await tap('[data-act="openEv"]'); await look('an event');
      await tap('[data-act="evEdit"]'); await look('changing an event'); await tap('[data-act="evEditCancel"]');
      await tap('[data-act="evDeleteAsk"]'); await look('deleting an event');
      await go(page, '#today'); await tap('[data-act="noteOpen"]'); await look('a note');
      await go(page, '#jar'); await tap('[data-act="jarPick"]'); await look('an idea picked');
      await go(page, '#settings/shifts'); await tap('[data-act="shiftDay"]'); await look('a shift day opened');
      assert.deepEqual(bad, []);
      await ctx.close();
    }
  }
});
