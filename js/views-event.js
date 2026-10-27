// One event: what it is, and the reminder you want for it.
import { esc, fmtDate, fromDayKey, dayKey, fmtTime, fmtRange, hhmm, addDays } from './util.js';
import {
  dayList, itemTime, itemTitle, itemSub, nameOf, settingsOf, reminderFor, fireTimes, evRef, calOf, reminderId,
  REMIND_OPTIONS, REMIND_NOTES, isBirthday, isLowCal
} from './logic.js';
import { icon, whoChip, seg } from './ui.js';
import { ui } from './uistate.js';

// The thing that was tapped, as shown on that day, plus the calendar event behind it.
export function findEvent(state, ref, day) {
  const it = day ? dayList(state, day).find((x) => x.ref === ref) : null;
  const evs = state.events.filter((e) => evRef(e) === ref);
  // every occurrence of something repeating has the same ref: the one behind the row that was tapped, then the one
  // starting that day, then one still running that day (the morning after something overnight)
  const onDay = (e) => !!day && e.start < addDays(fromDayKey(day), 1) && e.end > fromDayKey(day);
  const ev = (it && it.src && evs.includes(it.src) ? it.src : null)
    || evs.find((e) => dayKey(e.allDay ? fromDayKey(e.startKey || dayKey(e.start)) : e.start) === day)
    || evs.find(onDay) || evs[0] || null;
  return { it, ev };
}

export function viewEvent(state) {
  const { ref, day } = ui.ev;
  const back = `<button type="button" class="back-link" data-act="evBack">${icon.back(20)}Back</button>`;
  if (!ref) return `${back}<p class="muted">Nothing chosen.</p>`;
  const { it, ev } = findEvent(state, ref, day);
  const item = it || (ev ? { kind: 'event', who: ev.owner, title: ev.title, start: ev.start, end: ev.end, allDay: ev.allDay, ref, owner: ev.owner } : null);
  if (!item) return `${back}<h1 class="h1">Not found</h1><p class="muted">This may have been moved or deleted in Google Calendar.</p>`;
  const base = ev || item;
  const owner = item.owner || base.owner || state.me;
  const rem = reminderFor(state, ref, Object.assign({}, base, { owner }));
  const times = (rem && rem.times) || [];
  const s = settingsOf(state, state.me);
  const date = fromDayKey(day || dayKey(item.start));
  const sub = itemSub(state, item);
  const timed = !item.allDay;
  const opts = REMIND_OPTIONS.filter((o) => timed || !o.timedOnly);
  const note = ui.ev.noteDraft ?? (rem && rem.note) ?? '';

  // when the phone gets it
  let whenText = 'Pick when you want a reminder.';
  if (times.length && ev) {
    const fires = fireTimes(times, ev, s.remindAt).filter((f) => f.at > new Date());
    whenText = fires.length
      ? `Your phone gets ${fires.length === 1 ? 'a notification' : 'notifications'} ${fires.map((f) => `on ${fmtDate(f.at).replace(/ \d{4}$/, '')} at ${fmtTime(f.at)}`).join(', and ')}.`
      : 'The reminder times for this one have passed.';
  } else if (times.length) {
    whenText = 'It saves to Google Calendar first. The reminder starts working once it has synced.';
  }
  const partnerSync = owner !== state.me && !Object.values(state.status || {}).some((x) => x.person === owner);
  const src = ev || item.src || null;
  const cal = src ? calOf(state, src) : {};
  // someone else's event you only see as "Busy": no reminders (it would show the private name)
  const canRemind = owner === state.me || (cal.share === 'all' && !(src && src.busy) && !item.busyOnly);
  const out = [];
  out.push(back);
  out.push(`<h1 class="h1">${esc(itemTitle(state, item))}</h1>`);
  const location = (src && src.location) || item.location || '';
  out.push(`<div class="card stack-s pad">
    <div class="row">${icon.clock(22)}<span class="grow b">${esc(fmtDate(date))}, ${esc(item.allDay ? 'all day' : whenOn(item, day || dayKey(item.start)))}</span></div>
    <div class="row-wrap">${whoChip(state, item.who)}${item.calName ? `<span class="small muted">${esc(item.calName)}</span>` : ''}</div>
    ${location ? `<div class="row small-gap">${icon.home(20)}<span class="grow">${esc(location)}</span><a class="btn sec sm" href="https://www.google.com/maps/search/?api=1&amp;query=${encodeURIComponent(location)}" target="_blank" rel="noopener">Directions</a></div>` : ''}
    ${sub && sub !== location ? `<p class="small muted">${esc(sub)}</p>` : ''}
    ${base.sid || item.repeats ? '<p class="small">This repeats, so the reminder repeats too.</p>' : ''}
    ${pendingFor(state, src) ? '<p class="small note-box">Saving your change to Google Calendar. It shows here within a few minutes.</p>' : ''}
  </div>`);
  out.push(changeBlock(state, item, src, cal));
  const pri = priorityLink(state, src);
  if (!canRemind) {
    out.push(`<p class="small note-box">${esc(nameOf(state, owner))} shares this as “Busy”, so you can't set a reminder on it.</p>`);
    out.push(countdownBlock(state, ref, item, date));
    out.push(pri);
    return `<div class="stack-l">${out.join('')}</div>`;
  }
  out.push(`<section class="stack-s"><h2 class="h4">Remind me</h2>
    <div class="row-wrap">${opts.map((o) => `<button type="button" class="chip-btn ${times.includes(o.v) ? 'on' : ''}" aria-pressed="${times.includes(o.v)}" data-act="evTime" data-v="${o.v}">${esc(o.label)}</button>`).join('')}</div>
    <p class="small muted">${esc(whenText)}</p>
    ${rem && rem.auto ? `<p class="small note-box">This has a reminder because it's a birthday. You can change birthday reminders in <a href="#settings/notifications">Settings, Notifications</a>.</p>` : ''}
    ${partnerSync ? `<p class="small note-box">This is in ${esc(nameOf(state, owner))}'s calendar, so ${esc(nameOf(state, owner))}'s calendar sync sends the reminder. It starts once ${esc(nameOf(state, owner))} has connected Google Calendar.</p>` : ''}
  </section>`);
  if (times.length) {
    out.push(`<section class="stack-s"><h2 class="h4">What do you need to do?</h2>
      <div class="row-wrap">${REMIND_NOTES.map((n) => `<button type="button" class="chip-btn ${note === n ? 'on' : ''}" aria-pressed="${note === n}" data-act="evNotePick" data-v="${esc(n)}">${esc(n)}</button>`).join('')}</div>
      <div class="field"><label for="ev-note">Or write your own</label><input id="ev-note" type="text" data-bind="ev.noteDraft" data-act="evNote" value="${esc(REMIND_NOTES.includes(note) ? '' : note)}" placeholder="For example: Order flowers" autocomplete="off"></div>
      <p class="small muted">This shows on Today and in the notification.</p>
    </section>`);
    if (!(rem && rem.auto)) out.push(`<button type="button" class="btn sec self-start" data-act="evRemOff">No reminder for this</button>`);
  }
  out.push(countdownBlock(state, ref, item, date));
  out.push(pri);
  if (!hasPush()) out.push(`<p class="small note-box">Notifications are off on this phone. <a href="#settings/notifications">Turn them on</a> to get reminders on your phone. They always show on Today.</p>`);
  if (isBirthday(base) && !(s.autoRemind.birthdays || []).length) out.push(`<p class="small muted">Tip: you can have a reminder for every birthday, in <a href="#settings/notifications">Settings, Notifications</a>.</p>`);
  return `<div class="stack-l">${out.join('')}</div>`;
}
// the whole time, start and end ("4:30pm to 5:15pm"), unless it runs into another day
function whenOn(item, key) {
  if (dayKey(item.start) === key && dayKey(new Date(item.end.getTime() - 1)) === key) return fmtRange(item.start, item.end);
  return itemTime(item, key);
}
// Keep this event's whole calendar off Today and the week (or bring it back)
function priorityLink(state, src) {
  if (!src || !src.calKey || src.tag) return '';
  const cid = `${src.owner}__${src.calKey}`;
  const c = state.calendars[cid];
  if (!c || (c.primary && c.owner === state.me)) return '';
  const low = isLowCal(state, cid);
  return `<button type="button" class="btn link-btn self-start" data-act="calPriority" data-k="${esc(cid)}" data-v="${low ? 'normal' : 'low'}">${low ? `Make “${esc(c.name)}” normal priority` : `Make “${esc(c.name)}” low priority`}</button>`;
}
// Things made in this app, or your own events in a calendar you can edit
export function canChange(state, src, cal) {
  if (!src) return false;
  if (src.tag) {
    if (src.owner === state.me || src.tag.startsWith('both:')) return true;
    // a request between you, but not a holiday your partner booked just for themselves
    const r = src.tag.startsWith('req:') && state.requests.find((x) => `req:${x.id}` === src.tag);
    return !!r && !r.own && !(r.people && r.people.length === 1);
  }
  return src.owner === state.me && !!src.gid && cal.canWrite !== false && cal.role !== 'rota';
}
function pendingFor(state, src) {
  if (!src) return false;
  return state.outbox.some((o) => !o.done && ((src.tag && o.tag === src.tag && (o.op === 'update' || o.op === 'delete')) || (src.gid && o.gid === src.gid)));
}
function changeBlock(state, item, src, cal) {
  if (!canChange(state, src, cal)) return '';
  const e = ui.ev;
  // (your partner's copy of something you share says it repeats, without Google's ids)
  const recurring = !!(src.rid || src.sid);
  if (e.confirmDelete) {
    return `<section class="card stack-s pad warn-card"><span class="b">Delete “${esc(src.title)}”?</span>
      ${src.tag && (src.tag.startsWith('both:') || src.tag.startsWith('req:')) ? `<span class="small">It comes out of both your calendars, and ${esc(nameOf(state, state.partner))} gets a notification.</span>` : '<span class="small">It comes out of your Google Calendar.</span>'}
      ${recurring ? seg([{ v: 'one', label: 'Just this one', on: e.scope !== 'all' }, { v: 'all', label: 'Every time', on: e.scope === 'all' }], { act: 'evScope', label: 'Which ones', cls: 'seg-full' }) : ''}
      <div class="row-wrap"><button type="button" class="btn danger-btn" data-act="evDelete">Yes, delete</button><button type="button" class="btn sec" data-act="evDeleteCancel">Keep it</button></div></section>`;
  }
  if (!e.editing) {
    return `<div class="row-wrap"><button type="button" class="btn sec" data-act="evEdit">Change</button><button type="button" class="btn link-btn" data-act="evDeleteAsk">Delete</button></div>`;
  }
  const d = e.draft || {};
  const titleOnly = recurring && e.scope === 'all';
  return `<section class="card stack-s pad"><h2 class="h4">Change it</h2>
    ${recurring ? seg([{ v: 'one', label: 'Just this one', on: e.scope !== 'all' }, { v: 'all', label: 'Every time', on: e.scope === 'all' }], { act: 'evScope', label: 'Which ones', cls: 'seg-full' }) : ''}
    <div class="field"><label for="ed-title">Name</label><input id="ed-title" type="text" data-bind="ev.draft.title" value="${esc(d.title ?? src.title)}"></div>
    ${titleOnly ? '<p class="small muted">For every time, only the name can be changed here. Change times one at a time.</p>' : `
    <div class="field"><label for="ed-day">Date</label><input id="ed-day" type="date" data-bind="ev.draft.day" value="${esc(d.day ?? (src.allDay ? (src.startKey || dayKey(src.start)) : dayKey(src.start)))}"></div>
    ${src.allDay ? '' : `<div class="grid2"><div class="field"><label for="ed-start">Starts</label><input id="ed-start" type="time" data-bind="ev.draft.start" value="${esc(d.start ?? hhmm(src.start))}"></div>
    <div class="field"><label for="ed-end">Ends</label><input id="ed-end" type="time" data-bind="ev.draft.end" value="${esc(d.end ?? hhmm(src.end))}"></div></div>`}`}
    <div class="row-wrap"><button type="button" class="btn" data-act="evSave">Save the change</button><button type="button" class="btn sec" data-act="evEditCancel">Cancel</button></div></section>`;
}
// count down to it on Today, for both of you
function countdownBlock(state, ref, item, date) {
  if (date < new Date(new Date().toDateString())) return '';
  const id = reminderId(ref);
  const has = !!(((state.people[state.me] || {}).countdowns || {})[id]);
  return `<button type="button" class="btn ${has ? 'sec' : 'link-btn'} self-start" data-act="evCountdown" data-v="${has ? 'off' : 'on'}">${has ? 'Stop the countdown' : 'Count down to this on Today'}</button>`;
}
function hasPush() { try { return localStorage.getItem('caledonite.push') === '1' && Notification.permission === 'granted'; } catch (e) { return false; } }
