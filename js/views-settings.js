// Settings (with its own menu), plus the sign-in and first-time screens.
import { esc, dayKey, addDays, mondayOf, fmtDate, agoText, WEEKDAY_NAMES, fmtTime, atTime, MONTH_NAMES, fromDayKey } from './util.js';
import { isLowCal, nameOf, settingsOf, shiftFor, nextAltDaysOff, myReminders, remindSummary, REMIND_OPTIONS, leaveSummary, inQuietHours } from './logic.js';
import { icon, avatar, seg, toggleRow } from './ui.js';
import { ui } from './uistate.js';
import { APP, FIREBASE } from './config.js';
import { THEMES, PALETTES, getLook } from './theme.js';

export const SECTIONS = [
  ['calendars', 'Calendars', 'calendar'],
  ['shifts', 'Shifts', 'work'],
  ['routine', 'Our routine', 'clock'],
  ['requests', 'Requests', 'requests'],
  ['notifications', 'Notifications', 'bell'],
  ['holidays', 'Holidays', 'plane'],
  ['theme', 'Theme', 'drop'],
  ['apps', 'Linked apps', 'link'],
  ['account', 'Account', 'user']
];

export function viewSettings(state) {
  const page = ui.settings.page;
  if (page === 'home') return settingsHome(state);
  const title = (SECTIONS.find((s) => s[0] === page) || [0, 'Settings'])[1];
  const body = {
    calendars: secCalendars, shifts: secShifts, routine: secRoutine, requests: secRequests, holidays: secHolidays,
    notifications: secNotifications, theme: secTheme, apps: secApps, account: secAccount
  }[page] || (() => '');
  return `<button type="button" class="back-link" data-act="setPage" data-v="home">${icon.back(20)}All settings</button>
    <h1 class="h1">${esc(title)}</h1>
    <nav class="chips-scroll set-tabs" aria-label="Settings sections">${SECTIONS.map(([k, l]) => `<button type="button" class="tab-chip ${k === page ? 'on' : ''}" ${k === page ? 'aria-current="page"' : ''} data-act="setPage" data-v="${k}">${esc(l)}</button>`).join('')}</nav>
    <div class="stack-l">${body(state)}</div>`;
}

function settingsHome(state) {
  const me = state.me;
  const myCals = Object.values(state.calendars).filter((c) => c.owner === me);
  const accounts = new Set(myCals.map((c) => c.account || 'Google'));
  const s = settingsOf(state, me);
  const look = getLook();
  const shiftPeople = [state.me, state.partner].filter((p) => p && settingsOf(state, p).hasShifts);
  const status = {
    calendars: myCals.length ? `${myCals.length} calendar${myCals.length === 1 ? '' : 's'} from ${accounts.size} account${accounts.size === 1 ? '' : 's'}` : 'Not connected yet',
    shifts: shiftPeople.length ? shiftPeople.map((p) => (p === me ? 'Your shifts' : `${nameOf(state, p)}'s shifts`)).join(' and ') : 'No one works shifts',
    routine: `${s.hasShifts ? 'Shifts' : `Work ${fmtHM(s.workStart)} to ${fmtHM(s.workEnd)}${s.altOff ? `, every other ${WEEKDAY_NAMES[s.altOff.day]} off` : ''}`}. Dinner at ${fmtHM(state.household.dinnerTime || '19:00')}.`,
    requests: `${(state.household.favours || []).length} quick favours`,
    notifications: `${hasPush() ? 'On for this phone' : 'Off on this phone'}. ${s.quiet.on ? `Quiet ${fmtHM(s.quiet.from)} to ${fmtHM(s.quiet.to)}` : 'No quiet hours'}.`,
    holidays: holidayStatus(state),
    theme: (THEMES[look.theme] || THEMES.classic).name,
    apps: linkedStatus(state),
    account: [state.me, state.partner].filter(Boolean).map((p) => nameOf(state, p)).join(' and ')
  };
  const tint = { calendars: 'blue', shifts: 'orange', routine: 'tog', requests: 'grey', notifications: 'grey', holidays: 'orange', theme: 'family', apps: 'tog', account: 'blue' };
  return `<a href="#today" class="back-link">${icon.back(20)}Today</a>
    <h1 class="h1">Settings</h1>
    <div class="card flush menu">${SECTIONS.map(([k, l, ic]) => `<button type="button" class="menu-row" data-act="setPage" data-v="${k}">
      <span class="menu-ic tint-${tint[k]}">${icon[ic](20)}</span>
      <span class="grow col"><span class="b">${esc(l)}</span><span class="small muted">${esc(status[k])}</span></span>${icon.next(20)}</button>`).join('')}</div>
    <p class="small muted pad-x">Settings are saved to your account, so they follow you to a new phone. Your theme is just for this phone.</p>`;
}
function fmtHM(hm) { return fmtTime(atTime('2000-01-01', hm || '00:00')); }
function holidayStatus(state) {
  const l = leaveSummary(state, state.me);
  return `${l.left} of ${l.allowance} days left this year`;
}
function linkedStatus(state) {
  const L = state.linked || {};
  const names = [];
  if (L.peckish && L.peckish.found) names.push('Peckish');
  if (L.budgie && L.budgie.found && !L.budgie.error) names.push('Budgie');
  return names.length ? `${names.join(' and ')} linked` : 'Peckish and Budgie';
}
function hasPush() { try { return localStorage.getItem('caledonite.push') === '1' && Notification.permission === 'granted'; } catch (e) { return false; } }

// ---------- calendars ----------
const ROLE_OPTIONS = [
  ['own', 'Mine'], ['work', 'Work'], ['rota', 'Shift rota'], ['family', 'Family'], ['friends', 'Friends'], ['other', 'Other people']
];
function roleValue(c) {
  if (c.role === 'work') return 'work';
  if (c.role === 'rota') return 'rota';
  if (c.layer && c.layer !== 'own') return c.layer;
  return 'own';
}
function shareOptions(c) {
  if (c.role === 'work') return [['hours', 'Working hours'], ['busy', 'Just “Busy”'], ['none', 'Nothing']];
  return [['all', 'Everything'], ['busy', 'Just “Busy”'], ['none', 'Nothing']];
}
function shareHelp(state, c) {
  const P = state.partner ? nameOf(state, state.partner) : 'Your partner';
  const h = {
    all: `${P} sees the names and times.`,
    busy: `${P} sees the times as “Busy”, with no names.`,
    none: `${P} sees nothing from this calendar.`,
    hours: `${P} sees one “Working” block each day. No meeting names.`
  }[c.share] || '';
  const extra = c.layer && c.layer !== 'own' && c.share !== 'none' ? ` It shows as its own row, even if ${P} isn't on this calendar in Google.` : '';
  return h + extra;
}
const SHORT = { all: 'everything', busy: '“Busy” only', none: 'nothing', hours: 'working hours only' };

function secCalendars(state) {
  const me = state.me;
  const P = state.partner;
  const mine = Object.values(state.calendars).filter((c) => c.owner === me);
  const byAcc = {};
  for (const c of mine) (byAcc[c.account || 'Google'] = byAcc[c.account || 'Google'] || []).push(c);
  const out = [];
  if (!mine.length) out.push(connectGuide(state));
  else {
    out.push(`<p class="muted">Tap a calendar to choose what you see${P ? ` and what ${esc(nameOf(state, P))} sees` : ''}.</p>`);
    for (const [acc, cals] of Object.entries(byAcc)) {
      cals.sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0) || a.name.localeCompare(b.name));
      out.push(`<div class="card flush"><div class="acc-head"><span class="grow col"><span class="b">${esc(acc)}</span><span class="small muted">${esc(lastRunFor(state, me, acc))}</span></span><span class="pill ok">Linked</span></div>
        ${cals.map((c) => calRow(state, c)).join('')}</div>`);
    }
    out.push(`<button type="button" class="btn dashed-btn" data-act="setPage" data-v="account">${icon.plus(20)}Link another account or calendar</button>`);
  }
  if (P) {
    const theirs = Object.values(state.calendars).filter((c) => c.owner === P);
    const visible = theirs.filter((c) => c.share !== 'none' && c.role !== 'rota');
    out.push(`<h2 class="h4">${esc(nameOf(state, P))}'s calendars</h2>
      <div class="card flush">${visible.length ? visible.map((c) => `<div class="list-row wrap"><span class="dot" style="background:${esc(c.color || 'var(--orange)')}"></span><span class="grow col"><span class="b">${esc(c.name)}</span><span class="small muted">You see ${esc(SHORT[c.share] || 'nothing')}. ${esc(nameOf(state, P))} chooses this.</span></span>
        ${priorityToggle(state, c)}</div>`).join('') : `<p class="pad muted">${esc(nameOf(state, P))} hasn't shared a calendar yet.</p>`}</div>
      <p class="small muted pad-x">Low priority keeps a calendar off Today and the week. Tap a day in the month to see everything, including those.</p>`);
  }
  out.push(`<div class="card stack-s"><span class="b">Moving from TimeTree?</span><p class="small muted">TimeTree no longer lets other apps link to it, so it can't sync. Put upcoming TimeTree events into Google Calendar (or add them here) once, then Caledonite takes over.</p></div>`);
  return out.join('');
}
function lastRunFor(state, pid, acc) {
  const st = Object.values(state.status || {}).find((s) => s.person === pid && (s.account || 'Google') === acc);
  if (!st) return 'Waiting for the first sync';
  if (st.ok === false) return `Problem syncing: ${st.error || 'unknown error'}`;
  return `Synced ${agoText(st.lastRun)}`;
}
function calRow(state, c) {
  const open = ui.settings.openCal === c.key;
  const P = state.partner;
  const role = roleValue(c);
  return `<div class="cal-row">
    <button type="button" class="cal-head" aria-expanded="${open}" data-act="openCal" data-k="${esc(c.key)}">
      <span class="dot" style="background:${esc(c.color || 'var(--blue)')};opacity:${c.show === false ? 0.3 : 1}"></span>
      <span class="grow col"><span class="b">${esc(c.name)}</span><span class="small muted">${c.show === false ? 'Hidden from you.' : isLowCal(state, c.key) ? 'Low priority for you.' : 'Shown to you.'}${P ? ` ${esc(nameOf(state, P))} sees ${esc(SHORT[c.share] || 'nothing')}.` : ''}</span></span>
      <span class="chev ${open ? 'open' : ''}">${icon.next(20)}</span></button>
    ${open ? `<div class="cal-body stack">
      ${toggleRow({ act: 'calShow', on: c.show !== false, label: 'Show it in my calendar', data: `data-k="${esc(c.key)}"` })}
      ${c.show !== false ? `<div class="row between"><span class="col"><span class="b">Priority</span><span class="small muted">Low keeps it off Today and the week. It's still there when you tap a day in the month.</span></span>${priorityToggle(state, c)}</div>` : ''}
      <div class="field"><label for="role-${esc(c.key)}">This calendar is</label>
        <select id="role-${esc(c.key)}" data-act="calRole" data-k="${esc(c.key)}">${ROLE_OPTIONS.map(([v, l]) => `<option value="${v}" ${role === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      ${P ? `<div class="stack-s"><span class="b">${esc(nameOf(state, P))} sees</span>${seg(shareOptions(c).map(([v, l]) => ({ v, label: l, on: c.share === v, extra: ` data-k="${esc(c.key)}"` })), { act: 'calShare', label: `${nameOf(state, P)} sees`, cls: 'seg-3' })}<span class="small muted">${esc(shareHelp(state, c))}</span></div>` : ''}
    </div>` : ''}
  </div>`;
}
// Normal or Low, for whoever is looking (saved in your own settings)
export function priorityToggle(state, c) {
  const low = isLowCal(state, c.key);
  return seg([{ v: 'normal', label: 'Normal', on: !low }, { v: 'low', label: 'Low', on: low }].map((o) => Object.assign(o, { extra: ` data-k="${esc(c.key)}"` })), { act: 'calPriority', label: `Priority of ${c.name}`, cls: 'seg-sm' });
}
function connectGuide(state) {
  const url = state.household.connectUrl || '';
  return `<div class="card stack">
    <span class="h3">Connect your Google Calendar</span>
    <p class="muted">Caledonite reads your calendars with a small Google script that runs on your own account. It takes about two minutes, once.</p>
    <ol class="steps">
      <li>${url ? `Open <a href="${esc(safeUrl(url))}" target="_blank" rel="noopener">the Caledonite connect page</a>` : 'Open the Caledonite connect page (Ethan can share the link)'} while signed in to your Google account.</li>
      <li>Google asks for permission. Choose your account. If it says the app isn't verified, tap <b>Advanced</b>, then <b>Go to Caledonite sync</b>. Then tap <b>Allow</b>.</li>
      <li>Tap <b>Connect my calendar</b>.</li>
      <li>Come back here. Your calendars appear within a minute.</li>
    </ol>
  </div>`;
}
// only ever link to Google's script pages
function safeUrl(u) { return /^https:\/\/script\.google\.com\//.test(u || '') ? u : '#'; }

// ---------- shifts ----------
function secShifts(state) {
  const me = state.me; const P = state.partner;
  const people = [me, P].filter((p) => p && settingsOf(state, p).hasShifts);
  const out = [];
  if (!people.length) {
    out.push(`<div class="card stack"><p class="muted">No one has shifts turned on. Turn it on if you work shifts instead of set hours.</p></div>`);
    out.push(`<div class="card flush">${toggleRow({ act: 'myHasShifts', on: false, label: 'I work shifts', sub: 'Shows your shifts, and your sleep after nights.' })}</div>`);
    return out.join('');
  }
  const who = people.includes(ui.settings.shiftPerson) ? ui.settings.shiftPerson : people[0];
  const s = settingsOf(state, who);
  if (people.length > 1) out.push(seg(people.map((p) => ({ v: p, label: p === me ? 'My shifts' : `${nameOf(state, p)}'s shifts`, on: p === who })), { act: 'shiftPerson', label: 'Whose shifts', cls: 'seg-full' }));
  // rota source
  const rotaCals = Object.values(state.calendars).filter((c) => c.owner === who && c.role === 'rota');
  out.push(`<div class="card stack-s">
    <div class="row"><span class="grow col"><span class="b">${who === me ? 'Your' : esc(nameOf(state, who)) + "'s"} work rota</span>
    <span class="small muted">${rotaCals.length ? `From ${esc(rotaCals.map((c) => c.name).join(', '))}. Updates by itself.` : 'Not linked yet. Shifts can still be added by hand below.'}</span></span>${rotaCals.length ? '<span class="pill ok">Linked</span>' : ''}</div>
    ${who === me ? `<div class="field"><label for="rota-url">Rota calendar link (for example from Loop)</label><input id="rota-url" type="url" inputmode="url" placeholder="https://..." data-bind="settings.rotaDraft" value="${esc(ui.settings.rotaDraft ?? s.rotaUrl ?? '')}"></div>
      <button type="button" class="btn sec self-start" data-act="saveRota">Save link</button>
      <p class="small muted">In Loop on the web: Personal roster, then "View and share your roster calendar on other devices". Copy the iCalendar link and paste it here.</p>` : ''}
  </div>`);
  // week editor
  const wk = ui.settings.shiftWeek;
  const ws = addDays(mondayOf(new Date()), wk * 7);
  const rows = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(ws, i);
    const k = dayKey(d);
    const sh = shiftFor(state, who, k);
    const ov = state.shifts[`${who}|${k}`];
    const type = sh ? sh.type : null;
    const label = sh ? sh.label : 'No shift';
    const times = sh && !sh.allDay ? `${fmtTime(sh.start)} to ${fmtTime(sh.end)}` : (sh ? (type === 'leave' ? 'Annual leave' : 'Not working') : 'Tap to add a shift');
    rows.push(`<button type="button" class="list-row btn-row" data-act="cycleShift" data-p="${esc(who)}" data-day="${k}" data-type="${type || ''}" aria-label="${esc(fmtDate(d))}: ${esc(label)}. Tap to change.">
      <span class="grow col"><span class="b">${esc(fmtDate(d))}</span><span class="small muted">${esc(times)}</span></span>
      ${ov ? `<span class="small b link" data-act="clearShift" data-p="${esc(who)}" data-day="${k}" role="button" tabindex="0">Undo</span>` : ''}
      <span class="shift-pill sp-${type || 'none'}">${esc(label)}</span></button>`);
  }
  out.push(`<section class="stack-s"><h2 class="h4">Change a shift</h2>
    <p class="small muted">Swapped a shift or picked up an extra one? Tap a day to change it. Changes win over the rota for that day.</p>
    <div class="row between"><button type="button" class="icon-btn" aria-label="Previous week" data-act="shiftWeek" data-d="-1">${icon.back(20)}</button><span class="b">${esc(`${ws.getDate()} ${MONTH_NAMES[ws.getMonth()]} to ${addDays(ws, 6).getDate()} ${MONTH_NAMES[addDays(ws, 6).getMonth()]}`)}</span><button type="button" class="icon-btn" aria-label="Next week" data-act="shiftWeek" data-d="1">${icon.next(20)}</button></div>
    <div class="card flush">${rows.join('')}</div></section>`);
  // types
  const editable = ['long', 'night', 'early', 'late'];
  out.push(`<section class="stack-s"><h2 class="h4">Shift times</h2><p class="small muted">The usual times for each kind of shift.</p>
    <div class="card flush">${editable.map((t) => {
      const def = s.shiftTypes[t];
      return `<div class="type-times"><span class="shift-pill sp-${t} self-start">${esc(def.label)}</span>
        <div class="grid2"><div class="field"><label for="st-${t}">Starts</label><input id="st-${t}" type="time" value="${esc(def.start)}" data-act="shiftTime" data-p="${esc(who)}" data-t="${t}" data-f="start"></div>
        <div class="field"><label for="en-${t}">Ends</label><input id="en-${t}" type="time" value="${esc(def.end)}" data-act="shiftTime" data-p="${esc(who)}" data-t="${t}" data-f="end"></div></div></div>`;
    }).join('')}</div></section>`);
  out.push(`<section class="stack-s"><h2 class="h4">After a night shift</h2><div class="card grid2 pad">
    <div class="field"><label for="sleep-until">Sleeps until</label><input id="sleep-until" type="time" value="${esc(s.sleepUntil)}" data-act="personField" data-p="${esc(who)}" data-f="sleepUntil"></div>
    <div class="field"><label for="travel">Travel home</label><select id="travel" data-act="personField" data-p="${esc(who)}" data-f="travelMins">${[15, 30, 45, 60].map((m) => `<option value="${m}" ${Number(s.travelMins) === m ? 'selected' : ''}>${m === 60 ? '1 hour' : m + ' minutes'}</option>`).join('')}</select></div>
  </div></section>`);
  return out.join('');
}

// ---------- routine ----------
function secRoutine(state) {
  const s = settingsOf(state, state.me);
  const h = state.household;
  return `<section class="stack-s"><h2 class="h4">Your working hours</h2>
    <div class="card stack pad">
      ${toggleRow({ act: 'myHasShifts', on: s.hasShifts, label: 'I work shifts', sub: 'Turn on if you work shifts instead of set hours.' })}
      ${s.hasShifts ? '<p class="small muted">Your shifts are in Settings, Shifts.</p>' : `
      <div class="field"><label for="work-label">What it says</label><input id="work-label" type="text" value="${esc(s.workLabel)}" data-act="myField" data-f="workLabel"></div>
      <div class="grid2"><div class="field"><label for="w-start">Start</label><input id="w-start" type="time" value="${esc(s.workStart)}" data-act="myField" data-f="workStart"></div>
      <div class="field"><label for="w-end">Finish</label><input id="w-end" type="time" value="${esc(s.workEnd)}" data-act="myField" data-f="workEnd"></div></div>
      <span class="b">Working days</span>
      <div class="row-wrap">${[1, 2, 3, 4, 5, 6, 7].map((d) => `<button type="button" class="chip-btn ${s.workDays.includes(d) ? 'on' : ''}" aria-pressed="${s.workDays.includes(d)}" data-act="workDay" data-v="${d}">${WEEKDAY_NAMES[d]}</button>`).join('')}</div>
      ${altOffBlock(s)}
      <p class="small muted">A day off? Add an all-day event called Holiday or Day off, and that day has no working hours.</p>`}
    </div></section>
    <section class="stack-s"><h2 class="h4">Countdowns on Today</h2>
    <div class="card flush">
      ${toggleRow({ act: 'myToggle', on: s.christmas !== false, label: 'Christmas, Easter and other big days', sub: 'Also New Year, Valentine’s, Mother’s Day and Father’s Day. They take turns at the top of Today.', data: 'data-f="christmas"' })}
      ${[state.me, state.partner].filter(Boolean).map((pid) => { const b = (h.birthdays || {})[pid] || ''; return `<div class="list-row"><label for="bd-${esc(pid)}" class="grow col"><span class="b">${pid === state.me ? 'Your birthday' : `${esc(nameOf(state, pid))}'s birthday`}</span><span class="small muted">${b ? 'Counts down every year.' : 'Or put it in Google Calendar as an all-day “' + esc(nameOf(state, pid)) + '’s birthday”.'}</span></label><input id="bd-${esc(pid)}" type="date" class="time-sm" value="${b ? `2000-${esc(b)}` : ''}" data-act="hhBday" data-p="${esc(pid)}"></div>`; }).join('')}
      <div class="list-row"><label for="anniv" class="grow col"><span class="b">Your anniversary</span><span class="small muted">The date you got together. Or an all-day event with “anniversary” in the name.</span></label><input id="anniv" type="date" class="time-sm" value="${esc(h.anniversary || '')}" data-act="hhField" data-f="anniversary"></div>
      <p class="pad small muted">To count down to anything else, like a holiday, tap it in the calendar and choose “Count down to this”. Holidays you book together count down by themselves.</p>
    </div></section>
    <section class="stack-s"><h2 class="h4">Dinner</h2>
    <div class="card flush">
      <div class="list-row"><label for="dinner" class="grow b">Usual dinner time</label><input id="dinner" class="time-sm" type="time" value="${esc(h.dinnerTime || '19:00')}" data-act="hhField" data-f="dinnerTime"></div>
      ${toggleRow({ act: 'hhToggle', on: h.showDinner !== false, label: 'Show dinner on Today', sub: 'When you’re both home at dinner time.', data: 'data-f="showDinner"' })}
      ${toggleRow({ act: 'hhToggle', on: h.moveDinner !== false, label: 'Move dinner earlier before a night shift', sub: 'So you can eat together before they leave.', data: 'data-f="moveDinner"' })}
    </div></section>`;
}

function altOffBlock(s) {
  const a = s.altOff;
  const days = s.workDays.length ? s.workDays : [1, 2, 3, 4, 5];
  const next = a ? nextAltDaysOff(s, new Date(), 1)[0] : null;
  const head = toggleRow({
    act: 'altOffToggle', on: !!a, label: a ? `Every other ${WEEKDAY_NAMES[a.day]} off` : 'A day off every other week',
    sub: a && next ? `Next one: ${fmtDate(fromDayKey(next))}.` : 'For example, every other Friday.'
  });
  if (!a) return `<div class="card flush inset">${head}</div>`;
  // the next two of that weekday: which one is off?
  const opts = [];
  for (let i = 0; i < 14 && opts.length < 2; i++) {
    const d = addDays(new Date(), i);
    if ((d.getDay() || 7) === Number(a.day)) opts.push(dayKey(d));
  }
  return `<div class="card flush inset">${head}
    <div class="pad stack-s">
      <div class="field"><label for="alt-day">Which day</label><select id="alt-day" data-act="altOffDay">${days.map((d) => `<option value="${d}" ${Number(a.day) === d ? 'selected' : ''}>${WEEKDAY_NAMES[d]}</option>`).join('')}</select></div>
      <span class="b">Which one is your next day off?</span>
      <div class="row-wrap">${opts.map((k) => `<button type="button" class="chip-btn ${next === k ? 'on' : ''}" aria-pressed="${next === k}" data-act="altOffFrom" data-v="${k}">${esc(fmtDate(fromDayKey(k)))}</button>`).join('')}</div>
      <p class="small muted">The other ${esc(WEEKDAY_NAMES[a.day])}s are normal working days.</p>
    </div></div>`;
}

// ---------- requests ----------
function secRequests(state) {
  const h = state.household;
  const favs = h.favours || [];
  return `<section class="stack-s"><h2 class="h4">Quick favours</h2><p class="small muted">One tap to ask. They show when you ask a favour.</p>
    <div class="card flush">${favs.map((f, i) => `<div class="list-row"><span class="grow b">${esc(f)}</span><button type="button" class="icon-btn plain" aria-label="Remove ${esc(f)}" data-act="favRemove" data-i="${i}">${icon.close(20)}</button></div>`).join('') || '<p class="pad muted">None yet.</p>'}</div>
    <div class="row"><label class="sr" for="fav-new">New quick favour</label><input id="fav-new" class="grow" type="text" placeholder="For example: Pick up a prescription" data-bind="settings.favDraft" value="${esc(ui.settings.favDraft)}"><button type="button" class="btn" data-act="favAdd">Add</button></div></section>
    <section class="stack-s"><h2 class="h4">How requests work</h2><div class="card flush">
      ${toggleRow({ act: 'hhToggle', on: h.pencilDefault !== false, label: 'Pencil in requests by default', sub: 'Holds the time in both calendars until there’s an answer.', data: 'data-f="pencilDefault"' })}
      <div class="list-row"><label for="nudge" class="grow b">Remind if no answer after</label><select id="nudge" data-act="hhField" data-f="nudgeHours">${[[4, '4 hours'], [24, '1 day'], [48, '2 days'], [0, 'Never']].map(([v, l]) => `<option value="${v}" ${Number(h.nudgeHours ?? 24) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    </div></section>`;
}

// ---------- notifications ----------
function secNotifications(state) {
  const s = settingsOf(state, state.me);
  const n = s.notif;
  const on = hasPush();
  const list = myReminders(state);
  const bday = s.autoRemind.birthdays || [];
  return `<div class="card stack pad">
      <div class="row">${icon.bell(24)}<span class="grow col"><span class="b">This phone</span><span class="small muted">${on ? 'Notifications are on.' : 'Notifications are off.'}</span></span></div>
      <div class="row-wrap">${on ? '<button type="button" class="btn sec" data-act="testPush">Send a test notification</button><button type="button" class="btn sec" data-act="pushOn">Refresh</button>' : '<button type="button" class="btn" data-act="pushOn">Turn on notifications</button>'}</div>
      ${ui.pushMsg ? `<p class="small note-box">${esc(ui.pushMsg)}</p>` : ''}
    </div>
    <section class="stack-s"><h2 class="h4">Quiet hours</h2>
      <div class="card flush">
        ${toggleRow({ act: 'quietToggle', on: s.quiet.on, label: s.quiet.on ? `Quiet from ${fmtHM(s.quiet.from)} to ${fmtHM(s.quiet.to)}` : 'Quiet hours are off', sub: 'Notifications wait until the morning. Turn off for a night shift or a late night.' })}
        ${s.quiet.on ? `<div class="pad stack-s"><div class="grid2"><div class="field"><label for="q-from">Quiet from</label><input id="q-from" type="time" value="${esc(s.quiet.from)}" data-act="quietField" data-f="from"></div>
          <div class="field"><label for="q-to">Until</label><input id="q-to" type="time" value="${esc(s.quiet.to)}" data-act="quietField" data-f="to"></div></div></div>
          ${s.quiet.skip ? `<p class="pad small note-box">Quiet hours are off for one night (${esc(fmtDate(new Date(s.quiet.skip + 'T12:00')))}).</p>` : ''}` : ''}
        ${s.hasShifts ? toggleRow({ act: 'notifToggle', on: s.notif.quiet, label: 'Also quiet while I sleep after nights', sub: 'Messages to you wait until you wake.', data: 'data-f="quiet"' }) : ''}
      </div>
      <p class="small muted">${inQuietHours(s) ? 'Quiet hours are on now.' : ''} Today shows a “Not tonight” button in the evening too.</p>
    </section>
    <section class="stack-s"><h2 class="h4">Summaries</h2>
      <div class="card flush">
        ${toggleRow({ act: 'summaryToggle', on: s.morning.on, label: 'Morning summary', sub: 'Your day and your partner’s day, in one notification.', data: 'data-f="morning"' })}
        ${s.morning.on ? `<div class="list-row"><label for="m-at" class="grow b">Send it at</label><input id="m-at" class="time-sm" type="time" value="${esc(s.morning.at)}" data-act="summaryField" data-f="morning" data-k="at"></div>` : ''}
        ${toggleRow({ act: 'summaryToggle', on: s.weekAhead.on, label: 'Week ahead', sub: 'Next week’s shifts, days off and evenings you’re both free.', data: 'data-f="weekAhead"' })}
        ${s.weekAhead.on ? `<div class="pad stack-s"><div class="grid2"><div class="field"><label for="w-day">Send it on</label><select id="w-day" data-act="summaryField" data-f="weekAhead" data-k="day">${[[7, 'Sunday'], [6, 'Saturday'], [1, 'Monday']].map(([v, l]) => `<option value="${v}" ${Number(s.weekAhead.day) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div class="field"><label for="w-at">At</label><input id="w-at" type="time" value="${esc(s.weekAhead.at)}" data-act="summaryField" data-f="weekAhead" data-k="at"></div></div></div>` : ''}
      </div></section>
    <section class="stack-s"><h2 class="h4">Reminders</h2>
      <p class="small muted">Tap anything on Today or in the Calendar to set a reminder for it.</p>
      <div class="card flush">
        ${list.length ? list.slice(0, 12).map((x) => {
          const day = x.ev.allDay ? (x.ev.startKey || dayKey(x.ev.start)) : dayKey(x.ev.start);
          return `<button type="button" class="menu-row" data-act="openEv" data-ref="${esc(x.ref)}" data-day="${day}">
            <span class="grow col"><span class="b">${esc(x.title)}</span><span class="small muted">${esc(fmtDate(fromDayKey(day)))}. ${esc(remindSummary(x.rem.times))}${x.rem.auto ? ' (birthday)' : ''}.</span></span>${icon.next(20)}</button>`;
        }).join('') : '<p class="pad muted">No reminders coming up.</p>'}
      </div>
      <div class="card stack-s pad">
        <span class="b">Every birthday</span>
        <span class="small muted">For all-day events with “birthday” in the name, in your calendars.</span>
        <div class="row-wrap">${REMIND_OPTIONS.filter((o) => !o.timedOnly).map((o) => `<button type="button" class="chip-btn ${bday.includes(o.v) ? 'on' : ''}" aria-pressed="${bday.includes(o.v)}" data-act="autoBday" data-v="${o.v}">${esc(o.label)}</button>`).join('')}</div>
        <span class="small muted">${bday.length ? esc(remindSummary(bday)) + '. You can change one birthday by tapping it.' : 'Off. Pick one or more to turn it on.'}</span>
      </div>
      <div class="card flush"><div class="list-row"><label for="remind-at" class="grow col"><span class="b">Reminder time</span><span class="small muted">When “a week before” or “on the day” reminders arrive.</span></label><input id="remind-at" class="time-sm" type="time" value="${esc(s.remindAt || '09:00')}" data-act="myField" data-f="remindAt"></div></div>
    </section>
    <section class="stack-s"><h2 class="h4">What to send to this phone</h2>
    <div class="card flush">
      ${toggleRow({ act: 'notifToggle', on: n.reminders, label: 'Reminders', sub: 'For things you set a reminder on.', data: 'data-f="reminders"' })}
      ${toggleRow({ act: 'notifToggle', on: n.jobs, label: 'Jobs', sub: 'On the day a job is due.', data: 'data-f="jobs"' })}
      ${toggleRow({ act: 'notifToggle', on: n.summary, label: 'Summaries', sub: 'The morning summary and the week ahead.', data: 'data-f="summary"' })}
      ${toggleRow({ act: 'notifToggle', on: n.requests, label: 'Requests and answers', sub: 'When you’re asked something, or get an answer.', data: 'data-f="requests"' })}
      ${toggleRow({ act: 'notifToggle', on: n.notes, label: 'Notes', sub: 'When a note is left for you.', data: 'data-f="notes"' })}
      ${s.hasShifts ? toggleRow({ act: 'notifToggle', on: n.rota, label: 'Rota changes', sub: 'When a shift is added, moved or swapped.', data: 'data-f="rota"' }) : ''}
    </div></section>`;
}

// ---------- theme ----------
function secTheme(state) {
  const look = getLook();
  return `<p class="muted">Just for this phone. Each of you picks your own.</p>
    <div class="grid2">${Object.entries(THEMES).map(([k, t]) => `<button type="button" class="theme-tile ${look.theme === k ? 'on' : ''}" aria-pressed="${look.theme === k}" data-act="setTheme" data-v="${k}" style="background:${t.preview.bg};color:${t.preview.ink}">
      <span class="tt-top"><span class="tt-name" style="font-family:${t.preview.font}">${esc(t.label)}</span><span class="tt-dots">${t.preview.dots.map((c) => `<span style="background:${c}"></span>`).join('')}</span></span>
      <span class="tt-mood" style="background:${t.preview.card};border-top:1px solid ${t.preview.line}">${esc(t.mood)}</span></button>`).join('')}</div>
    ${look.theme === 'classic' ? `<span class="b">Classic colours</span>
      <div class="grid5">${Object.entries(PALETTES).map(([k, p]) => `<button type="button" class="swatch ${look.palette === k ? 'on' : ''}" aria-pressed="${look.palette === k}" data-act="setPalette" data-v="${k}"><span style="background:${p.swatch}"></span>${esc(p.name)}</button>`).join('')}</div>
      ${seg([{ v: 'auto', label: 'Match phone', on: look.mode === 'auto' }, { v: 'light', label: 'Light', on: look.mode === 'light' }, { v: 'dark', label: 'Dark', on: look.mode === 'dark' }], { act: 'setMode', label: 'Light or dark', cls: 'seg-full' })}` : ''}
    <p class="small muted">Body text stays in the easy-to-read font in every theme.</p>`;
}

// ---------- linked apps ----------
function secApps(state) {
  const L = state.linked || {};
  const pk = L.peckish || {}; const bg = L.budgie || {};
  return `<p class="muted">Peckish is on the same website as Caledonite, so on a phone where you use it, Caledonite reads what it has saved there. Budgie has a website of its own and gives Caledonite a limited link.</p>
    <div class="card stack pad"><div class="row"><span class="grow h3">Peckish</span><span class="pill ${pk.found ? 'ok' : ''}">${pk.found ? 'Found on this phone' : 'Not on this phone'}</span></div>
      <p class="small muted">${pk.found ? 'Tonight\u2019s dinner shows on Today. Before a long shift, it reminds you to make extra for a packed lunch.' : 'Open Peckish on this phone once, and tonight\u2019s dinner shows on Today.'}</p>
      <a class="b small" href="../es-kitchen/" target="_blank" rel="noopener">Open Peckish</a></div>
    <div class="card stack pad"><div class="row"><span class="grow h3">Budgie</span><span class="pill ${bg.found && !bg.error ? 'ok' : ''}">${bg.found ? (bg.error ? 'Problem' : 'Linked') : 'Not linked'}</span></div>
      ${bg.found ? `<p class="small muted">${bg.error ? esc(bg.error) : 'Your paydays and bills show in your calendar, only on this phone. The ideas jar knows what\u2019s left for fun until payday.' + (bg.stale ? ' (From the last time Budgie could be reached.)' : '')}</p>
      ${bg.fun ? `<p class="small">Left for fun: <b>£${esc(String(Math.floor(bg.fun.left)))}</b> (${esc(bg.fun.names.join(', '))}).</p>` : ''}
      <div class="row wrap"><a class="b small" href="https://budgie-money.github.io/" target="_blank" rel="noopener">Open Budgie</a><button type="button" class="b small" data-act="budgieUnlink">Unlink</button></div>` :
      `<p class="small muted">In Budgie, go to Settings, then Linked apps, and tap Link Caledonite. Copy the link it makes and paste it here. It only lets Caledonite see your paydays, bills and what's left for fun.</p>
      <div class="row"><label class="sr" for="bg-link">Your Caledonite link from Budgie</label><input id="bg-link" class="grow" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://budgie-money.github.io/#connect=..." data-bind="settings.budgieDraft" value="${esc(ui.settings.budgieDraft || '')}"><button type="button" class="btn" data-act="budgieLink">Link</button></div>
      <a class="b small" href="https://budgie-money.github.io/" target="_blank" rel="noopener">Open Budgie</a>`}</div>
    <button type="button" class="btn sec self-start" data-act="linkedReload">Check again</button>`;
}

// ---------- holidays ----------
function secHolidays(state) {
  const me = state.me; const P = state.partner;
  const s = settingsOf(state, me);
  const people = [me, P].filter(Boolean);
  const cards = people.map((pid) => {
    const l = leaveSummary(state, pid);
    const pct = l.allowance ? Math.min(100, Math.round((l.used + l.booked) / l.allowance * 100)) : 0;
    return `<div class="card stack-s pad"><div class="row"><span class="grow h3">${pid === me ? 'You' : esc(nameOf(state, pid))}</span><span class="b">${l.left} of ${l.allowance} days left</span></div>
      <div class="meter" role="img" aria-label="${l.used} used, ${l.booked} booked, ${l.left} left"><span style="width:${pct}%"></span></div>
      <span class="small muted">${l.used} used, ${l.booked} booked. Year from ${esc(fmtDate(new Date(l.year.start + 'T12:00')))}.</span>
      ${l.list.length ? `<div class="stack-s">${l.list.map((x) => `<div class="row small"><span class="grow">${esc(x.title)}${x.together ? ' (together)' : ''}</span><span class="muted">${esc(shortRange(x.from, x.to))}, ${x.days} day${x.days === 1 ? '' : 's'}</span></div>`).join('')}</div>` : ''}
    </div>`;
  }).join('');
  return `<p class="muted">Book time off together from Requests, then Ask, then Book a holiday. Once you both say yes, it's in both your calendars and counted here.</p>
    ${cards}
    <section class="stack-s"><h2 class="h4">Your allowance</h2>
    <div class="card flush">
      <div class="list-row"><label for="lv-allow" class="grow b">Days a year</label><input id="lv-allow" class="time-sm" type="number" inputmode="numeric" min="0" max="60" value="${esc(String(s.leave.allowance))}" data-act="leaveField" data-f="allowance"></div>
      <div class="list-row"><label for="lv-start" class="grow col"><span class="b">Holiday year starts</span><span class="small muted">Often 1 January or 1 April.</span></label><input id="lv-start" class="time-sm" type="date" value="${esc(`${new Date().getFullYear()}-${s.leave.yearStart}`)}" data-act="leaveField" data-f="yearStart"></div>
      ${toggleRow({ act: 'leaveToggle', on: !!s.leave.bankHolsCount, label: 'Bank holidays come out of my allowance', sub: 'Usual for some NHS and shift jobs.' })}
    </div></section>
    <p class="small muted">Days off are counted from your working pattern: working days only, and every other Friday when that's set. ${settingsOf(state, P || me).hasShifts || s.hasShifts ? 'For shifts, it counts the days you’d be on shift, or weekdays when the rota isn’t in yet.' : ''}</p>`;
}
function shortRange(a, b) {
  const f = (k) => { const d = new Date(k + 'T12:00'); return `${d.getDate()} ${MONTH_NAMES[d.getMonth()].slice(0, 3)}`; };
  return a === b ? f(a) : `${f(a)} to ${f(b)}`;
}

// ---------- account ----------
function secAccount(state) {
  const me = state.me; const P = state.partner;
  const h = state.household;
  const out = [];
  out.push(`<div class="card flush">
    <div class="list-row">${avatar(state, me, 44)}<span class="grow col"><span class="b">${esc(nameOf(state, me))}</span><span class="small muted">${esc(state.user ? state.user.email : '')}</span></span></div>
    ${P ? `<div class="list-row">${avatar(state, P, 44)}<span class="grow col"><span class="b">${esc(nameOf(state, P))}</span><span class="small muted">${esc(state.people[P].email || 'No Google email added yet')}</span></span></div>` : ''}
  </div>`);
  if (P && (state.people[P].joined || h.emailsLocked)) {
    out.push(`<div class="card stack-s pad"><span class="b">${esc(nameOf(state, P))}'s Google email</span><span class="small muted">${esc(state.people[P].email || '')}. Fixed now ${esc(nameOf(state, P))} has joined, so neither of you can lock the other out.</span></div>`);
  } else if (P) {
    out.push(`<div class="card stack-s pad"><label for="p-email" class="b">${esc(nameOf(state, P))}'s Google email</label>
      <p class="small muted">${esc(nameOf(state, P))} signs in with this. Only the two of you can open Caledonite.</p>
      <div class="row"><input id="p-email" class="grow" type="email" data-bind="settings.partnerEmailDraft" value="${esc(ui.settings.partnerEmailDraft || state.people[P].email || '')}" placeholder="name@gmail.com"><button type="button" class="btn" data-act="savePartnerEmail">Save</button></div></div>`);
  }
  const linked = ((state.people[me] && state.people[me].linked) || []).map((email) => ({ email })).concat((h.linked || []).filter((x) => x.person === me));
  out.push(`<div class="card stack-s pad"><span class="b">Your other Google accounts</span>
    <p class="small muted">Add another Gmail or a work Google account, then open the connect page while signed in to it and tap Connect my calendar. Its calendars join yours.</p>
    ${linked.map((x) => `<div class="row"><span class="grow">${esc(x.email)}</span><button type="button" class="icon-btn plain" aria-label="Remove ${esc(x.email)}" data-act="unlinkAcc" data-v="${esc(x.email)}">${icon.close(20)}</button></div>`).join('')}
    <div class="row"><label class="sr" for="link-acc">Another account's email</label><input id="link-acc" class="grow" type="email" placeholder="you@work.com" data-bind="settings.linkDraft" value="${esc(ui.settings.linkDraft)}"><button type="button" class="btn" data-act="linkAcc">Add</button></div>
    ${h.connectUrl ? `<a href="${esc(safeUrl(h.connectUrl))}" target="_blank" rel="noopener" class="b">Open the connect page</a>` : ''}</div>`);
  const sts = Object.values(state.status || {});
  out.push(`<div class="card stack-s pad"><div class="row"><span class="grow b">Calendar sync</span><button type="button" class="btn sec sm" data-act="syncNow">${icon.sync(18)} Sync now</button></div>
    ${sts.length ? sts.map((s) => `<div class="row small"><span class="grow">${esc(nameOf(state, s.person))}: ${esc(s.account || 'Google')}</span><span class="${s.ok === false ? 'ink-bad b' : 'muted'}">${s.ok === false ? 'Problem' : esc(agoText(s.lastRun))}</span></div>`).join('') : '<p class="small muted">No syncs yet.</p>'}</div>`);
  out.push(`<div class="card stack-s pad"><div class="row"><span class="grow b">${esc(APP.name)}</span><span class="small muted">Version ${esc(APP.version)}</span></div>
    ${state.demo ? '<p class="small muted">This is the demo, with made-up data.</p>' : ''}</div>`);
  out.push(`<button type="button" class="btn danger-btn" data-act="signOut">${state.demo ? 'Leave the demo' : 'Sign out'}</button>`);
  return out.join('');
}

// ---------- first-time screens ----------
export function viewSignedOut() {
  const ready = !!FIREBASE.config;
  return `<div class="welcome">
    <span class="logo">${icon.gem(56)}</span>
    <h1 class="h1">${esc(APP.name)}</h1>
    <p class="lead">Your calendars, side by side. See what each other is up to, find time together, and ask each other things.</p>
    ${ready ? '<button type="button" class="btn big-btn" data-act="signIn">Sign in with Google</button>' : '<p class="note-box">Caledonite isn’t connected to its database yet. You can try the demo.</p>'}
    <div class="row-wrap center"><a class="btn sec" href="?demo=ethan">Try the demo as Ethan</a><a class="btn sec" href="?demo=sophie">Try it as Sophie</a></div>
    ${ui.signInError ? `<p class="note-box">${esc(ui.signInError)}</p>` : ''}
  </div>`;
}
export function viewSetup(state) {
  const s = ui.setup;
  return `<div class="welcome left">
    <h1 class="h1">Set up ${esc(APP.name)}</h1>
    <p class="muted">Signed in as ${esc(state.user && state.user.email)}. This only happens once.</p>
    <div class="card stack pad">
      <div class="field"><label for="su-me">Your first name</label><input id="su-me" type="text" data-bind="setup.myName" value="${esc(s.myName || (state.user && state.user.name || '').split(' ')[0])}"></div>
      <label class="check"><input type="checkbox" data-act="setupFlag" data-f="myShifts" ${s.myShifts ? 'checked' : ''}> I work shifts</label>
    </div>
    <div class="card stack pad">
      <div class="field"><label for="su-p">Your partner's first name</label><input id="su-p" type="text" data-bind="setup.partnerName" value="${esc(s.partnerName)}"></div>
      <div class="field"><label for="su-pe">Their Google email</label><input id="su-pe" type="email" data-bind="setup.partnerEmail" value="${esc(s.partnerEmail)}" placeholder="name@gmail.com"></div>
      <label class="check"><input type="checkbox" data-act="setupFlag" data-f="partnerShifts" ${s.partnerShifts ? 'checked' : ''}> They work shifts</label>
    </div>
    <button type="button" class="btn big-btn" data-act="setupSave">Create ${esc(APP.name)}</button>
  </div>`;
}
export function viewNotMember(state) {
  return `<div class="welcome"><h1 class="h1">Not on the list yet</h1>
    <p class="lead">${esc(state.user && state.user.email)} isn't part of this ${esc(APP.name)}. Ask your partner to add this email in Settings, Account.</p>
    <button type="button" class="btn sec" data-act="signOut">Sign in with a different account</button></div>`;
}
export function viewLoading() {
  return `<div class="welcome"><span class="logo spin">${icon.gem(48)}</span><p class="muted">Loading your calendars...</p></div>`;
}
