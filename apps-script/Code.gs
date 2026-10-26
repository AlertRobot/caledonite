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
var WEEKDAYS_ = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
var MONTHS_ = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ===================== things you run =====================

/** The owner runs this once from the editor. Everyone else uses the Connect page. */
function connectMe() {
  var me = whoAmI_();
  installTrigger_();
  var r = syncAll();
  Logger.log('Connected ' + me.email + ' as ' + me.person + (me.main ? '' : ' (extra account)') + '. ' + r);
  return r;
}

/** Run once by the owner after setting up the two deployments. */
function setupProject() {
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
  removeTriggers_();
  Logger.log('This account will no longer sync.');
}

/** Owner only: back up the app's data to Google Drive now. */
function backupNow() {
  var hh = requireCreator_();
  var me = whoAmI_();
  var name = backup_(me, { hh: hh }, true);
  Logger.log('Saved ' + name + ' in the Caledonite backups folder in Google Drive.');
  return name;
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
  var me;
  try { me = whoAmI_(); } catch (err) {
    throw new Error('This Google account is not part of Caledonite yet. Ask Ethan to add it in Caledonite: Settings, then Account.');
  }
  installTrigger_();
  var r = syncAll();
  var n = (String(r).match(/(\d+) calendar/) || [])[1];
  return 'Connected. ' + (n ? n + ' calendar' + (n === '1' ? '' : 's') + ' synced. ' : '') + 'Caledonite now keeps ' + (me.main ? 'your' : 'this account\'s') + ' calendars up to date by itself. You can close this page.';
}
function disconnectFromPage() {
  removeTriggers_();
  return 'Stopped. This account no longer syncs to Caledonite.';
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
  try { syncAll(); } catch (err) { return text_('error: ' + err.message); }
  return text_('ok');
}
function text_(s) { return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.TEXT); }

// ===================== the sync =====================

function syncAll() {
  var lock = LockService.getUserLock();
  if (!lock.tryLock(25000)) return 'already running';
  var me = null;
  var errors = [];
  var n = 0;
  try {
    me = whoAmI_();
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
    if (me.main && ctx.settings.rotaUrl) stage('rota link', function () { syncRotaLink_(me, ctx); });
    else if (me.main) stage('rota link', function () { dropRotaLink_(me); });
    var changed = stage('outbox', function () { return processOutbox_(me, ctx); });
    if (changed) {
      // let the feeds catch up straight away
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
    lock.releaseLock();
  }
}
function isCreator_(me, ctx) {
  return String(((ctx.hh || {}).emails || [])[0] || '').toLowerCase() === me.email;
}

function whoAmI_() {
  var email = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (!email) throw new Error('Could not tell which Google account this is.');
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
  throw new Error(email + ' is not part of Caledonite. Add it in Caledonite: Settings, Account, then connect it again.');
}

function loadCtx_(me) {
  var hh = fsGet_(HOUSEHOLD) || {};
  var people = {};
  me.people.forEach(function (p) { people[p.id] = p.data; });
  var person = people[me.person] || {};
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
  var defaultId = CalendarApp.getDefaultCalendar().getId();
  var writes = [];
  var props = PropertiesService.getUserProperties();
  var pending = {};   // property updates, saved only once the writes have gone through
  var toForget = [];
  var seenCalKeys = {};
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
      // the same calendar seen from another of this person's accounts: let that account handle it
      if (doc && doc.account && doc.account !== me.email && Date.now() - (doc.lastSeen || 0) < 2 * 864e5) { delete seenCalKeys[calKey]; continue; }
      // calendars set up before family calendars were recognised
      if (doc && !doc.userSet && doc.layer === 'own' && isFamilyCal_(id, meta.name)) {
        writes.push(upd_(docPath, { layer: 'family', share: 'all' }, ['layer', 'share']));
        doc = merge_(doc, { layer: 'family', share: 'all' });
      }
      if (!doc) {
        doc = merge_(meta, defaultsFor_(cal, isPrimary, me));
        writes.push(upd_(docPath, doc));
      } else if (doc.name !== meta.name || doc.color !== meta.color || doc.canWrite !== meta.canWrite || doc.primary !== meta.primary || !doc.lastSeen || Date.now() - doc.lastSeen > 6 * 3600e3) {
        writes.push(upd_(docPath, meta, Object.keys(meta)));
        doc = merge_(doc, meta);
      }
      count++;
      var events = [];
      if (doc.show !== false || (doc.share && doc.share !== 'none')) events = readEvents_(cal, id, from, to);
      var d2 = doc;
      events.forEach(function (o) { seen.push({ calKey: calKey, shown: d2.show !== false, share: d2.share || 'busy', doc: d2, ev: o }); });
      var fw = feedWrites_(me, ctx, calKey, doc, events, props);
      writes = writes.concat(fw.writes);
      pending[fw.key] = fw.value;
      if (doc.role === 'rota') rotaChanged_(me, ctx, calKey, events, props);
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
    var old = {};
    try { old = JSON.parse(all[k] || '{}'); } catch (e) { old = {}; }
    Object.keys(old).forEach(function (path) { writes.push({ 'delete': docName_(path) }); });
    toForget.push(k);
  });
  fsCommit_(writes);
  // only now that the writes went through, remember what was written
  if (Object.keys(pending).length) props.setProperties(pending);
  toForget.forEach(function (k) { props.deleteProperty(k); });
  return { count: count, seen: seen };
}
function safeName_(cal) { try { return cal.getName(); } catch (e) { return ''; } }

function defaultsFor_(cal, isPrimary, me) {
  var id = cal.getId();
  var name = (cal.getName() || '').toLowerCase();
  var personal = /@(gmail|googlemail)\.com$/.test(me.email);
  if (/#contacts@|birthday/.test(id + ' ' + name)) return { show: false, share: 'none', role: 'normal', layer: 'own' };
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
          fields: 'nextPageToken,items(id,iCalUID,recurringEventId,summary,description,location,start,end,status,eventType,attendees(self,responseStatus))'
        });
        (res.items || []).forEach(function (it) { var o = normApi_(it); if (o) out.push(o); });
        token = res.nextPageToken;
      } while (token);
      return out;
    } catch (err) {
      Logger.log('Calendar API failed for ' + id + ', using CalendarApp: ' + err.message);
    }
  }
  var list = cal.getEvents(from, to);
  var evs = [];
  for (var k = 0; k < list.length; k++) { var o2 = norm_(list[k]); if (o2) evs.push(o2); }
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
  o.id = shortKey_(it.iCalUID + '|' + startMs);
  o.uid = shortKey_(it.iCalUID);
  if (it.recurringEventId) o.sid = o.uid;
  // only in your own copy: what the app needs to change or delete this event
  if (it.id) o.gid = it.id;
  if (it.recurringEventId) o.rid = it.recurringEventId;
  if (it.location) o.l = String(it.location).slice(0, 80);
  var m = desc.match(/\[caledonite:([^\]\s]+)\]/);
  if (m) o.tag = m[1];
  if (/#busy\b/i.test(desc)) o.pb = 1;
  return o;
}

function norm_(ev) {
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
  return o;
}

// Turn one calendar's events into the owner's copy and the partner's filtered copy, by month.
// Returns the writes and the property to save once they have gone through.
function feedWrites_(me, ctx, calKey, doc, events, props) {
  var writes = [];
  var pk = 'h_' + calKey;
  var old = {};
  try { old = JSON.parse(props.getProperty(pk) || '{}'); } catch (e) { old = {}; }
  var next = {};
  var byMonth = {};
  events.forEach(function (e) {
    var mk = e.ad ? e.sd.slice(0, 7) : Utilities.formatDate(new Date(e.s), TZ, 'yyyy-MM');
    (byMonth[mk] = byMonth[mk] || []).push(e);
  });
  Object.keys(byMonth).forEach(function (mk) {
    var list = byMonth[mk];
    var base = { owner: me.person, ownerEmail: ctx.appEmail, calKey: calKey, month: mk, account: me.email };
    if (doc.show !== false) {
      var priv = list.map(function (e) { var c = clone_(e); delete c.pb; return c; });
      put_(HOUSEHOLD + '/privateFeeds/' + me.person + '__' + calKey + '__' + mk, base, priv);
    }
    var shared = shareFilter_(doc, list);
    if (shared) put_(HOUSEHOLD + '/sharedFeeds/' + me.person + '__' + calKey + '__' + mk, base, shared);
  });
  function put_(path, base, evs) {
    var h = hash_(JSON.stringify(evs));
    next[path] = h;
    if (old[path] !== h) writes.push(upd_(path, merge_(base, { events: evs, updated: Date.now() })));
  }
  Object.keys(old).forEach(function (path) { if (!next[path]) writes.push({ 'delete': docName_(path) }); });
  return { writes: writes, key: pk, value: JSON.stringify(next) };
}

function shareFilter_(doc, list) {
  var share = doc.share || 'busy';
  if (share === 'none') return null;
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
    delete c.pb; delete c.gid; delete c.rid;
    return c;
  });
}

// ===================== rota link (for example from Loop) =====================

function syncRotaLink_(me, ctx) {
  var url = String(ctx.settings.rotaUrl || '').replace(/^webcal:/i, 'https:');
  if (!/^https:\/\//i.test(url)) return;
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  if (res.getResponseCode() >= 300) throw new Error('The rota link returned an error (' + res.getResponseCode() + ').');
  var events = parseIcs_(res.getContentText());
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
  rotaChanged_(me, ctx, calKey, events, props);
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
    var idx = line.indexOf(':');
    if (idx < 0) return;
    var left = line.slice(0, idx); var val = line.slice(idx + 1);
    var name = left.split(';')[0].toUpperCase();
    if (name === 'SUMMARY') cur.summary = val.replace(/\\,/g, ',').replace(/\\n/gi, ' ').replace(/\\;/g, ';');
    else if (name === 'UID') cur.uid = val;
    else if (name === 'STATUS') cur.status = val.toUpperCase();
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
    icsExpand_(r, to).forEach(function (st) {
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
function icsExpand_(r, to) {
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
    for (var k = 0; guard++ < 2000; k += rule.interval) { if (!add(keyPlus_(startKey, k))) break; }
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
// moving on by a day never looks like a change.
function rotaChanged_(me, ctx, calKey, events, props) {
  var now = Date.now();
  var win = { from: now - 864e5, to: now + 21 * 864e5 };
  var map = {};
  events.forEach(function (e) {
    var s = e.ad ? Utilities.parseDate(e.sd, TZ, 'yyyy-MM-dd').getTime() : e.s;
    var en = e.ad ? Utilities.parseDate(e.ed || keyPlus_(e.sd, 1), TZ, 'yyyy-MM-dd').getTime() : e.e;
    if (s < win.from || s > win.to) return;
    var k = evStartKey_(e);
    while (map[k]) k += '+';
    map[k] = [s, en, e.t || 'Shift'];
  });
  var key = 'rota_' + calKey;
  var before = null;
  try { before = JSON.parse(props.getProperty(key) || 'null'); } catch (err) { before = null; }
  props.setProperty(key, JSON.stringify({ from: win.from, to: win.to, map: map }));
  if (!before || typeof before !== 'object' || !before.map) return;
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
      if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) changes.push({ k: k, what: 'changed', v: b });
    } else if (b) {
      if (inside(b)) changes.push({ k: k, what: 'added', v: b });
    } else if (inside(a)) {
      changes.push({ k: k, what: 'removed', v: a });
    }
  });
  if (!changes.length) return;
  var name = (ctx.person && ctx.person.name) || 'Your partner';
  var parts = changes.slice(0, 2).map(function (c) {
    var label = shiftWords_({ t: c.v[2], s: c.v[0], e: c.v[1] });
    return dayLabel_(c.k.replace(/\+*$/, '')) + ': ' + label + ' ' + c.what + '.';
  });
  if (changes.length > 2) parts.push('And ' + (changes.length - 2) + ' more.');
  var writes = [];
  Object.keys(ctx.people).forEach(function (pid) {
    if (pid === me.person) return;
    writes.push(upd_(HOUSEHOLD + '/notify/' + Utilities.getUuid(), { to: pid, kind: 'rota', title: name + "'s rota has changed", body: parts.join(' '), link: '#calendar', sendAfter: now, sent: false, created: now }));
  });
  if (writes.length) fsCommit_(writes);
}

// ===================== the app's to-do list for your calendars =====================

// Returns true when something in Google Calendar changed, so the feeds can catch up.
function processOutbox_(me, ctx) {
  var items = fsQuery_('outbox', [['person', me.person], ['done', false]]).filter(function (it) {
    var acc = String(it.data.account || '').toLowerCase();
    return acc ? acc === me.email : me.main;
  });
  if (!items.length) return false;
  var rs = { tagMap: {}, owned: null, defaultId: null };
  var writes = [];
  var changed = false;
  // in the order they were made; ones made together (take out the pencilled-in event, then add the agreed one) by seq
  items.sort(function (a, b) { return ((a.data.created || 0) - (b.data.created || 0)) || ((a.data.seq || 0) - (b.data.seq || 0)); });
  var stuck = {};
  items.forEach(function (it) {
    var o = it.data;
    var own = !!ctx.appEmail && String(o.byEmail || '').toLowerCase() === ctx.appEmail;
    var result = {};
    // an earlier change to the same event failed this run: wait, so they still happen in order next time
    if (o.tag && stuck[o.tag]) return;
    try {
      if (o.op === 'create') result = createEvent_(me, ctx, o, own, rs);
      else if (o.op === 'update' || o.op === 'delete') result = own || partnerMayChange_(o.tag, rs) ? changeByTag_(o, rs) : { refused: 'not yours' };
      else if (o.op === 'edit' || o.op === 'remove') result = own ? editOwn_(o, rs) : { refused: 'not yours' };
      else result = { refused: 'unknown change' };
      if (!result.refused && !result.already && (result.eventId || result.changed)) changed = true;
      writes.push(upd_(HOUSEHOLD + '/outbox/' + it.id, { done: true, doneAt: Date.now(), result: result }, ['done', 'doneAt', 'result']));
    } catch (err) {
      if (o.tag) stuck[o.tag] = true;
      var tries = (o.tries || 0) + 1;
      var patch = { tries: tries, error: String(err && err.message || err).slice(0, 200) };
      if (tries >= 5) patch.done = true;
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

// Every event carrying this Caledonite tag, in calendars this account can change.
// Never from event ids the app sends: only what this run made, or what Google finds by the tag.
function findByTag_(rs, tag) {
  if (rs.tagMap[tag] && rs.tagMap[tag].length) return rs.tagMap[tag];
  var owned = ownedCals_(rs);
  var found = [];
  var timeMin = new Date(Date.now() - DAYS_BACK * 864e5 - 864e5).toISOString();
  var timeMax = new Date(Date.now() + (DAYS_AHEAD + 365) * 864e5).toISOString();
  var marker = '[caledonite:' + tag + ']';
  Object.keys(owned).forEach(function (calId) {
    var res = Calendar.Events.list(calId, { privateExtendedProperty: 'caledonite=' + tag, timeMin: timeMin, timeMax: timeMax, singleEvents: false, showDeleted: false, maxResults: 50, fields: 'items(id,status)' });
    (res.items || []).forEach(function (x) { if (x.status !== 'cancelled') found.push({ calId: calId, eventId: x.id }); });
  });
  if (!found.length) {
    // older events, made before the tag was stored as a property, only have it in the description
    Object.keys(owned).forEach(function (calId) {
      var res = Calendar.Events.list(calId, { q: tag, timeMin: timeMin, timeMax: timeMax, singleEvents: false, showDeleted: false, maxResults: 50, fields: 'items(id,status,description)' });
      (res.items || []).forEach(function (x) { if (x.status !== 'cancelled' && String(x.description || '').indexOf(marker) >= 0) found.push({ calId: calId, eventId: x.id }); });
    });
  }
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
  rs.tagMap[tag] = [{ calId: calId, eventId: created.id }];
  return { eventId: created.id, calId: calId };
}
function rrule_(rep) {
  if (!rep || !rep.freq) return '';
  var f = String(rep.freq).toUpperCase();
  if (['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].indexOf(f) < 0) return '';
  return 'RRULE:FREQ=' + f + ';INTERVAL=' + Math.max(1, Math.min(52, Math.floor(+rep.interval || 1)));
}

// update or delete: every copy carrying the tag
function changeByTag_(o, rs) {
  if (!o.tag) return { refused: 'no tag' };
  var owned = ownedCals_(rs);
  var targets = findByTag_(rs, o.tag).filter(function (t) { return owned[t.calId]; });
  var n = 0;
  targets.forEach(function (t) {
    if (o.op === 'delete') { Calendar.Events.remove(t.calId, t.eventId); n++; return; }
    var changes = o.changes || {};
    if (o.event && o.event.title && !changes.title) changes = merge_(changes, { title: o.event.title });
    var patch = patchFor_(changes, t.calId, t.eventId, tzOf_(o));
    if (Object.keys(patch).length) { Calendar.Events.patch(patch, t.calId, t.eventId); n++; }
  });
  if (o.op === 'delete') rs.tagMap[o.tag] = [];
  return { changed: n };
}

// edit or remove one of your own events (or a whole repeating series)
function editOwn_(o, rs) {
  var owned = ownedCals_(rs);
  if (!o.calId || !owned[o.calId]) return { refused: 'calendar not writable' };
  var all = o.scope === 'all' && o.rid;
  var target = all ? o.rid : o.gid;
  if (!target) return { refused: 'no event' };
  if (o.op === 'remove') { Calendar.Events.remove(o.calId, target); return { changed: 1 }; }
  var changes = o.changes || {};
  var patch = all ? (changes.title ? { summary: changes.title } : {}) : patchFor_(changes, o.calId, target, tzOf_(o));
  if (!Object.keys(patch).length) return { changed: 0 };
  Calendar.Events.patch(patch, o.calId, target);
  return { changed: 1 };
}

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
// Reminders are kept on each person's record (people/{id}.reminders), set in the app.
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
        if (fired[key] || doneAt >= f.at) return;
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
    var rems = p.data.reminders || {};
    var settings = p.data.settings || {};
    var bdays = (settings.autoRemind && settings.autoRemind.birthdays) || [];
    Object.keys(rems).forEach(function (id) {
      var r = rems[id];
      if (!r || r.owner !== me.person || !r.ref) return;
      var times = r.auto ? bdays : r.times;
      if (!times || !times.length) return;
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
  if (writes.length) fsCommit_(writes);
  var keys = Object.keys(newly);
  if (keys.length) {
    keys.forEach(function (k) { fired[k] = newly[k]; });
    Object.keys(fired).forEach(function (k) { if (now - fired[k] > 45 * 864e5) delete fired[k]; });
    props.setProperty('rem_fired', JSON.stringify(fired));
  }
}

// ===================== jobs (chores) =====================

function processJobs_(me, ctx) {
  var now = Date.now();
  var today = Utilities.formatDate(new Date(now), TZ, 'yyyy-MM-dd');
  var jobs = fsList_(HOUSEHOLD + '/jobs');
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
  if (writes.length) fsCommit_(writes);
  var keys = Object.keys(newly);
  if (keys.length) {
    keys.forEach(function (k) { sent[k] = newly[k]; });
    Object.keys(sent).forEach(function (k) { if (now - sent[k] > 40 * 864e5) delete sent[k]; });
    props.setProperty('job_sent', JSON.stringify(sent));
  }
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
  fsCommit_(writes);
  if (wantMorning) props.setProperty('digest_morning', today);
  if (wantWeek) props.setProperty('digest_week', today);
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
  fsList_(HOUSEHOLD + '/shifts').forEach(function (d) { if (d.data.person && d.data.day) overrides[d.data.person + '|' + d.data.day] = d.data; });
  var jobs = fsList_(HOUSEHOLD + '/jobs').map(function (j) { return j.data; });
  return {
    me: { id: me.person, name: 'You', settings: ctx.settings || {}, items: feedsFor('privateFeeds', me.person), mine: true },
    partner: partner ? { id: partner.id, name: partner.name || 'Your partner', settings: partner.settings || {}, items: feedsFor('sharedFeeds', partner.id), mine: false } : null,
    overrides: overrides, jobs: jobs
  };
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
    if (c.role === 'rota') { if (e.ad ? e.sd <= key && key < (e.ed || keyPlus_(e.sd, 1)) : evStartKey_(e) === key) rota.push(e); return; }
    if (e.tag && /^(both:|req:)/.test(e.tag)) { out.together.push(e); return; }
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
      if (en <= st) en += 864e5;
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
      else if (!out.off) out.work = { s: localTime_(key, hm_(s.workStart) || '09:00'), e: localTime_(key, hm_(s.workEnd) || '18:00') };
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
  var writes = [];
  waiting.forEach(function (r) {
    var d = r.data;
    if (d.autoNudged || d.type === 'heads') return;
    var since = Math.max(d.created || 0, d.reminded || 0);
    if (Date.now() - since < hours * 3600e3) return;
    var name = (ctx.person && ctx.person.name) || 'Your partner';
    writes.push(upd_(HOUSEHOLD + '/notify/' + Utilities.getUuid(), { to: d.to, kind: 'requests', title: 'Still waiting: ' + name + ' asked you something', body: d.title || '', link: '#requests', reqId: r.id, ask: '1', sendAfter: Date.now(), sent: false, created: Date.now() }));
    writes.push(upd_(HOUSEHOLD + '/requests/' + r.id, { autoNudged: Date.now() }, ['autoNudged']));
  });
  fsCommit_(writes);
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
  var from = prev.e + (Number(s.travelMins) || 0) * 60e3;
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

function processNotify_(ctx) {
  var now = Date.now();
  var due = fsQuery_('notify', [['sent', false]]).filter(function (n) { return (n.data.sendAfter || 0) <= now; });
  if (!due.length) return;
  var tokensFor = {};
  due.forEach(function (n) {
    var d = n.data;
    var who = ctx.people[d.to] || {};
    var settings = who.settings || {};
    // inside the person's quiet hours, or asleep after a night shift: wait (a test is sent straight away)
    if (d.kind !== 'test') {
      var until = Math.max(quietUntil_(settings, now), asleepUntil_(d.to, who, ctx, now));
      if (until > now) {
        try { fsCommit_([upd_(HOUSEHOLD + '/notify/' + n.id, { sendAfter: until }, ['sendAfter'])]); } catch (e) { /* the next run tries again */ }
        return;
      }
    }
    // claim it, so two accounts never send the same one
    try {
      fsCommit_([{ update: { name: docName_(HOUSEHOLD + '/notify/' + n.id), fields: toFields_({ sent: true, sentAt: now }) }, updateMask: { fieldPaths: ['sent', 'sentAt'] }, currentDocument: { updateTime: n.updateTime } }]);
    } catch (err) { return; }
    var notif = settings.notif || {};
    if (d.kind && notif[d.kind] === false) return;
    if (!tokensFor[d.to]) tokensFor[d.to] = fsList_(HOUSEHOLD + '/people/' + d.to + '/tokens');
    var msg = { title: String(d.title || 'Caledonite'), body: String(d.body || ''), link: String(d.link || '#today'), tag: String(n.id), kind: String(d.kind || '') };
    if (d.reqId) msg.reqId = String(d.reqId);
    if (d.ask) msg.ask = String(d.ask);
    tokensFor[d.to].forEach(function (t) {
      var code = sendPush_(t.data.token, msg);
      if (code === 404 || code === 410) fsCommit_([{ 'delete': docName_(HOUSEHOLD + '/people/' + d.to + '/tokens/' + t.id) }]);
    });
  });
}
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
  var sa = JSON.parse(prop_('SA_JSON'));
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
function fsQuery_(collId, eqs) {
  var filters = eqs.map(function (f) { return { fieldFilter: { field: { fieldPath: f[0] }, op: 'EQUAL', value: toValue_(f[1]) } }; });
  var where = filters.length === 1 ? filters[0] : { compositeFilter: { op: 'AND', filters: filters } };
  var r = call_('post', base_() + '/' + HOUSEHOLD + ':runQuery', { structuredQuery: { from: [{ collectionId: collId }], where: where, limit: 500 } });
  var out = [];
  (r || []).forEach(function (row) {
    if (row.document) out.push({ id: row.document.name.split('/').pop(), data: fromFields_(row.document.fields || {}), updateTime: row.document.updateTime });
  });
  return out;
}
function fsCommit_(writes) {
  for (var i = 0; i < writes.length; i += 400) {
    call_('post', base_().replace(/\/documents$/, '/documents:commit'), { writes: writes.slice(i, i + 400) });
  }
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
