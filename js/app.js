// Calendite: start-up, screens, taps and typing.
import { store, actions, setPhase } from './store.js';
import { ui, resetAsk, resetAdd } from './uistate.js';
import { viewToday, viewCalendar, waitingForMe } from './views-main.js';
import { viewRequests, viewAsk, viewAdd, askWhen, addDayKey } from './views-requests.js';
import { viewSettings, viewSignedOut, viewSetup, viewNotMember, viewLoading } from './views-settings.js';
import { applyLook, setLook } from './theme.js';
import { FIREBASE, APP } from './config.js';
import { icon } from './ui.js';
import { dayKey, addDays, fromDayKey, mondayOf, esc, minutesOf, pad } from './util.js';
import { freeSlots, settingsOf, shiftFor, SHIFT_ORDER, nameOf } from './logic.js';
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
    const on = r === key || (key === 'requests' && r === 'ask');
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
  else if (st.phase === 'not-member' || !st.me) html = viewNotMember(st);
  else {
    nav = true;
    if (r === 'settings') ui.settings.page = sub || 'home';
    const view = { today: viewToday, calendar: viewCalendar, requests: viewRequests, ask: viewAsk, add: viewAdd, settings: viewSettings }[r] || viewToday;
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
    if (i >= 0) { ui.ask.custom = false; ui.ask.slot = i; }
  },
  calGo: (el) => { const d = fromDayKey(el.dataset.day); ui.calView = 'month'; ui.calSel = el.dataset.day; ui.calMonth = new Date(d.getFullYear(), d.getMonth(), 1); },
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
  askNew: () => { resetAsk(); },
  answer: (el) => run(actions.answerRequest(el.dataset.id, el.dataset.a), {
    yes: 'Done. Saving it to your calendars.', no: 'Answer sent.', maybe: 'Answer sent.', seen: null, cancel: 'Request cancelled.', remind: 'Reminder sent.', 'accept-counter': 'Done. Saving it to your calendars.'
  }[el.dataset.a]),
  suggestOpen: (el) => { ui.suggestFor = el.dataset.id; render(); },
  suggestCancel: () => { ui.suggestFor = null; render(); },
  suggest: (el) => {
    const s = freeSlots(store.state, new Date(), 4)[Number(el.dataset.i)];
    ui.suggestFor = null;
    if (s) run(actions.answerRequest(el.dataset.id, 'other', { when: { day: s.key, start: s.start, end: s.end, allDay: false, label: s.label } }), 'Suggestion sent.');
  },
  askType: (el) => { ui.ask.type = el.dataset.v; render(); },
  askFav: (el) => { ui.ask.title = el.dataset.v; render(); },
  askSlot: (el) => { ui.ask.slot = Number(el.dataset.i); ui.ask.custom = false; render(); },
  askCustom: () => { ui.ask.custom = true; if (!ui.ask.cday) ui.ask.cday = dayKey(addDays(new Date(), 1)); render(); },
  askHold: () => { const def = store.state.household.pencilDefault !== false; ui.ask.hold = !(ui.ask.hold === null ? def : ui.ask.hold); render(); },
  askSend: async () => {
    const a = ui.ask;
    if (!a.title.trim()) { ui.focus = 'ask-title'; return toast('Add what it is first.'); }
    const when = askWhen(store.state);
    const def = store.state.household.pencilDefault !== false;
    const hold = (a.type === 'plan' || a.type === 'free') && (a.hold === null ? def : a.hold);
    try {
      await actions.createRequest({ type: a.type, title: a.title, when, hold });
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
    await run(actions.setShift(who, day, ui.add.shiftType));
    const label = settingsOf(st, who).shiftTypes[ui.add.shiftType].label;
    ui.add.done = `Saved: ${label} on ${whenLabel({ day, allDay: true }).replace(', all day', '')}${who === st.me ? '' : ` for ${nameOf(st, who)}`}.`;
    render();
  },
  addWho: (el) => { ui.add.who = el.dataset.v; render(); },
  addDay: (el) => { ui.add.day = el.dataset.v; if (el.dataset.v === 'pick' && !ui.add.date) ui.add.date = dayKey(new Date()); render(); },
  addBusy: (el) => { ui.add.busyOnly = el.dataset.v === 'busy'; render(); },
  addSave: async () => {
    const a = ui.add;
    const st = store.state;
    if (!a.title.trim()) { ui.focus = 'add-title'; return toast('Add what it is first.'); }
    if (!a.allDay && !a.start) { ui.focus = 'add-start'; return toast('Add a start time, or tick All day.'); }
    const day = addDayKey();
    let end = a.end;
    if (!a.allDay && (!end || end <= a.start)) end = plusMins(a.start, 60);
    const cals = Object.values(st.calendars).filter((c) => c.owner === st.me && c.canWrite && c.role !== 'rota');
    const calKey = a.cal || (cals.find((c) => c.primary) || cals[0] || {}).calKey || null;
    try {
      await actions.addEvent({ who: a.who, title: a.title, day, start: a.allDay ? null : a.start, end: a.allDay ? null : end, allDay: a.allDay, calKey, busyOnly: a.busyOnly });
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
    const myEmail = (st.people[st.me].email || '').toLowerCase();
    run(Promise.all([actions.updatePerson(st.partner, { email: v }), actions.updateHousehold({ emails: [myEmail, v] })]), 'Saved.');
  },
  linkAcc: () => {
    const st = store.state;
    const v = (ui.settings.linkDraft || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return toast('That doesn’t look like an email.');
    ui.settings.linkDraft = '';
    const linked = (st.household.linked || []).filter((x) => x.email !== v);
    run(actions.updateHousehold({ linked: [...linked, { email: v, person: st.me }] }), 'Added. Now run connectMe in the sync script while signed in to that account.');
  },
  unlinkAcc: (el) => {
    const linked = (store.state.household.linked || []).filter((x) => x.email !== el.dataset.v);
    run(actions.updateHousehold({ linked }));
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

// ---------- start ----------
async function boot() {
  applyLook();
  if (window.matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyLook());
  store.subscribe(() => render());
  window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });
  setInterval(() => { if (!document.hidden && !isEditing()) { store.state = Object.assign({}, store.state, { rev: store.state.rev + 1 }); render(); } }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && store.backend && store.state.phase === 'ready') store.backend.ping(); });
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
    } catch (e) {
      console.error(e);
      ui.signInError = 'Couldn’t reach Calendite’s server. Check your connection and reload.';
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
