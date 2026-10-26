/**
 * Calendite calendar sync.
 *
 * One copy of this script serves everyone. Each person, and each extra Google account
 * (a second Gmail, a work Google account), opens it once while signed in and runs
 * connectMe. From then on it runs by itself every 10 minutes under that account:
 *   - reads the calendars that account can see (including shared family/friends ones)
 *   - writes a full copy for the owner, and a privacy-filtered copy for the partner
 *   - adds, renames and removes events asked for in the app (requests, Add)
 *   - sends phone notifications
 *
 * Script properties (Project Settings > Script properties):
 *   PROJECT_ID   the Firebase project id
 *   SA_JSON      the Firebase service account key (paste the whole JSON file)
 *   WEBAPP_URL   this script's web app address (Deploy > Manage deployments)
 */

var HOUSEHOLD = 'households/main';
var DAYS_BACK = 14;
var DAYS_AHEAD = 120;
var TZ = 'Europe/London';

// ===================== things you run =====================

/** Run once while signed in to the Google account you want to connect. */
function connectMe() {
  var me = whoAmI_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncAll') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncAll').timeBased().everyMinutes(10).create();
  var r = syncAll();
  Logger.log('Connected ' + me.email + ' as ' + me.person + (me.main ? '' : ' (extra account)') + '. ' + r);
  return r;
}

/** Run once by the project owner after deploying the web app. */
function setupProject() {
  var url = prop_('WEBAPP_URL', true) || ScriptApp.getService().getUrl();
  var hh = fsGet_(HOUSEHOLD);
  if (!hh) throw new Error('Open Calendite and finish the first-time setup first.');
  var patch = { scriptUrl: 'https://script.google.com/d/' + ScriptApp.getScriptId() + '/edit' };
  if (url) patch.pingUrl = url;
  fsCommit_([upd_(HOUSEHOLD, patch)]);
  Logger.log('Saved the sync address in Calendite. Now connecting this account...');
  return connectMe();
}

/** Stop syncing this Google account. */
function disconnectMe() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncAll') ScriptApp.deleteTrigger(t);
  });
  Logger.log('This account will no longer sync.');
}

// ===================== web app (instant sync from the app) =====================

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents || '{}'); } catch (err) { body = {}; }
  var hh = fsGet_(HOUSEHOLD) || {};
  if (!body.secret || body.secret !== hh.pingSecret) return text_('no');
  try { syncAll(); } catch (err) { return text_('error: ' + err.message); }
  return text_('ok');
}
function doGet() { return text_('Calendite sync is running.'); }
function text_(s) { return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.TEXT); }

// ===================== the sync =====================

function syncAll() {
  var lock = LockService.getUserLock();
  if (!lock.tryLock(25000)) return 'already running';
  var me = null;
  try {
    me = whoAmI_();
    var ctx = loadCtx_(me);
    var n = syncCalendars_(me, ctx);
    if (me.main && ctx.settings.rotaUrl) syncRotaLink_(me, ctx);
    if (me.main) processOutbox_(me, ctx);
    if (me.main) nudgeRequests_(me, ctx);
    processNotify_(ctx);
    writeStatus_(me, true, '', n);
    return 'Synced ' + n + ' calendars.';
  } catch (err) {
    try { if (me) writeStatus_(me, false, String(err && err.message || err).slice(0, 300), 0); } catch (e2) { /* ignore */ }
    throw err;
  } finally {
    lock.releaseLock();
  }
}

function whoAmI_() {
  var email = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (!email) throw new Error('Could not tell which Google account this is.');
  var people = fsList_(HOUSEHOLD + '/people');
  for (var i = 0; i < people.length; i++) {
    if (String(people[i].data.email || '').toLowerCase() === email) return { email: email, person: people[i].id, main: true, people: people };
  }
  var hh = fsGet_(HOUSEHOLD) || {};
  var linked = hh.linked || [];
  for (var j = 0; j < linked.length; j++) {
    if (String(linked[j].email || '').toLowerCase() === email) return { email: email, person: linked[j].person, main: false, people: people };
  }
  throw new Error(email + ' is not part of Calendite. Add it in Calendite: Settings, Account, then run connectMe again.');
}

function loadCtx_(me) {
  var hh = fsGet_(HOUSEHOLD) || {};
  var people = {};
  me.people.forEach(function (p) { people[p.id] = p.data; });
  var person = people[me.person] || {};
  var calDocs = {};
  fsQuery_('calendars', [['owner', me.person]]).forEach(function (d) { calDocs[d.data.calKey] = d.data; });
  return { hh: hh, people: people, person: person, settings: person.settings || {}, appEmail: String(person.email || '').toLowerCase(), calDocs: calDocs };
}

function syncCalendars_(me, ctx) {
  var now = new Date();
  var from = new Date(now.getTime() - DAYS_BACK * 864e5);
  var to = new Date(now.getTime() + DAYS_AHEAD * 864e5);
  var cals = CalendarApp.getAllCalendars();
  var defaultId = CalendarApp.getDefaultCalendar().getId();
  var writes = [];
  var props = PropertiesService.getUserProperties();
  var seenCalKeys = {};
  var count = 0;
  for (var i = 0; i < cals.length; i++) {
    var cal = cals[i];
    var id = cal.getId();
    var calKey = shortKey_(id);
    seenCalKeys[calKey] = true;
    var isPrimary = id === defaultId;
    var meta = {
      owner: me.person, calKey: calKey, calId: id, name: cal.getName() || 'Calendar', color: cal.getColor() || '',
      account: me.email, canWrite: cal.isOwnedByMe(), primary: isPrimary && me.main, lastSeen: Date.now()
    };
    var doc = ctx.calDocs[calKey];
    var docPath = HOUSEHOLD + '/calendars/' + me.person + '__' + calKey;
    if (!doc) {
      doc = merge_(meta, defaultsFor_(cal, isPrimary, me));
      writes.push(upd_(docPath, doc));
    } else if (doc.name !== meta.name || doc.color !== meta.color || doc.canWrite !== meta.canWrite || doc.primary !== meta.primary || !doc.lastSeen || Date.now() - doc.lastSeen > 6 * 3600e3) {
      writes.push(upd_(docPath, meta, Object.keys(meta)));
      doc = merge_(doc, meta);
    }
    count++;
    var events = [];
    if (doc.show !== false || (doc.share && doc.share !== 'none')) {
      var list = cal.getEvents(from, to);
      for (var k = 0; k < list.length; k++) {
        var o = norm_(list[k]);
        if (o) events.push(o);
      }
    }
    writes = writes.concat(feedWrites_(me, ctx, calKey, doc, events, props));
    if (doc.role === 'rota') rotaChanged_(me, ctx, calKey, events, props);
  }
  // calendars this account no longer has: drop their feeds
  var all = props.getProperties();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('h_') !== 0) return;
    var ck = k.slice(2);
    if (ck === 'rotalink' || seenCalKeys[ck]) return;
    var old = JSON.parse(all[k] || '{}');
    Object.keys(old).forEach(function (path) { writes.push({ 'delete': docName_(path) }); });
    props.deleteProperty(k);
  });
  fsCommit_(writes);
  return count;
}

function defaultsFor_(cal, isPrimary, me) {
  var id = cal.getId();
  var name = (cal.getName() || '').toLowerCase();
  var personal = /@(gmail|googlemail)\.com$/.test(me.email);
  if (/#contacts@|birthday/.test(id + ' ' + name)) return { show: false, share: 'none', role: 'normal', layer: 'own' };
  if (/#holiday@|holidays in/.test(id + ' ' + name)) return { show: true, share: 'none', role: 'normal', layer: 'own' };
  if (/rota|roster|shift|loop|healthroster/.test(name)) return { show: true, share: 'all', role: 'rota', layer: 'own' };
  if (/work|office/.test(name) || (!personal && isPrimary)) return { show: true, share: 'hours', role: 'work', layer: 'own' };
  if (isPrimary && me.main) return { show: true, share: 'all', role: 'normal', layer: 'own' };
  if (!cal.isOwnedByMe()) {
    if (/family|mum|dad|parents|home/.test(name)) return { show: true, share: 'all', role: 'normal', layer: 'family' };
    if (/friend|mates|crew|squad|book club/.test(name)) return { show: true, share: 'all', role: 'normal', layer: 'friends' };
    return { show: true, share: 'busy', role: 'normal', layer: 'other' };
  }
  return { show: true, share: 'busy', role: 'normal', layer: 'own' };
}

function norm_(ev) {
  try {
    var st = ev.getMyStatus();
    if (st === CalendarApp.GuestStatus.NO) return null;
  } catch (e) { /* not a guest list event */ }
  var desc = ev.getDescription() || '';
  var start = ev.getStartTime();
  var o = { id: shortKey_(ev.getId() + '|' + start.getTime()), t: ev.getTitle() || '' };
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
  var m = desc.match(/\[calendite:([^\]\s]+)\]/);
  if (m) o.tag = m[1];
  if (/#busy\b/i.test(desc)) o.pb = 1;
  return o;
}

// Turn one calendar's events into the owner's copy and the partner's filtered copy, by month.
function feedWrites_(me, ctx, calKey, doc, events, props) {
  var writes = [];
  var pk = 'h_' + calKey;
  var old = JSON.parse(props.getProperty(pk) || '{}');
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
  props.setProperty(pk, JSON.stringify(next));
  return writes;
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
    delete c.pb;
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
  writes = writes.concat(feedWrites_(me, ctx, calKey, doc, events, props));
  rotaChanged_(me, ctx, calKey, events, props);
  fsCommit_(writes);
}

function parseIcs_(text) {
  var lines = String(text).replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  var out = [];
  var cur = null;
  var from = Date.now() - DAYS_BACK * 864e5;
  var to = Date.now() + DAYS_AHEAD * 864e5;
  lines.forEach(function (line) {
    if (line === 'BEGIN:VEVENT') { cur = {}; return; }
    if (line === 'END:VEVENT') {
      if (cur && cur.start) {
        var o = { id: shortKey_((cur.uid || '') + '|' + (cur.start.v)), t: cur.summary || 'Shift' };
        if (cur.start.date) {
          o.ad = 1; o.sd = cur.start.v; o.ed = cur.end && cur.end.date ? cur.end.v : nextDay_(cur.start.v);
          var t0 = Utilities.parseDate(o.sd, TZ, 'yyyy-MM-dd').getTime();
          if (t0 >= from - 864e5 && t0 <= to) out.push(o);
        } else {
          o.s = cur.start.ms; o.e = cur.end ? cur.end.ms : cur.start.ms + 3600e3;
          if (o.e >= from && o.s <= to) out.push(o);
        }
      }
      cur = null; return;
    }
    if (!cur) return;
    var idx = line.indexOf(':');
    if (idx < 0) return;
    var left = line.slice(0, idx); var val = line.slice(idx + 1);
    var name = left.split(';')[0].toUpperCase();
    if (name === 'SUMMARY') cur.summary = val.replace(/\\,/g, ',').replace(/\\n/g, ' ').replace(/\\;/g, ';');
    else if (name === 'UID') cur.uid = val;
    else if (name === 'DTSTART' || name === 'DTEND') {
      var p = icsTime_(left, val);
      if (name === 'DTSTART') cur.start = p; else cur.end = p;
    }
  });
  return out;
}
function icsTime_(left, val) {
  if (/VALUE=DATE(;|$)/i.test(left) || /^\d{8}$/.test(val)) {
    return { date: true, v: val.slice(0, 4) + '-' + val.slice(4, 6) + '-' + val.slice(6, 8) };
  }
  var y = val.slice(0, 4), mo = val.slice(4, 6), d = val.slice(6, 8), h = val.slice(9, 11), mi = val.slice(11, 13), s = val.slice(13, 15) || '00';
  var str = y + '-' + mo + '-' + d + ' ' + h + ':' + mi + ':' + s;
  var tzm = left.match(/TZID=([^;:]+)/i);
  var tz = /Z$/.test(val) ? 'UTC' : (tzm ? tzm[1].replace(/"/g, '') : TZ);
  var ms;
  try { ms = Utilities.parseDate(str, tz, 'yyyy-MM-dd HH:mm:ss').getTime(); } catch (e) { ms = Utilities.parseDate(str, TZ, 'yyyy-MM-dd HH:mm:ss').getTime(); }
  return { ms: ms, v: str };
}
function nextDay_(k) {
  var d = Utilities.parseDate(k, TZ, 'yyyy-MM-dd');
  return Utilities.formatDate(new Date(d.getTime() + 36 * 3600e3), TZ, 'yyyy-MM-dd');
}

// Tell the partner when shifts in the next three weeks change.
function rotaChanged_(me, ctx, calKey, events, props) {
  var horizon = Date.now() + 21 * 864e5;
  var soon = events.filter(function (e) { var t = e.ad ? Utilities.parseDate(e.sd, TZ, 'yyyy-MM-dd').getTime() : e.s; return t >= Date.now() - 864e5 && t <= horizon; })
    .map(function (e) { return (e.sd || e.s) + '|' + (e.ed || e.e) + '|' + e.t; }).sort();
  var h = hash_(soon.join(';'));
  var key = 'rota_' + calKey;
  var before = props.getProperty(key);
  props.setProperty(key, h);
  if (!before || before === h) return;
  var name = (ctx.person && ctx.person.name) || 'Your partner';
  Object.keys(ctx.people).forEach(function (pid) {
    if (pid === me.person) return;
    fsCommit_([upd_(HOUSEHOLD + '/notify/' + Utilities.getUuid(), { to: pid, kind: 'rota', title: name + "'s rota has changed", body: 'Open Calendite to see the new shifts.', link: '#calendar', sendAfter: Date.now(), sent: false, created: Date.now() })]);
  });
}

// ===================== the app's to-do list for your calendar =====================

function processOutbox_(me, ctx) {
  var items = fsQuery_('outbox', [['person', me.person], ['done', false]]);
  if (!items.length) return;
  var writes = [];
  items.sort(function (a, b) { return (a.data.created || 0) - (b.data.created || 0); });
  items.forEach(function (it) {
    var o = it.data;
    var result = {};
    try {
      if (o.op === 'create') result = createEvent_(me, ctx, o);
      else if (o.op === 'update' || o.op === 'delete') result = changeEvent_(me, o);
      writes.push(upd_(HOUSEHOLD + '/outbox/' + it.id, { done: true, doneAt: Date.now(), result: result }, ['done', 'doneAt', 'result']));
    } catch (err) {
      var tries = (o.tries || 0) + 1;
      var patch = { tries: tries, error: String(err && err.message || err).slice(0, 200) };
      if (tries >= 5) patch.done = true;
      writes.push(upd_(HOUSEHOLD + '/outbox/' + it.id, patch, Object.keys(patch)));
    }
  });
  fsCommit_(writes);
  // let the feeds catch up straight away
  syncCalendars_(me, loadCtx_(me));
}

function targetCalendar_(ctx, calKey) {
  if (calKey && ctx.calDocs[calKey] && ctx.calDocs[calKey].calId) {
    var c = CalendarApp.getCalendarById(ctx.calDocs[calKey].calId);
    if (c && c.isOwnedByMe()) return c;
  }
  return CalendarApp.getDefaultCalendar();
}
function createEvent_(me, ctx, o) {
  var ev = o.event || {};
  var cal = targetCalendar_(ctx, ev.calKey);
  var tag = o.tag || ('app:' + Utilities.getUuid().slice(0, 8));
  var desc = 'Added by Calendite [calendite:' + tag + ']' + (ev.busyOnly ? ' #busy' : '');
  var day = Utilities.parseDate(ev.day + ' 12:00', TZ, 'yyyy-MM-dd HH:mm');
  // already there? (a retry after a time-out)
  var existing = cal.getEventsForDay(day).filter(function (x) { return (x.getDescription() || '').indexOf('[calendite:' + tag + ']') >= 0; });
  if (existing.length) return { eventId: existing[0].getId(), calId: cal.getId(), already: true };
  var created;
  if (ev.allDay) {
    created = cal.createAllDayEvent(ev.title || 'Event', Utilities.parseDate(ev.day, TZ, 'yyyy-MM-dd'), { description: desc });
  } else {
    var s = Utilities.parseDate(ev.day + ' ' + (ev.start || '19:00'), TZ, 'yyyy-MM-dd HH:mm');
    var e = Utilities.parseDate(ev.day + ' ' + (ev.end || ev.start || '20:00'), TZ, 'yyyy-MM-dd HH:mm');
    if (e <= s) e = new Date(s.getTime() + 3600e3);
    created = cal.createEvent(ev.title || 'Event', s, e, { description: desc });
  }
  return { eventId: created.getId(), calId: cal.getId() };
}
function changeEvent_(me, o) {
  var made = fsQuery_('outbox', [['person', me.person], ['tag', o.tag], ['op', 'create']]);
  var done = 0;
  made.forEach(function (m) {
    var r = m.data.result || {};
    if (!r.eventId) return;
    var cal = r.calId ? CalendarApp.getCalendarById(r.calId) : null;
    var ev = cal ? cal.getEventById(r.eventId) : CalendarApp.getEventById(r.eventId);
    if (!ev) return;
    if (o.op === 'delete') ev.deleteEvent();
    else if (o.event && o.event.title) ev.setTitle(o.event.title);
    done++;
  });
  return { changed: done };
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
    writes.push(upd_(HOUSEHOLD + '/notify/' + Utilities.getUuid(), { to: d.to, kind: 'requests', title: 'Still waiting: ' + name + ' asked you something', body: d.title || '', link: '#requests', sendAfter: Date.now(), sent: false, created: Date.now() }));
    writes.push(upd_(HOUSEHOLD + '/requests/' + r.id, { autoNudged: Date.now() }, ['autoNudged']));
  });
  fsCommit_(writes);
}

// ===================== notifications =====================

function processNotify_(ctx) {
  var due = fsQuery_('notify', [['sent', false]]).filter(function (n) { return (n.data.sendAfter || 0) <= Date.now(); });
  if (!due.length) return;
  var tokensFor = {};
  due.forEach(function (n) {
    // claim it, so two accounts never send the same one
    try {
      fsCommit_([{ update: { name: docName_(HOUSEHOLD + '/notify/' + n.id), fields: toFields_({ sent: true, sentAt: Date.now() }) }, updateMask: { fieldPaths: ['sent', 'sentAt'] }, currentDocument: { updateTime: n.updateTime } }]);
    } catch (err) { return; }
    var d = n.data;
    var who = ctx.people[d.to] || {};
    var notif = (who.settings && who.settings.notif) || {};
    if (d.kind && notif[d.kind] === false) return;
    if (!tokensFor[d.to]) tokensFor[d.to] = fsList_(HOUSEHOLD + '/people/' + d.to + '/tokens');
    tokensFor[d.to].forEach(function (t) {
      var code = sendPush_(t.data.token, { title: d.title || 'Calendite', body: d.body || '', link: d.link || '#today', tag: n.id });
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

function writeStatus_(me, ok, error, n) {
  var id = me.email.replace(/[^a-z0-9]+/g, '_');
  fsCommit_([upd_(HOUSEHOLD + '/status/' + id, { person: me.person, account: me.email, main: me.main, ok: ok, error: error, calendars: n, lastRun: Date.now() })]);
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
function merge_(a, b) { var o = {}; Object.keys(a).forEach(function (k) { o[k] = a[k]; }); Object.keys(b).forEach(function (k) { o[k] = b[k]; }); return o; }
