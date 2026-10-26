// Settings (with its own menu), plus the sign-in and first-time screens.
import { esc, dayKey, addDays, mondayOf, fmtDate, agoText, WEEKDAY_NAMES, fmtTime, atTime, MONTH_NAMES } from './util.js';
import { nameOf, settingsOf, shiftFor, SHIFT_ORDER, LAYER_INFO, personColour } from './logic.js';
import { icon, avatar, seg, toggleRow, empty } from './ui.js';
import { ui } from './uistate.js';
import { APP, FIREBASE } from './config.js';
import { THEMES, PALETTES, getLook } from './theme.js';

export const SECTIONS = [
  ['calendars', 'Calendars', 'C'],
  ['shifts', 'Shifts', 'S'],
  ['routine', 'Our routine', 'R'],
  ['requests', 'Requests', 'Q'],
  ['notifications', 'Notifications', 'N'],
  ['theme', 'Theme', 'T'],
  ['apps', 'Linked apps', 'L'],
  ['account', 'Account', 'A']
];

export function viewSettings(state) {
  const page = ui.settings.page;
  if (page === 'home') return settingsHome(state);
  const title = (SECTIONS.find((s) => s[0] === page) || [0, 'Settings'])[1];
  const body = {
    calendars: secCalendars, shifts: secShifts, routine: secRoutine, requests: secRequests,
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
    routine: `${s.hasShifts ? 'Shifts' : `Work ${fmtHM(s.workStart)} to ${fmtHM(s.workEnd)}`}. Dinner at ${fmtHM(state.household.dinnerTime || '19:00')}.`,
    requests: `${(state.household.favours || []).length} quick favours`,
    notifications: hasPush() ? 'On for this phone' : 'Off on this phone',
    theme: (THEMES[look.theme] || THEMES.classic).name,
    apps: 'E&S Kitchen and E&S Budgie',
    account: [state.me, state.partner].filter(Boolean).map((p) => nameOf(state, p)).join(' and ')
  };
  const tint = { calendars: 'blue', shifts: 'orange', routine: 'tog', requests: 'grey', notifications: 'grey', theme: 'family', apps: 'tog', account: 'blue' };
  return `<a href="#today" class="back-link">${icon.back(20)}Today</a>
    <h1 class="h1">Settings</h1>
    <div class="card flush menu">${SECTIONS.map(([k, l, letter]) => `<button type="button" class="menu-row" data-act="setPage" data-v="${k}">
      <span class="menu-ic tint-${tint[k]}">${letter}</span>
      <span class="grow col"><span class="b">${esc(l)}</span><span class="small muted">${esc(status[k])}</span></span>${icon.next(20)}</button>`).join('')}</div>
    <p class="small muted pad-x">Settings are saved to your account, so they follow you to a new phone. Your theme is just for this phone.</p>`;
}
function fmtHM(hm) { return fmtTime(atTime('2000-01-01', hm || '00:00')); }
function hasPush() { try { return localStorage.getItem('calendite.push') === '1' && Notification.permission === 'granted'; } catch (e) { return false; } }

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
    out.push(`<h2 class="h4">${esc(nameOf(state, P))}'s calendars</h2>
      <div class="card flush">${theirs.length ? theirs.map((c) => `<div class="list-row"><span class="dot" style="background:${esc(c.color || 'var(--orange)')}"></span><span class="grow col"><span class="b">${esc(c.name)}</span><span class="small muted">You see ${esc(SHORT[c.share] || 'nothing')}. ${esc(nameOf(state, P))} chooses this.</span></span></div>`).join('') : `<p class="pad muted">${esc(nameOf(state, P))} hasn't connected a calendar yet.</p>`}</div>`);
  }
  out.push(`<div class="card stack-s"><span class="b">Moving from TimeTree?</span><p class="small muted">TimeTree no longer lets other apps link to it, so it can't sync. Put upcoming TimeTree events into Google Calendar (or add them here) once, then Calendite takes over.</p></div>`);
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
      <span class="grow col"><span class="b">${esc(c.name)}</span><span class="small muted">${c.show === false ? 'Hidden from you.' : 'Shown to you.'}${P ? ` ${esc(nameOf(state, P))} sees ${esc(SHORT[c.share] || 'nothing')}.` : ''}</span></span>
      <span class="chev ${open ? 'open' : ''}">${icon.next(20)}</span></button>
    ${open ? `<div class="cal-body stack">
      ${toggleRow({ act: 'calShow', on: c.show !== false, label: 'Show it in my calendar', data: `data-k="${esc(c.key)}"` })}
      <div class="field"><label for="role-${esc(c.key)}">This calendar is</label>
        <select id="role-${esc(c.key)}" data-act="calRole" data-k="${esc(c.key)}">${ROLE_OPTIONS.map(([v, l]) => `<option value="${v}" ${role === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      ${P ? `<div class="stack-s"><span class="b">${esc(nameOf(state, P))} sees</span>${seg(shareOptions(c).map(([v, l]) => ({ v, label: l, on: c.share === v, extra: ` data-k="${esc(c.key)}"` })), { act: 'calShare', label: `${nameOf(state, P)} sees`, cls: 'seg-3' })}<span class="small muted">${esc(shareHelp(state, c))}</span></div>` : ''}
    </div>` : ''}
  </div>`;
}
function connectGuide(state) {
  const url = state.household.scriptUrl || '';
  return `<div class="card stack">
    <span class="h3">Connect your Google Calendar</span>
    <p class="muted">Calendite reads your calendars with a small Google script that runs on your own account. It takes about two minutes, once.</p>
    <ol class="steps">
      <li>${url ? `Open <a href="${esc(url)}" target="_blank" rel="noopener">the Calendite sync script</a>` : 'Open the Calendite sync script (Ethan can share the link)'} while signed in to your Google account.</li>
      <li>At the top, pick <b>connectMe</b> in the list, then press <b>Run</b>.</li>
      <li>Google asks for permission. Choose your account, then <b>Advanced</b>, then <b>Go to Calendite sync</b>, then <b>Allow</b>.</li>
      <li>Come back here. Your calendars appear within a minute.</li>
    </ol>
  </div>`;
}

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
    rows.push(`<button type="button" class="list-row btn-row" data-act="cycleShift" data-p="${who}" data-day="${k}" data-type="${type || ''}" aria-label="${esc(fmtDate(d))}: ${esc(label)}. Tap to change.">
      <span class="grow col"><span class="b">${esc(fmtDate(d))}</span><span class="small muted">${esc(times)}</span></span>
      ${ov ? `<span class="small b link" data-act="clearShift" data-p="${who}" data-day="${k}" role="button" tabindex="0">Undo</span>` : ''}
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
        <div class="grid2"><div class="field"><label for="st-${t}">Starts</label><input id="st-${t}" type="time" value="${esc(def.start)}" data-act="shiftTime" data-p="${who}" data-t="${t}" data-f="start"></div>
        <div class="field"><label for="en-${t}">Ends</label><input id="en-${t}" type="time" value="${esc(def.end)}" data-act="shiftTime" data-p="${who}" data-t="${t}" data-f="end"></div></div></div>`;
    }).join('')}</div></section>`);
  out.push(`<section class="stack-s"><h2 class="h4">After a night shift</h2><div class="card grid2 pad">
    <div class="field"><label for="sleep-until">Sleeps until</label><input id="sleep-until" type="time" value="${esc(s.sleepUntil)}" data-act="personField" data-p="${who}" data-f="sleepUntil"></div>
    <div class="field"><label for="travel">Travel home</label><select id="travel" data-act="personField" data-p="${who}" data-f="travelMins">${[15, 30, 45, 60].map((m) => `<option value="${m}" ${Number(s.travelMins) === m ? 'selected' : ''}>${m === 60 ? '1 hour' : m + ' minutes'}</option>`).join('')}</select></div>
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
      <p class="small muted">A day off? Add an all-day event called Holiday or Day off, and that day has no working hours.</p>`}
    </div></section>
    <section class="stack-s"><h2 class="h4">Dinner</h2>
    <div class="card flush">
      <div class="list-row"><label for="dinner" class="grow b">Usual dinner time</label><input id="dinner" class="time-sm" type="time" value="${esc(h.dinnerTime || '19:00')}" data-act="hhField" data-f="dinnerTime"></div>
      ${toggleRow({ act: 'hhToggle', on: h.showDinner !== false, label: 'Show dinner on Today', sub: 'When you’re both home at dinner time.', data: 'data-f="showDinner"' })}
      ${toggleRow({ act: 'hhToggle', on: h.moveDinner !== false, label: 'Move dinner earlier before a night shift', sub: 'So you can eat together before they leave.', data: 'data-f="moveDinner"' })}
    </div></section>`;
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
  return `<div class="card stack pad">
      <div class="row">${icon.bell(24)}<span class="grow col"><span class="b">This phone</span><span class="small muted">${on ? 'Notifications are on.' : 'Notifications are off.'}</span></span></div>
      ${on ? '<button type="button" class="btn sec self-start" data-act="pushOn">Refresh</button>' : '<button type="button" class="btn self-start" data-act="pushOn">Turn on notifications</button>'}
      ${ui.pushMsg ? `<p class="small note-box">${esc(ui.pushMsg)}</p>` : ''}
    </div>
    <div class="card flush">
      ${toggleRow({ act: 'notifToggle', on: n.quiet, label: 'Quiet while I sleep after nights', sub: 'Messages to you wait until you wake.', data: 'data-f="quiet"' })}
      ${toggleRow({ act: 'notifToggle', on: n.requests, label: 'Requests and answers', sub: 'When you’re asked something, or get an answer.', data: 'data-f="requests"' })}
      ${toggleRow({ act: 'notifToggle', on: n.notes, label: 'Notes', sub: 'When a note is left for you.', data: 'data-f="notes"' })}
      ${toggleRow({ act: 'notifToggle', on: n.rota, label: 'Rota changes', sub: 'When a shift is added, moved or swapped.', data: 'data-f="rota"' })}
    </div>`;
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
function secApps() {
  return `<div class="card stack pad"><div class="row"><span class="grow h3">E&amp;S Kitchen</span><span class="pill">Coming later</span></div><p class="small muted">Tonight's dinner and who's cooking on Today, and long shifts sent to the meal planner so you get quick dinners and packed lunches.</p></div>
    <div class="card stack pad"><div class="row"><span class="grow h3">E&amp;S Budgie</span><span class="pill">Coming later</span></div><p class="small muted">Paydays and big bills in the calendar.</p></div>`;
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
  if (P) {
    out.push(`<div class="card stack-s pad"><label for="p-email" class="b">${esc(nameOf(state, P))}'s Google email</label>
      <p class="small muted">${esc(nameOf(state, P))} signs in with this. Only the two of you can open Calendite.</p>
      <div class="row"><input id="p-email" class="grow" type="email" data-bind="settings.partnerEmailDraft" value="${esc(ui.settings.partnerEmailDraft || state.people[P].email || '')}" placeholder="name@gmail.com"><button type="button" class="btn" data-act="savePartnerEmail">Save</button></div></div>`);
  }
  const linked = (h.linked || []).filter((x) => x.person === me);
  out.push(`<div class="card stack-s pad"><span class="b">Your other Google accounts</span>
    <p class="small muted">Add another Gmail or a work Google account, then open the sync script while signed in to it and run <b>connectMe</b>. Its calendars join yours.</p>
    ${linked.map((x) => `<div class="row"><span class="grow">${esc(x.email)}</span><button type="button" class="icon-btn plain" aria-label="Remove ${esc(x.email)}" data-act="unlinkAcc" data-v="${esc(x.email)}">${icon.close(20)}</button></div>`).join('')}
    <div class="row"><label class="sr" for="link-acc">Another account's email</label><input id="link-acc" class="grow" type="email" placeholder="you@work.com" data-bind="settings.linkDraft" value="${esc(ui.settings.linkDraft)}"><button type="button" class="btn" data-act="linkAcc">Add</button></div>
    ${h.scriptUrl ? `<a href="${esc(h.scriptUrl)}" target="_blank" rel="noopener" class="b">Open the sync script</a>` : ''}</div>`);
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
    ${ready ? '<button type="button" class="btn big-btn" data-act="signIn">Sign in with Google</button>' : '<p class="note-box">Calendite isn’t connected to its database yet. You can try the demo.</p>'}
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
export { personColour, LAYER_INFO, SHIFT_ORDER, empty };
