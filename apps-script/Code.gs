/**
 * Caledonite calendar sync.
 *
 * One copy of this script serves everyone, but only Ethan (the owner) ever edits it.
 * Every other Google account (Sophie, a second Gmail, a work account) connects through
 * the Connect page, which runs as that person. They never need to open this editor, so
 * they never see the service account key in Script properties and can't change the code.
 *
 * From then on it runs by itself every 10 minutes under each connected account:
 *   - reads the calendars that account can see (including shared family/friends ones)
 *   - writes a full copy for the owner, and a privacy-filtered copy for the partner
 *   - adds, changes and removes events asked for in the app (requests, Add, the event page)
 *   - sends phone notifications: requests, notes, rota changes, reminders, jobs, summaries
 *   - once a week, backs up the app's own data to the owner's Google Drive
 *
 * Two web app deployments (Deploy > Manage deployments), both from this project:
 *   1. Ping: execute as Me, access Anyone (even anonymous). The app calls it to sync now.
 *      Its address goes in the script property PING_URL. It serves no web page.
 *   2. Connect: execute as User accessing the web app, access Anyone with a Google account.
 *      Its address goes in CONNECT_URL. Each new account opens it once and taps Connect.
 * After a code change, give both deployments a new version.
 *
 * Script properties (Project Settings > Script properties):
 *   PROJECT_ID   the Firebase project id
 *   SA_JSON      the Firebase service account key (paste the whole JSON file)
 *   PING_URL     the ping deployment's address
 *   CONNECT_URL  the connect deployment's address
 * Then run setupProject once (owner only).
 */

var HOUSEHOLD = 'households/main';
var DAYS_BACK = 14;
var DAYS_AHEAD = 120;
var TZ = 'Europe/London';
var RUN_STARTED_ = 0;   // when this run started (a run is stopped by Google after 6 minutes)
var OUTBOX_BUDGET_ = 200e3;   // no new change to Google Calendar is started after this long into a run
var NOTIFY_BUDGET_ = 300e3;   // nor a new notification after this
function timeUsed_() { return RUN_STARTED_ ? Date.now() - RUN_STARTED_ : 0; }
var WEEKDAYS_ = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
var MONTHS_ = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ===================== things you run =====================

/** The owner runs this once from the editor. Everyone else uses the Connect page. */
function connectMe() {
  requireSelf_();
  var me = whoAmI_();
  installTrigger_();
  PropertiesService.getUserProperties().setProperty('me_person', me.person);
  var r = syncAll();
  Logger.log('Connected ' + me.email + ' as ' + me.person + (me.main ? '' : ' (extra account)') + '. ' + r);
  return r;
}

/** Run once by the owner after setting up the two deployments. */
function setupProject() {
  requireSelf_();
  requireCreator_();
  var patch = { scriptUrl: 'https://script.google.com/d/' + ScriptApp.getScriptId() + '/edit' };
  var ping = prop_('PING_URL', true) || prop_('WEBAPP_URL', true) || ScriptApp.getService().getUrl();
  if (ping) patch.pingUrl = ping;
  var connect = prop_('CONNECT_URL', true);
  if (connect) patch.connectUrl = connect;
  fsCommit_([upd_(HOUSEHOLD, patch)]);
  CacheService.getScriptCache().remove('ping_secret');
  Logger.log('Saved the sync addresses in Caledonite. Now connecting this account...');
  return connectMe();
}

/** Stop syncing this Google account. */
function disconnectMe() {
  requireSelf_();
  stopSyncing_();
  Logger.log('This account will no longer sync.');
}

/** Owner only: back up the app's data to Google Drive now. */
function backupNow() {
  requireSelf_();
  var hh = requireCreator_();
  var me = whoAmI_();
  var name = backup_(me, { hh: hh }, true);
  Logger.log('Saved ' + name + ' in the Caledonite backups folder in Google Drive.');
  return name;
}

// An account that has been removed in the app: what it wrote goes, and it stops running every 10 minutes
function forgetThisAccount_(email) {
  var props = PropertiesService.getUserProperties();
  var all = props.getProperties();
  // never connected here (someone who just opened the connect page): nothing to tidy up
  if (!Object.keys(all).length && !hasTrigger_()) return;
  var writes = copiesWritten_(all, email);
  fsQuery_('calendars', [['account', email]]).forEach(function (d) { writes.push({ 'delete': docName_(HOUSEHOLD + '/calendars/' + d.id) }); });
  fsCommit_(writes);
  props.deleteAllProperties();
  removeTriggers_();
}

// Stop syncing this account: it stops running, and the copies it wrote go too, so none are left behind that
// no longer follow your sharing choices. Its calendars' settings stay, for if it's connected again.
function stopSyncing_() {
  var had = hasTrigger_();
  removeTriggers_();
  var lock = LockService.getUserLock();
  if (!lock.tryLock(60000)) throw new Error('This account is in the middle of syncing. Try again in a minute.');
  var claim = '';
  try {
    for (var i = 0; i < 20 && !(claim = claimRun_()); i++) Utilities.sleep(3000);
    if (!claim) throw new Error('This account is in the middle of syncing. Try again in a minute.');
    var email = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
    var props = PropertiesService.getUserProperties();
    var all = props.getProperties();
    // never connected (or already stopped): nothing written to take out, and nothing to write (anyone with a
    // Google account can open the connect page, and their address could look like one of yours with dots for dashes)
    if (!had && !Object.keys(all).some(function (k) { return /^(h|rota)_/.test(k); })) return;
    fsCommit_(copiesWritten_(all, email));
    Object.keys(all).forEach(function (k) { if (/^(h|rota)_/.test(k)) props.deleteProperty(k); });
  } finally {
    if (claim) releaseRun_(claim);
    lock.releaseLock();
  }
}

// Deleting every copy this account remembers writing, and its status. Not a calendar another of your accounts
// has taken over since (same addresses): those copies are that account's now, and it would never write them again.
function copiesWritten_(all, email) {
  var writes = [];
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('h_') !== 0) return;
    var old = {};
    try { old = JSON.parse(all[k] || '{}'); } catch (e) { old = {}; }
    var paths = Object.keys(old);
    if (!paths.length) return;
    var ck = k.slice(2);
    var person = (String(paths[0]).split('/').pop() || '').split('__')[0];
    if (ck !== 'rotalink' && person && /^[A-Za-z0-9_-]+$/.test(person + ck) && otherAccount_(fsGet_(HOUSEHOLD + '/calendars/' + person + '__' + ck), email)) return;
    paths.forEach(function (path) { writes.push({ 'delete': docName_(path) }); });
  });
  if (email) writes.push({ 'delete': docName_(HOUSEHOLD + '/status/' + email.replace(/[^a-z0-9]+/g, '_')) });
  return writes;
}
// A calendar record saying another of your Google accounts writes its copies now
function otherAccount_(doc, email) {
  var acc = String((doc && doc.account) || '').toLowerCase();
  return !!acc && acc !== 'rota link' && acc !== String(email || '').toLowerCase();
}
function hasTrigger_() {
  return ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'syncAll'; });
}

function installTrigger_() {
  removeTriggers_();
  ScriptApp.newTrigger('syncAll').timeBased().everyMinutes(10).create();
}
function removeTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncAll') ScriptApp.deleteTrigger(t);
  });
}
// Only as the person themselves: from the editor, or the connect page (which runs as whoever opens it).
// Never in the ping deployment, which runs as Ethan for anyone at all.
function requireSelf_() {
  var active = '';
  try { active = String(Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (e) { active = ''; }
  var effective = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (!active || active !== effective) throw new Error('Open this page signed in to the Google account you want to connect.');
}
function requireCreator_() {
  var email = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  var hh = fsGet_(HOUSEHOLD);
  if (!hh) throw new Error('Open Caledonite and finish the first-time setup first.');
  if (String((hh.emails || [])[0] || '').toLowerCase() !== email) throw new Error('Only the person who set up Caledonite can run this.');
  return hh;
}

// ===================== the Connect page (runs as the person visiting) =====================

function doGet(e) {
  var active = '';
  try { active = String(Session.getActiveUser().getEmail() || ''); } catch (err) { active = ''; }
  // the anonymous ping deployment: no page, so no way to call functions from a browser
  if (!active) return text_('Caledonite sync is running.');
  var email = active.toLowerCase();
  var status;
  try {
    var me = whoAmI_();
    status = { ok: true, text: 'This account is part of Caledonite' + (me.main ? '.' : ', as one of ' + esc_(nameOf_(me)) + "'s extra accounts.") };
  } catch (err) {
    status = { ok: false, text: 'This account is not part of Caledonite yet. Ask Ethan to add ' + esc_(email) + ' in Caledonite: Settings, then Account. Then open this page again.' };
  }
  var html = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&display=swap">' +
    '<style>body{font-family:"Atkinson Hyperlegible",Verdana,Arial,sans-serif;font-size:20px;line-height:1.5;margin:0;padding:24px;background:#F7F5F0;color:#1B1B1F}' +
    'main{max-width:560px;margin:0 auto}h1{font-size:30px;margin:0 0 12px}p{margin:0 0 16px}' +
    '.box{background:#fff;border-radius:16px;padding:20px;margin:0 0 20px;border:2px solid #E2DED6}' +
    '.ok{border-color:#1D6A48}.no{border-color:#B8401E}' +
    'button{font:inherit;font-weight:700;border-radius:14px;border:none;cursor:pointer;display:block;width:100%}' +
    '#c{background:#2456C7;color:#fff;font-size:22px;padding:18px;margin:0 0 14px}#c:disabled{opacity:.5}' +
    '#d{background:transparent;color:#2456C7;font-size:18px;padding:12px;border:2px solid #2456C7}' +
    '#out{font-weight:700;min-height:1.5em}</style></head><body><main>' +
    '<h1>Connect to Caledonite</h1>' +
    '<div class="box"><p>Signed in as <b>' + esc_(email) + '</b>.</p><p>' + status.text + '</p></div>' +
    (status.ok ? '<p>Tap the button once. Caledonite then reads this account\'s calendars by itself every 10 minutes.</p>' +
      '<button id="c" onclick="go(\'connectFromPage\')">Connect my calendar</button>' +
      '<button id="d" onclick="go(\'disconnectFromPage\')">Stop syncing this account</button>' : '') +
    '<p id="out" role="status" aria-live="polite"></p>' +
    '<script>function go(fn){var o=document.getElementById("out"),c=document.getElementById("c");o.textContent="Working on it. This can take up to a minute.";if(c)c.disabled=true;' +
    'google.script.run.withSuccessHandler(function(m){o.textContent=m;if(c)c.disabled=false;}).withFailureHandler(function(e){o.textContent=(e&&e.message)||String(e);if(c)c.disabled=false;})[fn]();}</script>' +
    '</main></body></html>';
  return HtmlService.createHtmlOutput(html).setTitle('Connect to Caledonite').addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function connectFromPage() {
  requireSelf_();
  var me;
  try { me = whoAmI_(); } catch (err) {
    throw new Error('This Google account is not part of Caledonite yet. Ask Ethan to add it in Caledonite: Settings, then Account.');
  }
  installTrigger_();
  // its own owner, on the page that says whose it is: from now on it syncs as that person
  PropertiesService.getUserProperties().setProperty('me_person', me.person);
  var r = syncAll();
  var n = (String(r).match(/(\d+) calendar/) || [])[1];
  return 'Connected. ' + (n ? n + ' calendar' + (n === '1' ? '' : 's') + ' synced. ' : '') + 'Caledonite now keeps ' + (me.main ? 'your' : 'this account\'s') + ' calendars up to date by itself. You can close this page.';
}
function disconnectFromPage() {
  requireSelf_();
  stopSyncing_();
  return 'Stopped. This account no longer syncs to Caledonite, and its events have been taken out of the app.';
}
function nameOf_(me) {
  for (var i = 0; i < me.people.length; i++) if (me.people[i].id === me.person) return me.people[i].data.name || me.person;
  return me.person;
}
function esc_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ===================== ping (instant sync from the app) =====================

function doPost(e) {
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { body = {}; }
  // the secret first, from the cache, so a stranger's request costs at most one read
  var cache = CacheService.getScriptCache();
  var secret = cache.get('ping_secret');
  if (!secret) {
    var hh = fsGet_(HOUSEHOLD) || {};
    secret = hh.pingSecret || '';
    if (secret) cache.put('ping_secret', secret, 21600);
  }
  if (!body.secret || !secret || body.secret !== secret) return text_('no');
  if (cache.get('last_ping')) return text_('ok');
  cache.put('last_ping', String(Date.now()), 45);
  // the owner's account stopped syncing: a ping doesn't start it again
  if (!hasTrigger_()) return text_('not connected');
  try { syncAll({ fromPing: true }); } catch (err) { return text_('error: ' + err.message); }
  return text_('ok');
}
function text_(s) { return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.TEXT); }

// ===================== the sync =====================

// opts: { fromPing: true } from the ping (a time-driven run is handed Google's own event instead)
function syncAll(opts) {
  RUN_STARTED_ = Date.now();
  var lock = LockService.getUserLock();
  if (!lock.tryLock(25000)) return 'already running';
  var me = null;
  var errors = [];
  var n = 0;
  var claim = '';
  try {
    // and never two runs of one account at once, whichever way they started (Google doesn't say whose lock
    // the ping deployment, running as Ethan for no one in particular, gets)
    claim = claimRun_();
    if (!claim) return 'already running';
    // "Stop syncing" may have finished while this ping waited its turn: never write the copies back
    if (opts && opts.fromPing === true && !hasTrigger_()) return 'not connected';
    try { me = whoAmI_(); } catch (err) {
      // taken out of Caledonite (Settings, Account): take its calendars out too, and stop
      if (err && err.notMember) forgetThisAccount_(err.email);
      throw err;
    }
    // An account only ever syncs as the person it was connected as. Anyone can list any address on their own
    // record, so without this one of your extra accounts, once taken off your list, would be copied in full into
    // your partner's private copy. Moving it to the other person takes its own owner opening the connect page.
    var was = PropertiesService.getUserProperties().getProperty('me_person');
    if (was && was !== me.person) {
      var moved = new Error(me.email + ' was connected as ' + was + "'s account and is now listed for someone else, so it is not synced. Take it off the wrong person in Settings, Account, or open the connect page signed in to it to connect it again.");
      try { writeStatus_({ email: me.email, person: was, main: false }, [moved.message], 0); } catch (e3) { /* it's only the status */ }
      throw moved;
    }
    if (!was) PropertiesService.getUserProperties().setProperty('me_person', me.person);
    var ctx = loadCtx_(me);
    var stage = function (name, fn) {
      try { return fn(); } catch (err) {
        var msg = name + ': ' + String(err && err.message || err);
        Logger.log(msg);
        errors.push(msg.slice(0, 200));
        return null;
      }
    };
    var seen = [];
    var cal = stage('calendars', function () { return syncCalendars_(me, ctx, errors); });
    if (cal) { n = cal.count; seen = cal.seen; }
    if (me.main) stage('rota link', function () { var url = rotaUrlOf_(me, ctx); if (url) syncRotaLink_(me, ctx, url); else dropRotaLink_(me); });
    var changed = stage('outbox', function () { return processOutbox_(me, ctx); });
    // let the feeds catch up straight away, unless reading every calendar again could run into Google stopping this
    // run (and the reminders and notifications after it): the next run catches up
    if (changed && timeUsed_() < 150e3) {
      var again = stage('calendars after changes', function () { ctx.calDocs = loadCalDocs_(me); return syncCalendars_(me, ctx, errors); });
      if (again) { n = again.count; seen = again.seen; }
    }
    if (me.main) stage('nudges', function () { nudgeRequests_(me, ctx); });
    stage('reminders', function () { fireReminders_(me, ctx, seen); });
    if (me.main) stage('jobs', function () { processJobs_(me, ctx); });
    if (me.main) stage('summaries', function () { digests_(me, ctx); });
    if (me.main && isCreator_(me, ctx)) stage('backup', function () { backup_(me, ctx, false); });
    stage('notifications', function () { processNotify_(ctx); });
    try { writeStatus_(me, errors, n); } catch (e2) { Logger.log('status: ' + e2.message); }
    return 'Synced ' + n + ' calendars.' + (errors.length ? ' Problems: ' + errors.join(' | ') : '');
  } finally {
    if (claim) releaseRun_(claim);
    lock.releaseLock();
  }
}
// This account's run, marked in the script's cache under the script lock (held only for a moment).
// It runs out after 400 seconds, longer than a run can last, in case a run is stopped part way.
function claimRun_() {
  var email = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  var key = 'run_' + email.replace(/[^a-z0-9]+/g, '_');
  var cache = CacheService.getScriptCache();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return '';
  try {
    if (cache.get(key)) return '';
    cache.put(key, String(Date.now()), 400);
    return key;
  } finally {
    lock.releaseLock();
  }
}
function releaseRun_(key) { try { CacheService.getScriptCache().remove(key); } catch (e) { /* it runs out by itself */ } }
function isCreator_(me, ctx) {
  return String(((ctx.hh || {}).emails || [])[0] || '').toLowerCase() === me.email;
}

function whoAmI_() {
  var email = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (!email) throw new Error('Could not tell which Google account this is.');
  var notOne = function (taken) {
    var e = new Error(email + ' is not part of Caledonite. Add it in Caledonite: Settings, Account, then connect it again.');
    e.notMember = taken;
    e.email = email;
    return e;
  };
  // found not to be one of you a moment ago: no reading the household again (someone who isn't one of you,
  // opening the connect page over and over, can't use up the day's free database reads)
  var nmKey = 'nm_' + email.replace(/[^a-z0-9]+/g, '_');
  var cache = null;
  try { cache = CacheService.getScriptCache(); } catch (err) { cache = null; }
  if (cache && cache.get(nmKey)) throw notOne(false);
  var people = fsList_(HOUSEHOLD + '/people');
  // Each account belongs to exactly one of you. If two records claim it, sync nothing: syncing it as the wrong
  // person would copy that account's whole calendar into the other person's private copy.
  var one = function (ids, main) {
    var uniq = ids.filter(function (x, k) { return ids.indexOf(x) === k; });
    if (uniq.length > 1) throw new Error(email + ' is listed for more than one person in Caledonite, so it is not synced. Remove it from the wrong person in Settings, Account.');
    return uniq.length ? { email: email, person: uniq[0], main: main, people: people } : null;
  };
  var found = one(people.filter(function (p) { return String(p.data.email || '').toLowerCase() === email; }).map(function (p) { return p.id; }), true);
  if (found) return found;
  // extra accounts each person added to their own record, and the older list on the household
  var claims = people.filter(function (p) {
    return (p.data.linked || []).map(function (x) { return String(x || '').toLowerCase(); }).indexOf(email) >= 0;
  }).map(function (p) { return p.id; });
  var hh = fsGet_(HOUSEHOLD) || {};
  (hh.linked || []).forEach(function (x) { if (String(x.email || '').toLowerCase() === email && x.person) claims.push(x.person); });
  found = one(claims, false);
  if (found) return found;
  // only when the household could be read: a passing problem must never look like being taken out
  var e = notOne(people.length > 0);
  if (e.notMember && cache) { try { cache.put(nmKey, '1', 120); } catch (err) { /* it's only a saving */ } }
  throw e;
}

function loadCtx_(me) {
  var hh = fsGet_(HOUSEHOLD) || {};
  var people = {};
  me.people.forEach(function (p) { people[p.id] = p.data; });
  var person = people[me.person] || {};
  // the email whose copies these are must be this person's alone, or another of your accounts could be written
  // as readable by someone else
  var appEmail = String(person.email || '').toLowerCase();
  if (appEmail && me.people.some(function (p) { return p.id !== me.person && String(p.data.email || '').toLowerCase() === appEmail; })) {
    throw new Error(appEmail + ' is listed for more than one person in Caledonite, so nothing is synced. Correct it in Settings, Account.');
  }
  return { hh: hh, people: people, person: person, settings: person.settings || {}, appEmail: String(person.email || '').toLowerCase(), calDocs: loadCalDocs_(me) };
}
function loadCalDocs_(me) {
  var calDocs = {};
  // only the record at this person's own address for each calendar
  fsQuery_('calendars', [['owner', me.person]]).forEach(function (d) { if (d.id === me.person + '__' + d.data.calKey) calDocs[d.data.calKey] = d.data; });
  return calDocs;
}

// ===================== calendars =====================

function syncCalendars_(me, ctx, errors) {
  var now = new Date();
  var from = new Date(now.getTime() - DAYS_BACK * 864e5);
  var to = new Date(now.getTime() + DAYS_AHEAD * 864e5);
  var cals = CalendarApp.getAllCalendars();
  // every account has at least its own calendar: none at all is Google having a moment, not every calendar gone
  if (!cals || !cals.length) throw new Error('Google returned no calendars this time.');
  var defaultId = CalendarApp.getDefaultCalendar().getId();
  var writes = [];
  var props = PropertiesService.getUserProperties();
  var pending = {};   // property updates, saved only once the writes have gone through
  var toForget = [];
  var seenCalKeys = {};
  var handledElsewhere = {};
  var seen = [];
  var count = 0;
  for (var i = 0; i < cals.length; i++) {
    var cal = cals[i];
    var id = '';
    var calKey = '';
    try {
      id = cal.getId();
      calKey = shortKey_(id);
      seenCalKeys[calKey] = true;
      var isPrimary = id === defaultId;
      var meta = {
        owner: me.person, calKey: calKey, calId: id, name: cal.getName() || 'Calendar', color: cal.getColor() || '',
        account: me.email, canWrite: cal.isOwnedByMe(), primary: isPrimary && me.main, lastSeen: Date.now()
      };
      var doc = ctx.calDocs[calKey];
      var docPath = HOUSEHOLD + '/calendars/' + me.person + '__' + calKey;
      // the same calendar seen from another of this person's accounts: let that account handle it. It marks the
      // calendar as seen at least every 6 hours; after 12 without, this account takes over (keeping its settings)
      if (doc && doc.account && doc.account !== me.email && Date.now() - (doc.lastSeen || 0) < 12 * 3600e3) { delete seenCalKeys[calKey]; handledElsewhere[calKey] = true; continue; }
      // written by another of your accounts until now, or not kept up for a while: what this account remembers
      // writing may not be all there is, so start from what's really there (no month is left behind)
      var reseed = !!doc && (String(doc.account || '') !== me.email || !doc.lastSeen || Date.now() - doc.lastSeen > 12 * 3600e3 || props.getProperty('h_' + calKey) === null);
      // calendars set up before family calendars were recognised, or renamed since: shown as family, but never
      // shared more than before without you choosing it
      if (doc && !doc.userSet && doc.layer === 'own' && isFamilyCal_(id, meta.name)) {
        writes.push(upd_(docPath, { layer: 'family' }, ['layer']));
        doc = merge_(doc, { layer: 'family' });
      }
      // set up before it could be told apart as your partner's (before their sync had recorded it, as when you
      // connect first, or before partners' calendars were recognised at all): put right when its details are next
      // checked, unless you've chosen its sharing yourself
      var due = !!doc && (reseed || !doc.lastSeen || Date.now() - doc.lastSeen > 6 * 3600e3);
      if (due && !doc.userSet && (doc.share !== 'none' || doc.role !== 'normal') && partnersCal_(me, ctx, id, meta.canWrite)) {
        var fix = { share: 'none', role: 'normal', layer: isFamilyCal_(id, meta.name) ? 'family' : 'other' };
        writes.push(upd_(docPath, fix, Object.keys(fix)));
        if (doc.role === 'rota') toForget.push('rota_' + calKey);
        doc = merge_(doc, fix);
      }
      if (!doc) {
        doc = merge_(meta, defaultsFor_(cal, isPrimary, me, ctx));
        writes.push(upd_(docPath, doc));
        // one of yours that your partner's sync saw first (you shared it with them in Google): their record of it
        // is put right now, so it's never shown back to you as theirs
        if (meta.canWrite) writes = writes.concat(theirRecordsOfMine_(me, ctx, id, meta.name));
      } else if (doc.name !== meta.name || doc.color !== meta.color || doc.canWrite !== meta.canWrite || doc.primary !== meta.primary || !doc.lastSeen || Date.now() - doc.lastSeen > 6 * 3600e3) {
        writes.push(upd_(docPath, meta, Object.keys(meta)));
        doc = merge_(doc, meta);
      }
      count++;
      var events = [];
      var read = doc.show !== false || (doc.share && doc.share !== 'none');
      if (read) events = readEvents_(cal, id, from, to);
      var d2 = doc;
      events.forEach(function (o) { seen.push({ calKey: calKey, shown: d2.show !== false, share: d2.share || 'busy', doc: d2, ev: o }); });
      var fw = feedWrites_(me, ctx, calKey, doc, events, props, reseed ? copiesOf_(me.person, calKey) : null);
      writes = writes.concat(fw.writes);
      pending[fw.key] = fw.value;
      // (not when it wasn't read at all: no shifts isn't news, and turning it back on mustn't look like all new ones)
      if (doc.role === 'rota' && read) rotaChanged_(me, ctx, calKey, events, props, doc);
    } catch (err) {
      var msg = 'calendar ' + ((cal && safeName_(cal)) || id) + ': ' + String(err && err.message || err);
      Logger.log(msg);
      if (errors) errors.push(msg.slice(0, 200));
    }
  }
  // calendars this account no longer has: drop their feeds
  var all = props.getProperties();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('h_') !== 0) return;
    var ck = k.slice(2);
    if (ck === 'rotalink' || seenCalKeys[ck]) return;
    // now written by the other account, at the same addresses: just forget them here (also when this account
    // can't see it any more and another of yours took it over meanwhile: those copies are that account's now)
    if (!handledElsewhere[ck] && !otherAccount_(ctx.calDocs && ctx.calDocs[ck], me.email)) {
      var old = {};
      try { old = JSON.parse(all[k] || '{}'); } catch (e) { old = {}; }
      Object.keys(old).forEach(function (path) { writes.push({ 'delete': docName_(path) }); });
    }
    toForget.push(k);
    // and its rota as it was (if it comes back to this account, it's compared afresh, never with old shifts)
    if (all['rota_' + ck] !== undefined) toForget.push('rota_' + ck);
  });
  // and their records, once they've been gone a couple of days (so they leave Settings too)
  var listed = me.main ? accountsOf_(me, ctx) : {};
  Object.keys(ctx.calDocs || {}).forEach(function (ck) {
    var d = ctx.calDocs[ck];
    if (ck === 'rotalink' || seenCalKeys[ck] || handledElsewhere[ck]) return;
    var acc = String(d.account || '');
    if (acc === me.email) {
      if (Date.now() - (d.lastSeen || 0) >= 2 * 864e5) writes.push({ 'delete': docName_(HOUSEHOLD + '/calendars/' + me.person + '__' + ck) });
      return;
    }
    // an account taken out in the app that can't run any more to tidy up after itself (disconnected, access
    // taken away, or the account closed): your main account takes its calendars and their copies out
    if (!me.main || !acc || acc === 'Rota link' || listed[acc] || Date.now() - (d.lastSeen || 0) < 12 * 3600e3) return;
    Object.keys(copiesOf_(me.person, ck)).forEach(function (path) { writes.push({ 'delete': docName_(path) }); });
    writes.push({ 'delete': docName_(HOUSEHOLD + '/calendars/' + me.person + '__' + ck) });
  });
  fsCommit_(writes);
  // only now that the writes went through, remember what was written
  if (Object.keys(pending).length) props.setProperties(pending);
  toForget.forEach(function (k) { props.deleteProperty(k); });
  return { count: count, seen: seen };
}
function safeName_(cal) { try { return cal.getName(); } catch (e) { return ''; } }

// Every copy of one of this person's calendars in Firestore, whichever account wrote it: { path: '' }
function copiesOf_(person, calKey) {
  var out = {};
  var prefix = person + '__' + calKey + '__';
  ['privateFeeds', 'sharedFeeds'].forEach(function (coll) {
    fsQuery_(coll, [['owner', person], ['calKey', calKey]]).forEach(function (d) {
      if (String(d.id).indexOf(prefix) === 0) out[HOUSEHOLD + '/' + coll + '/' + d.id] = '';
    });
  });
  return out;
}
// The Google accounts that are this person's in Caledonite: { email: true }
function accountsOf_(me, ctx) {
  var out = {};
  (me.people || []).forEach(function (p) {
    if (p.id !== me.person) return;
    if (p.data.email) out[String(p.data.email).toLowerCase()] = true;
    (p.data.linked || []).forEach(function (x) { if (x) out[String(x).toLowerCase()] = true; });
  });
  ((ctx.hh || {}).linked || []).forEach(function (x) { if (x && x.person === me.person && x.email) out[String(x.email).toLowerCase()] = true; });
  out[me.email] = true;
  return out;
}

function defaultsFor_(cal, isPrimary, me, ctx) {
  var id = cal.getId();
  var name = (cal.getName() || '').toLowerCase();
  var personal = /@(gmail|googlemail)\.com$/.test(me.email);
  if (/#contacts@|birthday/.test(id + ' ' + name)) return { show: false, share: 'none', role: 'normal', layer: 'own' };
  // one of your partner's own calendars, shared with this account in Google: you see it, but it's never copied back
  // to them (it would show their own things as yours, as "Busy"), nor taken for your rota or your work
  if (partnersCal_(me, ctx, id, cal.isOwnedByMe())) return { show: true, share: 'none', role: 'normal', layer: isFamilyCal_(id, name) ? 'family' : 'other' };
  if (isFamilyCal_(id, name)) return { show: true, share: 'all', role: 'normal', layer: 'family' };
  if (/#holiday@|holidays in/.test(id + ' ' + name)) return { show: true, share: 'none', role: 'normal', layer: 'own' };
  if (/rota|roster|shift|loop|healthroster/.test(name)) return { show: true, share: 'all', role: 'rota', layer: 'own' };
  if (/work|office/.test(name) || (!personal && isPrimary)) return { show: true, share: 'hours', role: 'work', layer: 'own' };
  if (isPrimary && me.main) return { show: true, share: 'all', role: 'normal', layer: 'own' };
  // someone's main calendar at a company address, shared into this account: almost always your work calendar
  if (!cal.isOwnedByMe() && /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(id) && !/@(gmail|googlemail|hotmail|outlook|live|icloud|me|mac|yahoo|aol|btinternet|sky|proton|protonmail)\.|calendar\.google\.com$/i.test(id) && personal) {
    return { show: true, share: 'hours', role: 'work', layer: 'own' };
  }
  if (!cal.isOwnedByMe()) {
    if (/family|mum|dad|parents|home/.test(name)) return { show: true, share: 'all', role: 'normal', layer: 'family' };
    if (/friend|mates|crew|squad|book club/.test(name)) return { show: true, share: 'all', role: 'normal', layer: 'friends' };
    return { show: true, share: 'busy', role: 'normal', layer: 'other' };
  }
  return { show: true, share: 'busy', role: 'normal', layer: 'own' };
}

// A calendar that's your partner's: their main one (at one of their addresses in Caledonite), or one their sync
// has recorded as theirs (one they own and you don't). Asked once, when a calendar is first seen. Never Google's
// family group calendar, which is all of yours.
function partnersCal_(me, ctx, id, owned) {
  var lid = String(id || '').toLowerCase();
  if (/^family\d*@group\.calendar\.google\.com$/.test(lid)) return false;
  var mine = accountsOf_(me, ctx || {});
  var theirs = {};
  (me.people || []).forEach(function (p) {
    if (p.id === me.person) return;
    if (p.data && p.data.email) theirs[String(p.data.email).toLowerCase()] = true;
    ((p.data && p.data.linked) || []).forEach(function (x) { if (x) theirs[String(x).toLowerCase()] = true; });
  });
  (((ctx || {}).hh || {}).linked || []).forEach(function (x) { if (x && x.person && x.person !== me.person && x.email) theirs[String(x.email).toLowerCase()] = true; });
  if (theirs[lid] && !mine[lid]) return true;
  if (owned) return false;
  try {
    return fsQuery_('calendars', [['calId', id]]).some(function (d) {
      return d.data && d.data.owner && d.data.owner !== me.person && d.data.canWrite === true && d.id === d.data.owner + '__' + d.data.calKey && !mine[String(d.data.account || '').toLowerCase()];
    });
  } catch (e) { return false; }
}

// Your partner's records of a calendar of yours (one you own and they don't), still with the sharing it was first
// given there: as theirs from now on it's shared as Nothing (it's yours), unless they've chosen otherwise
function theirRecordsOfMine_(me, ctx, id, name) {
  if (/^family\d*@group\.calendar\.google\.com$/i.test(String(id || ''))) return [];
  var mine = accountsOf_(me, ctx || {});
  try {
    return fsQuery_('calendars', [['calId', id]]).filter(function (d) {
      var x = d.data || {};
      return x.owner && x.owner !== me.person && d.id === x.owner + '__' + x.calKey && x.canWrite !== true && !x.userSet &&
        (x.share !== 'none' || x.role !== 'normal') && !mine[String(x.account || '').toLowerCase()];
    }).map(function (d) {
      return upd_(HOUSEHOLD + '/calendars/' + d.id, { share: 'none', role: 'normal', layer: isFamilyCal_(id, name) ? 'family' : 'other' }, ['share', 'role', 'layer']);
    });
  } catch (e) { return []; }
}

// Google's family group calendar, or one called "Family"
function isFamilyCal_(id, name) {
  return /^family\d*@group\.calendar\.google\.com$/i.test(id) || /\bfamily\b/i.test(name || '');
}

// Read a calendar's events. The Calendar API gets them all in one or two requests;
// CalendarApp needs a round trip per detail (about 0.3 seconds an event), so it's only the fallback.
function readEvents_(cal, id, from, to) {
  if (typeof Calendar !== 'undefined' && Calendar.Events) {
    try {
      var out = [];
      var token = null;
      do {
        var res = Calendar.Events.list(id, {
          timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: true, showDeleted: false, maxResults: 2500,
          pageToken: token || undefined,
          fields: 'nextPageToken,items(id,iCalUID,recurringEventId,summary,description,location,start,end,status,eventType,visibility,birthdayProperties(type),attendees(self,responseStatus))'
        });
        // (one odd event is left out, never the reason the whole calendar is read the slow way every run, which
        // can use up the account's daily time for its 10-minute runs)
        (res.items || []).forEach(function (it) { var o = null; try { o = normApi_(it); } catch (e) { o = null; } if (o) out.push(o); });
        token = res.nextPageToken;
      } while (token);
      return out;
    } catch (err) {
      Logger.log('Calendar API failed for ' + id + ', using CalendarApp: ' + err.message);
    }
  }
  // the slow way can take minutes for a busy calendar: never so long that the whole run is stopped (and nothing
  // it did is saved). This calendar keeps what it had until the next run.
  var late = function () { if (RUN_STARTED_ && Date.now() - RUN_STARTED_ > 180e3) throw new Error('Not enough time left in this run to read it; trying again next run.'); };
  late();
  var list = cal.getEvents(from, to);
  var evs = [];
  for (var k = 0; k < list.length; k++) { if (k % 25 === 24) late(); var o2 = norm_(list[k]); if (o2) evs.push(o2); }
  return evs;
}
// The same shape as norm_, from a Calendar API event
function normApi_(it) {
  if (it.status === 'cancelled' || it.eventType === 'workingLocation') return null;
  var self = (it.attendees || []).filter(function (a) { return a.self; })[0];
  if (self && self.responseStatus === 'declined') return null;
  var desc = it.description || '';
  var o = { t: it.summary || '' };
  var startMs;
  if (it.start && it.start.date) {
    o.ad = 1;
    o.sd = it.start.date;
    o.ed = (it.end && it.end.date) || keyPlus_(it.start.date, 1);
    startMs = Utilities.parseDate(it.start.date, TZ, 'yyyy-MM-dd').getTime();
  } else {
    startMs = new Date(it.start.dateTime).getTime();
    o.s = startMs;
    o.e = new Date(it.end.dateTime).getTime();
  }
  // (a calendar shared with you as free/busy only may not say an event's iCalUID)
  var ical = it.iCalUID || it.id || '';
  o.id = shortKey_(ical + '|' + startMs);
  o.uid = shortKey_(ical);
  if (it.recurringEventId) o.sid = o.uid;
  // only in your own copy: what the app needs to change or delete this event
  if (it.id) o.gid = it.id;
  if (it.recurringEventId) o.rid = it.recurringEventId;
  if (it.location) o.l = String(it.location).slice(0, 80);
  var m = desc.match(/\[caledonite:([^\]\s]+)\]/);
  if (m) o.tag = m[1];
  // "#busy", or marked Private in Google Calendar: your partner only ever sees "Busy"
  if (/#busy\b/i.test(desc) || it.visibility === 'private' || it.visibility === 'confidential') o.pb = 1;
  // your contacts' birthdays and anniversaries, which Google now puts in your own calendar: never in your
  // partner's copy (they're other people's dates, as the old Birthdays calendar was). Your own birthday is.
  if (it.eventType === 'birthday' && !(it.birthdayProperties && it.birthdayProperties.type === 'self')) o.np = 1;
  return o;
}

function norm_(ev) {
  // where you're working from (Home, Office) is never an event, as with the Calendar API
  try { if (CalendarApp.EventType && CalendarApp.EventType.WORKING_LOCATION && ev.getEventType() === CalendarApp.EventType.WORKING_LOCATION) return null; } catch (e) { /* older events */ }
  try {
    var st = ev.getMyStatus();
    if (st === CalendarApp.GuestStatus.NO) return null;
  } catch (e) { /* not a guest list event */ }
  var desc = ev.getDescription() || '';
  var start = ev.getStartTime();
  var o = { id: shortKey_(ev.getId() + '|' + start.getTime()), t: ev.getTitle() || '' };
  o.uid = shortKey_(ev.getId());
  try { if (ev.isRecurringEvent()) o.sid = o.uid; } catch (e) { /* ignore */ }
  if (ev.isAllDayEvent()) {
    o.ad = 1;
    o.sd = day_(ev.getAllDayStartDate());
    o.ed = day_(ev.getAllDayEndDate());
  } else {
    o.s = start.getTime();
    o.e = ev.getEndTime().getTime();
  }
  var loc = ev.getLocation();
  if (loc) o.l = String(loc).slice(0, 80);
  var m = desc.match(/\[caledonite:([^\]\s]+)\]/);
  if (m) o.tag = m[1];
  if (/#busy\b/i.test(desc)) o.pb = 1;
  try {
    var vis = ev.getVisibility();
    if (vis === CalendarApp.Visibility.PRIVATE || vis === CalendarApp.Visibility.CONFIDENTIAL) o.pb = 1;
  } catch (e) { /* ignore */ }
  try { if (CalendarApp.EventType && ev.getEventType() === CalendarApp.EventType.BIRTHDAY) o.np = 1; } catch (e) { /* older events */ }
  return o;
}

// Turn one calendar's events into the owner's copy and the partner's filtered copy, by month.
// Returns the writes and the property to save once they have gone through.
// known: copies found in Firestore ({ path: '' }), when what this account remembers may not be all of them
function feedWrites_(me, ctx, calKey, doc, events, props, known) {
  var writes = [];
  var pk = 'h_' + calKey;
  var old = {};
  try { old = JSON.parse(props.getProperty(pk) || '{}'); } catch (e) { old = {}; }
  // anything found that this account didn't write is written again (or taken out)
  if (known) Object.keys(known).forEach(function (path) { if (!(path in old)) old[path] = ''; });
  var next = {};
  var byMonth = {};
  // in a fixed order, so the same events listed differently by Google are never written again
  events = events.slice().sort(function (a, b) {
    var ka = (a.ad ? a.sd : '') + '|' + (a.s || 0) + '|' + a.id, kb = (b.ad ? b.sd : '') + '|' + (b.s || 0) + '|' + b.id;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  events.forEach(function (e) {
    var mk = e.ad ? e.sd.slice(0, 7) : Utilities.formatDate(new Date(e.s), TZ, 'yyyy-MM');
    (byMonth[mk] = byMonth[mk] || []).push(e);
  });
  Object.keys(byMonth).forEach(function (mk) {
    var list = byMonth[mk];
    var base = { owner: me.person, ownerEmail: ctx.appEmail, calKey: calKey, month: mk, account: me.email };
    if (doc.show !== false) {
      // (pb stays: the app never shows the names of things you share only as "Busy", say in a shared countdown;
      // so does np, so the summaries and sleep after nights never take a contact's birthday for your shift)
      var priv = list.map(function (e) { return clone_(e); });
      put_(HOUSEHOLD + '/privateFeeds/' + me.person + '__' + calKey + '__' + mk, base, priv);
    }
    var shared = shareFilter_(doc, list);
    if (shared) put_(HOUSEHOLD + '/sharedFeeds/' + me.person + '__' + calKey + '__' + mk, base, shared);
  });
  function put_(path, base, evs) {
    // whose it is too (an email corrected before joining, or another of your accounts taking over)
    var json = JSON.stringify([base, evs]);
    // a month too full for one database record (at most 1 MB): this calendar keeps what it had, and says so,
    // rather than every calendar's copies failing to save with it, every run
    if (json.length > 800e3) throw new Error('It has too many events in ' + base.month + ' to copy into Caledonite.');
    var h = hash_(json);
    next[path] = h;
    if (old[path] !== h) writes.push(upd_(path, merge_(base, { events: evs, updated: Date.now() })));
  }
  Object.keys(old).forEach(function (path) { if (!next[path]) writes.push({ 'delete': docName_(path) }); });
  return { writes: writes, key: pk, value: JSON.stringify(next) };
}

function shareFilter_(doc, list) {
  var share = doc.share || 'busy';
  if (share === 'none') return null;
  list = list.filter(function (e) { return !e.np; });
  if (share === 'hours') {
    var days = {};
    list.forEach(function (e) {
      if (e.ad || e.e - e.s > 14 * 3600e3) return;
      var dk = Utilities.formatDate(new Date(e.s), TZ, 'yyyy-MM-dd');
      var d = days[dk] = days[dk] || { s: e.s, e: e.e };
      d.s = Math.min(d.s, e.s); d.e = Math.max(d.e, e.e);
    });
    return Object.keys(days).sort().map(function (dk) { return { id: 'w' + dk, t: 'Working', s: days[dk].s, e: days[dk].e }; });
  }
  return list.map(function (e) {
    var c = clone_(e);
    if (share === 'busy' || c.pb) { c.t = 'Busy'; c.b = 1; delete c.l; }
    delete c.pb; delete c.np; delete c.gid; delete c.rid;
    return c;
  });
}

// ===================== rota link (for example from Loop) =====================

// What only this person can read (people/{id}/private/main), read once a run
function privateOf_(ctx, pid) {
  ctx.priv = ctx.priv || {};
  if (!(pid in ctx.priv)) ctx.priv[pid] = fsGet_(HOUSEHOLD + '/people/' + pid + '/private/main') || {};
  return ctx.priv[pid];
}
// The rota link is kept where only its owner can read it (it gives the whole rota, whatever is shared of it);
// on their record until the app has moved it
function rotaUrlOf_(me, ctx) {
  var priv = privateOf_(ctx, me.person);
  return String(typeof priv.rotaUrl === 'string' ? priv.rotaUrl : ((ctx.settings || {}).rotaUrl || ''));
}

function syncRotaLink_(me, ctx, rotaUrl) {
  var url = String(rotaUrl || '').replace(/^webcal:/i, 'https:');
  if (!/^https:\/\//i.test(url)) return;
  // Google's own errors here name the address ("DNS error: https://..."), and what goes wrong ends up in this
  // account's status, which your partner's phone reads: the link (your whole rota) is never part of the message
  var res, text;
  try {
    res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    text = res.getResponseCode() < 300 ? res.getContentText() : '';
  } catch (err) {
    throw new Error('The rota link could not be reached this time. Trying again next run.');
  }
  if (res.getResponseCode() >= 300) throw new Error('The rota link returned an error (' + res.getResponseCode() + ').');
  // a sign-in or error page (or nothing) instead of a calendar is never "no shifts": the ones there stay,
  // and your partner isn't told they've all gone
  if (!/BEGIN:VCALENDAR/i.test(String(text || ''))) throw new Error('The rota link did not send a calendar this time. Trying again next run.');
  var events = parseIcs_(text);
  var calKey = 'rotalink';
  var path = HOUSEHOLD + '/calendars/' + me.person + '__' + calKey;
  var doc = ctx.calDocs[calKey];
  var writes = [];
  if (!doc) {
    doc = { owner: me.person, calKey: calKey, calId: 'rota-link', name: 'Work rota (link)', color: '#F08A3C', account: 'Rota link', canWrite: false, primary: false, show: true, share: 'all', role: 'rota', layer: 'own', lastSeen: Date.now() };
    writes.push(upd_(path, doc));
  } else if (Date.now() - (doc.lastSeen || 0) > 6 * 3600e3) {
    writes.push(upd_(path, { lastSeen: Date.now() }, ['lastSeen']));
  }
  var props = PropertiesService.getUserProperties();
  var fw = feedWrites_(me, ctx, calKey, doc, events, props);
  writes = writes.concat(fw.writes);
  fsCommit_(writes);
  props.setProperty(fw.key, fw.value);
  rotaChanged_(me, ctx, calKey, events, props, doc);
}

// The rota link was taken out in the app: its shifts go too, so old ones don't linger for months
function dropRotaLink_(me) {
  var props = PropertiesService.getUserProperties();
  var saved = props.getProperty('h_rotalink');
  if (saved === null) return;
  var old = {};
  try { old = JSON.parse(saved || '{}'); } catch (e) { old = {}; }
  var writes = Object.keys(old).map(function (path) { return { 'delete': docName_(path) }; });
  writes.push({ 'delete': docName_(HOUSEHOLD + '/calendars/' + me.person + '__rotalink') });
  fsCommit_(writes);
  props.deleteProperty('h_rotalink');
  props.deleteProperty('rota_rotalink');
}

// Windows time zone names that rota systems sometimes send, as the names Google understands
var WIN_TZ_ = {
  'gmt standard time': 'Europe/London', 'greenwich standard time': 'UTC', 'utc': 'UTC', 'coordinated universal time': 'UTC', 'gmt': 'UTC',
  'w. europe standard time': 'Europe/Berlin', 'romance standard time': 'Europe/Paris', 'central europe standard time': 'Europe/Budapest',
  'central european standard time': 'Europe/Warsaw', 'e. europe standard time': 'Europe/Bucharest', 'fle standard time': 'Europe/Kiev',
  'gtb standard time': 'Europe/Athens', 'irish standard time': 'Europe/Dublin', 'eastern standard time': 'America/New_York',
  'central standard time': 'America/Chicago', 'mountain standard time': 'America/Denver', 'pacific standard time': 'America/Los_Angeles',
  'aus eastern standard time': 'Australia/Sydney', 'india standard time': 'Asia/Kolkata', 'tokyo standard time': 'Asia/Tokyo',
  'china standard time': 'Asia/Shanghai', 'singapore standard time': 'Asia/Singapore', 'new zealand standard time': 'Pacific/Auckland'
};
function tzName_(raw) {
  var t = String(raw || '').replace(/"/g, '').trim();
  if (!t) return TZ;
  var mapped = WIN_TZ_[t.toLowerCase()];
  if (mapped) return mapped;
  if (/^[A-Za-z]+\/[A-Za-z_\-\/]+$/.test(t) || /^UTC$/i.test(t)) return t;
  return TZ;
}

// Shifts from an iCalendar link: single events, repeats (daily, weekly, monthly), exceptions and cancellations.
function parseIcs_(text) {
  var lines = String(text).replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  var raw = [];
  var cur = null;
  lines.forEach(function (line) {
    if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; return; }
    if (line === 'END:VEVENT') { if (cur && cur.start) raw.push(cur); cur = null; return; }
    if (!cur) return;
    // an alarm inside a shift has its own SUMMARY, DURATION and so on: never the shift's
    if (/^BEGIN:/i.test(line)) { cur.nest = (cur.nest || 0) + 1; return; }
    if (/^END:/i.test(line)) { if (cur.nest) cur.nest--; return; }
    if (cur.nest) return;
    var idx = line.indexOf(':');
    if (idx < 0) return;
    var left = line.slice(0, idx); var val = line.slice(idx + 1);
    var name = left.split(';')[0].toUpperCase();
    if (name === 'SUMMARY') cur.summary = val.replace(/\\,/g, ',').replace(/\\n/gi, ' ').replace(/\\;/g, ';');
    else if (name === 'UID') cur.uid = val;
    else if (name === 'STATUS') cur.status = val.toUpperCase();
    else if (name === 'CLASS') cur.priv = /^(PRIVATE|CONFIDENTIAL)$/i.test(String(val).trim());
    else if (name === 'DTSTART') cur.start = icsTime_(left, val);
    else if (name === 'DTEND') cur.end = icsTime_(left, val);
    else if (name === 'DURATION') cur.duration = icsDuration_(val);
    else if (name === 'RRULE') cur.rrule = icsRule_(val);
    else if (name === 'RECURRENCE-ID') cur.recurrenceId = icsTime_(left, val);
    else if (name === 'EXDATE') val.split(',').forEach(function (v) { if (v) cur.exdates.push(icsTime_(left, v)); });
  });
  var from = Date.now() - DAYS_BACK * 864e5;
  var to = Date.now() + DAYS_AHEAD * 864e5;
  // instances replaced or cancelled by their own entry (RECURRENCE-ID)
  var overrides = {};
  raw.forEach(function (r) { if (r.recurrenceId) overrides[(r.uid || '') + '|' + instKey_(r.recurrenceId)] = true; });
  var out = [];
  raw.forEach(function (r) {
    if (r.recurrenceId) {
      if (r.status !== 'CANCELLED') pushInst_(out, r, r.start, from, to);
      return;
    }
    if (r.status === 'CANCELLED') return;
    if (!r.rrule) { pushInst_(out, r, r.start, from, to); return; }
    var ex = {};
    r.exdates.forEach(function (x) { ex[instKey_(x)] = true; if (x.date) ex['d:' + x.v] = true; });
    icsExpand_(r, to, from).forEach(function (st) {
      var k = instKey_(st);
      if (ex[k] || ex['d:' + (st.date ? st.v : st.v.slice(0, 10))]) return;
      if (overrides[(r.uid || '') + '|' + k]) return;
      pushInst_(out, r, st, from, to);
    });
  });
  return out;
}
function instKey_(t) { return t.date ? 'd:' + t.v : 'm:' + t.ms; }
function pushInst_(out, r, st, from, to) {
  var o = { id: shortKey_((r.uid || '') + '|' + st.v), uid: shortKey_(r.uid || st.v), t: r.summary || 'Shift' };
  // marked private in the rota: your partner only ever sees "Busy", as for your own calendars
  if (r.priv) o.pb = 1;
  if (st.date) {
    o.ad = 1; o.sd = st.v;
    var days = 1;
    if (r.end && r.end.date && r.start.date) days = Math.max(1, Math.round((Date.UTC(+r.end.v.slice(0, 4), +r.end.v.slice(5, 7) - 1, +r.end.v.slice(8, 10)) - Date.UTC(+r.start.v.slice(0, 4), +r.start.v.slice(5, 7) - 1, +r.start.v.slice(8, 10))) / 864e5));
    else if (r.duration) days = Math.max(1, Math.round(r.duration / 864e5));
    o.ed = keyPlus_(st.v, days);
    var t0 = Utilities.parseDate(o.sd, TZ, 'yyyy-MM-dd').getTime();
    if (t0 >= from - 864e5 && t0 <= to) out.push(o);
  } else {
    var len = r.duration || (r.end && !r.end.date ? r.end.ms - r.start.ms : 3600e3);
    if (!(len > 0)) len = 3600e3;
    o.s = st.ms; o.e = st.ms + len;
    if (o.e >= from && o.s <= to) out.push(o);
  }
}
function icsTime_(left, val) {
  val = String(val).trim();
  if (/VALUE=DATE(;|$)/i.test(left) || /^\d{8}$/.test(val)) {
    return { date: true, v: val.slice(0, 4) + '-' + val.slice(4, 6) + '-' + val.slice(6, 8) };
  }
  var y = val.slice(0, 4), mo = val.slice(4, 6), d = val.slice(6, 8), h = val.slice(9, 11), mi = val.slice(11, 13), s = val.slice(13, 15) || '00';
  var str = y + '-' + mo + '-' + d + ' ' + h + ':' + mi + ':' + s;
  var tzm = left.match(/TZID=("[^"]+"|[^;:]+)/i);
  var tz = /Z$/.test(val) ? 'UTC' : (tzm ? tzName_(tzm[1]) : TZ);
  var ms;
  try { ms = Utilities.parseDate(str, tz, 'yyyy-MM-dd HH:mm:ss').getTime(); } catch (e) { ms = Utilities.parseDate(str, TZ, 'yyyy-MM-dd HH:mm:ss').getTime(); tz = TZ; }
  return { ms: ms, v: str, tz: tz };
}
// "PT12H30M", "P1D", "P1W" in milliseconds
function icsDuration_(val) {
  var m = String(val).match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  var ms = ((+m[2] || 0) * 7 * 864e5) + ((+m[3] || 0) * 864e5) + ((+m[4] || 0) * 3600e3) + ((+m[5] || 0) * 60e3) + ((+m[6] || 0) * 1e3);
  return m[1] === '-' ? -ms : ms;
}
function icsRule_(val) {
  var r = {};
  String(val).split(';').forEach(function (p) { var kv = p.split('='); if (kv.length === 2) r[kv[0].toUpperCase()] = kv[1]; });
  var until = null;
  if (r.UNTIL) {
    var u = r.UNTIL;
    until = /^\d{8}$/.test(u) ? { date: true, v: u.slice(0, 4) + '-' + u.slice(4, 6) + '-' + u.slice(6, 8) } : icsTime_(/Z$/.test(u) ? '' : 'TZID=' + TZ, u);
  }
  return {
    freq: (r.FREQ || '').toUpperCase(), interval: Math.max(1, +r.INTERVAL || 1), count: +r.COUNT || 0, until: until,
    byday: r.BYDAY ? r.BYDAY.split(',').map(function (x) { return x.replace(/^[+-]?\d+/, '').toUpperCase(); }) : null,
    bymonthday: r.BYMONTHDAY ? +r.BYMONTHDAY : 0
  };
}
// Every start of a repeating entry up to the end of the window (and COUNT/UNTIL).
// from: the start of the window (a daily entry begun years ago starts counting near it)
function icsExpand_(r, to, from) {
  var rule = r.rrule;
  var st = r.start;
  var startKey = st.date ? st.v : st.v.slice(0, 10);
  var clock = st.date ? '' : st.v.slice(11);
  var tz = st.tz || TZ;
  var out = [];
  var made = 0;
  var untilMs = rule.until ? (rule.until.date ? Utilities.parseDate(rule.until.v + ' 23:59:59', tz, 'yyyy-MM-dd HH:mm:ss').getTime() : rule.until.ms) : Infinity;
  var dayCodes = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
  function at(key) {
    if (st.date) return { date: true, v: key };
    var s = key + ' ' + clock;
    return { ms: Utilities.parseDate(s, tz, 'yyyy-MM-dd HH:mm:ss').getTime(), v: s, tz: tz };
  }
  function msOf(t) { return t.date ? Utilities.parseDate(t.v, TZ, 'yyyy-MM-dd').getTime() : t.ms; }
  function add(key) {
    if (rule.count && made >= rule.count) return false;
    var t = at(key);
    var ms = msOf(t);
    if (ms > untilMs || ms > to) return false;
    made++;
    out.push(t);
    return true;
  }
  var guard = 0;
  if (rule.freq === 'DAILY') {
    var k0 = 0;
    if (!rule.count && from) {
      var gap = daysBetween_(startKey, Utilities.formatDate(new Date(from - 2 * 864e5), TZ, 'yyyy-MM-dd'));
      if (gap > 0) k0 = Math.floor(gap / rule.interval) * rule.interval;
    }
    for (var k = k0; guard++ < 2000; k += rule.interval) { if (!add(keyPlus_(startKey, k))) break; }
  } else if (rule.freq === 'WEEKLY') {
    var startWd = isoWd_(startKey);
    var days = (rule.byday && rule.byday.length ? rule.byday : [dayCodes[startWd - 1]]).map(function (c) { return dayCodes.indexOf(c) + 1; }).filter(function (x) { return x > 0; }).sort();
    var monday = keyPlus_(startKey, 1 - startWd);
    var stop = false;
    for (var w = 0; !stop && guard++ < 1000; w += rule.interval) {
      for (var j = 0; j < days.length; j++) {
        var key = keyPlus_(monday, w * 7 + days[j] - 1);
        if (key < startKey) continue;
        if (!add(key)) { stop = true; break; }
      }
    }
  } else if (rule.freq === 'MONTHLY') {
    var y = +startKey.slice(0, 4), m = +startKey.slice(5, 7) - 1, dom = rule.bymonthday || +startKey.slice(8, 10);
    for (var n = 0; guard++ < 500; n += rule.interval) {
      var yy = y + Math.floor((m + n) / 12), mm = (m + n) % 12;
      var dim = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
      if (dom > dim) continue;
      var key2 = yy + '-' + pad2_(mm + 1) + '-' + pad2_(dom);
      if (key2 < startKey) continue;
      if (!add(key2)) break;
    }
  } else {
    add(startKey);
  }
  return out;
}

// Tell the partner which shifts in the next three weeks were added, removed or changed.
// Only the days both this run and the last run could see are compared, so the window
// moving on by a day never looks like a change. Only what the rota's sharing lets them see:
// nothing for "Nothing", and for "Busy" just the times (never the shift's name).
function rotaChanged_(me, ctx, calKey, events, props, doc) {
  var share = (doc && doc.share) || 'busy';
  var now = Date.now();
  var win = { from: now - 864e5, to: now + 21 * 864e5 };
  var map = {};
  var birthdays = {};
  // in time order, so a day's second shift is always its second, however Google listed them
  // (each start worked out once: Utilities calls aren't free)
  events = events.map(function (e) { return { e: e, s: e.ad ? Utilities.parseDate(e.sd, TZ, 'yyyy-MM-dd').getTime() : e.s }; })
    .sort(function (a, b) { return a.s - b.s || (a.e.ad ? -1 : 0) - (b.e.ad ? -1 : 0); });
  events.forEach(function (x) {
    var e = x.e, s = x.s;
    var en = e.ad ? Utilities.parseDate(e.ed || keyPlus_(e.sd, 1), TZ, 'yyyy-MM-dd').getTime() : e.e;
    if (s < win.from || s > win.to) return;
    // your contacts' birthdays (a rota kept in your main calendar) are never in your partner's copy, so never news.
    // Remembered by their times and name as an earlier version saved them, so a day off on someone's birthday
    // (the same times) is never taken for one
    if (e.np) { birthdays[s + '|' + en + '|' + (e.pb ? '' : String(e.t || 'Shift').slice(0, 40))] = true; return; }
    var k = evStartKey_(e);
    while (map[k]) k += '+';
    // a shift marked Private or #busy is never named, not even by a change to its name
    map[k] = [s, en, e.pb ? '' : String(e.t || 'Shift').slice(0, 40)];
    if (e.ad) map[k].push(1);
  });
  // a saved value can't be bigger than about 9 KB: a very full calendar keeps the nearest days only
  // (and says so, so the days past them are never compared)
  var order = Object.keys(map).sort(function (a, b) { return map[a][0] - map[b][0]; });
  while (order.length && JSON.stringify({ from: win.from, to: win.to, map: map }).length > 8000) {
    var last = order.pop();
    win.to = Math.min(win.to, map[last][0] - 1);
    delete map[last];
  }
  var key = 'rota_' + calKey;
  var before = null;
  var saved = props.getProperty(key);
  try { before = JSON.parse(saved || 'null'); } catch (err) { before = null; }
  props.setProperty(key, JSON.stringify({ from: win.from, to: win.to, map: map }));
  if (!before || typeof before !== 'object' || !before.map || share === 'none') return;
  // Every entry is remembered, whatever the sharing, so changing it never makes old entries look new. Shared as
  // working hours, your partner never sees all-day entries or very long ones, so never hears of them: both sides
  // are compared without them (each day's entries numbered again in time order)
  var keep = function (v) { return !!v && (share !== 'hours' || (!v[3] && v[1] - v[0] <= 14 * 3600e3)); };
  // (saved before they were left out: never "removed" either)
  before.map = rotaRekey_(before.map, function (v) { return keep(v) && !(v[3] && birthdays[v[0] + '|' + v[1] + '|' + v[2]]); });
  map = rotaRekey_(map, keep);
  var named = share === 'all';
  var lo = Math.max(before.from, win.from), hi = Math.min(before.to, win.to);
  var inside = function (v) { return v && v[0] >= lo && v[0] <= hi && v[1] > now; };
  var changes = [];
  var keys = {};
  Object.keys(map).forEach(function (k) { keys[k] = 1; });
  Object.keys(before.map).forEach(function (k) { keys[k] = 1; });
  Object.keys(keys).sort().forEach(function (k) {
    var a = before.map[k], b = map[k];
    if (a && b) {
      if (!inside(a) && !inside(b)) return;
      if (a[0] !== b[0] || a[1] !== b[1] || (named && a[2] !== b[2])) changes.push({ k: k, what: 'changed', v: b });
    } else if (b) {
      if (inside(b)) changes.push({ k: k, what: 'added', v: b });
    } else if (inside(a)) {
      changes.push({ k: k, what: 'removed', v: a });
    }
  });
  if (!changes.length) return;
  var name = (ctx.person && ctx.person.name) || 'Your partner';
  var parts = changes.slice(0, 2).map(function (c) {
    // an all-day entry (leave, a day off) by its name, never as a shift worked out from its times
    var label = c.v[3] ? ((named && c.v[2]) || 'an all-day entry') : shiftWords_({ t: named ? c.v[2] : '', s: c.v[0], e: c.v[1] });
    return dayLabel_(c.k.replace(/\+*$/, '')) + ': ' + label + ' ' + c.what + '.';
  });
  if (changes.length > 2) parts.push('And ' + (changes.length - 2) + ' more.');
  var writes = [];
  Object.keys(ctx.people).forEach(function (pid) {
    if (pid === me.person) return;
    writes.push(upd_(HOUSEHOLD + '/notify/' + Utilities.getUuid(), { to: pid, kind: 'rota', title: name + "'s rota has changed", body: parts.join(' '), link: '#calendar', sendAfter: now, sent: false, created: now }));
  });
  // not saved after all: compared with the rota as it was again next run, so the change is still told
  if (writes.length) {
    try { fsCommit_(writes); } catch (err) {
      if (saved === null) props.deleteProperty(key); else props.setProperty(key, saved);
      throw err;
    }
  }
}

// A saved rota with only the entries keep() allows, each day's numbered again in time order ("day", "day+", ...)
function rotaRekey_(m, keep) {
  var byDay = {};
  Object.keys(m || {}).forEach(function (k) {
    if (!keep(m[k])) return;
    var d = k.replace(/\+*$/, '');
    (byDay[d] = byDay[d] || []).push(m[k]);
  });
  var out = {};
  Object.keys(byDay).forEach(function (d) {
    byDay[d].sort(function (a, b) { return a[0] - b[0] || (b[3] || 0) - (a[3] || 0); }).forEach(function (v, i) { out[d + new Array(i + 1).join('+')] = v; });
  });
  return out;
}

// ===================== the app's to-do list for your calendars =====================

// Returns true when something in Google Calendar changed, so the feeds can catch up.
function processOutbox_(me, ctx) {
  var all = fsQuery_('outbox', [['person', me.person], ['done', false]]);
  // something you added to a calendar in another of your accounts that that account hasn't made yet: a change to it
  // before then (yours, or your partner's to something for you both) is handed on to it, never lost
  var waitingIn = {};
  var mine = accountsOf_(me, ctx);
  all.forEach(function (it) {
    var d = it.data, acc = String(d.account || '').toLowerCase();
    if (d.op === 'create' && d.tag && acc && acc !== me.email && mine[acc] && !!ctx.appEmail && String(d.byEmail || '').toLowerCase() === ctx.appEmail) waitingIn[d.tag] = acc;
  });
  var items = all.filter(function (it) {
    var acc = String(it.data.account || '').toLowerCase();
    // your partner's asks go to your main account: they can't add anything to your work calendar. Only a change
    // to something you share by its tag (both of you, or a request) is handed to the account whose calendar it's in.
    if (String(it.data.byEmail || '').toLowerCase() !== ctx.appEmail) {
      var handedOn = !!acc && acc !== (me.main ? me.email : '') && !!it.data.tag && (it.data.op === 'update' || it.data.op === 'delete');
      return me.main ? !handedOn : handedOn && acc === me.email;
    }
    return acc ? acc === me.email : me.main;
  });
  if (!items.length) return false;
  var rs = { tagMap: {}, owned: null, defaultId: null, removed: {} };
  var writes = [];
  var changed = false;
  // in the order they reached the database (two phones' clocks can differ: an answer must never come before
  // the request it answers); ones saved together (take out the pencilled-in event, then add the agreed one) by seq
  items.sort(function (a, b) {
    var ta = tsKey_(a.createTime), tb = tsKey_(b.createTime);
    return (ta && tb && ta !== tb ? (ta < tb ? -1 : 1) : 0) || ((a.data.created || 0) - (b.data.created || 0)) || ((a.data.seq || 0) - (b.data.seq || 0));
  });
  var stuck = {};
  var outOfTime = false;
  items.forEach(function (it) {
    // a long list (an account that hasn't run for a while): leave the rest for the next run, so this one is never
    // stopped by Google part way, before any of it is marked done, again and again
    if (outOfTime || timeUsed_() > OUTBOX_BUDGET_) { outOfTime = true; return; }
    var o = it.data;
    var own = !!ctx.appEmail && String(o.byEmail || '').toLowerCase() === ctx.appEmail;
    var result = {};
    // an earlier change to the same event (by its tag, or by its Google id: a whole series counts as one) failed
    // this run: wait, so they still happen in order next time
    var key = o.tag ? 't:' + o.tag : (o.rid || o.gid) ? 'g:' + (o.calId || '') + '|' + String(o.rid || o.gid) : '';
    if (key && stuck[key]) return;
    try {
      if (o.op === 'create') result = createEvent_(me, ctx, o, own, rs);
      else if (o.op === 'update' || o.op === 'delete') result = own || partnerMayChange_(o.tag, rs) ? changeByTag_(o, rs) : { refused: 'not yours' };
      else if (o.op === 'edit' || o.op === 'remove') result = own ? editOwn_(o, rs) : { refused: 'not yours' };
      else result = { refused: 'unknown change' };
      // not in any calendar this account has: your copy may be in one of your other accounts' calendars (your
      // partner's change to something for you both always comes here first). Handed on to that account.
      if (result.none && me.main && !o.account) {
        var holder = (o.tag && waitingIn[o.tag]) || holderOf_(me, ctx, o.tag, rs);
        if (holder) {
          if (key) stuck[key] = true;
          writes.push(upd_(HOUSEHOLD + '/outbox/' + it.id, { account: holder }, ['account']));
          return;
        }
      }
      delete result.none;
      if (!result.refused && !result.already && (result.eventId || result.changed)) changed = true;
      writes.push(upd_(HOUSEHOLD + '/outbox/' + it.id, { done: true, doneAt: Date.now(), result: result }, ['done', 'doneAt', 'result']));
    } catch (err) {
      if (key) stuck[key] = true;
      var tries = (o.tries || 0) + 1;
      var patch = { tries: tries, error: String(err && err.message || err).slice(0, 200) };
      // given up on after 5 tries, but not while Google is only having a moment (busy, a quota for the day, the
      // network): those keep trying for a day after the change was made, so an hour's outage loses nothing
      var age = Date.now() - (Date.parse(it.createTime || '') || o.created || 0);
      if (tries >= 5 && (!transient_(err) || age > 864e5)) patch.done = true;
      writes.push(upd_(HOUSEHOLD + '/outbox/' + it.id, patch, Object.keys(patch)));
    }
  });
  fsCommit_(writes);
  return changed;
}

// Your partner can change things you share (added for you both, or from a request between you),
// but not something you added just for yourself, or a holiday you booked on your own.
function partnerMayChange_(tag, rs) {
  tag = String(tag || '');
  if (/^both:/.test(tag)) return true;
  if (!/^req:/.test(tag)) return false;
  rs.reqs = rs.reqs || {};
  var id = tag.slice(4);
  if (!(id in rs.reqs)) rs.reqs[id] = /^[A-Za-z0-9_-]+$/.test(id) ? fsGet_(HOUSEHOLD + '/requests/' + id) : null;
  var r = rs.reqs[id];
  return !!r && !r.own && !(r.people && r.people.length === 1);
}

// Calendars this account can change, by id
function ownedCals_(rs) {
  if (rs.owned) return rs.owned;
  rs.owned = {};
  CalendarApp.getAllCalendars().forEach(function (c) { try { if (c.isOwnedByMe()) rs.owned[c.getId()] = true; } catch (e) { /* ignore */ } });
  rs.defaultId = CalendarApp.getDefaultCalendar().getId();
  rs.owned[rs.defaultId] = true;
  return rs.owned;
}

// A Firestore time ("2026-10-26T10:00:00.12Z") that sorts as text, whatever its number of decimals
function tsKey_(t) {
  var m = String(t || '').match(/^([^.Z]+)(?:\.(\d+))?Z$/);
  return m ? m[1] + '.' + ((m[2] || '') + '000000000').slice(0, 9) : '';
}

// Every event carrying this Caledonite tag, in calendars this account can change.
// Never from event ids the app sends: only what this run made, or what Google finds by the tag.
function findByTag_(rs, tag) {
  if (rs.tagMap[tag] && rs.tagMap[tag].length) return rs.tagMap[tag];
  var owned = ownedCals_(rs);
  var found = [];
  var timeMin = new Date(Date.now() - DAYS_BACK * 864e5 - 864e5).toISOString();
  var timeMax = new Date(Date.now() + (DAYS_AHEAD + 365) * 864e5).toISOString();
  var marker = '[caledonite:' + tag + ']';
  // every page: Google can hand back a page with fewer matches than asked for, or none, and more to come
  var each = function (calId, q, fn) {
    var token = null, guard = 0;
    do {
      var res = Calendar.Events.list(calId, merge_(q, { timeMin: timeMin, timeMax: timeMax, singleEvents: false, showDeleted: false, maxResults: 250, pageToken: token || undefined }));
      (res.items || []).forEach(fn);
      token = res.nextPageToken;
    } while (token && ++guard < 20);
  };
  Object.keys(owned).forEach(function (calId) {
    each(calId, { privateExtendedProperty: 'caledonite=' + tag, fields: 'nextPageToken,items(id,status,recurrence)' }, function (x) { if (x.status !== 'cancelled') found.push({ calId: calId, eventId: x.id, series: !!(x.recurrence && x.recurrence.length) }); });
  });
  if (!found.length) {
    // older events, made before the tag was stored as a property, only have it in the description
    Object.keys(owned).forEach(function (calId) {
      each(calId, { q: tag, fields: 'nextPageToken,items(id,status,description,recurrence)' }, function (x) { if (x.status !== 'cancelled' && String(x.description || '').indexOf(marker) >= 0) found.push({ calId: calId, eventId: x.id, series: !!(x.recurrence && x.recurrence.length) }); });
    });
  }
  // never something this run has just deleted (Google's search can take a moment to catch up)
  found = found.filter(function (x) { return !(rs.removed || {})[x.calId + '|' + x.eventId]; });
  rs.tagMap[tag] = found;
  return found;
}

function createEvent_(me, ctx, o, own, rs) {
  var ev = o.event || {};
  var tag = o.tag || ('app:' + Utilities.getUuid().slice(0, 8));
  var owned = ownedCals_(rs);
  // already there? (a retry after a time-out)
  var existing = findByTag_(rs, tag);
  if (existing.length) return { eventId: existing[0].eventId, calId: existing[0].calId, already: true };
  var calId = rs.defaultId;
  if (own && ev.calKey && ctx.calDocs[ev.calKey] && ctx.calDocs[ev.calKey].calId && owned[ctx.calDocs[ev.calKey].calId]) calId = ctx.calDocs[ev.calKey].calId;
  var resource = {
    summary: ev.title || 'Event',
    description: 'Added by Caledonite [caledonite:' + tag + ']' + (ev.busyOnly ? ' #busy' : ''),
    extendedProperties: { 'private': { caledonite: tag } }
  };
  var day = ev.day;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) throw new Error('No date for this event.');
  if (ev.allDay) {
    var last = /^\d{4}-\d{2}-\d{2}$/.test(String(ev.endDay || '')) && ev.endDay >= day ? ev.endDay : day;
    resource.start = { date: day };
    resource.end = { date: keyPlus_(last, 1) };
  } else {
    var st = hm_(ev.start) || '19:00';
    var en = hm_(ev.end) || hm_(ev.start) || '20:00';
    if (mins_(en) <= mins_(st)) en = addMins_(st, 60);
    resource.start = { dateTime: day + 'T' + st + ':00', timeZone: tzOf_(o) };
    resource.end = { dateTime: day + 'T' + en + ':00', timeZone: tzOf_(o) };
  }
  var rule = rrule_(ev.repeat);
  if (rule) resource.recurrence = [rule];
  var created = Calendar.Events.insert(resource, calId);
  rs.tagMap[tag] = [{ calId: calId, eventId: created.id, series: !!resource.recurrence }];
  return { eventId: created.id, calId: calId };
}
function rrule_(rep) {
  if (!rep || !rep.freq) return '';
  var f = String(rep.freq).toUpperCase();
  if (['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].indexOf(f) < 0) return '';
  return 'RRULE:FREQ=' + f + ';INTERVAL=' + Math.max(1, Math.min(52, Math.floor(+rep.interval || 1)));
}

// update or delete: every copy carrying the tag. With o.inst (when it first started, as Google writes it in an
// occurrence's id: 20261030T180000Z, or 20261030 for all day), just that occurrence of something that repeats.
// A changed time of something repeating (an exception: "series_20261113T190000Z", or "series_20261113" all day).
// A series split in Google Calendar ("this and following") is a series of its own: "series_R20261113T190000".
var EXCEPTION_RE_ = /_\d{8}(T\d{6}Z)?$/;
function changeByTag_(o, rs) {
  if (!o.tag) return { refused: 'no tag' };
  var inst = /^\d{8}(T\d{6}Z)?$/.test(String(o.inst || '')) ? String(o.inst) : '';
  var owned = ownedCals_(rs);
  var isExc = function (id) { return EXCEPTION_RE_.test(String(id)); };
  var found = findByTag_(rs, o.tag).filter(function (t) { return owned[t.calId]; });
  // Google lists a changed time of a series next to the series itself
  var series = {};
  found.forEach(function (t) { if (!isExc(t.eventId)) series[t.calId + '|' + t.eventId] = true; });
  // one occurrence: it's in one of the series (a split one has the later times)
  var targets = inst ? found.filter(function (t) { return !isExc(t.eventId); }) : found;
  var several = !!inst && targets.length > 1;
  var n = 0;
  targets.forEach(function (t) {
    var id = inst ? t.eventId + '_' + inst : t.eventId;
    var exception = !inst && isExc(t.eventId);
    // deleting the series takes its changed times with it
    if (exception && o.op === 'delete' && series[t.calId + '|' + String(t.eventId).replace(EXCEPTION_RE_, '')]) return;
    try {
      // in more than one series: only the one that really has that time (not one ended before it)
      if (several) { var cur = Calendar.Events.get(t.calId, id); if (!cur || cur.status === 'cancelled') return; }
      if (o.op === 'delete') { Calendar.Events.remove(t.calId, id); rs.removed[t.calId + '|' + id] = true; n++; return; }
      var changes = o.changes || {};
      if (o.event && o.event.title && !changes.title) changes = merge_(changes, { title: o.event.title });
      // a changed time keeps its own day and time when every time is changed: just the new name. And every time of
      // a series is only ever renamed: moving it to one day would take all the earlier times away
      if (exception || (!inst && t.series)) changes = changes.title ? { title: changes.title } : {};
      var patch = patchFor_(changes, t.calId, id, tzOf_(o));
      if (Object.keys(patch).length) { Calendar.Events.patch(patch, t.calId, id); n++; }
    } catch (err) {
      // already gone (that occurrence, or the whole thing): nothing to do
      if ((inst || o.op === 'delete') && gone_(err)) return;
      throw err;
    }
  });
  if (o.op === 'delete' && !inst) rs.tagMap[o.tag] = [];
  return found.length ? { changed: n } : { changed: 0, none: true };
}

// Which other of this person's Google accounts has a copy carrying this tag, going by the copies they wrote
// (only asked when this account has none; only accounts that write to a calendar of theirs)
function holderOf_(me, ctx, tag, rs) {
  rs.holders = rs.holders || {};
  if (tag in rs.holders) return rs.holders[tag];
  var accs = {};
  Object.keys(ctx.calDocs || {}).forEach(function (ck) {
    var d = ctx.calDocs[ck];
    if (d && d.canWrite && otherAccount_(d, me.email)) accs[String(d.account).toLowerCase()] = true;
  });
  var found = '';
  Object.keys(accs).some(function (acc) {
    var has = fsQuery_('privateFeeds', [['owner', me.person], ['account', acc]]).some(function (f) {
      return (f.data.events || []).some(function (e) { return e && e.tag === tag; });
    });
    if (has) found = acc;
    return has;
  });
  rs.holders[tag] = found;
  return found;
}

// edit or remove one of your own events (or a whole repeating series)
function editOwn_(o, rs) {
  var owned = ownedCals_(rs);
  if (!o.calId || !owned[o.calId]) return { refused: 'calendar not writable' };
  var all = o.scope === 'all' && o.rid;
  var target = all ? o.rid : o.gid;
  if (!target) return { refused: 'no event' };
  if (o.op === 'remove') {
    // deleted in Google Calendar meanwhile, or by an earlier try whose "done" didn't get saved: done
    try { Calendar.Events.remove(o.calId, target); } catch (err) { if (gone_(err)) return { changed: 0, gone: true }; throw err; }
    rs.removed[o.calId + '|' + target] = true;
    return { changed: 1 };
  }
  var changes = o.changes || {};
  var patch = all ? (changes.title ? { summary: changes.title } : {}) : patchFor_(changes, o.calId, target, tzOf_(o));
  if (!Object.keys(patch).length) return { changed: 0 };
  Calendar.Events.patch(patch, o.calId, target);
  return { changed: 1 };
}

// An error that's Google or the network having a moment, not something wrong with the change itself
function transient_(err) {
  return /rate limit|backend error|internal error|service unavailable|unavailable|timed out|timeout|try again|too many|quota|limits? exceeded|\b(429|500|502|503|504)\b|address unavailable|dns error|unexpected error/i.test(String(err && err.message || err));
}

// The Calendar API saying an event isn't there (any more)
function gone_(err) { return /not found|404|410|has been deleted/i.test(String(err && err.message || err)); }

// Times typed in the app are the phone's clock, so a phone abroad sends its time zone with them
function tzOf_(o) {
  var z = String((o && o.tz) || '');
  return /^[A-Za-z]+(\/[A-Za-z0-9_+\-]+){1,2}$/.test(z) || z === 'UTC' ? z : TZ;
}

// The Calendar API patch for {title, day, start, end, allDay}
function patchFor_(changes, calId, eventId, zone) {
  var p = {};
  if (changes.title) p.summary = String(changes.title);
  var timing = ['day', 'start', 'end', 'allDay'].some(function (k) { return changes[k] !== undefined && changes[k] !== null && changes[k] !== ''; });
  if (!timing) return p;
  var ex = Calendar.Events.get(calId, eventId) || {};
  var exStart = ex.start || {}, exEnd = ex.end || {};
  var wasAllDay = !!exStart.date;
  var allDay = changes.allDay !== undefined && changes.allDay !== null ? !!changes.allDay : wasAllDay;
  var day = changes.day || exStart.date || String(exStart.dateTime || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) return p;
  if (allDay) {
    var len = wasAllDay && exEnd.date ? Math.max(1, daysBetween_(exStart.date, exEnd.date)) : 1;
    p.start = { date: day, dateTime: null };
    p.end = { date: keyPlus_(day, len), dateTime: null };
  } else {
    zone = zone || TZ;
    var exSt = wasAllDay ? '' : String(exStart.dateTime || '').slice(11, 16);
    var st = hm_(changes.start) || exSt || '09:00';
    p.start = { dateTime: day + 'T' + st + ':00', timeZone: zone, date: null };
    // the end on its own day: overnight, or the last day of something longer
    var endDay = /^\d{4}-\d{2}-\d{2}$/.test(String(changes.endDay || '')) && changes.endDay > day ? changes.endDay : day;
    var en = hm_(changes.end);
    var len = wasAllDay ? 0 : Date.parse(exEnd.dateTime) - Date.parse(exStart.dateTime);
    if (!en && len > 0) {
      // no new end: keep how long it was, even past midnight
      var startMs = Utilities.parseDate(day + ' ' + st + ':00', zone, 'yyyy-MM-dd HH:mm:ss').getTime();
      p.end = { dateTime: Utilities.formatDate(new Date(startMs + len), zone, "yyyy-MM-dd'T'HH:mm:ss"), timeZone: zone, date: null };
    } else {
      en = en || addMins_(st, 60);
      if (endDay === day && mins_(en) <= mins_(st)) en = addMins_(st, 60);
      p.end = { dateTime: endDay + 'T' + en + ':00', timeZone: zone, date: null };
    }
  }
  return p;
}

// ===================== event reminders =====================
// Reminders are set in the app and kept where only that person can read them (people/{id}/private/main),
// or on their record (people/{id}.reminders) if they were set before that.
// This account sends the ones for events in its own calendars, whoever set them.
var REMIND_DAYS_ = { w2: 14, w1: 7, d1: 1, d0: 0 };
var REMIND_MINS_ = { h1: 60, m30: 30 };
var BIRTHDAY_RE_ = /\bbirthday\b|\bbday\b|\bb-day\b/i;

function evRef_(person, calKey, o) {
  if (o.tag) return 't:' + o.tag;
  return 'e:' + person + ':' + calKey + ':' + (o.uid || o.sid || o.id);
}
function reminderId_(ref) {
  var h = 5381;
  for (var i = 0; i < ref.length; i++) h = ((h * 33) ^ ref.charCodeAt(i)) >>> 0;
  return 'r' + h.toString(36) + ref.length.toString(36);
}
function evStartKey_(o) { return o.ad ? o.sd : Utilities.formatDate(new Date(o.s), TZ, 'yyyy-MM-dd'); }
function keyPlus_(key, n) {
  var d = Utilities.parseDate(key + ' 12:00', TZ, 'yyyy-MM-dd HH:mm');
  return Utilities.formatDate(new Date(d.getTime() + n * 864e5), TZ, 'yyyy-MM-dd');
}
function localTime_(key, hm) { return Utilities.parseDate(key + ' ' + (hm || '09:00'), TZ, 'yyyy-MM-dd HH:mm').getTime(); }

// When each reminder goes off, the same way the app works it out.
function fireTimes_(times, o, remindAt) {
  var out = [];
  var key = evStartKey_(o);
  (times || []).forEach(function (code) {
    if (REMIND_MINS_[code]) { if (!o.ad) out.push({ code: code, at: o.s - REMIND_MINS_[code] * 60e3 }); return; }
    if (REMIND_DAYS_[code] === undefined) return;
    var at = localTime_(keyPlus_(key, -REMIND_DAYS_[code]), remindAt);
    if (code === 'd0' && !o.ad && o.s - 3600e3 < at) at = o.s - 3600e3;
    out.push({ code: code, at: at });
  });
  return out;
}
function reminderLine_(o, now) {
  var key = evStartKey_(o);
  var today = Utilities.formatDate(new Date(now), TZ, 'yyyy-MM-dd');
  var days = Math.round((localTime_(key, '12:00') - localTime_(today, '12:00')) / 864e5);
  var time = o.ad ? '' : ' at ' + timeText_(o.s);
  var full = dayLabel_(key);
  if (days <= 0) return (!o.ad && o.s > now && o.s - now <= 90 * 60e3) ? 'Soon, at ' + timeText_(o.s) + '.' : 'Today' + time + '.';
  if (days === 1) return 'Tomorrow' + time + '.';
  if (days === 7) return 'In a week, on ' + full + time + '.';
  if (days === 14) return 'In two weeks, on ' + full + time + '.';
  return 'In ' + days + ' days, on ' + full + time + '.';
}
// "In 30 minutes, at 4pm. Shirley Dental."
function leaveLine_(code, o) {
  var lead = code === 'm30' ? 'In 30 minutes' : 'In an hour';
  return lead + ', at ' + timeText_(o.s) + '.' + (o.l ? ' ' + String(o.l).replace(/\.?\s*$/, '.') : '');
}
function timeText_(ms) {
  var h = Number(Utilities.formatDate(new Date(ms), TZ, 'H'));
  var m = Number(Utilities.formatDate(new Date(ms), TZ, 'm'));
  var suf = h < 12 ? 'am' : 'pm';
  var h12 = h % 12 === 0 ? 12 : h % 12;
  return h12 + (m ? ':' + (m < 10 ? '0' : '') + m : '') + suf;
}

function fireReminders_(me, ctx, seen) {
  var now = Date.now();
  var byRef = {};
  (seen || []).forEach(function (x) {
    var ref = evRef_(me.person, x.calKey, x.ev);
    (byRef[ref] = byRef[ref] || []).push(x);
  });
  var props = PropertiesService.getUserProperties();
  var fired = {};
  try { fired = JSON.parse(props.getProperty('rem_fired') || '{}'); } catch (e) { fired = {}; }
  var writes = [];
  var newly = {};

  function consider(personId, settings, ref, rem, list) {
    (list || []).forEach(function (x) {
      var o = x.ev;
      var title = o.t || rem.title || 'Reminder';
      if (personId !== me.person) {
        // someone else's reminder on this person's event: only what they're allowed to see
        if ((x.share || 'busy') !== 'all' || o.pb) return;
        var sh = shareFilter_(x.doc || { share: x.share }, [o]);
        if (!sh || !sh.length) return;
        o = merge_(o, { t: sh[0].t, l: sh[0].l });
        title = o.t || rem.title || 'Reminder';
      }
      var end = o.ad ? localTime_(o.ed || keyPlus_(o.sd, 1), '00:00') : o.e;
      if (end <= now) return;
      var occ = ref + '@' + evStartKey_(o);
      var doneAt = (rem.done && rem.done[occ]) || 0;
      fireTimes_(rem.times, o, settings.remindAt || '09:00').forEach(function (f) {
        if (f.at > now || now - f.at > 36 * 3600e3) return;
        var key = personId + '|' + occ + '|' + f.code;
        // (newly: the same event seen twice by this account, say in your partner's calendar shared with you)
        if (fired[key] || newly[key] || doneAt >= f.at) return;
        newly[key] = now;
        var line = (REMIND_MINS_[f.code] && o.l) ? leaveLine_(f.code, o) : reminderLine_(o, now);
        var body = line + (rem.note ? ' ' + String(rem.note).replace(/\.?$/, '.') : '');
        writes.push(upd_(HOUSEHOLD + '/notify/' + Utilities.getUuid(), {
          to: personId, kind: 'reminders', title: title, body: body, link: '#today', sendAfter: now, sent: false, created: now
        }));
      });
    });
  }

  me.people.forEach(function (p) {
    var priv = privateOf_(ctx, p.id);
    var rems = merge_(p.data.reminders || {}, priv.reminders || {});
    var settings = p.data.settings || {};
    var bdays = (settings.autoRemind && settings.autoRemind.birthdays) || [];
    if (!Array.isArray(bdays)) bdays = [];
    Object.keys(rems).forEach(function (id) {
      var r = rems[id];
      if (!r || r.owner !== me.person || !r.ref) return;
      var times = r.auto ? bdays : r.times;
      // (one odd value never stops everyone's reminders)
      if (!Array.isArray(times) || !times.length) return;
      consider(p.id, settings, r.ref, merge_(r, { times: times }), byRef[r.ref]);
    });
    // every birthday in your own calendars, unless you've set that one yourself
    if (p.id === me.person && bdays.length) {
      Object.keys(byRef).forEach(function (ref) {
        if (rems[reminderId_(ref)]) return;
        var list = byRef[ref].filter(function (x) { return x.shown && x.ev.ad && BIRTHDAY_RE_.test(x.ev.t || ''); });
        if (list.length) consider(p.id, settings, ref, { times: bdays, note: '', title: list[0].ev.t }, list);
      });
    }
  });
  // only the last few days are needed (older reminder times are skipped anyway)
  sendOnce_(props, 'rem_fired', fired, newly, 3, writes);
}

// Remember what's being sent before sending it, so a list that can't be saved never sends the same thing
// again every 10 minutes. Kept to the last few days: a saved value can't be bigger than about 9 KB.
function sendOnce_(props, key, sent, newly, days, writes) {
  var now = Date.now();
  var keys = Object.keys(newly);
  if (!keys.length) return;
  var before = props.getProperty(key);
  keys.forEach(function (k) { sent[k] = newly[k]; });
  Object.keys(sent).forEach(function (k) { if (!(now - sent[k] <= days * 864e5)) delete sent[k]; });
  props.setProperty(key, JSON.stringify(sent));
  try { fsCommit_(writes); } catch (err) {
    // not sent after all: try them again next time
    if (before === null) props.deleteProperty(key); else props.setProperty(key, before);
    throw err;
  }
}

// ===================== jobs (chores) =====================

function processJobs_(me, ctx) {
  var now = Date.now();
  var today = Utilities.formatDate(new Date(now), TZ, 'yyyy-MM-dd');
  // only today's open ones: done jobs are kept, and reading them all every 10 minutes adds up
  var jobs = fsQuery_('jobs', [['done', false], ['day', today]]);
  var props = PropertiesService.getUserProperties();
  var sent = {};
  try { sent = JSON.parse(props.getProperty('job_sent') || '{}'); } catch (e) { sent = {}; }
  var remindAt = ctx.settings.remindAt || '09:00';
  var partner = partnerOf_(me, ctx);
  var writes = [];
  var newly = {};
  jobs.forEach(function (j) {
    var d = j.data;
    if (d.done || d.remind === false || d.day !== today) return;
    if (d.who !== me.person && d.who !== 'both') return;
    var at = d.time && hm_(d.time) ? localTime_(today, hm_(d.time)) - 30 * 60e3 : localTime_(today, remindAt);
    if (now < at) return;
    var key = me.person + '|' + j.id + '|' + today;
    if (sent[key]) return;
    newly[key] = now;
    var body = d.who === 'both' ? 'With ' + ((partner && partner.name) || 'your partner') + '.' : 'On your list for today.';
    if (d.time && hm_(d.time)) body = 'At ' + timeText_(localTime_(today, hm_(d.time))) + '. ' + body;
    writes.push(upd_(HOUSEHOLD + '/notify/' + Utilities.getUuid(), { to: me.person, kind: 'jobs', title: 'Today: ' + (d.title || 'a job'), body: body, link: '#today', sendAfter: now, sent: false, created: now }));
  });
  // each is for today only
  sendOnce_(props, 'job_sent', sent, newly, 2, writes);
}
function partnerOf_(me, ctx) {
  var ids = Object.keys(ctx.people).filter(function (pid) { return pid !== me.person; });
  return ids.length ? merge_(ctx.people[ids[0]], { id: ids[0] }) : null;
}

// ===================== morning summary and week ahead =====================

var DEFAULT_SHIFTS_ = {
  long: { label: 'Long day', start: '07:30', end: '20:00' },
  night: { label: 'Night', start: '19:30', end: '08:00' },
  early: { label: 'Early', start: '07:00', end: '15:30' },
  late: { label: 'Late', start: '12:30', end: '20:30' },
  leave: { label: 'Holiday', allDay: true },
  off: { label: 'Day off', allDay: true }
};
var HOLIDAY_RE_ = /\b(holiday|annual leave|day off|out of office|ooo|bank holiday|leave)\b/i;

function digests_(me, ctx) {
  var now = Date.now();
  var today = Utilities.formatDate(new Date(now), TZ, 'yyyy-MM-dd');
  var props = PropertiesService.getUserProperties();
  var s = ctx.settings || {};
  var morning = s.morning || {};
  var week = s.weekAhead || {};
  var wantMorning = false, wantWeek = false;
  if (morning.on !== false) {
    var atM = localTime_(today, hm_(morning.at) || '07:30');
    wantMorning = now >= atM && now - atM <= 3 * 3600e3 && props.getProperty('digest_morning') !== today;
  }
  if (week.on !== false && isoWd_(today) === (+week.day || 7)) {
    var atW = localTime_(today, hm_(week.at) || '18:00');
    wantWeek = now >= atW && now - atW <= 3 * 3600e3 && props.getProperty('digest_week') !== today;
  }
  if (!wantMorning && !wantWeek) return;
  var data = digestData_(me, ctx);
  var writes = [];
  if (wantMorning) writes.push(upd_(HOUSEHOLD + '/notify/' + Utilities.getUuid(), { to: me.person, kind: 'summary', title: "Good morning. Here's " + WEEKDAYS_[isoWd_(today) - 1], body: morningText_(data, today), link: '#today', sendAfter: now, sent: false, created: now }));
  if (wantWeek) writes.push(upd_(HOUSEHOLD + '/notify/' + Utilities.getUuid(), { to: me.person, kind: 'summary', title: 'Your week ahead', body: weekText_(data, nextMonday_(today)), link: '#calendar', sendAfter: now, sent: false, created: now }));
  // remembered before it's sent (as for reminders), so a run stopped just after sending never sends it again
  var before = { digest_morning: props.getProperty('digest_morning'), digest_week: props.getProperty('digest_week') };
  if (wantMorning) props.setProperty('digest_morning', today);
  if (wantWeek) props.setProperty('digest_week', today);
  try { fsCommit_(writes); } catch (err) {
    Object.keys(before).forEach(function (k) { if (before[k] === null) props.deleteProperty(k); else props.setProperty(k, before[k]); });
    throw err;
  }
}

// Everything the summaries need: both people's settings, events, calendars, shifts and jobs.
function digestData_(me, ctx) {
  var partner = partnerOf_(me, ctx);
  var cals = {};
  fsList_(HOUSEHOLD + '/calendars').forEach(function (d) { cals[d.id] = d.data; });
  var feedsFor = function (coll, owner) {
    var list = [];
    fsQuery_(coll, [['owner', owner]]).forEach(function (f) {
      var c = cals[owner + '__' + f.data.calKey] || {};
      (f.data.events || []).forEach(function (e) { list.push({ ev: e, cal: c }); });
    });
    return list;
  };
  var overrides = {};
  // from yesterday on (the summaries look at today and the week ahead): not every shift ever put in by hand
  var since = keyPlus_(Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'), -1);
  fsQuery_('shifts', [['day', since, '>=']]).forEach(function (d) { if (d.data.person && d.data.day) overrides[d.data.person + '|' + d.data.day] = d.data; });
  // only the ones still to do (done ones are kept, and there are more of them every week)
  var jobs = fsQuery_('jobs', [['done', false]]).map(function (j) { return j.data; });
  var mine = { id: me.person, name: 'You', settings: ctx.settings || {}, items: feedsFor('privateFeeds', me.person), mine: true };
  // (their working hours aren't said when every work calendar of theirs is shared as Nothing, as in the app)
  var workCals = partner ? Object.keys(cals).map(function (k) { return cals[k]; }).filter(function (c) { return c && c.owner === partner.id && c.role === 'work'; }) : [];
  var hideWork = workCals.length > 0 && workCals.every(function (c) { return c.share === 'none'; });
  var theirs = partner ? { id: partner.id, name: partner.name || 'Your partner', settings: partner.settings || {}, items: feedsFor('sharedFeeds', partner.id), mine: false, hideWork: hideWork } : null;
  // whose calendars each thing made in the app is in, and the requests they came from (read only when needed)
  var tagOwners = {};
  [mine, theirs].forEach(function (p) {
    if (p) p.items.forEach(function (x) { if (x.ev && x.ev.tag) (tagOwners[x.ev.tag] = tagOwners[x.ev.tag] || {})[p.id] = true; });
  });
  var reqs = {};
  var reqOf = function (id) {
    if (!(id in reqs)) reqs[id] = /^[A-Za-z0-9_-]+$/.test(id) ? fsGet_(HOUSEHOLD + '/requests/' + id) : null;
    return reqs[id];
  };
  return { me: mine, partner: theirs, overrides: overrides, jobs: jobs, tagOwners: tagOwners, reqOf: reqOf };
}

// Something made in the app, the way the app sees it: 'both' (added for you both, or a request between you),
// 'own' (a favour, something added for one of you, a holiday booked just for yourself), or 'skip' (said no to or
// called off)
function togetherOf_(tag, data) {
  tag = String(tag || '');
  if (/^both:/.test(tag)) return 'both';
  if (!/^req:/.test(tag)) return 'own';
  var r = data.reqOf ? data.reqOf(tag.slice(4)) : null;
  if (r && (r.status === 'no' || r.status === 'cancelled')) return 'skip';
  if (Object.keys((data.tagOwners || {})[tag] || {}).length > 1) return 'both';
  var justOne = r && (r.own === true || (Array.isArray(r.people) && r.people.length === 1));
  return r && r.type !== 'favour' && r.type !== 'add' && !justOne ? 'both' : 'own';
}

// One person's day: shift, work, day off, their own events, and things together.
function personDay_(p, key, data) {
  var s = p.settings || {};
  var dayStart = localTime_(key, '00:00'), dayEnd = localTime_(keyPlus_(key, 1), '00:00');
  var out = { shift: null, work: null, off: '', events: [], together: [] };
  var ov = data.overrides[p.id + '|' + key];
  var rota = [];
  p.items.forEach(function (x) {
    var e = x.ev, c = x.cal;
    if (p.mine && c.show === false) return;
    var s0 = e.ad ? localTime_(e.sd, '00:00') : e.s;
    var e0 = e.ad ? localTime_(e.ed || keyPlus_(e.sd, 1), '00:00') : e.e;
    if (!(s0 < dayEnd && e0 > dayStart)) return;
    // (a contact's birthday in a rota kept in your main calendar is just a birthday, never the day's shift)
    if (c.role === 'rota' && !e.np) { if (e.ad ? e.sd <= key && key < (e.ed || keyPlus_(e.sd, 1)) : evStartKey_(e) === key) rota.push(e); return; }
    if (e.tag && /^(both:|req:)/.test(e.tag)) {
      var tk = togetherOf_(e.tag, data);
      if (tk === 'skip') return;
      if (tk === 'both') { out.together.push(e); return; }
    }
    if (c.role === 'work') return;
    if (c.layer && c.layer !== 'own') return;
    if (e.ad && HOLIDAY_RE_.test(e.t || '')) { if (e.sd === key || s0 <= dayStart) out.off = 'holiday'; return; }
    if (!e.ad && s0 < dayStart) return;
    out.events.push(e);
  });
  if (ov) {
    var types = merge_(DEFAULT_SHIFTS_, s.shiftTypes || {});
    var def = types[ov.type] || {};
    if (ov.type === 'off' || ov.type === 'leave' || def.allDay) out.off = ov.type === 'leave' ? 'holiday' : 'day off';
    else {
      var st = localTime_(key, hm_(ov.start) || def.start || '09:00');
      var en = localTime_(key, hm_(ov.end) || def.end || '17:00');
      // overnight: that time the next morning (a night when the clocks change is 23 or 25 hours long)
      if (en <= st) en = localTime_(keyPlus_(key, 1), hm_(ov.end) || def.end || '17:00');
      out.shift = { t: def.label || 'Shift', s: st, e: en, type: ov.type };
    }
  } else if (rota.length) {
    var r = rota[0];
    if (r.ad) { if (/leave|holiday|annual/i.test(r.t || '')) out.off = 'holiday'; else if (/off|rest/i.test(r.t || '')) out.off = 'day off'; }
    else out.shift = { t: r.t, s: r.s, e: r.e };
  }
  if (!s.hasShifts && !out.shift) {
    var wd = isoWd_(key);
    var days = s.workDays || [1, 2, 3, 4, 5];
    if (days.indexOf(wd) >= 0) {
      if (altOff_(s, key)) out.off = out.off || 'day off';
      else if (!out.off && !p.hideWork) out.work = { s: localTime_(key, hm_(s.workStart) || '09:00'), e: localTime_(key, hm_(s.workEnd) || '18:00') };
    }
  }
  out.events.sort(function (a, b) { return (a.ad ? 0 : a.s) - (b.ad ? 0 : b.s); });
  return out;
}
function altOff_(s, key) {
  var a = s && s.altOff;
  if (!a || !a.day || !a.from) return false;
  if (isoWd_(key) !== +a.day) return false;
  var days = daysBetween_(a.from, key);
  return ((days % 14) + 14) % 14 === 0;
}
// "long day until 8pm", "night shift from 7:30pm"
function shiftWords_(sh) {
  var t = String(sh.t || '').toLowerCase();
  var kind = /night/.test(t) ? 'night shift' : /long/.test(t) ? 'long day' : /early/.test(t) ? 'early shift' : /late/.test(t) ? 'late shift' : '';
  if (!kind && sh.s && sh.e) {
    var hours = (sh.e - sh.s) / 3600e3;
    var startH = Number(Utilities.formatDate(new Date(sh.s), TZ, 'H'));
    var crosses = evStartKey_({ s: sh.s }) !== evStartKey_({ s: sh.e - 1 });
    kind = crosses || startH >= 18 ? 'night shift' : hours >= 11 ? 'long day' : startH < 10 ? 'early shift' : 'late shift';
  }
  return kind || 'shift';
}
function dayWords_(d) {
  var bits = [];
  if (d.shift) bits.push(shiftWords_(d.shift) + (shiftWords_(d.shift) === 'night shift' ? ' from ' + timeText_(d.shift.s) : ' until ' + timeText_(d.shift.e)));
  else if (d.work) bits.push('working ' + timeText_(d.work.s) + ' to ' + timeText_(d.work.e));
  else if (d.off) bits.push(d.off === 'holiday' ? 'on holiday' : 'day off');
  d.events.slice(0, 3).forEach(function (e) { bits.push(e.ad ? (e.t || 'something on') : (e.t || 'Busy') + ' at ' + timeText_(e.s)); });
  if (d.events.length > 3) bits.push((d.events.length - 3) + ' more');
  return bits.length ? bits.join(', ') : 'nothing planned';
}
function morningText_(data, key) {
  var parts = [];
  var mine = personDay_(data.me, key, data);
  parts.push('You: ' + dayWords_(mine));
  var together = mine.together.slice();
  if (data.partner) {
    var theirs = personDay_(data.partner, key, data);
    parts.push(data.partner.name + ': ' + dayWords_(theirs));
    theirs.together.forEach(function (e) { if (!together.some(function (x) { return x.tag === e.tag; })) together.push(e); });
  }
  if (together.length) {
    parts.push('Together: ' + together.map(function (e) {
      var t = String(e.t || 'Plans').replace(/^pencilled in:\s*/i, '');
      return e.ad ? t : t + ' at ' + timeText_(e.s);
    }).join(', '));
  }
  var jobs = data.jobs.filter(function (j) { return !j.done && j.day === key && (j.who === data.me.id || j.who === 'both'); });
  if (jobs.length) parts.push('Jobs: ' + jobs.map(function (j) { return j.title; }).join(', '));
  return parts.join('. ') + '.';
}
var SHIFT_PLURAL_ = { 'long day': 'long days', 'night shift': 'nights', 'early shift': 'earlies', 'late shift': 'lates', 'shift': 'shifts' };
function weekText_(data, monday) {
  var keys = [];
  for (var i = 0; i < 7; i++) keys.push(keyPlus_(monday, i));
  var people = [data.partner, data.me].filter(Boolean);
  var days = {};
  people.forEach(function (p) { days[p.id] = keys.map(function (k) { return personDay_(p, k, data); }); });
  var parts = [];
  people.forEach(function (p) {
    var groups = {}, order = [];
    var offs = [];
    days[p.id].forEach(function (d, i) {
      if (d.shift) {
        var w = SHIFT_PLURAL_[shiftWords_(d.shift)] || 'shifts';
        if (!groups[w]) { groups[w] = []; order.push(w); }
        groups[w].push(WEEKDAYS_[i]);
      } else if (d.off && (p.settings.hasShifts ? d.off === 'holiday' : (p.settings.workDays || [1, 2, 3, 4, 5]).indexOf(i + 1) >= 0)) {
        offs.push(WEEKDAYS_[i]);
      }
    });
    var bits = order.map(function (w) { return w + ' ' + andList_(groups[w]); });
    if (offs.length) bits.push(andList_(offs) + ' off');
    if (bits.length) parts.push(p.name + ': ' + bits.join(', '));
    else if (p.settings.hasShifts) parts.push(p.name + ': no shifts');
  });
  if (data.partner) {
    var free = [];
    keys.forEach(function (k, i) {
      var lo = localTime_(k, '18:00'), hi = localTime_(k, '23:00');
      var busy = people.some(function (p) {
        var d = days[p.id][i];
        var spans = [];
        if (d.shift) spans.push([d.shift.s, d.shift.e]);
        if (d.work) spans.push([d.work.s, d.work.e]);
        d.events.forEach(function (e) { if (!e.ad) spans.push([e.s, e.e]); });
        d.together.forEach(function (e) { if (!e.ad) spans.push([e.s, e.e]); });
        return spans.some(function (sp) { return sp[0] < hi && sp[1] > lo; });
      });
      if (!busy) free.push(WEEKDAYS_[i]);
    });
    parts.push('Both free: ' + (free.length ? andList_(free) + (free.length === 1 ? ' evening' : ' evenings') : 'no evenings this week'));
  }
  return parts.join('. ') + '.';
}
function nextMonday_(key) {
  var wd = isoWd_(key);
  return keyPlus_(key, 8 - wd);
}
function andList_(a) { return a.length <= 1 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; }

// ===================== backup to Google Drive =====================

function backup_(me, ctx, force) {
  var props = PropertiesService.getUserProperties();
  var last = +props.getProperty('last_backup') || 0;
  if (!force && Date.now() - last < 7 * 864e5) return '';
  // if Drive is having problems, try again every 6 hours, not every run
  if (!force && Date.now() - (+props.getProperty('backup_try') || 0) < 6 * 3600e3) return '';
  props.setProperty('backup_try', String(Date.now()));
  var hh = clone_(ctx.hh && Object.keys(ctx.hh).length ? ctx.hh : (fsGet_(HOUSEHOLD) || {}));
  delete hh.pingSecret;
  var dump = { exported: new Date().toISOString(), household: hh };
  ['people', 'calendars', 'requests', 'notes', 'shifts', 'jobs', 'ideas'].forEach(function (c) {
    dump[c] = fsList_(HOUSEHOLD + '/' + c).map(function (d) { return merge_({ id: d.id }, d.data); });
  });
  // nor what your partner's record still holds from before it had a private place (the app moves it there):
  // their rota link, reminders and private countdowns
  dump.people.forEach(function (p) {
    if (p.id === me.person) return;
    delete p.reminders;
    if (p.settings && typeof p.settings === 'object') delete p.settings.rotaUrl;
    var cds = p.countdowns && typeof p.countdowns === 'object' ? p.countdowns : {};
    Object.keys(cds).forEach(function (k) { if (!cds[k] || cds[k].shared === false) delete cds[k]; });
  });
  // your own reminders and private countdowns, never your partner's (this goes in your Google Drive)
  dump.mine = { person: me.person, private: fsGet_(HOUSEHOLD + '/people/' + me.person + '/private/main') || {} };
  var token = ScriptApp.getOAuthToken();
  var api = 'https://www.googleapis.com/drive/v3/files';
  var auth = { Authorization: 'Bearer ' + token };
  var json = function (res, what) {
    if (res.getResponseCode() >= 300) throw new Error('Google Drive ' + what + ' failed (' + res.getResponseCode() + ').');
    return JSON.parse(res.getContentText() || '{}');
  };
  var folder = props.getProperty('backup_folder') || '';
  if (folder) {
    var chk = UrlFetchApp.fetch(api + '/' + encodeURIComponent(folder) + '?fields=id,trashed', { headers: auth, muteHttpExceptions: true });
    if (chk.getResponseCode() >= 300 || JSON.parse(chk.getContentText() || '{}').trashed) folder = '';
  }
  if (!folder) {
    var q = "name = 'Caledonite backups' and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
    var found = json(UrlFetchApp.fetch(api + '?q=' + encodeURIComponent(q) + '&fields=files(id)&spaces=drive', { headers: auth, muteHttpExceptions: true }), 'search');
    folder = found.files && found.files.length ? found.files[0].id : '';
    if (!folder) folder = json(UrlFetchApp.fetch(api + '?fields=id', { method: 'post', contentType: 'application/json', headers: auth, muteHttpExceptions: true, payload: JSON.stringify({ name: 'Caledonite backups', mimeType: 'application/vnd.google-apps.folder' }) }), 'folder').id;
    props.setProperty('backup_folder', folder);
  }
  var name = 'Caledonite backup ' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd') + '.json';
  var boundary = 'caledonite' + Utilities.getUuid().replace(/-/g, '');
  var body = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify({ name: name, parents: [folder], mimeType: 'application/json' }) + '\r\n--' + boundary +
    '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(dump) + '\r\n--' + boundary + '--';
  json(UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'post', contentType: 'multipart/related; boundary=' + boundary, headers: auth, muteHttpExceptions: true, payload: body }), 'upload');
  // keep the newest 8
  var listQ = "'" + folder + "' in parents and trashed = false";
  var files = json(UrlFetchApp.fetch(api + '?q=' + encodeURIComponent(listQ) + '&orderBy=createdTime%20desc&fields=files(id,name,createdTime)&pageSize=100', { headers: auth, muteHttpExceptions: true }), 'list').files || [];
  files.slice(8).forEach(function (f) { UrlFetchApp.fetch(api + '/' + encodeURIComponent(f.id), { method: 'delete', headers: auth, muteHttpExceptions: true }); });
  props.setProperty('last_backup', String(Date.now()));
  return name;
}

// ===================== reminders for unanswered requests =====================

function nudgeRequests_(me, ctx) {
  var hours = Number(ctx.hh.nudgeHours === undefined ? 24 : ctx.hh.nudgeHours);
  if (!hours) return;
  var waiting = fsQuery_('requests', [['from', me.person], ['status', 'waiting']]);
  waiting.forEach(function (r) {
    var d = r.data;
    if (d.autoNudged || d.type === 'heads') return;
    // its time has gone by: nothing left to say yes to (the app offers "Not this time" or Cancel instead)
    if (whenOver_(d.when, Date.now())) return;
    var since = Math.max(d.created || 0, d.reminded || 0);
    if (Date.now() - since < hours * 3600e3) return;
    var name = (ctx.person && ctx.person.name) || 'Your partner';
    // together, and only if it's still as it was read: one answered or called off a moment ago isn't nudged
    var pair = [
      upd_(HOUSEHOLD + '/notify/' + Utilities.getUuid(), { to: d.to, kind: 'requests', title: 'Still waiting: ' + name + ' asked you something', body: d.title || '', link: '#requests', reqId: r.id, ask: '1', sendAfter: Date.now(), sent: false, created: Date.now() }),
      ifSame_(upd_(HOUSEHOLD + '/requests/' + r.id, { autoNudged: Date.now() }, ['autoNudged']), r)
    ];
    try { fsCommit_(pair); } catch (err) { if (!/FAILED_PRECONDITION|^Firestore 409/i.test(String(err && err.message))) throw err; }
  });
}

// A request's time ({ day, start, end, allDay, endDay }) is over: past the end of its last day, or its end time
function whenOver_(w, now) {
  if (!w || !/^\d{4}-\d{2}-\d{2}$/.test(String(w.day || ''))) return false;
  var last = /^\d{4}-\d{2}-\d{2}$/.test(String(w.endDay || '')) && w.endDay > w.day ? w.endDay : w.day;
  if (w.allDay) return now >= localTime_(keyPlus_(last, 1), '00:00');
  var st = hm_(w.start) || '19:00';
  var en = hm_(w.end) || addMins_(st, 60);
  // overnight (an end before the start, on the same day): the next morning
  if (last === w.day && mins_(en) <= mins_(st)) last = keyPlus_(w.day, 1);
  return now >= localTime_(last, en);
}

// ===================== notifications =====================

// Quiet hours (default 11pm to 7am): is this moment inside them, and when do they end?
// quiet.skip = a date: the quiet hours that start that evening are skipped ("not tonight"),
// including the early-morning part of the same night.
function quietUntil_(settings, now) {
  var q = (settings && settings.quiet) || {};
  if (q.on === false) return 0;
  var fromHm = hm_(q.from) || '23:00', toHm = hm_(q.to) || '07:00';
  var from = mins_(fromHm), to = mins_(toHm);
  if (from === to) return 0;
  var key = Utilities.formatDate(new Date(now), TZ, 'yyyy-MM-dd');
  var cur = Number(Utilities.formatDate(new Date(now), TZ, 'H')) * 60 + Number(Utilities.formatDate(new Date(now), TZ, 'm'));
  var startKey = '', until = 0;
  if (from < to) {
    if (cur >= from && cur < to) { startKey = key; until = localTime_(key, toHm); }
  } else if (cur >= from) {
    startKey = key; until = localTime_(keyPlus_(key, 1), toHm);
  } else if (cur < to) {
    startKey = keyPlus_(key, -1); until = localTime_(key, toHm);
  }
  if (!until) return 0;
  if (q.skip && String(q.skip) === startKey) return 0;
  return until;
}

// Asleep after a night shift, worked out the way the app does: when they wake (ms), or 0.
// p: { id, settings, items: [{ ev, cal }] (their rota), mine }, data: { overrides, jobs }
function sleepUntil_(p, data, now) {
  var s = p.settings || {};
  if (!s.hasShifts || (s.notif && s.notif.quiet === false)) return 0;
  var today = Utilities.formatDate(new Date(now), TZ, 'yyyy-MM-dd');
  var prev = personDay_(p, keyPlus_(today, -1), data).shift;
  if (!prev || !(prev.type ? prev.type === 'night' : shiftWords_(prev) === 'night shift')) return 0;
  // (either of you can set the other's travel time: never more than the app allows, 4 hours; half an hour, as in
  // the app, until it's set)
  var from = prev.e + Math.max(0, Math.min(240, Number(s.travelMins === undefined ? 30 : s.travelMins) || 0)) * 60e3;
  var until = localTime_(today, hm_(s.sleepUntil) || '14:00');
  return now >= from && now < until ? until : 0;
}
// The same for someone a notification is for: their rota and yesterday's shift change, read only when needed
function asleepUntil_(pid, who, ctx, now) {
  var s = (who && who.settings) || {};
  if (!s.hasShifts || (s.notif && s.notif.quiet === false)) return 0;
  ctx.asleep = ctx.asleep || {};
  if (!(pid in ctx.asleep)) {
    try {
      var items = [];
      fsQuery_('calendars', [['owner', pid], ['role', 'rota']]).forEach(function (c) {
        var feeds = fsQuery_('privateFeeds', [['owner', pid], ['calKey', c.data.calKey]]);
        if (!feeds.length) feeds = fsQuery_('sharedFeeds', [['owner', pid], ['calKey', c.data.calKey]]);
        feeds.forEach(function (f) { (f.data.events || []).forEach(function (e) { items.push({ ev: e, cal: c.data }); }); });
      });
      var y = keyPlus_(Utilities.formatDate(new Date(now), TZ, 'yyyy-MM-dd'), -1);
      var overrides = {};
      fsQuery_('shifts', [['person', pid], ['day', y]]).forEach(function (d) { overrides[pid + '|' + y] = d.data; });
      ctx.asleep[pid] = sleepUntil_({ id: pid, settings: s, items: items, mine: false }, { overrides: overrides, jobs: [] }, now);
    } catch (err) {
      Logger.log('asleep: ' + err.message);
      ctx.asleep[pid] = 0;
    }
  }
  return ctx.asleep[pid];
}

// The notifications waiting to go now. Only those whose time has come are read (Peckish queues a week of meal
// reminders, and every run of every account would otherwise read them all, which adds up against the free
// database reads), using the index in the README. Once an hour, for everyone's runs, everything not yet sent is
// read instead, so one saved without a proper time is never stuck; and if the index isn't there yet, always that.
function dueNotify_(now) {
  var cache = null;
  try { cache = CacheService.getScriptCache(); } catch (e) { cache = null; }
  var everything = function () { return fsQuery_('notify', [['sent', false]]).filter(function (n) { return (n.data.sendAfter || 0) <= now; }); };
  if (!cache || !cache.get('notify_swept')) {
    var all = everything();
    if (cache) { try { cache.put('notify_swept', '1', 3600); } catch (e) { /* it's only a saving */ } }
    return all;
  }
  if (!cache.get('notify_noindex')) {
    try { return fsQuery_('notify', [['sent', false], ['sendAfter', now, '<=']]); } catch (err) {
      if (!/index/i.test(String(err && err.message))) throw err;
      Logger.log('notify: the index for waiting notifications is not set up yet (see the README)');
      try { cache.put('notify_noindex', '1', 21600); } catch (e) { /* tried again next run */ }
    }
  }
  return everything();
}

function processNotify_(ctx) {
  var now = Date.now();
  // in the order they were made (a request, then it being called off), not the database's order of their ids
  var due = dueNotify_(now).sort(function (a, b) { return ((a.data.created || a.data.sendAfter || 0) - (b.data.created || b.data.sendAfter || 0)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
  if (!due.length) return;
  var tokensFor = {};
  var outOfTime = false;
  due.forEach(function (n) {
    // the rest wait for the next run (still unsent), rather than this run being stopped part way
    if (outOfTime || timeUsed_() > NOTIFY_BUDGET_) { outOfTime = true; return; }
    var d = n.data;
    // only ever one of the two of you (its address builds the path to their phones)
    if (!Object.prototype.hasOwnProperty.call(ctx.people, String(d.to))) {
      try { fsCommit_([ifSame_(upd_(HOUSEHOLD + '/notify/' + n.id, { sent: true, sentAt: now, error: 'not for anyone here' }, ['sent', 'sentAt', 'error']), n)]); } catch (e) { /* the next run tries again */ }
      return;
    }
    var who = ctx.people[d.to] || {};
    var settings = who.settings || {};
    // inside the person's quiet hours, or asleep after a night shift: wait (a test is sent straight away)
    if (d.kind !== 'test') {
      var until = Math.max(quietUntil_(settings, now), asleepUntil_(d.to, who, ctx, now));
      if (until > now) {
        // only if it's as it was read: one Peckish has just taken back (or changed) is never made again as a stub
        try { fsCommit_([ifSame_(upd_(HOUSEHOLD + '/notify/' + n.id, { sendAfter: until }, ['sendAfter']), n)]); } catch (e) { /* the next run tries again */ }
        return;
      }
    }
    // a question (with Yes and Can't on it) that waited for quiet hours or sleep: not sent once it's been answered
    // or called off, or its time has gone by ("Still waiting" the afternoon after)
    if (d.reqId && d.ask && !askStillOpen_(String(d.reqId), ctx, now)) {
      try { fsCommit_([ifSame_(upd_(HOUSEHOLD + '/notify/' + n.id, { sent: true, sentAt: now, error: 'already answered' }, ['sent', 'sentAt', 'error']), n)]); } catch (e) { /* the next run tries again */ }
      return;
    }
    // claim it, so two accounts never send the same one
    try {
      fsCommit_([{ update: { name: docName_(HOUSEHOLD + '/notify/' + n.id), fields: toFields_({ sent: true, sentAt: now }) }, updateMask: { fieldPaths: ['sent', 'sentAt'] }, currentDocument: { updateTime: n.updateTime } }]);
    } catch (err) { return; }
    var notif = settings.notif || {};
    if (d.kind && notif[d.kind] === false) return;
    // Firebase sends at most 4 KB, so a long note is cut short rather than never arriving
    var msg = { title: cut_(d.title || 'Caledonite', 150), body: cut_(d.body || '', 700), link: cut_(d.link || '#today', 200), tag: String(n.id), kind: String(d.kind || '') };
    if (d.reqId) msg.reqId = String(d.reqId);
    if (d.ask) msg.ask = String(d.ask);
    var delivered = 0, again = false;
    try {
      if (!tokensFor[d.to]) tokensFor[d.to] = fsList_(HOUSEHOLD + '/people/' + d.to + '/tokens');
    } catch (err) { again = true; }
    (tokensFor[d.to] || []).forEach(function (t) {
      var code = 0;
      try { code = sendPush_(t.data.token, msg); } catch (err) { code = 0; }
      if (code >= 200 && code < 300) delivered++;
      else if (code === 404 || code === 410) { try { fsCommit_([{ 'delete': docName_(HOUSEHOLD + '/people/' + d.to + '/tokens/' + t.id) }]); } catch (err) { /* next time */ } }
      else if (!code || code === 429 || code >= 500) again = true;
    });
    // Firebase (or the network) having a moment, and it reached none of their phones: tried again in a few minutes,
    // a couple of times, rather than lost. Never when one phone has it (it would arrive twice there).
    if (!delivered && again) unclaim_(n.id, now);
  });
}
// The request a question is about still wants an answer (read once a run; if it can't be read, it's asked as before)
function askStillOpen_(id, ctx, now) {
  ctx.asks = ctx.asks || {};
  if (!(id in ctx.asks)) {
    var open = true;
    try {
      if (/^[A-Za-z0-9_-]+$/.test(id)) {
        var r = fsGet_(HOUSEHOLD + '/requests/' + id);
        open = !!r && (r.status === 'waiting' || r.status === 'maybe') && !whenOver_(r.when, now);
      }
    } catch (err) { open = true; }
    ctx.asks[id] = open;
  }
  return ctx.asks[id];
}
// Back to waiting, as it was before it was claimed (no fields of its own added, so Peckish can still keep its ones
// up to date). How many times is kept in the script's cache, shared by every account's run.
function unclaim_(id, now) {
  var cache = CacheService.getScriptCache();
  var key = 'push_retry_' + id;
  var n = (+cache.get(key) || 0) + 1;
  if (n > 3) return;
  cache.put(key, String(n), 21600);
  try {
    fsCommit_([{ update: { name: docName_(HOUSEHOLD + '/notify/' + id), fields: toFields_({ sent: false, sendAfter: now + n * 5 * 60e3 }) }, updateMask: { fieldPaths: ['sent', 'sendAfter', 'sentAt'] }, currentDocument: { exists: true } }]);
  } catch (err) { Logger.log('notify retry: ' + err.message); }
}
// A write that only goes through if the document is still exactly as it was read
function ifSame_(w, doc) {
  if (doc && doc.updateTime) w.currentDocument = { updateTime: doc.updateTime };
  return w;
}
function cut_(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function sendPush_(token, msg) {
  var url = 'https://fcm.googleapis.com/v1/projects/' + prop_('PROJECT_ID') + '/messages:send';
  var res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + saToken_() },
    payload: JSON.stringify({ message: { token: token, data: msg, webpush: { headers: { Urgency: 'high', TTL: '86400' } } } })
  });
  return res.getResponseCode();
}

function writeStatus_(me, errors, n) {
  var id = me.email.replace(/[^a-z0-9]+/g, '_');
  var errs = (errors || []).slice(0, 5).map(function (e) { return String(e).slice(0, 200); });
  fsCommit_([upd_(HOUSEHOLD + '/status/' + id, { person: me.person, account: me.email, main: me.main, ok: errs.length === 0, error: (errors || []).join(' | ').slice(0, 300), errors: errs, calendars: n, lastRun: Date.now() })]);
}

// ===================== Firestore (REST, as the service account) =====================

function prop_(k, optional) {
  var v = PropertiesService.getScriptProperties().getProperty(k);
  if (!v && !optional) throw new Error('Missing script property ' + k + '. See Project Settings > Script properties.');
  return v;
}
function saToken_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('sa_token');
  if (hit) return hit;
  var raw = prop_('SA_JSON');
  // (the parser's own message quotes the text around the mistake: part of the key, shown on the connect page)
  var sa;
  try { sa = JSON.parse(raw); } catch (e) { throw new Error('The script property SA_JSON is not the service account key file. Paste the whole file in again.'); }
  var now = Math.floor(Date.now() / 1000);
  var enc = function (o) { return Utilities.base64EncodeWebSafe(JSON.stringify(o)).replace(/=+$/, ''); };
  var input = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({
    iss: sa.client_email, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging'
  });
  var sig = Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(input, sa.private_key)).replace(/=+$/, '');
  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', { method: 'post', muteHttpExceptions: true, payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: input + '.' + sig } });
  if (res.getResponseCode() !== 200) throw new Error('Could not sign in to Firebase: ' + res.getContentText().slice(0, 200));
  var tok = JSON.parse(res.getContentText()).access_token;
  cache.put('sa_token', tok, 3000);
  return tok;
}
function base_() { return 'https://firestore.googleapis.com/v1/projects/' + prop_('PROJECT_ID') + '/databases/(default)/documents'; }
function docName_(path) { return 'projects/' + prop_('PROJECT_ID') + '/databases/(default)/documents/' + path; }
function call_(method, url, body) {
  var opt = { method: method, muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + saToken_() }, contentType: 'application/json' };
  if (body) opt.payload = JSON.stringify(body);
  var res = UrlFetchApp.fetch(url, opt);
  var code = res.getResponseCode();
  if (code === 404 && method === 'get') return null;
  if (code >= 300) {
    var e = new Error('Firestore ' + code + ': ' + res.getContentText().slice(0, 300));
    e.code = code;
    throw e;
  }
  return JSON.parse(res.getContentText() || '{}');
}
function fsGet_(path) {
  var r = call_('get', base_() + '/' + path);
  return r ? fromFields_(r.fields || {}) : null;
}
function fsList_(coll) {
  var out = [];
  var token = '';
  do {
    var r = call_('get', base_() + '/' + coll + '?pageSize=300' + (token ? '&pageToken=' + encodeURIComponent(token) : ''));
    if (!r) break;
    (r.documents || []).forEach(function (d) { out.push({ id: d.name.split('/').pop(), data: fromFields_(d.fields || {}), updateTime: d.updateTime }); });
    token = r.nextPageToken || '';
  } while (token);
  return out;
}
// eqs: [field, value] (equal), or [field, value, '>='] for from that value on ('<=' up to it)
function fsQuery_(collId, eqs) {
  var ops = { '>=': 'GREATER_THAN_OR_EQUAL', '<=': 'LESS_THAN_OR_EQUAL' };
  var filters = eqs.map(function (f) { return { fieldFilter: { field: { fieldPath: f[0] }, op: ops[f[2]] || 'EQUAL', value: toValue_(f[1]) } }; });
  var where = filters.length === 1 ? filters[0] : { compositeFilter: { op: 'AND', filters: filters } };
  var r = call_('post', base_() + '/' + HOUSEHOLD + ':runQuery', { structuredQuery: { from: [{ collectionId: collId }], where: where, limit: 500 } });
  var out = [];
  (r || []).forEach(function (row) {
    if (row.document) out.push({ id: row.document.name.split('/').pop(), data: fromFields_(row.document.fields || {}), updateTime: row.document.updateTime, createTime: row.document.createTime });
  });
  return out;
}
// In parts of at most 400 writes and about 4 MB (Firestore takes 500 writes and 10 MB at once): the first sync of a
// few busy calendars is never one request too big to go through, every run
function fsCommit_(writes) {
  var batch = [], size = 0;
  var send = function () {
    if (batch.length) call_('post', base_().replace(/\/documents$/, '/documents:commit'), { writes: batch });
    batch = []; size = 0;
  };
  writes.forEach(function (w) {
    var n = JSON.stringify(w).length;
    if (batch.length && (batch.length >= 400 || size + n > 4e6)) send();
    batch.push(w); size += n;
  });
  send();
}
function upd_(path, obj, mask) {
  var w = { update: { name: docName_(path), fields: toFields_(obj) } };
  w.updateMask = { fieldPaths: mask || Object.keys(obj) };
  return w;
}
function toFields_(obj) {
  var f = {};
  Object.keys(obj).forEach(function (k) { if (obj[k] !== undefined) f[k] = toValue_(obj[k]); });
  return f;
}
function toValue_(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) < 9e15 ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue_) } };
  return { mapValue: { fields: toFields_(v) } };
}
function fromValue_(v) {
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return new Date(v.timestampValue).getTime();
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue_);
  if ('mapValue' in v) return fromFields_(v.mapValue.fields || {});
  return null;
}
function fromFields_(f) {
  var o = {};
  Object.keys(f).forEach(function (k) { o[k] = fromValue_(f[k]); });
  return o;
}

// ===================== small helpers =====================

function shortKey_(s) {
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(d).replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
}
function hash_(s) { return shortKey_(s); }
function day_(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }
function clone_(o) { return JSON.parse(JSON.stringify(o)); }
function merge_(a, b) { var o = {}; Object.keys(a || {}).forEach(function (k) { o[k] = a[k]; }); Object.keys(b || {}).forEach(function (k) { o[k] = b[k]; }); return o; }
function pad2_(n) { return (n < 10 ? '0' : '') + n; }
// "9:00" or "09:00" as "09:00"; anything else as ''
function hm_(s) {
  var m = String(s || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m || +m[1] > 23 || +m[2] > 59) return '';
  return pad2_(+m[1]) + ':' + m[2];
}
function mins_(hm) { var p = String(hm).split(':'); return (+p[0] || 0) * 60 + (+p[1] || 0); }
function addMins_(hm, n) { var t = Math.min(23 * 60 + 59, mins_(hm) + n); return pad2_(Math.floor(t / 60)) + ':' + pad2_(t % 60); }
// Monday = 1 ... Sunday = 7, for a "YYYY-MM-DD" date
function isoWd_(key) { var d = new Date(Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10))); return ((d.getUTCDay() + 6) % 7) + 1; }
function daysBetween_(a, b) {
  var da = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10)), db = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
  return Math.round((db - da) / 864e5);
}
// "Thursday 5 November"
function dayLabel_(key) { return WEEKDAYS_[isoWd_(key) - 1] + ' ' + (+key.slice(8, 10)) + ' ' + MONTHS_[+key.slice(5, 7) - 1]; }
