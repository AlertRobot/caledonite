// Today and Calendar screens.
import {
  esc, dayKey, fromDayKey, addDays, fmtDate, fmtTime, fmtRange, MONTH_NAMES, atTime, mondayOf, fmtDateShort, agoText, minutesOf, relDay
} from './util.js';
import {
  buildDay, dayList, statusNow, nextBothFree, itemTime, itemTitle, itemSub, nameOf, shortName, personColour, monthCell, allLayers, layerChipLabel, LAYER_INFO, settingsOf, reminderFor, myReminders, reminderLine, countdowns, countdownText, jobsOn, inQuietHours, quietNight, lowCount
} from './logic.js';
import { jobRow } from './views-extra.js';
import { icon, avatar, whoChip, seg } from './ui.js';
import { ui } from './uistate.js';
import { requestPassed } from './store.js';

function motif() {
  const t = document.documentElement.dataset.theme;
  const m = { starship: icon.orbit, dragonfire: icon.wing, fairytale: icon.castle }[t];
  return m ? `<span class="motif">${m(34)}</span>` : '';
}
export function pageHeader(state, title, small) {
  return `<header class="page-head">
    <div class="col">${small ? `<span class="head-small">${esc(small)}</span>` : ''}<h1>${esc(title)}</h1></div>
    <span class="row small-gap">${motif()}<a href="#settings" class="head-btn" aria-label="Settings">${icon.settings(24)}</a></span>
  </header>`;
}

// (not one whose time has passed while it waited: there's nothing left to answer)
export function waitingForMe(state) {
  return state.requests.filter((r) => ((r.to === state.me && (r.status === 'waiting' || r.status === 'maybe' || (r.type === 'heads' && r.status === 'sent')))
    || (r.from === state.me && r.status === 'other')) && !requestPassed(r));
}

// ---------------- TODAY ----------------
// One screen, read top to bottom: anything that needs you, what you're both doing now,
// then the day itself. The week ahead lives on Calendar.
export function viewToday(state) {
  const now = new Date();
  const key = dayKey(now);
  const d = buildDay(state, key, now);
  const P = state.partner;
  const me = state.me;
  const out = [];
  out.push(pageHeader(state, 'Today', fmtDate(now)));
  out.push(milestones(state, now));

  // something wrong with the sync or this phone's notifications
  out.push(...warnings(state, now));

  // anything that needs you: requests, notes, reminders
  const att = [];
  const waiting = waitingForMe(state);
  if (waiting.length && P) {
    const fromPartner = waiting.filter((r) => r.from === P).length;
    const label = fromPartner === waiting.length ? `${nameOf(state, P)} asked you ${waiting.length === 1 ? 'something' : waiting.length + ' things'}` : `${waiting.length} request${waiting.length === 1 ? ' needs' : 's need'} you`;
    att.push(`<a class="att-row" href="#requests">${avatar(state, P, 34)}<span class="grow b">${esc(label)}</span><span class="att-go">${icon.next(18)}</span></a>`);
  }
  for (const n of state.notes.filter((x) => x.to === me && !x.seen && (x.showAfter || 0) <= Date.now()).slice(0, 3)) {
    att.push(`<div class="att-row">${avatar(state, n.from, 34)}<span class="grow col"><span class="small muted b">Note from ${esc(nameOf(state, n.from))}</span><span>${esc(n.text)}</span></span>
      <button type="button" class="btn sec sm" data-act="noteSeen" data-id="${esc(n.id)}">Got it</button></div>`);
  }
  for (const x of myReminders(state, now).filter((r) => r.active).slice(0, 4)) att.push(reminderRow(state, x, now));
  if (att.length) out.push(`<div class="card flush att">${att.join('')}</div>`);

  // my shift today (big, as Sophie asked)
  const mine = d.persons[me];
  const myShift = mine && mine.items.find((it) => it.kind === 'shift' && !it.allDay && !it.cont);
  if (myShift) {
    const s = settingsOf(state, me);
    const home = new Date(myShift.end.getTime() + (s.travelMins || 0) * 60000);
    out.push(`<button type="button" class="shift-card" data-act="shiftEdit" data-p="${esc(me)}" data-day="${key}" aria-label="Your shift today: ${esc(itemTitle(state, myShift))}. Change it">
      <span class="row between"><span class="b small shift-ink">Your shift today</span><span class="shift-ink">${icon.pencil(18)}</span></span>
      <span class="h2">${esc(itemTitle(state, myShift))}</span>
      <span class="b">${esc(fmtRange(myShift.start, myShift.end))}. Home about ${esc(fmtTime(home))}${myShift.end.getDate() !== myShift.start.getDate() ? ' tomorrow morning' : ''}.</span>
    </button>`);
  }

  // right now, the two of you
  if (P) {
    const ps = statusNow(state, P, now);
    const ms = statusNow(state, me, now);
    const sleeping = ps && ps.kind === 'sleep';
    const note = ui.noteOpen ? `<div class="now-note stack-s">
        <label for="note" class="b">Note for ${esc(nameOf(state, P))}</label>
        <textarea id="note" rows="3" data-bind="noteText" placeholder="Hope you slept well. I've done the food shop.">${esc(ui.noteText)}</textarea>
        <span class="small muted">${sleeping ? `${esc(nameOf(state, P))} sees it after waking up.` : `${esc(nameOf(state, P))} gets it straight away.`}</span>
        <div class="row-wrap"><button type="button" class="btn sm" data-act="saveNote">Save note</button><button type="button" class="btn link-btn" data-act="noteCancel">Cancel</button></div>
      </div>` : '';
    const seen = ms.kind === 'work' ? ` ${nameOf(state, P)} sees “${workSeenAs(state)}”.` : '';
    out.push(`<section class="stack-s"><h2 class="label">Right now</h2>
      <div class="card flush now">
        <div class="now-row">${avatar(state, P, 36)}<span class="grow col"><span class="b now-title">${esc(nameOf(state, P))}: ${esc(ps.title)}${sleeping ? ` <span class="ink-${personColour(state, P)} now-moon">${icon.moon(16)}</span>` : ''}</span><span class="small muted">${esc(ps.sub)}${sleeping ? ' Notifications wait until then.' : ''}</span></span>
          ${ui.noteOpen ? '' : `<button type="button" class="icon-btn plain" aria-label="Leave ${esc(nameOf(state, P))} a note" data-act="noteOpen">${icon.pencil(20)}</button>`}</div>
        ${note}
        <div class="now-row">${avatar(state, me, 36)}<span class="grow col"><span class="b now-title">You: ${esc(ms.title)}</span><span class="small muted">${esc(ms.sub + seen)}</span></span></div>
        ${quietLine(state, now)}
      </div></section>`);
  } else {
    out.push(`<div class="card stack"><span class="h3">Waiting for your partner</span><p class="muted">Once they sign in, you'll see what they're up to here. Add their Google email in Settings, Account.</p><a class="btn sec self-start" href="#settings/account">Open Account settings</a></div>`);
  }

  // the day
  let items = dayList(state, key, Object.assign(layerFilter(), { hideLow: true }));
  items = items.filter((it) => !(it.kind === 'shift' && it.allDay && it.who === me && myShift));
  const free = freeTonight(state, d);
  const more = moreLink(state, key);
  out.push(`<section class="stack-s"><h2 class="label">The day</h2>
    ${items.length || free || more ? `<div class="card flush agenda">${items.length || free ? '' : '<p class="muted pad">Nothing planned today.</p>'}${items.map((it) => agendaRow(state, it, key)).join('')}${free}${more}</div>` : `<div class="card pad muted">Nothing planned today.</div>`}
  </section>`);

  // next time you're both free (when it isn't tonight)
  if (P && !free) {
    const nf = nextBothFree(state, now);
    if (nf) {
      out.push(`<div class="card flush"><div class="now-row"><span class="tog-ic">${icon.heart(18)}</span>
        <span class="grow col"><span class="b">Both free ${esc(nf.label.charAt(0).toLowerCase() + nf.label.slice(1))}</span><span class="small muted">${esc(nf.sub)} <a href="#jar" class="nowrap">Ideas jar</a></span></span>
        <a href="#ask" class="btn tog sm" data-act="askFrom" data-day="${nf.key}" data-start="${hm(nf.start)}">Plan</a></div></div>`);
    }
  }

  // jobs for today (and anything overdue)
  const jobs = jobsOn(state, key);
  // (nothing due today, but jobs coming up: just the next one, so all of them are still a tap away)
  const next = jobs.length ? null : state.jobs.filter((j) => !j.done && j.day > key).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))[0];
  if (jobs.length || next) {
    out.push(`<section class="stack-s"><div class="row between"><h2 class="label">Jobs</h2><a href="#jobs" class="b small small-link">All jobs</a></div>
      ${jobs.length ? `<div class="card flush">${jobs.map((j) => jobRow(state, j, key, true)).join('')}</div>` : `<a href="#jobs" class="card flush next-job"><span class="list-row"><span class="grow col"><span class="b">${esc(next.title)}</span><span class="small muted">Nothing due today. Next: ${esc(relDay(fromDayKey(next.day)))}.</span></span>${icon.next(18)}</span></a>`}</section>`);
  }
  out.push(`<a href="#calendar" class="small-link center-link" data-act="calGo" data-v="week" data-day="${dayKey(addDays(now, 1))}">See the rest of the week ${icon.next(16)}</a>`);
  return out.join('');
}
// "2 more from low-priority calendars", opening that day in the month
function moreLink(state, key) {
  const n = lowCount(state, key, layerFilter());
  return n ? `<a href="#calendar" class="ag-add ag-more" data-act="calGo" data-day="${key}">${n} more from low-priority calendars ${icon.next(16)}</a>` : '';
}
// Christmas, birthdays, the anniversary...: one line at the top of Today, taking turns
let cdIdx = 0;
function milestones(state, now) {
  const list = countdowns(state, now).slice(0, 6).map(countdownText);
  if (!list.length) return '';
  const i = cdIdx % list.length;
  return `<button type="button" class="cd-strip" data-act="cdNext" aria-label="Countdowns. Tap for the next one.">${icon.gift(18)}<span id="cd-rot" class="cd-rot" aria-live="off" data-list="${esc(JSON.stringify(list))}">${esc(list[i])}</span>${list.length > 1 ? `<span class="cd-dots" aria-hidden="true">${list.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('')}</span>` : ''}</button>`;
}
export function rotateCountdown() {
  const el = document.getElementById('cd-rot');
  if (!el || document.hidden) return;
  let list = [];
  try { list = JSON.parse(el.dataset.list || '[]'); } catch (e) { return; }
  if (list.length < 2) return;
  cdIdx = (cdIdx + 1) % list.length;
  el.classList.add('out');
  setTimeout(() => {
    el.textContent = list[cdIdx];
    el.classList.remove('out');
    const dots = el.parentElement && el.parentElement.querySelectorAll('.cd-dots i');
    if (dots) dots.forEach((d, k) => d.classList.toggle('on', k === cdIdx));
  }, 220);
}
function hm(d) { return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }

function reminderRow(state, x, now) {
  const day = x.ev.allDay ? (x.ev.startKey || dayKey(x.ev.start)) : dayKey(x.ev.start);
  return `<div class="att-row"><span class="remind-ic">${icon.bell(18)}</span>
    <button type="button" class="grow col att-open" data-act="openEv" data-ref="${esc(x.ref)}" data-day="${day}"><span class="b">${esc(x.title)}</span><span class="small muted">${esc(reminderLine(x.ev, now).replace(/\.+$/, ''))}${x.note ? `. ${esc(x.note)}` : ''}</span></button>
    <button type="button" class="tick-btn" aria-label="Done: ${esc(x.title)}" data-act="remDone" data-ref="${esc(x.ref)}" data-occ="${esc(x.occ)}" data-title="${esc(x.title)}">${icon.check(18)}</button></div>`;
}

// A sync that has stopped, or a phone that has stopped getting notifications
function warnings(state, now) {
  const out = [];
  if (state.demo) return out;
  const mine = Object.values(state.status || {}).filter((x) => x.person === state.me);
  const bad = mine.find((x) => x.ok === false);
  const newest = Math.max(0, ...mine.map((x) => x.lastRun || 0));
  if (bad) {
    out.push(`<div class="card warn-card stack-s"><span class="b">Your calendar sync has a problem</span><span class="small">${esc(bad.account || '')}: ${esc(bad.error || 'unknown error')}</span>
      <div class="row-wrap"><button type="button" class="btn sec sm" data-act="syncNow">Try again</button><a href="#settings/account" class="btn link-btn">Details</a></div></div>`);
  } else if (mine.length && now - newest > 45 * 60000) {
    out.push(`<div class="card warn-card stack-s"><span class="b">Your calendar hasn't synced since ${esc(agoText(newest))}</span><span class="small">It normally syncs every 10 minutes.</span>
      <div class="row-wrap"><button type="button" class="btn sec sm" data-act="syncNow">Sync now</button><a href="#settings/account" class="btn link-btn">Details</a></div></div>`);
  }
  const P = state.partner;
  if (P) {
    const theirs = Object.values(state.status || {}).filter((x) => x.person === P);
    const last = Math.max(0, ...theirs.map((x) => x.lastRun || 0));
    if (theirs.length && now - last > 3 * 3600000) out.push(`<p class="small note-box">${esc(nameOf(state, P))}'s calendar hasn't synced since ${esc(agoText(last))}, so what you see of their day may be out of date.</p>`);
  }
  // notifications: allowed on this phone, but this phone's address is missing
  try {
    const flag = localStorage.getItem('caledonite.push') === '1';
    const id = localStorage.getItem('caledonite.pushId');
    if (flag && 'Notification' in window && Notification.permission === 'denied') {
      out.push(`<div class="card warn-card stack-s"><span class="b">Notifications are blocked on this phone</span><span class="small">Allow them for this site in Chrome's settings, then tap Turn on again in Settings, Notifications.</span></div>`);
    } else if (flag && state.tokens && id && !state.tokens.includes(id)) {
      out.push(`<div class="card warn-card stack-s"><span class="b">This phone has stopped getting notifications</span>
        <div class="row-wrap"><button type="button" class="btn sec sm" data-act="pushOn">Turn them back on</button></div></div>`);
    }
  } catch (e) { /* no storage */ }
  return out;
}
// Quiet hours, with a one-tap "not tonight" (shown from three hours before)
function quietLine(state, now) {
  const s = settingsOf(state, state.me);
  const q = s.quiet;
  if (!q.on) return '';
  const m = now.getHours() * 60 + now.getMinutes();
  const from = minutesOf(q.from || '23:00');
  const soon = (from - m + 1440) % 1440 <= 180;
  const inside = inQuietHours(s, now);
  const night = quietNight(s, now);
  const skipped = q.skip === night;
  if (!soon && !inside && !skipped) return '';
  const t = (hmv) => fmtTime(atTime('2000-01-01', hmv));
  if (skipped) return `<div class="now-row quiet-row">${icon.moon(18)}<span class="grow small">No quiet hours tonight.</span><button type="button" class="btn link-btn sm" data-act="quietTonight" data-v="on">Turn back on</button></div>`;
  return `<div class="now-row quiet-row">${icon.moon(18)}<span class="grow small">${inside ? 'Quiet hours now' : 'Quiet hours'}, ${esc(t(q.from))} to ${esc(t(q.to))}.</span><button type="button" class="btn link-btn sm" data-act="quietTonight" data-v="off">Not tonight</button></div>`;
}

function workSeenAs(state) {
  const workCals = Object.values(state.calendars).filter((c) => c.owner === state.me && c.role === 'work');
  if (!workCals.length) return 'Working';
  const share = workCals[0].share;
  return share === 'hours' ? 'Working' : share === 'busy' ? 'Busy' : share === 'all' ? 'Everything' : 'Nothing';
}

// both free this evening: the last line of the day, with a way to plan it
function freeTonight(state, d) {
  if (!state.partner) return '';
  const now = new Date();
  const iv = d.bothFree.find((x) => x[1] - x[0] >= 90 * 60000 && new Date(x[1]).getHours() >= 18 && x[1] > now.getTime());
  if (!iv) return '';
  const s = new Date(Math.max(iv[0], now.getTime())); const e = new Date(iv[1]);
  const open = e >= atTime(d.key, '22:30');
  return `<div class="ag-row ag-free"><span class="ag-time"><b>${esc(open ? 'From' : fmtTime(s))}</b><span>${esc(open ? fmtTime(new Date(iv[0])) : fmtTime(e))}</span></span><span class="ag-bar"></span>
    <span class="ag-main"><span class="b ink-tog">Free together</span><span class="small muted">Nothing planned yet. <a href="#jar" class="nowrap">Ideas jar</a></span></span>
    <a href="#ask" class="btn tog sm" data-act="askFrom" data-day="${d.key}" data-start="${hm(new Date(iv[0]))}">Plan</a></div>`;
}

// who something belongs to, in words and as a colour
export function whoLabel(state, who) {
  if (who === 'both') return 'Together';
  if (who && who.includes(':')) {
    const [owner, layer] = who.split(':');
    const info = LAYER_INFO[layer] || LAYER_INFO.other;
    const l = owner === state.me ? `Your ${info.label}` : `${shortName(state, owner)}'s ${info.label}`;
    return l.charAt(0).toUpperCase() + l.slice(1);
  }
  return who === state.me ? 'You' : shortName(state, who);
}
function whoColour(state, who) {
  if (who === 'both') return 'var(--tog)';
  if (who && who.includes(':')) return barColour(state, who);
  return `var(--${personColour(state, who)})`;
}
function timeCell(t) {
  const parts = t.split(' to ');
  return parts.length === 2 ? `<b>${esc(parts[0])}</b><span>${esc(parts[1])}</span>` : `<b>${esc(t)}</b>`;
}
export function agendaRow(state, it, key) {
  const dashed = it.kind === 'hold' || it.pending;
  const sub = itemSub(state, it);
  const inner = `<span class="ag-time">${timeCell(itemTime(it, key))}</span>
    <span class="ag-bar${dashed ? ' dashed' : ''}" style="background:${whoColour(state, it.who)}"></span>
    <span class="ag-main"><span class="b ag-title">${esc(itemTitle(state, it))}${bellFor(state, it)}</span>
    <span class="small muted ag-sub">${esc(whoLabel(state, it.who))}${sub ? ` · ${esc(sub)}` : ''}</span></span>`;
  // a shift (from the rota, or changed here): tapped, that day opens in Settings, Shifts
  if (!it.ref && it.kind === 'shift' && it.shift && settingsOf(state, it.who).hasShifts) {
    const day = it.cont ? dayKey(addDays(fromDayKey(key), -1)) : key;
    return `<button type="button" class="ag-row ag-tap" data-act="shiftEdit" data-p="${esc(it.who)}" data-day="${day}" aria-label="${esc(itemTitle(state, it))}, ${esc(itemTime(it, key))}, ${esc(whoLabel(state, it.who))}. Change it">${inner}</button>`;
  }
  if (!it.ref) return `<div class="ag-row">${inner}</div>`;
  return `<button type="button" class="ag-row ag-tap" data-act="openEv" data-ref="${esc(it.ref)}" data-day="${key}" aria-label="${esc(itemTitle(state, it))}, ${esc(itemTime(it, key))}, ${esc(whoLabel(state, it.who))}">${inner}</button>`;
}

// a small bell after the name when there's a reminder
export function bellFor(state, it) {
  if (!it.ref) return '';
  const r = reminderFor(state, it.ref, it);
  return r && (r.times || []).length ? `<span class="bell-mark" title="Reminder set">${icon.bell(14)}<span class="sr">Reminder set</span></span>` : '';
}

export function layerFilter() {
  const f = {};
  for (const [k, off] of Object.entries(ui.layerOff)) if (off) f[k] = false;
  return f;
}

// ---------------- CALENDAR ----------------
export function viewCalendar(state) {
  const out = [];
  const isMonth = ui.calView === 'month';
  const m = ui.calMonth;
  const ws = ui.weekStart;
  const range = isMonth ? `${MONTH_NAMES[m.getMonth()]} ${m.getFullYear()}` : weekLabel(ws);
  out.push(pageHeader(state, 'Calendar', range));
  out.push(seg([{ v: 'week', label: 'Week', on: !isMonth }, { v: 'month', label: 'Month', on: isMonth }], { act: 'calView', label: 'Week or month', cls: 'seg-full' }));
  // layer chips
  const chips = [];
  const ids = [state.me, state.partner].filter(Boolean);
  for (const pid of ids) chips.push({ k: pid, label: pid === state.me ? 'You' : shortName(state, pid), dot: `var(--${personColour(state, pid)})` });
  for (const lk of allLayers(state)) {
    const layer = lk.split(':')[1];
    chips.push({ k: lk, label: layerChipLabel(state, lk), dot: `var(--layer-${layer}, ${(LAYER_INFO[layer] || LAYER_INFO.other).colour})` });
  }
  out.push(`<div class="chips-scroll" role="group" aria-label="Calendars to show">${chips.map((c) => {
    const on = !ui.layerOff[c.k];
    return `<button type="button" class="layer-chip ${on ? 'on' : ''}" aria-pressed="${on}" data-act="layerToggle" data-k="${esc(c.k)}"><span class="dot" style="background:${c.dot}"></span>${esc(c.label)}</button>`;
  }).join('')}<a href="#settings/calendars" class="b pad-x">More</a></div>`);
  out.push(isMonth ? monthView(state) : weekView(state));
  return out.join('');
}
function weekLabel(ws) {
  const we = addDays(ws, 6);
  if (ws.getMonth() === we.getMonth()) return `${ws.getDate()} to ${we.getDate()} ${MONTH_NAMES[we.getMonth()]}`;
  return `${fmtDateShort(ws)} to ${fmtDateShort(we)}`;
}

function filterNow() {
  const f = {};
  for (const [k, off] of Object.entries(ui.layerOff)) if (off) f[k] = false;
  return f;
}

function monthView(state) {
  const m = ui.calMonth;
  const first = new Date(m.getFullYear(), m.getMonth(), 1);
  const gridStart = mondayOf(first);
  const todayK = dayKey(new Date());
  const f = filterNow();
  const cells = [];
  let freeCount = 0;
  for (let i = 0; i < 42; i++) {
    const d = addDays(gridStart, i);
    const k = dayKey(d);
    const inMonth = d.getMonth() === m.getMonth();
    if (!inMonth) {
      if (i >= 35 && d > first) { cells.push(''); continue; }
      cells.push(`<span class="mcell out"><span class="mnum">${d.getDate()}</span></span>`);
      continue;
    }
    const mc = monthCell(state, k, f);
    if (k < todayK) mc.freeEvening = false;
    if (mc.freeEvening) freeCount++;
    const sel = ui.calSel === k;
    const isToday = k === todayK;
    const bars = mc.bars.map((b) => `<span class="mbar" style="background:${barColour(state, b)}"></span>`).join('');
    cells.push(`<button type="button" class="mcell ${sel ? 'sel' : ''} ${isToday ? 'today' : ''}" aria-pressed="${sel}" aria-label="${esc(fmtDate(d))}${mc.freeEvening ? ', both free in the evening' : ''}" data-act="calSel" data-day="${k}">
      <span class="mnum">${d.getDate()}</span>${mc.freeEvening ? '<span class="mfree"></span>' : ''}${bars}</button>`);
  }
  // trim a blank last row
  const rows = [];
  for (let r = 0; r < 6; r++) {
    const slice = cells.slice(r * 7, r * 7 + 7);
    if (r === 5 && slice.every((c) => c === '' || c.includes('mcell out'))) break;
    rows.push(slice.map((c) => c || '<span class="mcell out"></span>').join(''));
  }
  const selKey = ui.calSel;
  const selDate = fromDayKey(selKey);
  const items = dayList(state, selKey, f);
  const d = buildDay(state, selKey);
  const P = state.partner;
  const showLegend = [
    ['me', 'Your plans'], ...(P ? [['partner', `${shortName(state, P)}'s plans`]] : []),
    ...(P && settingsOf(state, P).hasShifts ? [['sleep', `${shortName(state, P)} sleeping`]] : []),
    ['together', 'Together']
  ];
  return `<div class="card month">
    <div class="row between month-nav">
      <button type="button" class="icon-btn" aria-label="Previous month" data-act="monthPrev">${icon.back(20)}</button>
      <span class="b">${MONTH_NAMES[ui.calMonth.getMonth()]} ${ui.calMonth.getFullYear()}</span>
      <button type="button" class="icon-btn" aria-label="Next month" data-act="monthNext">${icon.next(20)}</button>
    </div>
    <div class="mgrid mhead"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span></div>
    <div class="mgrid">${rows.join('')}</div>
    <div class="legend">${showLegend.map(([k, l]) => `<span><span class="lbar" style="background:${barColour(state, k)}"></span>${esc(l)}</span>`).join('')}<span><span class="ldot"></span>Both free in the evening</span></div>
  </div>
  ${P ? `<div class="count-card"><span class="count">${freeCount}</span><span class="b">evenings left in ${MONTH_NAMES[ui.calMonth.getMonth()]} when you're both free</span></div>` : ''}
  <section class="stack-s">
    <h2 class="label">${esc(fmtDate(selDate))}${selKey === dayKey(new Date()) ? ' (today)' : ''}</h2>
    <div class="card flush agenda">
      ${items.length ? items.filter((it) => !it.low).map((it) => agendaRow(state, it, selKey)).join('') : '<p class="muted pad">Nothing planned.</p>'}
      ${items.some((it) => it.low) ? `<div class="ag-divider">Low priority</div>${items.filter((it) => it.low).map((it) => agendaRow(state, it, selKey)).join('')}` : ''}
      ${P && d.freeEvening && selKey >= dayKey(new Date()) ? `<div class="ag-row ag-free"><span class="ag-time"><b>Evening</b></span><span class="ag-bar"></span><span class="ag-main"><span class="b ink-tog">You're both free</span></span><a href="#ask" class="btn tog sm" data-act="askFrom" data-day="${selKey}" data-start="19:00">Plan</a></div>` : ''}
      <a href="#add" class="ag-add" data-act="addFor" data-day="${selKey}">${icon.plus(18)} Add on this day</a>
    </div>
  </section>`;
}

export function barColour(state, b) {
  if (b === 'me') return `var(--${personColour(state, state.me)})`;
  if (b === 'partner') return `var(--${personColour(state, state.partner)})`;
  if (b === 'sleep') return `var(--${personColour(state, state.partner)}-sleep)`;
  if (b === 'together') return 'var(--tog)';
  if (b === 'hold') return 'var(--tog-hold)';
  const layer = b.split(':')[1];
  return `var(--layer-${layer}, ${(LAYER_INFO[layer] || LAYER_INFO.other).colour})`;
}

function miniRow(state, it, key) {
  const inner = `<span class="mini-time b">${esc(itemTime(it, key))}</span><span class="grow">${esc(itemTitle(state, it))}${bellFor(state, it)}</span>${whoChip(state, it.who)}`;
  const cls = `mini ${it.kind === 'hold' || it.pending ? 'dashed' : ''}`;
  if (!it.ref) return `<div class="${cls}">${inner}</div>`;
  return `<button type="button" class="${cls} mini-tap" data-act="openEv" data-ref="${esc(it.ref)}" data-day="${key}">${inner}</button>`;
}

function weekView(state) {
  const ws = ui.weekStart;
  const f = filterNow();
  const P = state.partner;
  const todayK = dayKey(new Date());
  const cards = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(ws, i);
    const k = dayKey(date);
    const d = buildDay(state, k);
    const open = ui.weekOpen === k;
    const rows = [];
    // from 6am (by the clock, so the day the clocks change lines up too) to midnight
    const six = atTime(k, '06:00').getTime();
    const pct = (t) => Math.max(0, Math.min(100, ((t - six) / 3600000) / 18 * 100));
    const segs = (list) => list.map(([s, e, col]) => {
      const l = pct(s); const r = pct(e);
      if (r <= l) return '';
      return `<span class="seg-bar" style="left:${l.toFixed(2)}%;width:${(r - l).toFixed(2)}%;background:${col}"></span>`;
    }).join('');
    for (const pid of [state.me, P].filter(Boolean)) {
      if (f[pid] === false) continue;
      const p = d.persons[pid];
      const col = `var(--${personColour(state, pid)})`;
      const list = [];
      const lines = [];
      for (const it of p.items) {
        if (it.low || it.kind === 'money') continue;
        if (it.allDay) { lines.push(col); continue; }
        list.push([it.start.getTime(), it.end.getTime(), it.kind === 'sleep' ? `var(--${personColour(state, pid)}-sleep)` : col]);
      }
      for (const t of d.together) {
        if (t.allDay) lines.push('var(--tog)');
        else list.push([t.start.getTime(), t.end.getTime(), t.kind === 'hold' ? 'var(--tog-hold)' : 'var(--tog)']);
      }
      rows.push(`<span class="strip-label ink-${personColour(state, pid)}">${pid === state.me ? 'You' : esc(shortName(state, pid))}</span><div class="strip">${allDayLine(lines)}${segs(list)}</div>`);
    }
    if (P) {
      const list = d.bothFree.map(([s, e]) => [s, e, 'var(--free)']);
      for (const t of d.together) if (!t.allDay) list.push([t.start.getTime(), t.end.getTime(), t.kind === 'hold' ? 'var(--tog-hold)' : 'var(--tog)']);
      rows.push(`<span class="strip-label ink-tog">Both</span><div class="strip">${segs(list)}</div>`);
    }
    for (const lk of Object.keys(d.layers)) {
      if (f[lk] === false) continue;
      const layer = lk.split(':')[1];
      const col = `var(--layer-${layer}, ${(LAYER_INFO[layer] || LAYER_INFO.other).colour})`;
      const shown = d.layers[lk].filter((x) => !x.low);
      if (!shown.length) continue;
      const timed = shown.filter((x) => !x.allDay);
      // ("Family" for yours; "Sophie's family" for your partner's, on two short lines rather than cut short)
      const lname = layerChipLabel(state, lk).replace(/^Your /, '').replace(/^\w/, (c) => c.toUpperCase());
      rows.push(`<span class="strip-label${lname.includes(' ') ? ' two' : ''}" style="color:var(--layer-${layer}-ink, ${(LAYER_INFO[layer] || LAYER_INFO.other).ink})">${esc(lname)}</span><div class="strip">${allDayLine(shown.some((x) => x.allDay) ? [col] : [])}${segs(timed.map((x) => [x.start.getTime(), x.end.getTime(), col]))}</div>`);
    }
    const items = dayList(state, k, Object.assign({}, f, { hideLow: true }));
    cards.push(`<article class="card wday ${k === todayK ? 'is-today' : ''}">
      <button type="button" class="wday-head" aria-expanded="${open}" data-act="weekOpen" data-day="${k}">
        <span class="h3 grow">${esc(fmtDate(date).replace(/ \w+$/, ''))}</span>
        ${k === todayK ? '<span class="pill dark">Today</span>' : ''}
        <span class="b link small">${open ? 'Hide' : 'Details'}</span>
      </button>
      <div class="strips">${rows.join('')}</div>
      ${P ? freeLine(d, k) : ''}
      ${open ? `<div class="wday-list agenda">${items.length ? items.map((it) => agendaRow(state, it, k)).join('') : '<p class="muted pad">Nothing planned.</p>'}${moreLink(state, k)}
        <a href="#add" class="ag-add" data-act="addFor" data-day="${k}">${icon.plus(18)} Add on this day</a></div>` : ''}
    </article>`);
  }
  return `<div class="row between week-nav">
      <button type="button" class="icon-btn" aria-label="Previous week" data-act="weekPrev">${icon.back(20)}</button>
      <button type="button" class="btn sec sm" data-act="weekToday">This week</button>
      <button type="button" class="icon-btn" aria-label="Next week" data-act="weekNext">${icon.next(20)}</button>
    </div>
    <div class="scale"><span></span><div><span style="left:0">6am</span><span style="left:33.3%;transform:translateX(-50%)">Noon</span><span style="left:66.7%;transform:translateX(-50%)">6pm</span><span style="right:0">12am</span></div></div>
    ${cards.join('')}`;
}
// all-day things: a thin line through the whole strip, one per colour
function allDayLine(cols) {
  const u = [...new Set(cols)].slice(0, 3);
  return u.map((c, i) => `<span class="seg-line" style="background:${c};top:${u.length === 1 ? 7 : 3 + i * 5}px"></span>`).join('');
}
// what the two of you have that day; time you're both free still to come is tapped to plan it
function freeLine(d, k) {
  const text = esc(freeText(d));
  const iv = bestFree(d);
  if (!iv || iv[1] <= Date.now() || d.together.some((t) => !t.auto && !t.allDay)) return `<p class="b small ink-tog">${text}</p>`;
  return `<a href="#ask" class="wday-free b small ink-tog" data-act="askFrom" data-day="${k}" data-start="${hm(new Date(Math.max(iv[0], atTime(k, '09:00').getTime())))}"><span class="grow">${text}</span><span class="wday-plan">Plan ${icon.next(16)}</span></a>`;
}
function bestFree(d) {
  const iv = d.bothFree.filter((x) => x[1] - x[0] >= 60 * 60000);
  return iv.length ? iv.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a)) : null;
}
// (any day of the week, so never "today")
export function freeText(d) {
  const tog = d.together.filter((t) => !t.auto && !t.allDay);
  const iv = d.bothFree.filter((x) => x[1] - x[0] >= 60 * 60000);
  if (!iv.length && !tog.length) {
    const din = d.together.find((t) => t.auto);
    return din ? `${din.title} at ${fmtTime(din.start)}` : 'Not free together';
  }
  const parts = [];
  if (tog.length) parts.push(`${tog[0].title} at ${fmtTime(tog[0].start)}`);
  if (iv.length) {
    const best = iv.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
    const s = new Date(best[0]); const e = new Date(best[1]);
    parts.push(e.getHours() >= 23 ? `Both free from ${fmtTime(s)}` : `Both free ${fmtRange(s, e)}`);
  }
  return parts.join('. ');
}
