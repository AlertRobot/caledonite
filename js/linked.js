// Peckish and Budgie live on the same website as Caledonite, so on a phone where you use them,
// Caledonite can read what they've saved on the phone. Nothing is sent anywhere; nothing is changed.
import { dayKey, addDays, fromDayKey } from './util.js';

const BASE = new URL('../', location.href).href; // https://alertrobot.github.io/

// ---------- Peckish: this week's and next week's dinners ----------
let library = null;
async function peckishLibrary() {
  if (library) return library;
  try {
    const res = await fetch(`${BASE}es-kitchen/data/library.json`);
    const data = await res.json();
    library = {};
    for (const r of data.recipes || []) library[r.id] = { title: r.short || r.title, time: r.time || null };
  } catch (e) { library = {}; }
  return library;
}
export async function loadPeckish() {
  const weeks = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const m = k && k.match(/^esk-wk:[^:]+:(\d{4}-\d{2}-\d{2})$/);
      if (!m) continue;
      try { weeks.push({ start: m[1], doc: JSON.parse(localStorage.getItem(k)) }); } catch (e) { /* skip */ }
    }
  } catch (e) { return { found: false }; }
  if (!weeks.length) return { found: false };
  const lib = await peckishLibrary();
  const days = {};
  for (const w of weeks) {
    const list = Array.isArray(w.doc && w.doc.days) ? w.doc.days : Array.from({ length: 7 }, (_, i) => (w.doc && w.doc.days && w.doc.days[`d${i}`]) || {});
    list.forEach((d, i) => {
      if (!d || (!d.r && !d.takeaway)) return;
      const key = dayKey(addDays(fromDayKey(w.start), i));
      const rec = d.r ? lib[d.r] : null;
      days[key] = { takeaway: !!d.takeaway, title: rec ? rec.title : 'dinner planned in Peckish', time: rec ? rec.time : null };
    });
  }
  return { found: true, days };
}

// ---------- Budgie: paydays, bills and what's left for fun ----------
function idbGet(name, store, key) {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(name);
      req.onupgradeneeded = () => { req.transaction.abort(); resolve(null); };
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(store)) { db.close(); resolve(null); return; }
        const q = db.transaction(store).objectStore(store).get(key);
        q.onsuccess = () => { resolve(q.result || null); db.close(); };
        q.onerror = () => { resolve(null); db.close(); };
      };
    } catch (e) { resolve(null); }
  });
}
function loadEngine() {
  if (window.Budgie && window.Budgie.load) return Promise.resolve(window.Budgie);
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = `${BASE}budgie/engine.js`;
    s.onload = () => resolve(window.Budgie || null);
    s.onerror = () => resolve(null);
    document.head.appendChild(s);
  });
}
const FUN_RE = /fun|entertain|going out|leisure|social|date|treat/i;
const money = (n) => `£${(Math.round((+n || 0) * 100) / 100).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

export async function loadBudgie() {
  let data = await idbGet('budgie', 'kv', 'data');
  if (!data) { try { data = JSON.parse(localStorage.getItem('budgie.kv.data') || 'null'); } catch (e) { data = null; } }
  if (!data || !data.tables || !data.me) return { found: false };
  const B = await loadEngine();
  if (!B || !B.load || !B.coming) return { found: true, error: 'Budgie is on this phone, but its engine could not be loaded.' };
  try {
    const today = dayKey(new Date());
    const db = B.load(data.tables, today);
    const me = data.me;
    const days = {};
    for (const c of B.coming(db, me, addDays14(today, -14), 120) || []) {
      if (!c || !c.date) continue;
      const isPay = /payday/i.test(c.name || '') || c.table === 'income';
      if (!isPay && c.table !== 'bills') continue;
      (days[c.date] = days[c.date] || []).push({
        name: isPay ? (c.name || 'Payday') : `${c.name}`,
        sub: c.amount ? `${isPay ? '' : 'Bill, '}${money(c.amount)}` : (isPay ? '' : 'Bill'),
        pay: isPay, amount: c.amount || 0
      });
    }
    // what's left to spend on fun until payday
    let fun = null;
    try {
      const per = B.periodAt(db, me, today);
      const plan = B.planFor(db, me, per);
      const st = B.budgetState(db, me, per);
      let left = 0; const names = [];
      for (const l of plan.lines || []) {
        if (l.kind !== 'spend' || !FUN_RE.test(l.name || '')) continue;
        const x = st[l.id];
        if (!x) continue;
        left += Math.max(0, +x.left || 0);
        names.push(l.name);
      }
      if (names.length) fun = { left: Math.round(left * 100) / 100, names, until: per.next || null };
    } catch (e) { fun = null; }
    return { found: true, days, fun, synced: data.lastSync || null };
  } catch (e) {
    console.warn('budgie', e);
    return { found: true, error: 'Budgie is on this phone, but its data could not be read.' };
  }
}
function addDays14(k, n) { return dayKey(addDays(fromDayKey(k), n)); }

export async function loadLinked() {
  const [peckish, budgie] = await Promise.all([loadPeckish().catch(() => ({ found: false })), loadBudgie().catch(() => ({ found: false }))]);
  return { peckish, budgie, loaded: Date.now() };
}
