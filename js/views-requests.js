// Requests, asking something, and adding something.
import { esc, dayKey, addDays, fmtTime, agoText, atTime } from './util.js';
import { nameOf, shortName, freeSlots, sleepingUntil, settingsOf, SHIFT_ORDER, REMIND_OPTIONS, REMIND_NOTES, remindSummary, leaveDaysFor, leaveSummary, JOB_REPEATS } from './logic.js';
import { whenLabel, requestPassed } from './store.js';
import { icon, avatar, seg, toggleRow, empty } from './ui.js';
import { ui } from './uistate.js';
import { pageHeader } from './views-main.js';

const TYPE_LABEL = { plan: 'Plan together', favour: 'Favour', free: 'Keep time free', heads: 'Heads up', add: 'Added for you', leave: 'Holiday' };
const EVENT_REPEATS = [['', 'Doesn’t repeat'], ['WEEKLY:1', 'Every week'], ['WEEKLY:2', 'Every 2 weeks'], ['MONTHLY:1', 'Every month'], ['YEARLY:1', 'Every year']];

// ---------------- REQUESTS ----------------
export function viewRequests(state) {
  const P = state.partner;
  const forMe = state.requests.filter((r) => r.to === state.me && r.status !== 'cancelled');
  const sent = state.requests.filter((r) => r.from === state.me && r.status !== 'cancelled');
  const openForMe = forMe.filter((r) => isOpen(r) && r.status !== 'other').length;
  const openSent = sent.filter((r) => isOpen(r) && r.status !== 'sent').length;
  const list = ui.reqTab === 'for' ? forMe : sent;
  const recent = list.filter((r) => isOpen(r) || (Date.now() - (r.answeredAt || r.created || 0)) < 7 * 86400000);
  const older = list.filter((r) => !recent.includes(r));
  return `${pageHeader(state, 'Requests', 'Between you two')}
    ${P ? `<a href="#ask" class="btn big-btn" data-act="askNew">${icon.plus(20)} Ask ${esc(shortName(state, P))} something</a>` : ''}
    ${seg([{ v: 'for', label: `For you (${openForMe})`, on: ui.reqTab === 'for' }, { v: 'sent', label: `You sent (${openSent})`, on: ui.reqTab === 'sent' }], { act: 'reqTab', label: 'Which requests', cls: 'seg-full' })}
    <div class="stack">${recent.length ? recent.map((r) => reqCard(state, r)).join('') : empty(ui.reqTab === 'for' ? 'Nothing waiting for you.' : 'You haven’t asked anything lately.')}</div>
    ${older.length ? `<details class="older" data-keep="older-${ui.reqTab}" ${ui.opened[`older-${ui.reqTab}`] ? 'open' : ''}><summary class="b">Older (${older.length})</summary><div class="stack">${older.slice(0, 20).map((r) => reqCard(state, r)).join('')}</div></details>` : ''}`;
}
// worked out afresh each time: a saved "Tomorrow, 7pm" would be wrong by the next day
function whenText(w) { return w ? whenLabel(w) || w.label || '' : ''; }
// still to be answered (not one whose time went by while it waited)
function isOpen(r) { return (r.status === 'waiting' || r.status === 'maybe' || r.status === 'other' || r.status === 'sent') && !requestPassed(r); }

function reqCard(state, r) {
  const mine = r.from === state.me;
  const other = mine ? r.to : r.from;
  const on = nameOf(state, other);
  // (something you added for your partner is added for them, not for you)
  const kind = r.type === 'add' && mine ? `Added for ${on}` : (TYPE_LABEL[r.type] || 'Request');
  const head = `<div class="row">${mine ? '' : avatar(state, r.from, 32)}<span class="grow b small muted">${mine ? 'You asked' : esc(nameOf(state, r.from))}, ${esc(agoText(r.created))}</span><span class="pill">${esc(kind)}</span></div>`;
  const when = r.when ? `<p class="row small-gap b">${icon.clock(18)}${esc(whenText(r.when))}</p>` : '';
  let body = '';
  const id = esc(r.id);
  // still waiting, but its time has gone by: only clearing it away is left (that frees anything pencilled in)
  const passed = ['waiting', 'maybe', 'other'].includes(r.status) && requestPassed(r);
  const passedLine = passed ? `<p class="note-box">${r.status === 'other' ? `The other time, ${esc(whenText(r.counter))}, has passed.` : 'This time has passed.'}</p>` : '';
  if (passed && !mine) {
    body = r.status === 'other' ? passedLine : `${passedLine}<div class="row-wrap"><button type="button" class="btn sec" data-act="answer" data-a="no" data-id="${id}">Not this time</button></div>`;
  } else if (passed) {
    body = `${passedLine}<div class="row-wrap"><button type="button" class="btn sec" data-act="answer" data-a="cancel" data-id="${id}">Cancel request</button></div>`;
  } else if (!mine) {
    if (r.status === 'waiting' || r.status === 'maybe') {
      const maybeNote = r.status === 'maybe' ? '<p class="small muted">You said you’re not sure yet.</p>' : '';
      if (ui.suggestFor === r.id) {
        const slots = freeSlots(state, new Date(), 4);
        ui.suggestSlots = slots; // what a tap on one of these means, even if the list changes later
        body = `<div class="stack-s"><span class="b small">Suggest a time you're both free:</span>
          ${slots.map((s, i) => `<button type="button" class="slot" data-act="suggest" data-id="${id}" data-i="${i}">${esc(s.label)}</button>`).join('') || '<p class="muted small">No shared free time in the next three weeks.</p>'}
          <button type="button" class="btn link-btn self-start" data-act="suggestCancel">Cancel</button></div>`;
      } else if (r.type === 'favour') {
        body = `${maybeNote}<div class="row-wrap"><button type="button" class="btn tog" data-act="answer" data-a="yes" data-id="${id}">Yes, I'll do it</button><button type="button" class="btn sec" data-act="answer" data-a="no" data-id="${id}">I can't</button></div>`;
      } else {
        body = `${maybeNote}<div class="row-wrap"><button type="button" class="btn tog" data-act="answer" data-a="yes" data-id="${id}">${r.type === 'leave' ? 'Yes, book it' : 'Yes, add it'}</button>
          ${r.when && r.type !== 'leave' ? `<button type="button" class="btn sec" data-act="suggestOpen" data-id="${id}">Another time</button>` : ''}
          ${r.status === 'waiting' ? `<button type="button" class="btn link-btn" data-act="answer" data-a="maybe" data-id="${id}">Not sure yet</button>` : ''}
          <button type="button" class="btn link-btn" data-act="answer" data-a="no" data-id="${id}">Not this time</button></div>`;
      }
    } else if (r.status === 'sent') {
      body = `<p class="small muted">No answer needed.</p><button type="button" class="btn sec self-start" data-act="answer" data-a="seen" data-id="${id}">Got it</button>`;
    } else if (r.status === 'other') {
      body = `<p class="note-box">You suggested ${esc(whenText(r.counter))}. Waiting for ${esc(on)}.</p>`;
    } else body = resultLine(state, r, false);
  } else {
    if (r.status === 'waiting') {
      const asleep = sleepingUntil(state, r.to);
      body = `<p class="small muted">Waiting for ${esc(on)}.${r.hold ? ' Pencilled into both calendars until there\u2019s an answer.' : ''}${asleep ? ` ${esc(on)} is asleep, so the notification waits until about ${esc(fmtTime(asleep))}.` : ''}</p>
        <div class="row-wrap">${askerButtons(r, id, on)}</div>`;
    } else if (r.status === 'maybe') {
      body = `<p class="note-box">${esc(on)} isn't sure yet.${r.hold ? ' It stays pencilled in.' : ''}</p>
        <div class="row-wrap">${askerButtons(r, id, on)}</div>`;
    } else if (r.status === 'other') {
      body = `<p class="note-box">${esc(on)} suggested <b>${esc(whenText(r.counter))}</b> instead.</p>
        <div class="row-wrap"><button type="button" class="btn tog" data-act="answer" data-a="accept-counter" data-id="${id}">That works</button><button type="button" class="btn link-btn" data-act="answer" data-a="cancel" data-id="${id}">Not this time</button></div>`;
    } else if (r.status === 'sent') {
      body = `<p class="small muted">Sent. No answer needed.</p>`;
    } else body = resultLine(state, r, true);
  }
  const title = r.type === 'leave' ? (r.title ? `Holiday: ${r.title}` : 'Holiday') : r.title;
  const days = r.type === 'leave' && r.days ? `<p class="small muted">${esc(leaveDaysLine(state, r))}</p>` : '';
  return `<article class="card stack ${isOpen(r) ? '' : 'faded'}">${head}<h3 class="h3">${esc(title)}</h3>${when}${days}${body}</article>`;
}
// still waiting for an answer (or a "not sure yet"): remind them, or call it off
function askerButtons(r, id, on) {
  return `${(!r.reminded || Date.now() - r.reminded > 6 * 3600000) ? `<button type="button" class="btn sec" data-act="answer" data-a="remind" data-id="${id}">Remind ${esc(on)}</button>` : '<span class="small b muted">Reminder sent.</span>'}
        <button type="button" class="btn link-btn" data-act="answer" data-a="cancel" data-id="${id}">Cancel request</button>`;
}
function leaveDaysLine(state, r) {
  const bits = [];
  for (const pid of r.people || [r.from, r.to]) {
    if (typeof r.days[pid] !== 'number') continue;
    bits.push(`${pid === state.me ? 'you' : nameOf(state, pid)}: ${r.days[pid]} day${r.days[pid] === 1 ? '' : 's'}`);
  }
  return bits.length ? `Holiday allowance it takes. ${bits.join(', ').replace(/^y/, 'Y')}.` : '';
}
function resultLine(state, r, mine) {
  const on = nameOf(state, mine ? r.to : r.from);
  const who = mine ? on : 'You';
  // a holiday booked just for one of you: no one said yes, and it's in one calendar
  if (r.status === 'yes' && (r.own || (r.people && r.people.length === 1))) {
    return `<p class="ok-box">${mine ? 'Booked. It’s in your calendar.' : `${esc(on)} booked it. It’s in ${esc(on)}’s calendar.`}</p>`;
  }
  if (r.status === 'yes') {
    // a favour, or something added for one of you, goes in that one calendar only
    const where = r.type === 'favour' ? (mine ? `${on} will do it.` : 'Done. It’s in your calendar as a reminder.')
      : r.type === 'add' ? (!r.when ? '' : mine ? `It’s in ${on}’s calendar.` : 'It’s in your calendar.')
      : r.when ? 'It’s in both your calendars.' : '';
    return `<p class="ok-box">${esc(who)} said yes. ${esc(where)}</p>`;
  }
  if (r.status === 'no') return `<p class="note-box">${esc(who)} ${mine ? 'can’t' : 'said not'} this time.</p>`;
  if (r.status === 'seen') return `<p class="small b ink-tog">${mine ? `${esc(on)} has seen it.` : 'Seen.'}</p>`;
  return '';
}

// ---------------- ASK ----------------
const TYPES = [
  ['plan', 'Plan something together', 'A date, a trip, seeing people'],
  ['favour', 'Ask a favour', 'Can you do something for me?'],
  ['free', 'Keep time free', 'Please don’t book anything then'],
  ['heads', 'Heads up', 'Just so you know. No answer needed'],
  ['leave', 'Book a holiday', 'Time off together, from your allowances']
];
export function viewAsk(state) {
  const P = state.partner;
  if (!P) return `${pageHeader(state, 'Ask', '')}${empty('Your partner hasn’t joined yet.')}`;
  const a = ui.ask;
  const pn = nameOf(state, P);
  if (a.sent) {
    const asleep = sleepingUntil(state, P);
    return `<a href="#requests" class="back-link">${icon.back(20)}Requests</a>
      <section class="card stack done-card">
        <span class="tick">${icon.check(26)}</span>
        <h1 class="h2">Sent to ${esc(pn)}</h1>
        <p>${asleep ? `${esc(pn)} is asleep after a night shift, so the notification waits until about ${esc(fmtTime(asleep))}.` : `${esc(pn)} gets a notification now.`}</p>
        ${a.heldNote ? '<p class="muted">Pencilled into both calendars until there’s an answer.</p>' : ''}
        <div class="row-wrap"><a href="#requests" class="btn">Back to requests</a><button type="button" class="btn sec" data-act="askAgain">Ask something else</button></div>
      </section>`;
  }
  const slots = freeSlots(state, new Date(), 4);
  // keep the time that was tapped, even when the free times move on (a slot ends, or a new one appears)
  if (!a.custom && a.pick) {
    const i = slots.findIndex((x) => x.key === a.pick.key && x.start === a.pick.start && x.end === a.pick.end);
    if (i >= 0) a.slot = i;
    else Object.assign(a, { custom: true, cday: a.pick.key, cstart: a.pick.start, cend: a.pick.end, pick: null });
  }
  a.shown = slots;
  const holdDefault = state.household.pencilDefault !== false;
  const hold = a.hold === null ? holdDefault : a.hold;
  const favours = state.household.favours || [];
  const needsWhen = a.type !== 'heads' && a.type !== 'leave';
  const placeholder = { plan: 'Cinema, then food', favour: 'Pick up a parcel', free: 'My friends are visiting', heads: "I'll be home late", leave: 'Spain' }[a.type];
  return `<a href="#requests" class="back-link">${icon.back(20)}Requests</a>
    <h1 class="h1">Ask ${esc(pn)}</h1>
    <section class="stack">
      <h2 class="h4">What kind of request?</h2>
      <div class="grid2">${TYPES.map(([v, t, d]) => `<button type="button" class="type-card ${a.type === v ? 'on' : ''}" aria-pressed="${a.type === v}" data-act="askType" data-v="${v}"><span class="b">${t}</span><span class="small muted">${d}</span></button>`).join('')}</div>
    </section>
    <section class="stack-s">
      <label for="ask-title" class="h4">${a.type === 'leave' ? 'Where or what? (optional)' : 'What is it?'}</label>
      ${a.type === 'plan' ? `<a href="#jar" class="b small-link" data-act="jarFromAsk">${icon.heart(18)} Pick something from the ideas jar</a>` : ''}
      ${a.type === 'favour' && favours.length ? `<div class="row-wrap">${favours.map((f) => `<button type="button" class="chip-btn fav-chip" data-act="askFav" data-v="${esc(f)}">${esc(f)}</button>`).join('')}</div>` : ''}
      <input id="ask-title" type="text" data-bind="ask.title" value="${esc(a.title)}" placeholder="For example: ${esc(placeholder)}" autocomplete="off">
    </section>
    ${needsWhen ? `<section class="stack-s">
      <h2 class="h4">When?</h2>
      ${slots.length ? `<span class="small muted">Times you're both free, from both your calendars${settingsOf(state, P).hasShifts || settingsOf(state, state.me).hasShifts ? ' and the rota' : ''}:</span>` : ''}
      ${slots.map((s, i) => `<button type="button" class="slot ${!a.custom && a.slot === i ? 'on' : ''}" aria-pressed="${!a.custom && a.slot === i}" data-act="askSlot" data-i="${i}">${esc(s.label)}</button>`).join('')}
      <button type="button" class="btn link-btn self-start" data-act="askCustom">${slots.length ? 'Choose a different time' : 'Choose a time'}</button>
      ${a.custom || !slots.length ? `<div class="grid3">
        <div class="field"><label for="ask-day">Day</label><input id="ask-day" type="date" data-bind="ask.cday" value="${esc(a.cday || dayKey(addDays(new Date(), 1)))}"></div>
        <div class="field"><label for="ask-start">From</label><input id="ask-start" type="time" data-bind="ask.cstart" value="${esc(a.cstart)}"></div>
        <div class="field"><label for="ask-end">To</label><input id="ask-end" type="time" data-bind="ask.cend" value="${esc(a.cend)}"></div>
      </div>` : ''}
    </section>` : ''}
    ${a.type === 'leave' ? leavePicker(state) : ''}
    ${a.type === 'plan' || a.type === 'free' ? `<div class="card flush">${toggleRow({ act: 'askHold', on: hold, label: 'Pencil it in while I wait', sub: 'Shows in both calendars as "Pencilled in", so nothing else gets booked.' })}</div>` : ''}
    <button type="button" class="btn big-btn" data-act="askSend">${a.type === 'heads' ? 'Send heads up' : `Send to ${esc(pn)}`}</button>`;
}
// The dates of a holiday, and what it takes from each allowance
function leavePicker(state) {
  const a = ui.ask;
  const from = a.lfrom || dayKey(addDays(new Date(), 14));
  const to = a.lto && a.lto >= from ? a.lto : from;
  const rows = [state.me, state.partner].map((pid) => {
    const n = leaveDaysFor(state, pid, from, to);
    const sum = leaveSummary(state, pid);
    return `<div class="row"><span class="grow">${pid === state.me ? 'You' : esc(nameOf(state, pid))}</span><span class="b">${n} day${n === 1 ? '' : 's'}</span><span class="small muted">${esc(String(sum.left - n))} left after</span></div>`;
  }).join('');
  return `<section class="stack-s"><h2 class="h4">When?</h2>
    <div class="grid2"><div class="field"><label for="lv-from">First day off</label><input id="lv-from" type="date" data-bind="ask.lfrom" data-act="askLeaveDate" value="${esc(from)}"></div>
    <div class="field"><label for="lv-to">Last day off</label><input id="lv-to" type="date" data-bind="ask.lto" data-act="askLeaveDate" value="${esc(to)}"></div></div>
    <div class="card stack-s pad">${rows}<span class="small muted">Working days only. Weekends, bank holidays and days you'd be off anyway don't count.</span></div>
  </section>`;
}
export function leaveWhen() {
  const a = ui.ask;
  const from = a.lfrom || dayKey(addDays(new Date(), 14));
  const to = a.lto && a.lto >= from ? a.lto : from;
  const w = { day: from, endDay: to, allDay: true, start: null, end: null };
  w.label = whenLabel(w);
  return w;
}
export function askWhen(state) {
  const a = ui.ask;
  if (a.type === 'heads') return null;
  if (a.type === 'leave') return leaveWhen();
  const slots = a.shown || freeSlots(state, new Date(), 4);
  const s = a.custom ? null : (a.pick || slots[a.slot]);
  if (s) {
    return { day: s.key, start: s.start, end: s.end, allDay: false, label: s.label };
  }
  const day = a.cday || dayKey(addDays(new Date(), 1));
  const w = { day, start: a.cstart || '19:00', end: a.cend || '', allDay: false };
  if (w.end && w.end <= w.start) w.end = '';
  w.label = whenLabel(w);
  return w;
}

// ---------------- ADD ----------------
export function viewAdd(state) {
  const a = ui.add;
  const P = state.partner;
  const me = state.me;
  const meShifts = settingsOf(state, me).hasShifts;
  const paShifts = P && settingsOf(state, P).hasShifts;
  const out = [pageHeader(state, 'Add', '')];
  if (a.done) {
    out.push(`<section class="card stack done-card"><span class="tick">${icon.check(26)}</span><p class="b">${esc(a.done)}</p>
      <div class="row-wrap"><button type="button" class="btn" data-act="addAgain">Add another</button><a href="#calendar" class="btn sec">See the calendar</a></div></section>`);
    return out.join('');
  }
  const kinds = [{ v: 'event', label: 'Event' }, { v: 'job', label: 'Job' }, { v: 'leave', label: 'Holiday' }];
  if (meShifts || paShifts) kinds.push({ v: 'shift', label: 'Shift' });
  out.push(seg(kinds.map((k) => Object.assign(k, { on: a.kind === k.v })), { act: 'addKind', label: 'What are you adding?', cls: 'seg-full kind-seg' }));
  if (a.kind === 'job') { out.push(addJobForm(state)); return out.join(''); }
  if (a.kind === 'leave') { out.push(addLeaveForm(state)); return out.join(''); }
  if (a.kind === 'shift') { out.push(addShiftForm(state)); return out.join(''); }

  // what, who, when
  const whos = [{ v: 'me', label: 'Me' }];
  if (P) { whos.push({ v: 'partner', label: shortName(state, P) }); whos.push({ v: 'both', label: 'Both' }); }
  out.push(`<div class="card flush form-card">
    ${titleRow('add-title', 'add.title', a.title, 'What is it?', 'For example: Dentist')}
    ${P ? fRow('Who', seg(whos.map((w) => Object.assign(w, { on: a.who === w.v })), { act: 'addWho', label: 'Who is it for?' })) : ''}
    ${dayRows(a)}
    <button type="button" class="f-row" aria-pressed="${a.allDay}" data-act="addAllDayT"><span class="b grow">All day</span><span class="switch ${a.allDay ? 'on' : ''}"><span></span></span></button>
    ${a.allDay ? '' : fRow('<label for="add-start">Time</label>', `<input id="add-start" type="time" aria-label="Starts" data-bind="add.start" value="${esc(a.start)}"><span class="muted">to</span><input id="add-end" type="time" aria-label="Ends" data-bind="add.end" value="${esc(a.end)}">`)}
  </div>`);
  if (a.who !== 'me' && P) out.push(`<p class="small muted f-hint">${esc(whoNote(state, a.who))}</p>`);

  // the rest, folded away
  if (a.who !== 'partner') {
    const cals = Object.values(state.calendars).filter((c) => c.owner === me && c.canWrite && c.role !== 'rota');
    const cal = cals.find((c) => c.calKey === a.cal) || cals.find((c) => c.primary) || cals[0];
    const bits = [(EVENT_REPEATS.find(([v]) => v === (a.repeat || '')) || EVENT_REPEATS[0])[1]];
    if (a.who === 'me' && cals.length > 1 && cal) bits.push(cal.name);
    if (a.who === 'me' && P && a.busyOnly) bits.push(`${nameOf(state, P)} sees “Busy”`);
    bits.push(a.remind.length ? remindSummary(a.remind) : 'No reminder');
    const inner = [];
    if (a.more) {
      inner.push(fRow('<label for="add-repeat">Repeats</label>', `<select id="add-repeat" data-bind="add.repeat" data-act="addRerender">${EVENT_REPEATS.map(([v, l]) => `<option value="${v}" ${(a.repeat || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`));
      if (a.who === 'me' && cals.length > 1) inner.push(fRow('<label for="add-cal">Calendar</label>', `<select id="add-cal" data-bind="add.cal" data-act="addRerender">${cals.map((c) => `<option value="${esc(c.calKey)}" ${cal && cal.calKey === c.calKey ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`));
      if (a.who === 'me' && P) inner.push(fRow(`${esc(shortName(state, P))} sees`, seg([{ v: 'all', label: 'Everything', on: !a.busyOnly }, { v: 'busy', label: '“Busy”', on: a.busyOnly }], { act: 'addBusy', label: 'What your partner sees' })));
      const opts = REMIND_OPTIONS.filter((o) => !a.allDay || !o.timedOnly);
      inner.push(`<div class="f-block"><span class="b">Remind me</span>
        <div class="row-wrap">${opts.map((o) => `<button type="button" class="chip-btn ${a.remind.includes(o.v) ? 'on' : ''}" aria-pressed="${a.remind.includes(o.v)}" data-act="addRemind" data-v="${o.v}">${esc(o.label)}</button>`).join('')}</div>
        ${a.remind.length ? `<span class="b pad-top">What do you need to do?</span>
        <div class="row-wrap">${REMIND_NOTES.map((n) => `<button type="button" class="chip-btn ${a.note === n ? 'on' : ''}" aria-pressed="${a.note === n}" data-act="addNotePick" data-v="${esc(n)}">${esc(n)}</button>`).join('')}</div>
        <input id="add-note" type="text" aria-label="Or write your own" data-bind="add.note" value="${esc(REMIND_NOTES.includes(a.note) ? '' : a.note)}" placeholder="Or write your own" autocomplete="off">` : '<span class="small muted">It shows on Today and pops up on your phone.</span>'}
      </div>`);
    }
    out.push(`<div class="card flush form-card">
      <button type="button" class="f-row more-btn" aria-expanded="${!!a.more}" data-act="addMore">${icon.sliders(20)}<span class="grow col"><span class="b">More options</span><span class="small muted">${esc(bits.join(' · '))}</span></span><span class="chev ${a.more ? 'open' : ''}">${icon.next(18)}</span></button>
      ${inner.join('')}
    </div>`);
  }
  const label = a.who === 'me' ? 'Add to my calendar' : a.who === 'both' ? 'Add for both of us' : `Send to ${shortName(state, P)}`;
  out.push(`<div class="save-bar"><button type="button" class="btn big-btn" data-act="addSave">${esc(label)}</button></div>`);
  return out.join('');
}
function fmtHMs(hm) { return fmtTime(atTime('2000-01-01', hm)); }
function fRow(label, ctl) { return `<div class="f-row"><span class="f-label">${label}</span><div class="f-ctl">${ctl}</div></div>`; }
function titleRow(id, bind, value, label, placeholder) {
  return `<div class="f-title"><label for="${id}" class="sr">${esc(label)}</label><input id="${id}" class="title-input" type="text" data-bind="${bind}" value="${esc(value)}" placeholder="${esc(label)}" autocomplete="off" enterkeyhint="done"></div>`;
}
function dayRows(a) {
  const opts = [{ v: 'today', label: 'Today' }, { v: 'tomorrow', label: 'Tomorrow' }, { v: 'pick', label: 'Pick' }];
  return fRow('Day', seg(opts.map((o) => Object.assign(o, { on: a.day === o.v })), { act: 'addDay', label: 'Which day' }))
    + (a.day === 'pick' ? fRow('<label for="add-date">Date</label>', `<input id="add-date" type="date" data-bind="add.date" value="${esc(a.date || dayKey(new Date()))}">`) : '');
}
function addJobForm(state) {
  const a = ui.add;
  const P = state.partner;
  const whos = [['me', 'Me'], ...(P ? [['partner', shortName(state, P)], ['both', 'Together']] : [])];
  return `<div class="card flush form-card">
      ${titleRow('job-title', 'add.title', a.title, 'What needs doing?', 'Food shop')}
      ${fRow('Who', seg(whos.map(([v, l]) => ({ v, label: l, on: (a.jobWho || 'me') === v })), { act: 'addJobWho', label: 'Who is doing it' }))}
      ${dayRows(a)}
      ${fRow('<label for="job-time">Time</label>', `<input id="job-time" type="time" data-bind="add.start" value="${esc(a.start)}">`)}
      ${fRow('<label for="job-repeat">Repeats</label>', `<select id="job-repeat" data-bind="add.jobRepeat">${JOB_REPEATS.map((o) => `<option value="${o.v}" ${(a.jobRepeat || '') === o.v ? 'selected' : ''}>${o.label}</option>`).join('')}</select>`)}
    </div>
    <p class="small muted f-hint">${(a.jobWho || 'me') === 'both' ? 'One you do together, like the food shop. You both get the reminder on the day.' : 'It shows on Today, with a reminder on the day. The time is optional.'}</p>
    <div class="save-bar"><button type="button" class="btn big-btn" data-act="addJobSave">Add the job</button></div>`;
}
function addLeaveForm(state) {
  const a = ui.add;
  const from = a.lfrom || dayKey(addDays(new Date(), 14));
  const to = a.lto && a.lto >= from ? a.lto : from;
  const n = leaveDaysFor(state, state.me, from, to);
  const sum = leaveSummary(state, state.me);
  return `<div class="card flush form-card">
      ${titleRow('lv-title', 'add.title', a.title, 'Where or what? (optional)', '')}
      ${fRow('<label for="al-from">First day</label>', `<input id="al-from" type="date" data-bind="add.lfrom" data-act="addLeaveDate" value="${esc(from)}">`)}
      ${fRow('<label for="al-to">Last day</label>', `<input id="al-to" type="date" data-bind="add.lto" data-act="addLeaveDate" value="${esc(to)}">`)}
      ${fRow('Uses', `<span class="b">${n} day${n === 1 ? '' : 's'}</span><span class="small muted">${sum.left - n} left after</span>`)}
    </div>
    <p class="small muted f-hint">Just for you. To book time off together, ask ${esc(nameOf(state, state.partner) || 'your partner')} from Requests.</p>
    <div class="save-bar"><button type="button" class="btn big-btn" data-act="addLeaveSave">Book it</button></div>`;
}
function addShiftForm(state) {
  const a = ui.add;
  const me = state.me; const P = state.partner;
  const who = a.shiftWho || (settingsOf(state, me).hasShifts ? me : P);
  const types = settingsOf(state, who).shiftTypes;
  const options = [me, P].filter((x) => x && settingsOf(state, x).hasShifts);
  return `<div class="card flush form-card">
      ${options.length > 1 ? fRow('Whose', seg(options.map((x) => ({ v: x, label: x === me ? 'Mine' : shortName(state, x), on: who === x })), { act: 'addShiftWho', label: 'Whose shift' })) : ''}
      ${dayRows(a)}
      <div class="f-block"><span class="b">Which shift?</span>
      <div class="grid2">${SHIFT_ORDER.map((t) => {
        const def = types[t] || {};
        return `<button type="button" class="type-card ${a.shiftType === t ? 'on' : ''}" aria-pressed="${a.shiftType === t}" data-act="addShiftType" data-v="${t}"><span class="b">${esc(def.label)}</span><span class="small muted">${def.allDay ? (t === 'off' ? 'Not working' : 'Annual leave') : esc(`${fmtHMs(def.start)} to ${fmtHMs(def.end)}`)}</span></button>`;
      }).join('')}</div></div>
    </div>
    <p class="small muted f-hint">${who === me ? 'Your shifts' : `${esc(nameOf(state, who))}'s shifts`}. A change here wins over the rota for that day.</p>
    <div class="save-bar"><button type="button" class="btn big-btn" data-act="addShiftSave">Save shift</button></div>`;
}
function whoNote(state, who) {
  const P = state.partner;
  if (who === 'me') return 'Saves to your Google Calendar.';
  if (who === 'both') return `Goes in both your Google Calendars. ${nameOf(state, P)} gets a notification.`;
  return `${nameOf(state, P)}'s calendar is theirs, so this goes to them as a request. It's added when they say yes.`;
}
export function addDayKey() {
  const a = ui.add;
  if (a.day === 'today') return dayKey(new Date());
  if (a.day === 'tomorrow') return dayKey(addDays(new Date(), 1));
  return a.date || dayKey(new Date());
}
