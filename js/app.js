// Caledonite: start-up, screens, taps and typing.
import { store, actions, setPhase, setLinked } from './store.js';
import { ui, resetAsk, resetAdd } from './uistate.js';
import { viewToday, viewCalendar, waitingForMe, rotateCountdown } from './views-main.js';
import { viewRequests, viewAsk, viewAdd, askWhen, addDayKey, leaveWhen } from './views-requests.js';
import { viewSettings, viewSignedOut, viewSetup, viewNotMember, viewLoading } from './views-settings.js';
import { viewEvent, findEvent } from './views-event.js';
import { viewJobs, viewJar, STARTER_IDEAS, pickIdea, jarBudget } from './views-extra.js';
import { loadLinked, parseBudgieLink, setBudgieLink, unlinkBudgie } from './linked.js';
import { applyLook, setLook } from './theme.js';
import { FIREBASE, APP } from './config.js';
import { icon } from './ui.js';
import { dayKey, addDays, fromDayKey, mondayOf, esc, minutesOf, pad } from './util.js';
import { freeSlots, settingsOf, shiftFor, SHIFT_ORDER, nameOf, reminderFor, reminderId, quietNight, repeatOf, leaveDaysFor, nextBothFree } from './logic.js';
import { whenLabel } from './store.js';

const root = document.getElementById('app');
let pendingRender = false;
let lastRoute = '';

function route() {
  const h = (location.hash || '#today').slice(1);
  const [r, sub] = h.split('/');
  return { r: r || 'today', sub: sub || '' };
}
function isEditing() {
  const a = document.activeElement;
  return a && root.contains(a) && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes(a.type)));
}

function navBar(state, r) {
  const n = waitingForMe(state).length;
  const tab = (href, key, label, ic, extra = '') => {
    const on = r === key || (key === 'requests' && r === 'ask') || (key === 'today' && (r === 'jobs' || r === 'jar')) || (r === 'event' && ui.ev.back && ui.ev.back.startsWith('#' + key));
    return `<a href="#${href}" class="nav-item ${on ? 'on' : ''}" ${on ? 'aria-current="page"' : ''}><span class="nav-ic">${ic}${extra}</span>${label}</a>`;
  };
  return `<nav class="bottom-nav" aria-label="Main">
    ${tab('today', 'today', 'Today', icon.today(22))}
    ${tab('calendar', 'calendar', 'Calendar', icon.calendar(22))}
    ${tab('requests', 'requests', 'Requests', icon.requests(22), n ? `<span class="badge">${n}</span>` : '')}
    ${tab('add', 'add', 'Add', icon.add(22))}
  </nav>`;
}

export function render() {
  if (isEditing()) { pendingRender = true; return; }
  pendingRender = false;
  const st = store.state;
  let html = '';
  let nav = false;
  const { r, sub } = route();
  if (st.phase === 'loading') html = viewLoading();
  else if (st.phase === 'signed-out') html = viewSignedOut();
  else if (st.phase === 'setup') html = viewSetup(st);
  else if (st.phase === 'ready' && !st.me && !Object.keys(st.people).length) html = viewLoading();
  else if (st.phase === 'not-member' || !st.me) html = viewNotMember(st);
  else {
    nav = true;
    if (r === 'settings') ui.settings.page = sub || 'home';
    const view = { today: viewToday, calendar: viewCalendar, requests: viewRequests, ask: viewAsk, add: viewAdd, settings: viewSettings, event: viewEvent, jobs: viewJobs, jar: viewJar }[r] || viewToday;
    try { html = view(st); } catch (e) {
      console.error(e);
      html = `<div class="welcome"><h1 class="h2">Something went wrong</h1><p class="muted">${esc(e && e.message)}</p><a class="btn" href="#today">Back to Today</a></div>`;
    }
  }
  const key = `${st.phase}|${r}|${sub}`;
  const keepScroll = key === lastRoute;
  const y = window.scrollY;
  root.innerHTML = `<main class="page ${nav ? 'has-nav' : ''} ${st.demo ? 'is-demo' : ''}">${st.demo ? '<div class="demo-bar">Demo with made-up data. <a href="./">Leave</a></div>' : ''}${html}</main>${nav ? navBar(st, r) : ''}${ui.toast ? `<div class="toast" role="status">${esc(ui.toast)}</div>` : ''}`;
  if (keepScroll) window.scrollTo(0, y);
  lastRoute = key;
  if (ui.focus) { const el = document.getElementById(ui.focus); if (el) el.focus(); ui.focus = null; }
}

function toast(text) {
  ui.toast = text;
  render();
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { ui.toast = null; render(); }, 2600);
}
function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}
function hhmmOf(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
// the next Monday (1) ... Sunday (7), counting today
function nextWeekday(iso) {
  for (let i = 0; i < 7; i++) { const d = addDays(new Date(), i); if ((d.getDay() || 7) === iso) return dayKey(d); }
  return dayKey(new Date());
}
function plusMins(hm, mins) {
  const t = Math.min(23 * 60 + 59, minutesOf(hm) + mins);
  return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
}
async function run(p, okText) {
  try { await p; if (okText) toast(okText); } catch (e) { console.error(e); toast('That didn’t save. Check your connection and try again.'); }
}

// ---------- taps ----------
const H = {
  todayFilter: (el) => { ui.todayFilter = el.dataset.v; render(); },
  noteOpen: () => { ui.noteOpen = true; ui.focus = 'note'; render(); },
  noteCancel: () => { ui.noteOpen = false; ui.noteText = ''; render(); },
  saveNote: () => {
    if (!ui.noteText.trim()) return toast('Write a note first.');
    const t = ui.noteText; ui.noteOpen = false; ui.noteText = '';
    run(actions.saveNote(t), 'Note saved.');
  },
  noteSeen: (el) => run(actions.noteSeen(el.dataset.id)),
  askFrom: (el) => {
    resetAsk();
    ui.ask.custom = true; ui.ask.cday = el.dataset.day; ui.ask.cstart = el.dataset.start || '19:00'; ui.ask.cend = plusMins(ui.ask.cstart, 120);
    const slots = freeSlots(store.state, new Date(), 4);
    const i = slots.findIndex((s) => s.key === el.dataset.day && s.start === ui.ask.cstart);
    if (i >= 0) { ui.ask.custom = false; ui.ask.slot = i; ui.ask.pick = slots[i]; }
  },
  calGo: (el) => {
    const d = fromDayKey(el.dataset.day);
    if (el.dataset.v === 'week') { ui.calView = 'week'; ui.weekStart = mondayOf(d); ui.weekOpen = el.dataset.day; return; }
    ui.calView = 'month'; ui.calSel = el.dataset.day; ui.calMonth = new Date(d.getFullYear(), d.getMonth(), 1);
  },
  calView: (el) => { ui.calView = el.dataset.v; render(); },
  layerToggle: (el) => { ui.layerOff[el.dataset.k] = !ui.layerOff[el.dataset.k]; render(); },
  monthPrev: () => { ui.calMonth = new Date(ui.calMonth.getFullYear(), ui.calMonth.getMonth() - 1, 1); render(); },
  monthNext: () => { ui.calMonth = new Date(ui.calMonth.getFullYear(), ui.calMonth.getMonth() + 1, 1); render(); },
  calSel: (el) => { ui.calSel = el.dataset.day; render(); },
  weekOpen: (el) => { ui.weekOpen = ui.weekOpen === el.dataset.day ? null : el.dataset.day; render(); },
  weekPrev: () => { ui.weekStart = addDays(ui.weekStart, -7); render(); },
  weekNext: () => { ui.weekStart = addDays(ui.weekStart, 7); render(); },
  weekToday: () => { ui.weekStart = mondayOf(new Date()); ui.weekOpen = dayKey(new Date()); render(); },
  addFor: (el) => { resetAdd(); ui.add.kind = 'event'; ui.add.day = 'pick'; ui.add.date = el.dataset.day; },
  reqTab: (el) => { ui.reqTab = el.dataset.v; render(); },
  // ----- one event, and its reminder -----
  openEv: (el) => {
    const h = location.hash || '#today';
    ui.ev = { ref: el.dataset.ref, day: el.dataset.day, back: h.startsWith('#event') ? ui.ev.back : h, noteDraft: null };
    go('#event');
  },
  evBack: () => go(ui.ev.back || '#today'),
  evTime: (el) => {
    const st = store.state;
    const { it, ev } = findEvent(st, ui.ev.ref, ui.ev.day);
    const base = ev || it;
    if (!base) return;
    const owner = (it && it.owner) || base.owner || st.me;
    const rem = reminderFor(st, ui.ev.ref, Object.assign({}, base, { owner }));
    const cur = (rem && rem.times) || [];
    const v = el.dataset.v;
    const times = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
    run(actions.setReminder({ ref: ui.ev.ref, owner, title: (it && it.title) || base.title, times, note: rem ? rem.note : '' }));
  },
  evNotePick: (el) => {
    const st = store.state;
    const { it, ev } = findEvent(st, ui.ev.ref, ui.ev.day);
    const base = ev || it;
    if (!base) return;
    const owner = (it && it.owner) || base.owner || st.me;
    const rem = reminderFor(st, ui.ev.ref, Object.assign({}, base, { owner }));
    const note = rem && rem.note === el.dataset.v ? '' : el.dataset.v;
    ui.ev.noteDraft = null;
    run(actions.setReminder({ ref: ui.ev.ref, owner, title: (it && it.title) || base.title, times: rem ? rem.times : [], note }));
  },
  evRemOff: () => {
    const st = store.state;
    const { it, ev } = findEvent(st, ui.ev.ref, ui.ev.day);
    const base = ev || it;
    const owner = (it && it.owner) || (base && base.owner) || st.me;
    // keep an empty one, so an automatic birthday reminder stays off too
    run(actions.setReminder({ ref: ui.ev.ref, owner, title: base ? base.title : '', times: [], note: '' }), 'Reminder turned off.');
  },
  remDone: (el) => run(actions.reminderDone(el.dataset.ref, el.dataset.occ, el.dataset.title), 'Ticked off.'),
  testPush: async () => {
    ui.pushMsg = 'Sending a test. It should arrive within a minute.'; render();
    try { await actions.testPush(); } catch (e) { console.error(e); ui.pushMsg = 'That didn’t send. Try again in a moment.'; render(); }
  },
  autoBday: (el) => {
    const s = settingsOf(store.state, store.state.me);
    const cur = s.autoRemind.birthdays || [];
    const v = el.dataset.v;
    run(actions.updateMySettings({ autoRemind: Object.assign({}, s.autoRemind, { birthdays: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] }) }));
  },
  addRemind: (el) => { const v = el.dataset.v; ui.add.remind = ui.add.remind.includes(v) ? ui.add.remind.filter((x) => x !== v) : [...ui.add.remind, v]; render(); },
  addNotePick: (el) => { ui.add.note = ui.add.note === el.dataset.v ? '' : el.dataset.v; render(); },
  // ----- quiet hours, summaries, countdowns, holidays -----
  quietTonight: (el) => {
    const s = settingsOf(store.state, store.state.me);
    const skip = el.dataset.v === 'off' ? quietNight(s, new Date()) : null;
    run(actions.updateMySettings({ quiet: Object.assign({}, s.quiet, { skip }) }), skip ? 'No quiet hours tonight.' : 'Quiet hours are back on tonight.');
  },
  quietToggle: () => { const s = settingsOf(store.state, store.state.me); run(actions.updateMySettings({ quiet: Object.assign({}, s.quiet, { on: !s.quiet.on, skip: null }) })); },
  summaryToggle: (el) => { const s = settingsOf(store.state, store.state.me); const f = el.dataset.f; run(actions.updateMySettings({ [f]: Object.assign({}, s[f], { on: !s[f].on }) })); },
  myToggle: (el) => { const s = settingsOf(store.state, store.state.me); const f = el.dataset.f; run(actions.updateMySettings({ [f]: s[f] === false })); },
  leaveToggle: () => { const s = settingsOf(store.state, store.state.me); run(actions.updateMySettings({ leave: Object.assign({}, s.leave, { bankHolsCount: !s.leave.bankHolsCount }) })); },
  linkedReload: async () => { setLinked(await loadLinked()); toast('Checked.'); },
  budgieLink: async () => {
    const cfg = parseBudgieLink(ui.settings.budgieDraft);
    if (!cfg) return toast('That doesn\u2019t look like a Budgie link. Make one in Budgie: Settings, then Linked apps.');
    setBudgieLink(cfg); ui.settings.budgieDraft = '';
    const L = await loadLinked(); setLinked(L);
    toast(L.budgie && L.budgie.found && !L.budgie.error ? 'Budgie linked.' : (L.budgie && L.budgie.error) || 'Linked.');
  },
  budgieUnlink: async () => { unlinkBudgie(); setLinked(await loadLinked()); toast('Budgie unlinked.'); },
  // ----- jobs -----
  addJobNew: () => { resetAdd(); ui.add.kind = 'job'; },
  addJobWho: (el) => { ui.add.jobWho = el.dataset.v; render(); },
  addJobSave: async () => {
    const a = ui.add; const st = store.state;
    if (!a.title.trim()) { ui.focus = 'job-title'; return toast('Add what needs doing first.'); }
    const who = a.jobWho === 'both' ? 'both' : a.jobWho === 'partner' ? st.partner : st.me;
    const day = addDayKey();
    try {
      await actions.addJob({ title: a.title, who, day, time: a.start || null, repeat: repeatOf(a.jobRepeat) });
      ui.add.done = `Job added: ${a.title.trim()}, ${whenLabel({ day, allDay: true }).replace(', all day', '')}.`;
      render();
    } catch (e) { console.error(e); toast('That didn’t save. Check your connection and try again.'); }
  },
  jobDone: (el) => {
    const j = store.state.jobs.find((x) => x.id === el.dataset.id);
    if (!j) return;
    if (j.done) return run(actions.updateJob(j.id, { done: false }));
    run(actions.jobDone(j), j.repeat ? 'Done. See you next time.' : 'Done.');
  },
  jobDelete: (el) => run(actions.deleteJob(el.dataset.id), 'Job removed.'),
  // ----- holidays -----
  addLeaveSave: async () => {
    const st = store.state; const a = ui.add;
    const from = a.lfrom || dayKey(addDays(new Date(), 14));
    const to = a.lto && a.lto >= from ? a.lto : from;
    const when = { day: from, endDay: to, allDay: true };
    when.label = whenLabel(when);
    try {
      await actions.bookOwnLeave({ title: a.title, when, days: { [st.me]: leaveDaysFor(st, st.me, from, to) } });
      ui.add.done = `Booked: ${a.title.trim() || 'Holiday'} (${when.label}). It goes in your calendar within a few minutes.`;
      render();
    } catch (e) { console.error(e); toast('That didn’t save. Check your connection and try again.'); }
  },
  // ----- ideas jar -----
  jarSeed: () => run(actions.seedIdeas(STARTER_IDEAS), 'The jar is full.'),
  jarFilter: (el) => { ui.jar.filter = el.dataset.v; ui.jar.pick = null; render(); },
  jarPick: () => {
    const st = store.state;
    const fun = jarBudget(st);
    const idea = pickIdea(st, fun ? Math.floor(fun.left) : null, ui.jar.filter);
    ui.jar.pickNone = !idea;
    ui.jar.pick = idea ? idea.id : null;
    render();
  },
  jarPlan: (el) => {
    const idea = store.state.ideas.find((i) => i.id === el.dataset.id);
    resetAsk();
    ui.ask.type = 'plan';
    ui.ask.title = idea ? idea.title : '';
    const nf = nextBothFree(store.state, new Date());
    if (nf) {
      const slots = freeSlots(store.state, new Date(), 4);
      const i = slots.findIndex((x) => x.key === nf.key);
      if (i >= 0) { ui.ask.slot = i; ui.ask.pick = slots[i]; }
    }
    if (idea) run(actions.updateIdea(idea.id, { used: (idea.used || 0) + 1, lastUsed: Date.now() }));
  },
  jarFromAsk: () => { ui.jar.pick = null; },
  jarAdd: () => {
    const d = ui.jar.draft;
    if (!d.title.trim()) { ui.focus = 'idea-title'; return toast('Write the idea first.'); }
    ui.jar.draft = { title: '', cost: '', where: d.where };
    run(actions.addIdea(d), 'Added to the jar.');
  },
  jarRemove: (el) => run(actions.deleteIdea(el.dataset.id)),
  // ----- changing or deleting an event -----
  evEdit: () => { ui.ev.editing = true; ui.ev.confirmDelete = false; ui.ev.draft = {}; ui.ev.scope = 'one'; render(); },
  evEditCancel: () => { ui.ev.editing = false; ui.ev.draft = null; render(); },
  evScope: (el) => { ui.ev.scope = el.dataset.v; render(); },
  evDeleteAsk: () => { ui.ev.confirmDelete = true; ui.ev.editing = false; ui.ev.scope = 'one'; render(); },
  evDeleteCancel: () => { ui.ev.confirmDelete = false; render(); },
  evSave: async () => {
    const st = store.state;
    const { it, ev } = findEvent(st, ui.ev.ref, ui.ev.day);
    const src = ev || (it && it.src);
    if (!src) return;
    const d = ui.ev.draft || {};
    const changes = {};
    if (d.title !== undefined && d.title.trim() && d.title.trim() !== src.title) changes.title = d.title.trim();
    if (ui.ev.scope !== 'all') {
      if (d.day) changes.day = d.day;
      if (!src.allDay && (d.start || d.end || d.day)) {
        changes.start = d.start || hhmmOf(src.start);
        changes.end = d.end || hhmmOf(src.end);
        changes.day = changes.day || dayKey(src.start);
        if (changes.end <= changes.start) return toast('The end needs to be after the start.');
      }
      if (src.allDay && d.day) changes.allDay = true;
    }
    if (!Object.keys(changes).length) { ui.ev.editing = false; render(); return; }
    try {
      await actions.editEvent({ ev: src, changes, scope: ui.ev.scope });
      ui.ev.editing = false; ui.ev.draft = null;
      toast('Saving the change to Google Calendar.');
    } catch (e) { console.error(e); toast('That didn’t save. Check your connection and try again.'); }
  },
  evDelete: async () => {
    const st = store.state;
    const { it, ev } = findEvent(st, ui.ev.ref, ui.ev.day);
    const src = ev || (it && it.src);
    if (!src) return;
    try {
      await actions.removeEvent({ ev: src, scope: ui.ev.scope });
      ui.ev.confirmDelete = false;
      toast('Deleting it from Google Calendar.');
      go(ui.ev.back || '#today');
    } catch (e) { console.error(e); toast('That didn’t delete. Check your connection and try again.'); }
  },
  evCountdown: (el) => {
    const st = store.state;
    const { it, ev } = findEvent(st, ui.ev.ref, ui.ev.day);
    const src = ev || (it && it.src) || it;
    const id = reminderId(ui.ev.ref);
    if (el.dataset.v === 'off') return run(actions.removeCountdown(id), 'Countdown removed.');
    const date = src.allDay ? (src.startKey || dayKey(src.start)) : dayKey(src.start);
    run(actions.setCountdown({ id, title: (it && it.title) || src.title, date, ref: ui.ev.ref }), 'It counts down on Today now.');
  },
  // ----- every other Friday off -----
  altOffToggle: () => {
    const s = settingsOf(store.state, store.state.me);
    if (s.altOff) return run(actions.updateMySettings({ altOff: null }));
    const days = s.workDays.filter((d) => d <= 5);
    const day = days.includes(5) ? 5 : (days[days.length - 1] || 5);
    run(actions.updateMySettings({ altOff: { day, from: nextWeekday(day) } }));
  },
  altOffFrom: (el) => { const s = settingsOf(store.state, store.state.me); run(actions.updateMySettings({ altOff: { day: s.altOff.day, from: el.dataset.v } })); },
  askNew: () => { resetAsk(); },
  answer: (el) => run(actions.answerRequest(el.dataset.id, el.dataset.a), {
    yes: 'Done. Saving it to your calendars.', no: 'Answer sent.', maybe: 'Answer sent.', seen: null, cancel: 'Request cancelled.', remind: 'Reminder sent.', 'accept-counter': 'Done. Saving it to your calendars.'
  }[el.dataset.a]),
  suggestOpen: (el) => { ui.suggestFor = el.dataset.id; render(); },
  suggestCancel: () => { ui.suggestFor = null; render(); },
  suggest: (el) => {
    const s = ui.suggestSlots[Number(el.dataset.i)];
    ui.suggestFor = null;
    if (s) run(actions.answerRequest(el.dataset.id, 'other', { when: { day: s.key, start: s.start, end: s.end, allDay: false, label: s.label } }), 'Suggestion sent.');
  },
  askType: (el) => { ui.ask.type = el.dataset.v; render(); },
  askFav: (el) => { ui.ask.title = el.dataset.v; render(); },
  askSlot: (el) => { ui.ask.slot = Number(el.dataset.i); ui.ask.pick = (ui.ask.shown || [])[ui.ask.slot] || null; ui.ask.custom = false; render(); },
  askCustom: () => { ui.ask.custom = true; ui.ask.pick = null; if (!ui.ask.cday) ui.ask.cday = dayKey(addDays(new Date(), 1)); render(); },
  askHold: () => { const def = store.state.household.pencilDefault !== false; ui.ask.hold = !(ui.ask.hold === null ? def : ui.ask.hold); render(); },
  askSend: async () => {
    const a = ui.ask;
    if (!a.title.trim() && a.type !== 'leave') { ui.focus = 'ask-title'; return toast('Add what it is first.'); }
    const st = store.state;
    const when = askWhen(st);
    const def = st.household.pencilDefault !== false;
    const hold = (a.type === 'plan' || a.type === 'free') && (a.hold === null ? def : a.hold);
    const extra = a.type === 'leave' ? { days: { [st.me]: leaveDaysFor(st, st.me, when.day, when.endDay), [st.partner]: leaveDaysFor(st, st.partner, when.day, when.endDay) }, people: [st.me, st.partner] } : {};
    try {
      await actions.createRequest(Object.assign({ type: a.type, title: a.title, when, hold }, extra));
      ui.ask.sent = true; ui.ask.heldNote = hold;
      render();
    } catch (e) { console.error(e); toast('That didn’t send. Check your connection and try again.'); }
  },
  askAgain: () => { resetAsk(); render(); },
  addKind: (el) => { ui.add.kind = el.dataset.v; render(); },
  addShiftWho: (el) => { ui.add.shiftWho = el.dataset.v; render(); },
  addShiftType: (el) => { ui.add.shiftType = el.dataset.v; render(); },
  addShiftSave: async () => {
    const st = store.state;
    const who = ui.add.shiftWho || (settingsOf(st, st.me).hasShifts ? st.me : st.partner);
    const day = addDayKey();
    try { await actions.setShift(who, day, ui.add.shiftType); } catch (e) { console.error(e); return toast('That didn’t save. Check your connection and try again.'); }
    const label = settingsOf(st, who).shiftTypes[ui.add.shiftType].label;
    ui.add.done = `Saved: ${label} on ${whenLabel({ day, allDay: true }).replace(', all day', '')}${who === st.me ? '' : ` for ${nameOf(st, who)}`}.`;
    render();
  },
  addWho: (el) => { ui.add.who = el.dataset.v; render(); },
  addDay: (el) => { ui.add.day = el.dataset.v; if (el.dataset.v === 'pick' && !ui.add.date) ui.add.date = dayKey(new Date()); render(); },
  addBusy: (el) => { ui.add.busyOnly = el.dataset.v === 'busy'; render(); },
  calPriority: (el) => {
    const s = settingsOf(store.state, store.state.me);
    const set = new Set(s.lowCals || []);
    if (el.dataset.v === 'low') set.add(el.dataset.k); else set.delete(el.dataset.k);
    const c = store.state.calendars[el.dataset.k];
    run(actions.updateMySettings({ lowCals: [...set] }), el.dataset.v === 'low' ? `${c ? c.name : 'That calendar'} is now low priority.` : `${c ? c.name : 'That calendar'} is back on Today and the week.`);
  },
  cdNext: () => rotateCountdown(),
  addAllDayT: () => { ui.add.allDay = !ui.add.allDay; render(); },
  addMore: () => { ui.add.more = !ui.add.more; render(); },
  addSave: async () => {
    const a = ui.add;
    const st = store.state;
    if (!a.title.trim()) { ui.focus = 'add-title'; return toast('Add what it is first.'); }
    if (!a.allDay && !a.start) { ui.focus = 'add-start'; return toast('Add a start time, or tick All day.'); }
    const day = addDayKey();
    let end = a.end;
    if (!a.allDay && end && end <= a.start) { ui.focus = 'add-end'; return toast('The end needs to be after the start.'); }
    if (!a.allDay && !end) end = plusMins(a.start, 60);
    const cals = Object.values(st.calendars).filter((c) => c.owner === st.me && c.canWrite && c.role !== 'rota');
    const calKey = a.cal || (cals.find((c) => c.primary) || cals[0] || {}).calKey || null;
    try {
      const rep = a.who !== 'partner' && a.repeat ? { freq: a.repeat.split(':')[0], interval: Number(a.repeat.split(':')[1]) || 1 } : null;
      const tag = await actions.addEvent({ who: a.who, title: a.title, day, start: a.allDay ? null : a.start, end: a.allDay ? null : end, allDay: a.allDay, calKey, busyOnly: a.busyOnly, repeat: rep });
      if (a.who !== 'partner' && a.remind.length && tag) await actions.setReminder({ ref: `t:${tag}`, owner: st.me, title: a.title.trim(), times: a.remind, note: a.note.trim() });
      const when = whenLabel({ day, start: a.start, end, allDay: a.allDay });
      ui.add.done = a.who === 'partner' ? `Sent to ${nameOf(st, st.partner)}: ${a.title} (${when}). It goes in their calendar when they say yes.`
        : a.who === 'both' ? `Added for both of you: ${a.title} (${when}).` : `Added: ${a.title} (${when}). It reaches Google Calendar within a few minutes.`;
      render();
    } catch (e) { console.error(e); toast('That didn’t save. Check your connection and try again.'); }
  },
  addAgain: () => { resetAdd(); render(); },
  setPage: (el) => { go(el.dataset.v === 'home' ? '#settings' : `#settings/${el.dataset.v}`); },
  openCal: (el) => { ui.settings.openCal = ui.settings.openCal === el.dataset.k ? null : el.dataset.k; render(); },
  calShow: (el) => { const c = store.state.calendars[el.dataset.k]; run(actions.updateCalendar(el.dataset.k, { show: c.show === false })); },
  calShare: (el) => run(actions.updateCalendar(el.dataset.k, { share: el.dataset.v })),
  myHasShifts: () => {
    const s = settingsOf(store.state, store.state.me);
    run(actions.updateMySettings(s.hasShifts ? { hasShifts: false, workDays: [1, 2, 3, 4, 5] } : { hasShifts: true, workDays: [] }));
  },
  shiftPerson: (el) => { ui.settings.shiftPerson = el.dataset.v; render(); },
  saveRota: () => {
    const v = (ui.settings.rotaDraft ?? '').trim();
    if (v && !/^https?:\/\//i.test(v) && !/^webcal:\/\//i.test(v)) return toast('That doesn’t look like a link.');
    run(actions.updateMySettings({ rotaUrl: v.replace(/^webcal:/i, 'https:') }), v ? 'Rota link saved. It syncs within a few minutes.' : 'Rota link removed.');
  },
  cycleShift: (el) => {
    const st = store.state;
    const { p, day } = el.dataset;
    const cur = st.shifts[`${p}|${day}`];
    const curType = cur ? cur.type : (el.dataset.type || null);
    const order = ['long', 'night', 'early', 'late', 'off', 'leave'];
    const i = curType ? order.indexOf(curType) : -1;
    const next = i + 1 < order.length ? order[i + 1] : null;
    run(actions.setShift(p, day, next));
  },
  clearShift: (el) => run(actions.setShift(el.dataset.p, el.dataset.day, null)),
  shiftWeek: (el) => { ui.settings.shiftWeek += Number(el.dataset.d); render(); },
  workDay: (el) => {
    const s = settingsOf(store.state, store.state.me);
    const v = Number(el.dataset.v);
    const days = s.workDays.includes(v) ? s.workDays.filter((x) => x !== v) : [...s.workDays, v].sort();
    run(actions.updateMySettings({ workDays: days }));
  },
  hhToggle: (el) => { const f = el.dataset.f; const cur = store.state.household[f] !== false; run(actions.updateHousehold({ [f]: !cur })); },
  favRemove: (el) => { const favs = [...(store.state.household.favours || [])]; favs.splice(Number(el.dataset.i), 1); run(actions.updateHousehold({ favours: favs })); },
  favAdd: () => {
    const v = (ui.settings.favDraft || '').trim();
    if (!v) return toast('Type a favour first.');
    ui.settings.favDraft = '';
    run(actions.updateHousehold({ favours: [...(store.state.household.favours || []), v] }));
  },
  notifToggle: (el) => {
    const s = settingsOf(store.state, store.state.me);
    run(actions.updateMySettings({ notif: Object.assign({}, s.notif, { [el.dataset.f]: !s.notif[el.dataset.f] }) }));
  },
  pushOn: async () => {
    ui.pushMsg = 'Asking this phone...'; render();
    try {
      const r = await actions.enableNotifications();
      ui.pushMsg = r.ok ? 'Done. Notifications are on for this phone.' : (r.reason === 'demo' ? 'Notifications don’t work in the demo.' : r.reason);
    } catch (e) { console.error(e); ui.pushMsg = 'That didn’t work. Try again in a moment.'; }
    render();
  },
  setTheme: (el) => { setLook({ theme: el.dataset.v }); render(); },
  setPalette: (el) => { setLook({ palette: el.dataset.v }); render(); },
  setMode: (el) => { setLook({ mode: el.dataset.v }); render(); },
  savePartnerEmail: () => {
    const st = store.state;
    const v = (ui.settings.partnerEmailDraft || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return toast('That doesn’t look like an email.');
    run(actions.setPartnerEmail(v), 'Saved.');
  },
  linkAcc: () => {
    const st = store.state;
    const v = (ui.settings.linkDraft || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return toast('That doesn’t look like an email.');
    ui.settings.linkDraft = '';
    const linked = ((st.people[st.me] && st.people[st.me].linked) || []).filter((x) => x !== v);
    run(actions.setLinkedAccounts([...linked, v]), 'Added. Now open the connect page while signed in to that account.');
  },
  unlinkAcc: (el) => {
    const st = store.state;
    const linked = ((st.people[st.me] && st.people[st.me].linked) || []).filter((x) => x !== el.dataset.v);
    run(actions.setLinkedAccounts(linked));
  },
  syncNow: async () => { const ok = await actions.syncNow(); toast(ok ? 'Syncing now.' : 'The sync script isn’t set up yet.'); },
  signOut: () => { if (store.state.demo) location.href = './'; else actions.signOut(); },
  signIn: async () => {
    ui.signInError = null;
    try { await actions.signIn(); } catch (e) {
      console.error(e);
      ui.signInError = e && e.code === 'auth/popup-closed-by-user' ? 'Sign-in was closed before it finished.' : 'Sign-in didn’t work. Try again.';
      render();
    }
  },
  setupSave: async () => {
    const s = ui.setup;
    const st = store.state;
    const myName = (s.myName || (st.user && st.user.name || '').split(' ')[0] || '').trim();
    if (!myName || !s.partnerName.trim()) return toast('Add both first names.');
    try { await actions.createHousehold({ myName, myShifts: s.myShifts, partnerName: s.partnerName, partnerEmail: s.partnerEmail, partnerShifts: s.partnerShifts }); } catch (e) { console.error(e); toast('That didn’t save. Try again.'); }
  }
};
// changes from selects, time boxes and tick boxes
const C = {
  addAllDay: (el) => { ui.add.allDay = el.checked; render(); },
  setupFlag: (el) => { ui.setup[el.dataset.f] = el.checked; },
  calRole: (el) => {
    const v = el.value;
    const patch = v === 'work' ? { role: 'work', layer: 'own' } : v === 'rota' ? { role: 'rota', layer: 'own' } : v === 'own' ? { role: 'normal', layer: 'own' } : { role: 'normal', layer: v };
    const c = store.state.calendars[el.dataset.k];
    if (v === 'work' && c.share === 'all') patch.share = 'hours';
    if (v !== 'work' && c.share === 'hours') patch.share = 'busy';
    run(actions.updateCalendar(el.dataset.k, patch));
  },
  shiftTime: (el) => {
    const st = store.state;
    const s = settingsOf(st, el.dataset.p);
    const types = JSON.parse(JSON.stringify(s.shiftTypes));
    types[el.dataset.t][el.dataset.f] = el.value;
    run(actions.updatePersonSettings(el.dataset.p, { shiftTypes: types }));
  },
  personField: (el) => run(actions.updatePersonSettings(el.dataset.p, { [el.dataset.f]: el.dataset.f === 'travelMins' ? Number(el.value) : el.value })),
  myField: (el) => run(actions.updateMySettings({ [el.dataset.f]: el.value })),
  evNote: (el) => {
    const st = store.state;
    const { it, ev } = findEvent(st, ui.ev.ref, ui.ev.day);
    const base = ev || it;
    if (!base) return;
    const owner = (it && it.owner) || base.owner || st.me;
    const rem = reminderFor(st, ui.ev.ref, Object.assign({}, base, { owner }));
    ui.ev.noteDraft = null;
    run(actions.setReminder({ ref: ui.ev.ref, owner, title: (it && it.title) || base.title, times: rem ? rem.times : [], note: el.value.trim() }));
  },
  altOffDay: (el) => {
    const day = Number(el.value);
    run(actions.updateMySettings({ altOff: { day, from: nextWeekday(day) } }));
  },
  addNote: (el) => { ui.add.note = el.value; },
  quietField: (el) => { const s = settingsOf(store.state, store.state.me); run(actions.updateMySettings({ quiet: Object.assign({}, s.quiet, { [el.dataset.f]: el.value }) })); },
  summaryField: (el) => { const s = settingsOf(store.state, store.state.me); const f = el.dataset.f; run(actions.updateMySettings({ [f]: Object.assign({}, s[f], { [el.dataset.k]: el.dataset.k === 'day' ? Number(el.value) : el.value }) })); },
  leaveField: (el) => {
    const s = settingsOf(store.state, store.state.me);
    const v = el.dataset.f === 'allowance' ? Math.max(0, Math.min(60, Number(el.value) || 0)) : (el.value || '').slice(5);
    if (el.dataset.f === 'yearStart' && !/^\d{2}-\d{2}$/.test(v)) return;
    run(actions.updateMySettings({ leave: Object.assign({}, s.leave, { [el.dataset.f]: v }) }));
  },
  askLeaveDate: () => render(),
  addLeaveDate: () => render(),
  addRerender: () => render(),
  hhBday: (el) => {
    const h = store.state.household || {};
    const b = Object.assign({}, h.birthdays || {});
    // cleared: an empty value, as a saved change merges into what's there (a removed key would come back)
    b[el.dataset.p] = el.value ? el.value.slice(5) : '';
    run(actions.updateHousehold({ birthdays: b }), 'Saved.');
  },
  hhField: (el) => run(actions.updateHousehold({ [el.dataset.f]: el.dataset.f === 'nudgeHours' ? Number(el.value) : el.value }))
};

root.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || !root.contains(el)) return;
  if (el.tagName === 'SELECT' || (el.tagName === 'INPUT' && el.type !== 'button')) return;
  const fn = H[el.dataset.act];
  if (!fn) return;
  if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') { e.preventDefault(); e.stopPropagation(); }
  fn(el, e);
});
root.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset && el.dataset.act && C[el.dataset.act]) C[el.dataset.act](el, e);
});
root.addEventListener('input', (e) => {
  const el = e.target;
  const b = el.dataset && el.dataset.bind;
  if (!b) return;
  const parts = b.split('.');
  let o = ui;
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
  o[parts[parts.length - 1]] = el.value;
});
root.addEventListener('focusout', () => {
  setTimeout(() => { if (pendingRender && !isEditing()) render(); }, 0);
});
root.addEventListener('keydown', (e) => {
  const el = e.target.closest && e.target.closest('[role="button"][data-act]');
  if (el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); H[el.dataset.act] && H[el.dataset.act](el, e); }
});

// Peckish and Budgie data on this phone (at most once a minute)
let linkedAt = 0;
async function refreshLinked() {
  if (Date.now() - linkedAt < 60000) return;
  linkedAt = Date.now();
  try {
    const params = new URLSearchParams(location.search);
    if (params.get('demo')) {
      const { demoLinked } = await import('./demo.js');
      setLinked(demoLinked());
    } else setLinked(await loadLinked());
  } catch (e) { console.warn('linked', e); }
}

// The app stays open for days on a phone: after midnight, move the calendar on with today
let shownDay = dayKey(new Date());
function newDay() {
  const k = dayKey(new Date());
  if (k === shownDay) return;
  const was = fromDayKey(shownDay); const now = new Date();
  if (ui.calSel === shownDay) ui.calSel = k;
  if (ui.weekOpen === shownDay) ui.weekOpen = k;
  if (dayKey(ui.weekStart) === dayKey(mondayOf(was))) ui.weekStart = mondayOf(now);
  if (ui.calMonth.getFullYear() === was.getFullYear() && ui.calMonth.getMonth() === was.getMonth()) ui.calMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  shownDay = k;
}

// ---------- start ----------
async function boot() {
  applyLook();
  if (window.matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyLook());
  store.subscribe(() => render());
  setInterval(rotateCountdown, 5000);
  window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });
  setInterval(() => { newDay(); if (!document.hidden && !isEditing()) { store.state = Object.assign({}, store.state, { rev: store.state.rev + 1 }); render(); } }, 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    newDay();
    if (store.backend && store.state.phase === 'ready') store.backend.ping();
    refreshLinked();
  });
  refreshLinked();
  // first sign-in: mark yourself as joined
  let joinedChecked = false;
  store.subscribe((st) => {
    if (joinedChecked || st.phase !== 'ready' || !st.me || st.demo) return;
    joinedChecked = true;
    actions.markJoined().catch((e) => console.warn('joined', e));
  });
  const params = new URLSearchParams(location.search);
  const demo = params.get('demo');
  if (demo) {
    const { createDemoBackend } = await import('./demo.js');
    store.backend = createDemoBackend(demo === 'sophie' ? 'sophie' : 'ethan');
    await store.backend.init();
  } else if (!FIREBASE.config) {
    setPhase('signed-out');
  } else {
    try {
      const { createFirebaseBackend } = await import('./firebase.js');
      store.backend = await createFirebaseBackend();
      store.backend.onLateError = (e) => { console.error(e); toast('A change you made didn’t save, so it has been undone. Try it again.'); };
    } catch (e) {
      console.error(e);
      ui.signInError = 'Couldn’t reach Caledonite’s server. Check your connection and reload.';
      setPhase('signed-out');
    }
  }
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('sw', e));
  }
  document.title = APP.name;
}
render();
boot();

export { shiftFor, SHIFT_ORDER };
