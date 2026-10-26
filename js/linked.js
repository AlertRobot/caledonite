// Peckish lives on the same website as Caledonite, so on a phone where you use it, Caledonite reads what it has
// saved on the phone. Budgie has its own website and a limited link (below).
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
// Budgie lives on its own website now (budgie-money.github.io), so Caledonite can't read it from the phone.
// Instead it has its own limited link, made in Budgie (Settings, Linked apps), which can only ask Budgie's sheet
// for your paydays, bills and what's left for fun. It can't see anything else or change anything.
const BG_LINK = 'cal.budgieLink', BG_CACHE = 'cal.budgieCache';
const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } };
export function parseBudgieLink(text) {
  const m = String(text || '').match(/#connect=([A-Za-z0-9_\-=]+)/); if (!m) return null;
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const j = JSON.parse(decodeURIComponent(escape(atob(b64 + '==='.slice((b64.length + 3) % 4)))));
    if (!j.u || !j.k) return null;
    const url = new URL(j.u); // only ever a Google Apps Script web app, over https
    if (url.protocol !== 'https:' || !/^script\.google(usercontent)?\.com$/.test(url.hostname)) return null;
    // only Caledonite's own limited link, never Budgie's full key
    if (!/^app_caledonite_[0-9a-f]{64}$/.test(String(j.k))) return null;
    return { u: j.u, k: j.k };
  } catch (e) { return null; }
}
export function setBudgieLink(cfg) { lsSet(BG_LINK, cfg); lsSet(BG_CACHE, null); }
export function unlinkBudgie() { lsSet(BG_LINK, null); lsSet(BG_CACHE, null); }
export async function loadBudgie() {
  const cfg = lsGet(BG_LINK);
  if (!cfg) return { found: false, needsLink: true };
  const cached = lsGet(BG_CACHE);
  try {
    const res = await fetch(cfg.u, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ key: cfg.k, action: 'app.calendar' }) });
    const j = await res.json();
    if (!j.ok) {
      // a link that's been switched off: forget what it said last time, too
      if (/not allowed|key|link/i.test(j.error || '')) { lsSet(BG_CACHE, null); return { found: true, error: 'Budgie turned this link down. Make a new one in Budgie (Settings, Linked apps) and paste it here.' }; }
      throw new Error(j.error || 'Budgie said no');
    }
    const out = { found: true, days: cleanDays(j.days), fun: cleanFun(j.fun), synced: Number(j.synced) || Date.now(), name: String(j.name || '') };
    lsSet(BG_CACHE, out);
    return out;
  } catch (e) {
    // offline: what Budgie said last time
    if (cached) return Object.assign({}, cached, { stale: true });
    return { found: true, error: 'Couldn\u2019t reach Budgie just now.' };
  }
}

// Only the shape Caledonite draws, so an odd answer can never break Today
const isKey = (k) => /^\d{4}-\d{2}-\d{2}$/.test(String(k));
function cleanDays(days) {
  const out = {};
  if (!days || typeof days !== 'object') return out;
  for (const [k, list] of Object.entries(days)) {
    if (!isKey(k) || !Array.isArray(list)) continue;
    const items = list.filter((m) => m && typeof m === 'object' && m.name).map((m) => ({ name: String(m.name).slice(0, 80), sub: String(m.sub || '').slice(0, 80), pay: !!m.pay }));
    if (items.length) out[k] = items;
  }
  return out;
}
function cleanFun(f) {
  if (!f || typeof f !== 'object' || !Number.isFinite(Number(f.left))) return null;
  return { left: Number(f.left), names: Array.isArray(f.names) ? f.names.map(String) : [], until: isKey(f.until) ? f.until : null };
}

export async function loadLinked() {
  const [peckish, budgie] = await Promise.all([loadPeckish().catch(() => ({ found: false })), loadBudgie().catch(() => ({ found: false }))]);
  return { peckish, budgie, loaded: Date.now() };
}
