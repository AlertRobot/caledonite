// The real backend: Firebase sign-in (Google) and Firestore, with offline storage.
import { FIREBASE, HOUSEHOLD_PATH } from './config.js';
import { setRaw, setPhase, store, setupOps } from './store.js';

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
  let creating = false;
  function fresh() {
    return { household: {}, people: {}, calendars: {}, feeds: [], shifts: {}, requests: {}, notes: {}, outbox: {}, status: {}, jobs: {}, ideas: {}, tokens: undefined, private: undefined, _priv: {}, _shared: {} };
  }
  function publish() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      raw.feeds = [...Object.values(raw._priv), ...Object.values(raw._shared)];
      setRaw(raw, { phase: 'ready', user: { email: user.email, name: user.displayName || '' } });
    }, 60);
  }
  // (and anything about to be shown: drawn after signing out, it would bring back what was there)
  function stopAll() { clearTimeout(timer); unsubs.forEach((u) => u()); unsubs = []; listening = false; }
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
      if (!snap.exists()) {
        // offline with nothing saved on this phone yet isn't "no household": wait for the server
        if (snap.metadata.fromCache) return;
        // ask the server once more before offering the first-time setup: a phone whose saved copy was just
        // cleared (the site's data deleted while the app was open) can be told "not there" when it is
        confirmMissing().then((d) => {
          if (user !== u) return;
          if (d) { useHousehold(d); return; }
          const who = { user: { email: u.email, name: u.displayName || '' } };
          // the server has it, but this phone's saved copy says it doesn't: never the first-time setup
          if (lastDirect === 'exists') { setPhase('stuck', who); return; }
          if (lastDirect === 'denied') { setPhase('not-member', Object.assign(who, { error: 'permission-denied' })); return; }
          setPhase('setup', Object.assign(who, { setupCheck: lastCheck }));
        });
        return;
      }
      raw.household = snap.data();
      if (!listening) {
        // just made on this phone: wait until the server has it. (Not a change saved offline earlier and still
        // waiting to be sent: offline, that would keep the app loading until it's back online.)
        if (creating && snap.metadata.hasPendingWrites) return;
        listening = true; listenAll();
      }
      // a change you've just made (offline too) shows straight away
      publish();
    }, (err) => {
      // not allowed to read = not in this household
      setPhase('not-member', { user: { email: u.email, name: u.displayName || '' }, error: String(err && err.code || err) });
    }));
  }
  // the household as the server has it, or null if it really isn't there (or can't be reached or read)
  // (what it said is shown on the setup page, so a phone that's wrongly offered it can say why)
  let lastCheck = '';
  let lastDirect = '';
  async function confirmMissing() {
    lastDirect = '';
    try {
      const d = await fs.getDocFromServer(ref(''));
      lastCheck = d.exists() ? 'found' : 'not found on the server';
      if (d.exists()) return d.data();
    } catch (e) { console.warn('household check', e); lastCheck = 'couldn\u2019t check (' + String((e && e.code) || e) + ')'; }
    // asked once more straight from the server's web address, past this phone's saved copy: after the site's data is
    // cleared while the app was open, that copy can get stuck and answer "not there" even when asked for the server's
    lastDirect = await direct();
    if (lastDirect === 'exists') { lastCheck = 'there on the server, but this phone\u2019s saved copy is stuck'; healCache(true); }
    else if (lastDirect === 'missing') lastCheck = 'not found on the server';
    else if (lastDirect === 'denied') lastCheck = 'not open to this account';
    lastCheck += ' at ' + new Date().toTimeString().slice(0, 5);
    return null;
  }
  // the household as the server has it, as this account (the rules apply as usual): exists, missing, denied or error
  async function direct() {
    try {
      if (!user || !user.getIdToken) return 'error';
      const tok = await user.getIdToken();
      const r = await fetch(`https://firestore.googleapis.com/v1/projects/${FIREBASE.config.projectId}/databases/(default)/documents/${H}`, { headers: { Authorization: `Bearer ${tok}` }, cache: 'no-store' });
      return r.status === 200 ? 'exists' : r.status === 404 ? 'missing' : r.status === 403 ? 'denied' : 'error';
    } catch (e) { console.warn('direct check', e); return 'error'; }
  }
  // this phone's saved copy of Caledonite's data is thrown away and the app opens again, fetching everything afresh.
  // Done by itself once (not again within a few minutes, so it can never keep reloading); the stuck page's button
  // does it on request. Only Caledonite's own copy: Peckish shares this web address and keeps its own.
  async function healCache(auto) {
    const KEY = 'caledonite.healedAt';
    try { if (auto && Date.now() - (+sessionStorage.getItem(KEY) || 0) < 5 * 60000) return false; sessionStorage.setItem(KEY, String(Date.now())); } catch (e) { if (auto) return false; }
    stopAll();
    try { await fs.terminate(db); await fs.clearIndexedDbPersistence(db); } catch (e) {
      console.warn('clear saved copy', e);
      try {
        const all = indexedDB.databases ? await indexedDB.databases() : [];
        await Promise.all(all.filter((x) => /^firestore\//.test(x.name || '') && x.name.includes(`/${FIREBASE.config.projectId}/`)).map((x) => new Promise((res) => {
          const q = indexedDB.deleteDatabase(x.name); q.onsuccess = q.onerror = q.onblocked = () => res();
        })));
      } catch (e2) { console.warn('clear saved copy', e2); }
    }
    location.reload();
    return true;
  }
  function useHousehold(d) {
    raw.household = d;
    if (!listening) { listening = true; listenAll(); }
    publish();
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
    mapColl('outbox', fs.query(c('outbox'), fs.where('byEmail', '==', email), fs.where('done', '==', false)), 'outbox');
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
    // what's just for you (reminders, private countdowns): only you can read it
    // (whether it's what the server has, or only what this phone saved: moving older things in waits for the server)
    const privUnsub = fs.onSnapshot(ref(`people/${me}/private/main`), { includeMetadataChanges: true }, (snap) => {
      raw.private = snap.exists() ? snap.data() : {};
      raw.privateFromServer = !snap.metadata.fromCache;
      publish();
    }, (err) => console.warn('private', err));
    unsubs.push(privUnsub);
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
        // a change to something that must still be there (a job or idea the other phone may have just removed):
        // never made again as a blank one
        else if (o.type === 'patch') b.update(ref(o.path), o.data);
        else if (o.type === 'add') b.set(fs.doc(fs.collection(db, `${H}/${o.path}`)), o.data);
        else if (o.type === 'delete') b.delete(ref(o.path));
        // taken out of a map (a.b.c), whether or not the document is there yet
        else if (o.type === 'unset') b.set(ref(o.path), o.field.split('.').reduceRight((inner, k) => ({ [k]: inner }), fs.deleteField()), { merge: true });
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
    // this phone stops getting your notifications (given a moment, so signing out offline still works)
    async signOut() {
      try {
        const id = localStorage.getItem('caledonite.pushId');
        const me = store.state.me;
        localStorage.removeItem('caledonite.push'); localStorage.removeItem('caledonite.pushId');
        if (id && me) await Promise.race([fs.deleteDoc(ref(`people/${me}/tokens/${id}`)), new Promise((res) => setTimeout(res, 2000))]);
      } catch (e) { console.warn('push off', e); }
      await fa.signOut(auth);
    },
    // the household and both of you, in one go: the rules only allow your two records while the household is being made
    // the setup page's Check again: start over as this account
    recheck() { if (user) start(user); },
    // the stuck page's "Fix this phone"
    heal() { return healCache(false); },
    async createHousehold(info) {
      const b = fs.writeBatch(db);
      for (const o of setupOps(user.email, info)) b.set(ref(o.path), o.data);
      creating = true;
      try { await b.commit(); } catch (e) {
        // already set up (this phone just couldn't see it): open it, never a second household
        const d = await confirmMissing();
        if (d) { useHousehold(d); return 'exists'; }
        e.check = lastCheck;
        throw e;
      } finally { creating = false; }
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
