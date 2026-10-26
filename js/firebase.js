// The real backend: Firebase sign-in (Google) and Firestore, with offline storage.
import { FIREBASE, HOUSEHOLD_PATH } from './config.js';
import { setRaw, setPhase, store } from './store.js';
import { DEFAULT_SETTINGS } from './logic.js';

export async function createFirebaseBackend() {
  const SDK = `https://www.gstatic.com/firebasejs/${FIREBASE.sdk}`;
  const [{ initializeApp }, fa, fs] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`)
  ]);
  const app = initializeApp(FIREBASE.config);
  const auth = fa.getAuth(app);
  let db;
  try {
    db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) });
  } catch (e) {
    db = fs.getFirestore(app);
  }
  const H = HOUSEHOLD_PATH;
  const ref = (path) => fs.doc(db, path ? `${H}/${path}` : H);

  let raw = fresh();
  let unsubs = [];
  let user = null;
  let timer = null;
  function fresh() {
    return { household: {}, people: {}, calendars: {}, feeds: [], shifts: {}, requests: {}, notes: {}, outbox: {}, status: {}, _priv: {}, _shared: {} };
  }
  function publish() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      raw.feeds = [...Object.values(raw._priv), ...Object.values(raw._shared)];
      setRaw(raw, { phase: 'ready', user: { email: user.email, name: user.displayName || '' } });
    }, 60);
  }
  function stopAll() { unsubs.forEach((u) => u()); unsubs = []; }
  function mapColl(name, q, into, map) {
    unsubs.push(fs.onSnapshot(q, (snap) => {
      const obj = {};
      snap.forEach((d) => { obj[d.id] = map ? map(d.data(), d.id) : d.data(); });
      raw[into] = obj;
      publish();
    }, (err) => console.warn(name, err)));
  }

  async function start(u) {
    user = u;
    stopAll();
    raw = fresh();
    setPhase('loading', { user: { email: u.email, name: u.displayName || '' } });
    unsubs.push(fs.onSnapshot(ref(''), (snap) => {
      if (!snap.exists()) { setPhase('setup', { user: { email: u.email, name: u.displayName || '' } }); return; }
      raw.household = snap.data();
      if (unsubs.length === 1) listenAll();
      publish();
    }, (err) => {
      // not allowed to read = not in this household
      setPhase('not-member', { user: { email: u.email, name: u.displayName || '' }, error: String(err && err.code || err) });
    }));
  }
  function listenAll() {
    const c = (name) => fs.collection(db, `${H}/${name}`);
    mapColl('people', c('people'), 'people');
    mapColl('calendars', c('calendars'), 'calendars');
    mapColl('shifts', c('shifts'), 'shifts');
    mapColl('requests', c('requests'), 'requests');
    mapColl('notes', c('notes'), 'notes');
    mapColl('outbox', fs.query(c('outbox'), fs.where('done', '==', false)), 'outbox');
    mapColl('status', c('status'), 'status');
    mapColl('sharedFeeds', c('sharedFeeds'), '_shared', (d) => ({ owner: d.owner, calKey: d.calKey, private: false, events: d.events || [] }));
    mapColl('privateFeeds', fs.query(c('privateFeeds'), fs.where('ownerEmail', '==', user.email.toLowerCase())), '_priv', (d) => ({ owner: d.owner, calKey: d.calKey, private: true, events: d.events || [] }));
  }

  fa.onAuthStateChanged(auth, (u) => {
    if (!u) { stopAll(); setPhase('signed-out', { user: null }); return; }
    start(u);
  });
  try { await fa.getRedirectResult(auth); } catch (e) { /* ignore */ }

  const backend = {
    demo: false,
    async init() {},
    async set(path, data) { await fs.setDoc(ref(path), data); },
    async update(path, patch) { await fs.setDoc(ref(path), patch, { merge: true }); },
    async add(coll, data) { const r = await fs.addDoc(fs.collection(db, `${H}/${coll}`), data); return r.id; },
    async del(path) { await fs.deleteDoc(ref(path)); },
    async ping() {
      const h = raw.household || {};
      if (!h.pingUrl || !h.pingSecret) return false;
      try {
        await fetch(h.pingUrl, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ secret: h.pingSecret, action: 'ping' }) });
        return true;
      } catch (e) { return false; }
    },
    async enableNotifications() {
      if (!('Notification' in window) || !('serviceWorker' in navigator)) return { ok: false, reason: 'This phone or browser can’t show notifications from web apps.' };
      if (!FIREBASE.vapidKey) return { ok: false, reason: 'Notifications aren’t set up yet.' };
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return { ok: false, reason: 'Notifications were blocked. You can allow them in Chrome’s site settings.' };
      const fm = await import(`${SDK}/firebase-messaging.js`);
      if (!(await fm.isSupported())) return { ok: false, reason: 'This browser doesn’t support web notifications.' };
      const reg = await navigator.serviceWorker.ready;
      const token = await fm.getToken(fm.getMessaging(app), { vapidKey: FIREBASE.vapidKey, serviceWorkerRegistration: reg });
      const me = store.state.me;
      const id = await sha1(token);
      await fs.setDoc(ref(`people/${me}/tokens/${id}`), { token, ua: navigator.userAgent.slice(0, 200), created: Date.now() });
      try { localStorage.setItem('calendite.push', '1'); } catch (e) { /* ignore */ }
      return { ok: true };
    },
    async signIn() {
      const p = new fa.GoogleAuthProvider();
      p.setCustomParameters({ prompt: 'select_account' });
      try { await fa.signInWithPopup(auth, p); } catch (e) {
        if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')) await fa.signInWithRedirect(auth, p);
        else throw e;
      }
    },
    async signOut() { await fa.signOut(auth); },
    async createHousehold({ myName, myShifts, partnerName, partnerEmail, partnerShifts }) {
      const myEmail = user.email.toLowerCase();
      const slug = (n, fallback) => (n || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20) || fallback;
      let a = slug(myName, 'me');
      let b = slug(partnerName, 'partner');
      if (a === b) b = b + '2';
      const settingsFor = (shifts) => shifts
        ? { workLabel: 'Working', workDays: [], hasShifts: true, sleepUntil: '14:00', travelMins: 30 }
        : { workLabel: 'Working', workStart: '09:00', workEnd: '17:30', workDays: [1, 2, 3, 4, 5], hasShifts: false };
      const secret = Array.from(crypto.getRandomValues(new Uint8Array(18))).map((x) => x.toString(16).padStart(2, '0')).join('');
      const emails = [myEmail, (partnerEmail || '').toLowerCase().trim()].filter(Boolean);
      await fs.setDoc(ref(''), {
        emails, created: Date.now(), dinnerTime: '19:00', moveDinner: true, pencilDefault: true, nudgeHours: 24,
        favours: ['Put the bins out', 'Pick up some shopping', 'Give me a lift', 'Book a table somewhere'],
        pingSecret: secret, pingUrl: '', linked: [], settingsRev: Date.now()
      });
      await fs.setDoc(ref(`people/${a}`), { name: myName.trim(), email: myEmail, colour: 'blue', settings: settingsFor(myShifts) });
      await fs.setDoc(ref(`people/${b}`), { name: partnerName.trim(), email: emails[1] || '', colour: 'orange', settings: settingsFor(partnerShifts) });
    }
  };
  return backend;
}

async function sha1(s) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((x) => x.toString(16).padStart(2, '0')).join('');
}
export { DEFAULT_SETTINGS };
