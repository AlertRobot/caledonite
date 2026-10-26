// Caledonite service worker: works offline, shows notifications, and answers requests
// straight from a notification's buttons.
importScripts('./js/ops.js');

const VERSION = 'caledonite-v7';
const SDK_VERSION = '12.6.0';
const SDK_CACHE = `caledonite-sdk-${SDK_VERSION}`;
// public settings, the same as js/config.js
const FB = { apiKey: 'AIzaSyDN_valkNmZFdG6TjWElHgFS38yAKsLsVk', projectId: 'caledonite' };
const SHELL = [
  './', './index.html', './manifest.webmanifest', './css/app.css',
  './js/app.js', './js/config.js', './js/util.js', './js/logic.js', './js/store.js', './js/ui.js', './js/uistate.js', './js/ops.js',
  './js/theme.js', './js/views-main.js', './js/views-requests.js', './js/views-settings.js', './js/views-event.js', './js/views-extra.js',
  './js/linked.js', './js/firebase.js', './js/demo.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png'
];
const SDK_FILES = ['firebase-app', 'firebase-auth', 'firebase-firestore', 'firebase-messaging']
  .map((n) => `https://www.gstatic.com/firebasejs/${SDK_VERSION}/${n}.js`);

self.addEventListener('install', (e) => {
  e.waitUntil(Promise.all([
    caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'no-cache' })))),
    // the Firebase library, kept across app updates so the app opens offline straight after one
    caches.open(SDK_CACHE).then((c) => Promise.all(SDK_FILES.map((u) => c.match(u).then((hit) => hit || c.add(u).catch(() => null)))))
  ]).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== SDK_CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // our own files: always the newest from the network (never a half-updated mix), the saved copy when offline
  if (url.origin === location.origin) {
    e.respondWith(fetch(e.request, { cache: 'no-cache' }).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('./index.html'))));
    return;
  }
  // the Firebase library: its own cache, kept across updates
  if (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    e.respondWith(caches.open(SDK_CACHE).then((c) => c.match(e.request).then((r) => r || fetch(e.request).then((res) => { c.put(e.request, res.clone()); return res; }))));
    return;
  }
  // fonts: cache first
  if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(e.request, copy));
      return res;
    })));
  }
});

// ---------- notifications sent by the calendar sync ----------
self.addEventListener('push', (e) => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch (err) { p = { data: { title: 'Caledonite', body: e.data ? e.data.text() : '' } }; }
  const d = p.data || p.notification || {};
  const opts = {
    body: d.body || '', icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', tag: d.tag || undefined,
    data: { link: d.link || '#today', reqId: d.reqId || null }
  };
  // a request: answer it from the notification
  if (d.reqId && d.ask === '1') {
    opts.actions = [{ action: 'yes', title: 'Yes' }, { action: 'no', title: "Can't" }];
    opts.requireInteraction = false;
  }
  e.waitUntil(self.registration.showNotification(d.title || 'Caledonite', opts));
});

self.addEventListener('notificationclick', (e) => {
  const n = e.notification;
  const data = n.data || {};
  n.close();
  if ((e.action === 'yes' || e.action === 'no') && data.reqId) {
    e.waitUntil(answerFromNotification(data.reqId, e.action).then((msg) => {
      return self.registration.showNotification('Caledonite', { body: msg, icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', tag: `answered-${data.reqId}` });
    }).catch((err) => {
      console.warn('answer', err);
      return openApp('#requests');
    }));
    return;
  }
  e.waitUntil(openApp(data.link || '#today'));
});
function openApp(hash) {
  const link = new URL('./' + hash, self.registration.scope).href;
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) { c.navigate(link); return c.focus(); } }
    return self.clients.openWindow(link);
  });
}

// ---------- answering without opening the app ----------
// Uses your own sign-in (saved on the phone by Firebase), so the database rules apply as usual.
function idbAuthUser() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('firebaseLocalStorageDb');
    req.onerror = () => reject(new Error('no sign-in on this phone'));
    req.onsuccess = () => {
      const db = req.result;
      try {
        const q = db.transaction('firebaseLocalStorage').objectStore('firebaseLocalStorage').get(`firebase:authUser:${FB.apiKey}:[DEFAULT]`);
        q.onsuccess = () => { db.close(); q.result && q.result.value ? resolve(q.result.value) : reject(new Error('not signed in')); };
        q.onerror = () => { db.close(); reject(new Error('not signed in')); };
      } catch (err) { db.close(); reject(err); }
    };
  });
}
async function idToken() {
  const u = await idbAuthUser();
  const t = u.stsTokenManager || {};
  if (t.accessToken && t.expirationTime && t.expirationTime - Date.now() > 120000) return { token: t.accessToken, email: (u.email || '').toLowerCase() };
  const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${FB.apiKey}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(t.refreshToken || '')}`
  });
  if (!res.ok) throw new Error('could not refresh sign-in');
  const j = await res.json();
  return { token: j.id_token, email: (u.email || '').toLowerCase() };
}
const ROOT = `projects/${FB.projectId}/databases/(default)/documents`;
const API = `https://firestore.googleapis.com/v1/${ROOT}`;
function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  const fields = {};
  for (const k of Object.keys(v)) fields[k] = toValue(v[k]);
  return { mapValue: { fields } };
}
function fromValue(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  if ('mapValue' in v) { const o = {}; const f = v.mapValue.fields || {}; for (const k of Object.keys(f)) o[k] = fromValue(f[k]); return o; }
  if ('timestampValue' in v) return Date.parse(v.timestampValue);
  return null;
}
function fromDoc(d) { const o = {}; const f = d.fields || {}; for (const k of Object.keys(f)) o[k] = fromValue(f[k]); return o; }
function newId() { return Array.from(crypto.getRandomValues(new Uint8Array(15))).map((b) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.charAt(b % 62)).join('').slice(0, 20); }

async function answerFromNotification(reqId, action) {
  const { token, email } = await idToken();
  const auth = { Authorization: `Bearer ${token}` };
  const get = async (path) => { const r = await fetch(`${API}/households/main/${path}`, { headers: auth }); if (!r.ok) throw new Error(`read ${path}: ${r.status}`); return r.json(); };
  const [reqDoc, peopleRes] = await Promise.all([get(`requests/${reqId}`), get('people?pageSize=10')]);
  const req = fromDoc(reqDoc);
  const people = {};
  for (const d of peopleRes.documents || []) people[d.name.split('/').pop()] = fromDoc(d);
  const me = Object.keys(people).find((pid) => (people[pid].email || '').toLowerCase() === email);
  if (!me || req.to !== me) throw new Error('not for you');
  if (req.status !== 'waiting' && req.status !== 'maybe') return 'You already answered that one.';
  const names = {};
  for (const pid of Object.keys(people)) names[pid] = people[pid].name || 'Your partner';
  const res = self.CaledoniteOps.buildAnswer({ req, id: reqId, answer: action, me, byEmail: email, names, now: Date.now() });
  const writes = [{
    update: { name: `${ROOT}/households/main/requests/${reqId}`, fields: toValue(res.patch).mapValue.fields },
    updateMask: { fieldPaths: Object.keys(res.patch) }
  }];
  for (const o of res.outbox) writes.push({ update: { name: `${ROOT}/households/main/outbox/${newId()}`, fields: toValue(o).mapValue.fields }, currentDocument: { exists: false } });
  if (res.notify) {
    const to = people[res.notify.to] || {};
    const notif = (to.settings && to.settings.notif) || {};
    if (notif.requests !== false) {
      const nd = Object.assign({}, res.notify, { sendAfter: Date.now(), sent: false, created: Date.now() });
      writes.push({ update: { name: `${ROOT}/households/main/notify/${newId()}`, fields: toValue(nd).mapValue.fields }, currentDocument: { exists: false } });
    }
  }
  const r = await fetch(`${API}:commit`, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, auth), body: JSON.stringify({ writes }) });
  if (!r.ok) throw new Error(`save: ${r.status}`);
  // ask the sync to pick it up straight away
  try {
    const hr = await fetch(`${API}/households/main`, { headers: auth });
    const hh = hr.ok ? fromDoc(await hr.json()) : {};
    if (hh && hh.pingUrl) fetch(hh.pingUrl, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ secret: hh.pingSecret, action: 'ping' }) });
  } catch (err) { /* the sync runs within 10 minutes anyway */ }
  const title = req.type === 'leave' ? (req.title ? `Holiday: ${req.title}` : 'the holiday') : (req.title || 'that');
  return action === 'yes' ? `You said yes to ${title}.` : `You said you can't do ${title}.`;
}
