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

test("a partner's shift times can't break the Shifts page", async () => {
  const page = await open('ethan', '#settings/shifts');
  const p = await page.getAttribute('[data-act="cycleShift"]', 'data-p');
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
  await useFakeFirebase(page, { email: 'e@x.com', displayName: 'Ethan Dunning' });
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
    if (h === '#ask') await page.click('[data-act="askType"][data-v="favour"]');
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
