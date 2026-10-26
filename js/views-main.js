// Today and Calendar screens.
import {
  esc, dayKey, fromDayKey, addDays, startOfDay, fmtDate, fmtTime, fmtRange, relDay, MONTH_NAMES, atTime, mondayOf, fmtDateShort
} from './util.js';
import {
  buildDay, dayList, statusNow, nextBothFree, itemTime, itemTitle, itemSub, nameOf, personColour, monthCell, allLayers,
  layerChipLabel, LAYER_INFO, settingsOf, isWorkingShift
} from './logic.js';
import { icon, avatar, whoChip, seg, empty } from './ui.js';
import { ui } from './uistate.js';

function motif() {
  const t = document.documentElement.dataset.theme;
  const m = { starship: icon.orbit, dragonfire: icon.wing, fairytale: icon.castle }[t];
  return m ? `<span class="motif">${m(34)}</span>` : '';
}
export function pageHeader(state, title, small) {
  return `<header class="page-head">
    <div class="col"><span class="small b muted">${esc(small || '')}</span><h1>${esc(title)}</h1></div>
    <span class="row small-gap">${motif()}<a href="#settings" class="av-btn" aria-label="Settings">${avatar(state, state.me, 44)}</a></span>
  </header>`;
}

export function waitingForMe(state) {
  return state.requests.filter((r) => (r.to === state.me && (r.status === 'waiting' || r.status === 'maybe' || (r.type === 'heads' && r.status === 'sent')))
    || (r.from === state.me && r.status === 'other'));
}

// ---------------- TODAY ----------------
export function viewToday(state) {
  const now = new Date();
  const key = dayKey(now);
  const d = buildDay(state, key, now);
  const P = state.partner;
  const me = state.me;
  const out = [];
  out.push(pageHeader(state, 'Today', `Hi ${nameOf(state, me)} · ${fmtDate(now)}`));

  // requests waiting
  const waiting = waitingForMe(state);
  if (waiting.length && P) {
    const fromPartner = waiting.filter((r) => r.from === P).length;
    const label = fromPartner === waiting.length ? `${nameOf(state, P)} asked you ${waiting.length === 1 ? 'something' : waiting.length + ' things'}` : `${waiting.length} request${waiting.length === 1 ? '' : 's'} need you`;
    out.push(`<a class="card row link-card" href="#requests">${avatar(state, P, 32)}<span class="grow b">${esc(label)}</span><span class="b link">Open</span></a>`);
  }
  // notes for me
  for (const n of state.notes.filter((x) => x.to === me && !x.seen && (x.showAfter || 0) <= Date.now()).slice(0, 3)) {
    out.push(`<div class="card stack">
      <div class="row">${avatar(state, n.from, 32)}<span class="b muted grow">A note from ${esc(nameOf(state, n.from))}</span></div>
      <p class="note-text">${esc(n.text)}</p>
      <button type="button" class="btn sec self-start" data-act="noteSeen" data-id="${esc(n.id)}">Got it</button></div>`);
  }

  // my shift today (big card, like Sophie's design)
  const mine = d.persons[me];
  const myShift = mine && mine.items.find((it) => it.kind === 'shift' && !it.allDay && !it.cont);
  if (myShift) {
    const s = settingsOf(state, me);
    const home = new Date(myShift.end.getTime() + (s.travelMins || 0) * 60000);
    out.push(`<section class="shift-card">
      <span class="b small shift-ink">Your shift today</span>
      <span class="h2">${esc(itemTitle(state, myShift))}</span>
      <span class="big b">${esc(fmtRange(myShift.start, myShift.end))}</span>
      <span>Home about ${esc(fmtTime(home))}${myShift.end.getDate() !== myShift.start.getDate() ? ' tomorrow morning' : ''}.</span>
    </section>`);
  }

  // right now
  if (P) {
    const ps = statusNow(state, P, now);
    const ms = statusNow(state, me, now);
    const sleeping = ps && ps.kind === 'sleep';
    let noteBlock = '';
    if (ui.noteOpen) {
      noteBlock = `<div class="stack-s">
        <label for="note" class="b">Note for ${esc(nameOf(state, P))}</label>
        <textarea id="note" rows="3" data-bind="noteText" placeholder="Hope you slept well. I've done the food shop.">${esc(ui.noteText)}</textarea>
        <span class="small muted">${sleeping ? `${esc(nameOf(state, P))} sees it after waking up.` : `${esc(nameOf(state, P))} gets it straight away.`}</span>
        <div class="row-wrap"><button type="button" class="btn" data-act="saveNote">Save note</button><button type="button" class="btn sec" data-act="noteCancel">Cancel</button></div>
      </div>`;
    } else {
      noteBlock = `<button type="button" class="btn sec self-start" data-act="noteOpen">Leave ${esc(nameOf(state, P))} a note</button>`;
    }
    out.push(`<section class="stack">
      <h2 class="label">Right now</h2>
      <div class="card stack">
        <div class="row">${avatar(state, P, 44)}<div class="grow col"><span class="b small ink-${personColour(state, P)}">${esc(nameOf(state, P))}</span><span class="h3">${esc(ps.title)}</span></div>${sleeping ? `<span class="ink-${personColour(state, P)}">${icon.moon(26)}</span>` : ''}</div>
        <p class="muted">${esc(ps.sub)}</p>
        ${sleeping ? '<span class="pill self-start">Quiet hours: notifications held</span>' : ''}
        ${noteBlock}
      </div>
      <div class="card stack">
        <div class="row">${avatar(state, me, 44)}<div class="grow col"><span class="b small ink-${personColour(state, me)}">You</span><span class="h3">${esc(ms.title)}</span></div></div>
        <p class="muted">${esc(ms.sub)}</p>
        ${ms.kind === 'work' ? `<div class="row small-gap">${icon.eye(20)}<span class="grow">${esc(nameOf(state, P))} sees: <b>${esc(workSeenAs(state))}</b></span><a href="#settings/calendars" class="b pad-y">Change</a></div>` : ''}
      </div>
    </section>`);

    const nf = nextBothFree(state, now);
    if (nf) {
      out.push(`<section class="banner stack-s">
        <span class="b small banner-label">Next time you're both free</span>
        <span class="h2">${esc(nf.label)}</span>
        <span>${esc(nf.sub)}</span>
        <a href="#ask" class="btn banner-btn self-start" data-act="askFrom" data-day="${nf.key}" data-start="${hm(nf.start)}">Plan something</a>
      </section>`);
    }
  } else {
    out.push(`<div class="card stack"><span class="h3">Waiting for your partner</span><p class="muted">Once they sign in, you'll see what they're up to here. Add their Google email in Settings, Account.</p><a class="btn sec self-start" href="#settings/account">Open Account settings</a></div>`);
  }

  // today's plans
  const filter = {};
  if (P && ui.todayFilter === 'me') filter[P] = false;
  if (P && ui.todayFilter === 'partner') filter[me] = false;
  let items = dayList(state, key, Object.assign({}, filter, layerFilter()));
  if (ui.todayFilter === 'me') items = items.filter((it) => it.who !== P && !(it.layer && it.layer.startsWith(P + ':')));
  if (ui.todayFilter === 'partner') items = items.filter((it) => it.who !== me && !(it.layer && it.layer.startsWith(me + ':')));
  items = items.filter((it) => !(it.kind === 'shift' && it.allDay && it.who === me && myShift));
  const segItems = P ? [{ v: 'both', label: 'Both', on: ui.todayFilter === 'both' }, { v: 'me', label: 'You', on: ui.todayFilter === 'me' }, { v: 'partner', label: nameOf(state, P), on: ui.todayFilter === 'partner' }] : [];
  out.push(`<section class="stack">
    <div class="row between"><h2 class="label">Today's plans</h2>${P ? seg(segItems, { act: 'todayFilter', label: 'Show plans for', cls: 'seg-sm' }) : ''}</div>
    ${items.length ? items.map((it) => itemRow(state, it, key)).join('') : empty('Nothing planned today.')}
    ${freeRows(state, d)}
  </section>`);

  // coming up
  if (P) {
    const rows = [];
    for (let i = 1; i <= 3; i++) {
      const dk = dayKey(addDays(now, i));
      rows.push(comingUp(state, dk));
    }
    out.push(`<section class="stack"><h2 class="label">Coming up</h2>${rows.join('')}</section>`);
  }
  return out.join('');
}
function hm(d) { return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }

function workSeenAs(state) {
  const workCals = Object.values(state.calendars).filter((c) => c.owner === state.me && c.role === 'work');
  if (!workCals.length) return 'Working';
  const share = workCals[0].share;
  return share === 'hours' ? 'Working' : share === 'busy' ? 'Busy' : share === 'all' ? 'Everything' : 'Nothing';
}

function freeRows(state, d) {
  if (!state.partner) return '';
  const now = new Date();
  const rows = d.bothFree.filter((iv) => iv[1] - iv[0] >= 90 * 60000 && new Date(iv[1]).getHours() >= 18).slice(0, 1);
  return rows.map((iv) => {
    const s = new Date(iv[0]); const e = new Date(iv[1]);
    const open = e >= atTime(d.key, '22:30');
    return `<div class="item free-row"><span class="item-time">${esc(open ? 'From ' + fmtTime(s) : fmtRange(s, e))}</span><div class="item-main"><span class="chip chip-tog">Both of you</span><span class="b">Free together</span><span class="small muted">${s < now ? '' : 'Nothing planned yet.'}</span></div></div>`;
  }).join('');
}

export function itemRow(state, it, key, { compact = false } = {}) {
  const cls = ['item'];
  if (it.kind === 'hold' || it.pending) cls.push('item-dashed');
  if (it.kind === 'together' || it.kind === 'hold') cls.push('item-tog');
  const sub = itemSub(state, it);
  return `<div class="${cls.join(' ')}">
    <span class="item-time">${esc(itemTime(it, key))}</span>
    <div class="item-main">
      ${whoChip(state, it.who)}
      <span class="b">${esc(itemTitle(state, it))}</span>
      ${sub && !compact ? `<span class="small muted">${esc(sub)}</span>` : ''}
    </div>
  </div>`;
}

function comingUp(state, key) {
  const d = buildDay(state, key);
  const date = fromDayKey(key);
  const lines = [];
  for (const pid of [state.partner, state.me]) {
    const p = d.persons[pid];
    const bits = [];
    for (const it of p.items) {
      if (it.cont || it.kind === 'sleep') continue;
      if (it.kind === 'shift') bits.push(it.allDay ? it.title : `${itemTitle(state, it)}, ${fmtRange(it.start, it.end)}`);
      else if (it.kind === 'work') bits.push(`${it.title}, ${fmtRange(it.start, it.end)}`);
      else if (bits.length < 3) bits.push(it.allDay ? it.title : `${it.title} at ${fmtTime(it.start)}`);
    }
    if (settingsOf(state, pid).hasShifts && !p.items.some((it) => it.kind === 'shift')) bits.unshift('No shift');
    if (bits.length) lines.push(`<span><b class="ink-${personColour(state, pid)}">${pid === state.me ? 'You' : esc(nameOf(state, pid))}:</b> ${esc(bits.join('. '))}.</span>`);
  }
  const tog = d.together.filter((t) => !(t.auto && t.title === 'Dinner together'));
  if (tog.length) lines.push(`<span><b class="ink-tog">Together:</b> ${esc(tog.map((t) => t.allDay ? t.title : `${t.title} at ${fmtTime(t.start)}`).join('. '))}.</span>`);
  if (d.freeEvening && !tog.some((t) => !t.auto && t.start.getHours() >= 17)) lines.push(`<span class="ink-tog b">You're both free in the evening.</span>`);
  if (!lines.length) lines.push('<span class="muted">Nothing planned.</span>');
  return `<a class="card stack-s plain" href="#calendar" data-act="calGo" data-day="${key}"><span class="b">${esc(relDay(date))}</span>${lines.join('')}</a>`;
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
  for (const pid of ids) chips.push({ k: pid, label: pid === state.me ? 'You' : nameOf(state, pid), dot: `var(--${personColour(state, pid)})` });
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
    ['me', 'Your plans'], ...(P ? [['partner', `${nameOf(state, P)}'s plans`]] : []),
    ...(P && settingsOf(state, P).hasShifts ? [['sleep', `${nameOf(state, P)} sleeping`]] : []),
    ['together', 'Together'], ...allLayers(state).map((lk) => [lk, layerChipLabel(state, lk)])
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
  <section class="card stack-s">
    <h2 class="h3">${esc(fmtDate(selDate))}${selKey === dayKey(new Date()) ? ' (today)' : ''}</h2>
    ${items.length ? items.map((it) => miniRow(state, it, selKey)).join('') : '<p class="muted">Nothing planned.</p>'}
    ${P && d.freeEvening && selKey >= dayKey(new Date()) ? `<div class="row between pad-top"><span class="b ink-tog">You're both free this evening.</span><a href="#ask" class="btn tog sm" data-act="askFrom" data-day="${selKey}" data-start="19:00">Plan something</a></div>` : ''}
    <a href="#add" class="b small-link" data-act="addFor" data-day="${selKey}">${icon.plus(18)} Add something on this day</a>
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
  return `<div class="mini ${it.kind === 'hold' || it.pending ? 'dashed' : ''}"><span class="mini-time b">${esc(itemTime(it, key))}</span><span class="grow">${esc(itemTitle(state, it))}</span>${whoChip(state, it.who)}</div>`;
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
    const dayStart = atTime(k, '00:00').getTime();
    const pct = (t) => Math.max(0, Math.min(100, ((t - dayStart) / 3600000 - 6) / 18 * 100));
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
      for (const it of p.items) {
        if (it.allDay) continue;
        list.push([it.start.getTime(), it.end.getTime(), it.kind === 'sleep' ? `var(--${personColour(state, pid)}-sleep)` : col]);
      }
      for (const t of d.together) if (!t.allDay) list.push([t.start.getTime(), t.end.getTime(), t.kind === 'hold' ? 'var(--tog-hold)' : 'var(--tog)']);
      rows.push(`<span class="strip-label ink-${personColour(state, pid)}">${pid === state.me ? 'You' : esc(nameOf(state, pid))}</span><div class="strip">${segs(list)}</div>`);
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
      const timed = d.layers[lk].filter((x) => !x.allDay);
      if (!timed.length && !d.layers[lk].length) continue;
      rows.push(`<span class="strip-label" style="color:var(--layer-${layer}-ink, ${(LAYER_INFO[layer] || LAYER_INFO.other).ink})">${esc(layerChipLabel(state, lk).replace(/^Your /, '').replace(/^\w/, (c) => c.toUpperCase()))}</span><div class="strip">${segs(timed.map((x) => [x.start.getTime(), x.end.getTime(), col]))}</div>`);
    }
    const items = dayList(state, k, f);
    cards.push(`<article class="card wday ${k === todayK ? 'is-today' : ''}">
      <button type="button" class="wday-head" aria-expanded="${open}" data-act="weekOpen" data-day="${k}">
        <span class="h3 grow">${esc(fmtDate(date).replace(/ \w+$/, ''))}</span>
        ${k === todayK ? '<span class="pill dark">Today</span>' : ''}
        <span class="b link small">${open ? 'Hide' : 'Details'}</span>
      </button>
      <div class="strips">${rows.join('')}</div>
      ${P ? `<p class="b small ink-tog">${esc(freeText(d))}</p>` : ''}
      ${open ? `<div class="wday-list">${items.length ? items.map((it) => miniRow(state, it, k)).join('') : '<p class="muted">Nothing planned.</p>'}</div>` : ''}
    </article>`);
  }
  return `<div class="row between week-nav">
      <button type="button" class="icon-btn" aria-label="Previous week" data-act="weekPrev">${icon.back(20)}</button>
      <button type="button" class="btn sec sm" data-act="weekToday">This week</button>
      <button type="button" class="icon-btn" aria-label="Next week" data-act="weekNext">${icon.next(20)}</button>
    </div>
    <div class="scale"><span></span><div><span style="left:0">6am</span><span style="left:33.3%;transform:translateX(-50%)">Noon</span><span style="left:66.7%;transform:translateX(-50%)">6pm</span><span style="right:0">Midnight</span></div></div>
    ${cards.join('')}`;
}
function freeText(d) {
  const tog = d.together.filter((t) => !t.auto && !t.allDay);
  const iv = d.bothFree.filter((x) => x[1] - x[0] >= 60 * 60000);
  if (!iv.length && !tog.length) {
    const din = d.together.find((t) => t.auto);
    return din ? `${din.title} at ${fmtTime(din.start)}` : 'Not free together today';
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
