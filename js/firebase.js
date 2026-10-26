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
  let listening = false;
  let user = null;
  let timer = null;
  let lastPing = 0;
  function fresh() {
    return { household: {}, people: {}, calendars: {}, feeds: [], shifts: {}, requests: {}, notes: {}, outbox: {}, status: {}, jobs: {}, ideas: {}, tokens: undefined, _priv: {}, _shared: {} };
  }
  function publish() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      raw.feeds = [...Object.values(raw._priv), ...Object.values(raw._shared)];
      setRaw(raw, { phase: 'ready', user: { email: user.email, name: user.displayName || '' } });
    }, 60);
  }
  function stopAll() { unsubs.forEach((u) => u()); unsubs = []; listening = false; }
  function mapColl(name, q, into, map, tries = 0) {
    let un = null;
    const holder = () => un && un();
    unsubs.push(holder);
    un = fs.onSnapshot(q, (snap) => {
      const obj = {};
      snap.forEach((d) => { obj[d.id] = map ? map(d.data(), d.id) : d.data(); });
      raw[into] = obj;
      publish();
    }, (err) => {
      console.warn(name, err);
      // right after the household is created the server may not know it yet: try again
      if (tries < 6) setTimeout(() => { if (unsubs.includes(holder)) mapColl(name, q, into, map, tries + 1); }, 1500 * (tries + 1));
    });
  }

  async function start(u) {
    user = u;
    stopAll();
    raw = fresh();
    setPhase('loading', { user: { email: u.email, name: u.displayName || '' } });
    unsubs.push(fs.onSnapshot(ref(''), { includeMetadataChanges: true }, (snap) => {
      if (!snap.exists()) { setPhase('setup', { user: { email: u.email, name: u.displayName || '' } }); return; }
      raw.household = snap.data();
      if (snap.metadata.hasPendingWrites) return; // wait until the server has it
      if (!listening) { listening = true; listenAll(); }
      publish();
    }, (err) => {
      // not allowed to read = not in this household
      setPhase('not-member', { user: { email: u.email, name: u.displayName || '' }, error: String(err && err.code || err) });
    }));
  }
  function listenAll() {
    const c = (name) => fs.collection(db, `${H}/${name}`);
    const email = user.email.toLowerCase();
    // only what's still relevant, so reads don't grow forever
    const since = (days) => Date.now() - days * 864e5;
    mapColl('people', c('people'), 'people');
    mapColl('calendars', c('calendars'), 'calendars');
    mapColl('shifts', fs.query(c('shifts'), fs.where('day', '>=', dayKeyOf(since(30)))), 'shifts');
    // a year and a bit: holiday bookings count towards the year's allowance
    mapColl('requests', fs.query(c('requests'), fs.where('created', '>=', since(400))), 'requests');
    mapColl('notes', fs.query(c('notes'), fs.where('created', '>=', since(30))), 'notes');
    mapColl('outbox', fs.query(c('outbox'), fs.where('done', '==', false)), 'outbox');
    mapColl('status', c('status'), 'status');
    mapColl('jobs', c('jobs'), 'jobs');
    mapColl('ideas', c('ideas'), 'ideas');
    mapColl('sharedFeeds', fs.query(c('sharedFeeds'), fs.where('ownerEmail', '!=', email)), '_shared', (d) => ({ owner: d.owner, calKey: d.calKey, private: false, events: d.events || [] }));
    mapColl('privateFeeds', fs.query(c('privateFeeds'), fs.where('ownerEmail', '==', email)), '_priv', (d) => ({ owner: d.owner, calKey: d.calKey, private: true, events: d.events || [] }));
    listenTokens();
  }
  // this person's phones (to spot a phone that has stopped getting notifications)
  let tokenUnsub = null;
  function listenTokens() {
    const people = raw.people || {};
    const me = Object.keys(people).find((pid) => (people[pid].email || '').toLowerCase() === user.email.toLowerCase());
    if (!me) { setTimeout(() => { if (listening) listenTokens(); }, 1500); return; }
    if (tokenUnsub) tokenUnsub();
    tokenUnsub = fs.onSnapshot(fs.collection(db, `${H}/people/${me}/tokens`), (snap) => {
      const obj = {};
      snap.forEach((d) => { obj[d.id] = true; });
      raw.tokens = obj;
      publish();
      refreshPush(me, obj);
    }, (err) => console.warn('tokens', err));
    unsubs.push(() => { if (tokenUnsub) tokenUnsub(); tokenUnsub = null; });
  }
  // Notification addresses change now and then. Each time the app opens, make sure this phone's is saved.
  let pushChecked = false;
  async function refreshPush(me, have) {
    if (pushChecked) return;
    pushChecked = true;
    try {
      if (!('Notification' in window) || Notification.permission !== 'granted' || localStorage.getItem('caledonite.push') !== '1') return;
      const fm = await import(`${SDK}/firebase-messaging.js`);
      if (!(await fm.isSupported())) return;
      const reg = await navigator.serviceWorker.ready;
      const token = await fm.getToken(fm.getMessaging(app), { vapidKey: FIREBASE.vapidKey, serviceWorkerRegistration: reg });
      const id = await sha1(token);
      localStorage.setItem('caledonite.pushId', id);
      if (!have[id]) await fs.setDoc(ref(`people/${me}/tokens/${id}`), { token, ua: navigator.userAgent.slice(0, 200), created: Date.now() });
    } catch (e) { console.warn('push refresh', e); }
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
    // Several changes, saved together. Saved on the phone straight away; sent when online.
    async commit(ops) {
      const b = fs.writeBatch(db);
      for (const o of ops) {
        if (o.type === 'set') b.set(ref(o.path), o.data);
        else if (o.type === 'update') b.set(ref(o.path), o.data, { merge: true });
        else if (o.type === 'add') b.set(fs.doc(fs.collection(db, `${H}/${o.path}`)), o.data);
        else if (o.type === 'delete') b.delete(ref(o.path));
        else if (o.type === 'unset') b.update(ref(o.path), { [o.field]: fs.deleteField() });
      }
      const p = b.commit();
      // offline the server never answers; the change is already saved on the phone.
      // If the server turns it down later (when back online), the phone undoes it: say so.
      let waited = false;
      p.catch((e) => { if (waited && backend.onLateError) backend.onLateError(e); });
      return Promise.race([p, new Promise((res) => setTimeout(() => { waited = true; res(); }, 1200))]);
    },
    async unset(path, field) { await fs.updateDoc(ref(path), { [field]: fs.deleteField() }); },
    async ping(force) {
      const h = raw.household || {};
      if (!h.pingUrl || !h.pingSecret) return false;
      // at most one quick sync every 2 minutes, unless asked for
      if (!force && Date.now() - lastPing < 120000) return true;
      lastPing = Date.now();
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
      try { localStorage.setItem('caledonite.push', '1'); localStorage.setItem('caledonite.pushId', id); } catch (e) { /* ignore */ }
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
        : { workLabel: 'Working', workStart: '09:00', workEnd: '18:00', workDays: [1, 2, 3, 4, 5], hasShifts: false };
      const secret = Array.from(crypto.getRandomValues(new Uint8Array(18))).map((x) => x.toString(16).padStart(2, '0')).join('');
      const emails = [myEmail, (partnerEmail || '').toLowerCase().trim()].filter(Boolean);
      await fs.setDoc(ref(''), {
        emails, created: Date.now(), dinnerTime: '19:00', moveDinner: true, pencilDefault: true, nudgeHours: 24,
        favours: ['Put the bins out', 'Pick up some shopping', 'Give me a lift', 'Book a table somewhere'],
        pingSecret: secret, pingUrl: '', settingsRev: Date.now()
      });
      await fs.setDoc(ref(`people/${a}`), { name: myName.trim(), email: myEmail, colour: 'blue', joined: true, settings: settingsFor(myShifts) });
      await fs.setDoc(ref(`people/${b}`), { name: partnerName.trim(), email: emails[1] || '', colour: 'orange', settings: settingsFor(partnerShifts) });
    }
  };
  return backend;
}

function dayKeyOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
async function sha1(s) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((x) => x.toString(16).padStart(2, '0')).join('');
}
export { DEFAULT_SETTINGS };
