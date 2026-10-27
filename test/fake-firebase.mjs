// A stand-in for the Firebase SDK, served to the page in place of gstatic's, so js/firebase.js can be checked
// in a browser without a real project. The test drives it through window.__fb:
//   __fb.user                         who is signed in (set before the page loads, with addInitScript)
//   __fb.emitDoc(path, data, meta)    a document snapshot (data null: no such document; meta: { pending, fromCache })
//   __fb.emitColl(path, { id: data }) a collection or query snapshot
//   __fb.listening(path)              whether something is listening there
//   __fb.writes                       what the app saved
//   __fb.authChanged(user)            the sign-in changing (null: signed out)
//   __fb.server[path]                 what getDocFromServer finds there (missing: no such document)
//   __fb.failCommit                   a batch commit is turned down (as the rules would)
const SHARED = `
const fb = window.__fb = window.__fb || {};
fb.listeners = fb.listeners || [];
fb.writes = fb.writes || [];
fb.server = fb.server || {};
fb.emitDoc = (path, data, meta = {}) => fb.listeners.filter((l) => l.path === path).forEach((l) => l.next({
  id: path.split('/').pop(), exists: () => data != null, data: () => data,
  metadata: { hasPendingWrites: !!meta.pending, fromCache: !!meta.fromCache }
}));
fb.emitColl = (path, docs) => fb.listeners.filter((l) => l.path === path).forEach((l) => l.next({
  forEach: (fn) => Object.entries(docs).forEach(([id, d]) => fn({ id, data: () => d }))
}));
fb.listening = (path) => fb.listeners.some((l) => l.path === path);
export default fb;
`;
const MODULES = {
  'firebase-app.js': `export function initializeApp(config) { return { config }; }`,
  'firebase-auth.js': `${SHARED}
export function getAuth(app) { return { app }; }
export function onAuthStateChanged(auth, cb) { fb.authChanged = cb; setTimeout(() => cb(fb.user || null), 0); return () => {}; }
export async function getRedirectResult() { return null; }
export class GoogleAuthProvider { setCustomParameters() {} }
export async function signInWithPopup() {}
export async function signInWithRedirect() {}
export async function signOut() {}`,
  'firebase-firestore.js': `${SHARED}
export function initializeFirestore() { return {}; }
export function getFirestore() { return {}; }
export function persistentLocalCache() { return {}; }
export function persistentMultipleTabManager() { return {}; }
export function doc(db, path) { return { path }; }
export function collection(db, path) { return { path }; }
export function query(c) { return { path: c.path }; }
export function where() { return null; }
export function deleteField() { return { deleteField: true }; }
export function onSnapshot(ref, a, b, c) {
  const l = typeof a === 'function' ? { path: ref.path, next: a, err: b } : { path: ref.path, next: b, err: c };
  fb.listeners.push(l);
  return () => { fb.listeners = fb.listeners.filter((x) => x !== l); };
}
export function writeBatch() {
  const ops = [];
  return { set: (r, d, o) => ops.push({ type: 'set', path: r.path, data: d, merge: !!(o && o.merge) }), update: (r, d) => ops.push({ type: 'update', path: r.path, data: d }), delete: (r) => ops.push({ type: 'delete', path: r.path }), commit: async () => { if (fb.failCommit) { const e = new Error('Missing or insufficient permissions.'); e.code = 'permission-denied'; throw e; } fb.writes.push(...ops); } };
}
export async function getDocFromServer(r) {
  const d = fb.server[r.path];
  return { id: r.path.split('/').pop(), exists: () => d != null, data: () => d, metadata: { hasPendingWrites: false, fromCache: false } };
}
export async function setDoc(r, d, o) { fb.writes.push({ type: 'set', path: r.path, data: d, merge: !!(o && o.merge) }); }
export async function addDoc(c, d) { fb.writes.push({ type: 'add', path: c.path, data: d }); return { id: 'x' + fb.writes.length }; }
export async function deleteDoc(r) { fb.writes.push({ type: 'delete', path: r.path }); }
export async function updateDoc(r, d) { fb.writes.push({ type: 'update', path: r.path, data: d }); }`
};

export async function useFakeFirebase(page, user) {
  await page.addInitScript((u) => { window.__fb = { user: u }; }, user);
  await page.route(/https:\/\/www\.gstatic\.com\/firebasejs\/[^/]+\/([a-z-]+\.js)/, (route) => {
    const name = route.request().url().split('/').pop();
    const body = MODULES[name];
    if (!body) return route.abort();
    return route.fulfill({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body });
  });
}
