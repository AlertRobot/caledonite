// Screen state that isn't saved anywhere (which tab is open, what's half-typed).
import { dayKey, mondayOf } from './util.js';

const today = new Date();
export const ui = {
  todayFilter: 'both',
  noteOpen: false,
  noteText: '',
  calView: 'month',
  calMonth: new Date(today.getFullYear(), today.getMonth(), 1),
  calSel: dayKey(today),
  weekStart: mondayOf(today),
  weekOpen: dayKey(today),
  layerOff: {},
  reqTab: 'for',
  suggestFor: null,
  suggestSlots: [],
  ask: { type: 'plan', title: '', slot: 0, custom: false, cday: '', cstart: '19:00', cend: '21:00', hold: null, sent: false, lfrom: '', lto: '', pick: null, shown: null },
  add: { kind: 'event', who: 'me', title: '', day: 'today', date: '', start: '', end: '', allDay: false, cal: '', busyOnly: false, shiftType: 'long', shiftWho: null, done: '', remind: [], note: '', repeat: '', jobWho: 'me', jobRepeat: '', lfrom: '', lto: '', more: false },
  ev: { ref: null, day: null, back: '#today', noteDraft: null, editing: false, confirmDelete: false, scope: 'one', draft: null },
  jar: { pick: null, adding: false, draft: { title: '', cost: '', where: 'out' }, filter: 'all' },
  jobs: { showDone: false },
  // folded lists opened (Older requests, Done jobs), so a redraw doesn't fold them again
  opened: {},
  settings: { page: 'home', openCal: null, shiftWeek: 0, shiftPerson: null, shiftOpen: null, back: null, editType: null, favDraft: '', partnerEmailDraft: '', linkDraft: '' },
  setup: { myName: '', myShifts: false, partnerName: '', partnerEmail: '', partnerShifts: false },
  toast: null
};

export function resetAsk() {
  ui.ask = { type: 'plan', title: '', slot: 0, custom: false, cday: '', cstart: '19:00', cend: '21:00', hold: null, sent: false, lfrom: '', lto: '', pick: null, shown: null };
}
export function resetAdd() {
  const keep = { kind: ui.add.kind, who: ui.add.who };
  ui.add = Object.assign({ title: '', day: 'today', date: '', start: '', end: '', allDay: false, cal: '', busyOnly: false, shiftType: 'long', shiftWho: null, done: '', remind: [], note: '', repeat: '', jobWho: 'me', jobRepeat: '', lfrom: '', lto: '', more: false }, keep);
}
