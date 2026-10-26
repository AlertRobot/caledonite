// One event: what it is, and the reminder you want for it.
import { esc, fmtDate, fromDayKey, dayKey, fmtTime } from './util.js';
import {
  dayList, itemTime, itemTitle, itemSub, nameOf, settingsOf, reminderFor, fireTimes, evRef,
  REMIND_OPTIONS, REMIND_NOTES, isBirthday
} from './logic.js';
import { icon, whoChip } from './ui.js';
import { ui } from './uistate.js';

// The thing that was tapped, as shown on that day, plus the calendar event behind it.
export function findEvent(state, ref, day) {
  const it = day ? dayList(state, day).find((x) => x.ref === ref) : null;
  const evs = state.events.filter((e) => evRef(e) === ref);
  const ev = evs.find((e) => dayKey(e.allDay ? fromDayKey(e.startKey || dayKey(e.start)) : e.start) === day) || evs[0] || null;
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
  const out = [];
  out.push(back);
  out.push(`<h1 class="h1">${esc(itemTitle(state, item))}</h1>`);
  out.push(`<div class="card stack-s pad">
    <div class="row">${icon.clock(22)}<span class="grow b">${esc(fmtDate(date))}, ${esc(item.allDay ? 'all day' : itemTime(item, day || dayKey(item.start)).replace(/^All day$/, 'all day'))}</span></div>
    <div class="row-wrap">${whoChip(state, item.who)}${item.calName ? `<span class="small muted">${esc(item.calName)}</span>` : ''}</div>
    ${sub ? `<p class="small muted">${esc(sub)}</p>` : ''}
    ${base.sid || item.repeats ? '<p class="small">This repeats, so the reminder repeats too.</p>' : ''}
  </div>`);
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
  if (!hasPush()) out.push(`<p class="small note-box">Notifications are off on this phone. <a href="#settings/notifications">Turn them on</a> to get reminders on your phone. They always show on Today.</p>`);
  if (isBirthday(base) && !(s.autoRemind.birthdays || []).length) out.push(`<p class="small muted">Tip: you can have a reminder for every birthday, in <a href="#settings/notifications">Settings, Notifications</a>.</p>`);
  return `<div class="stack-l">${out.join('')}</div>`;
}
function hasPush() { try { return localStorage.getItem('caledonite.push') === '1' && Notification.permission === 'granted'; } catch (e) { return false; } }
