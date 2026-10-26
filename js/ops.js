// What answering a request changes. Shared by the app and the service worker (answer buttons on
// notifications), so both do exactly the same thing. Plain script: no imports or exports.
(function (root) {
  // an hour later, but never past midnight (23:30 gives 23:59, not 23:30)
  function plusHour(hm) {
    var p = String(hm || '19:00').split(':').map(Number);
    var t = Math.min(23 * 60 + 59, (p[0] || 0) * 60 + (p[1] || 0) + 60);
    var h = Math.floor(t / 60), m = t % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }
  function evFromWhen(title, w, defaultStart) {
    var start = w.allDay ? null : (w.start || defaultStart || '19:00');
    var ev = { title: title, day: w.day, start: start, end: w.allDay ? null : (w.end || plusHour(start)), allDay: !!w.allDay };
    if (w.endDay && w.endDay !== w.day) ev.endDay = w.endDay;
    return ev;
  }
  function eventTitle(r) {
    if (r.type === 'free') return 'Kept free: ' + r.title;
    if (r.type === 'leave') return r.title ? 'Holiday: ' + r.title : 'Holiday';
    return r.title;
  }

  // req: the request; me: who is answering (person id); byEmail: their email; names: {pid: name}; tz: the phone's time zone
  // returns { patch, outbox: [...], notify: {...} | null }
  function buildAnswer(o) {
    var r = o.req, id = o.id, answer = o.answer, me = o.me, now = o.now || Date.now();
    var tag = 'req:' + id;
    var both = [r.from, r.to];
    var meName = (o.names && o.names[me]) || 'Your partner';
    var patch = { answeredAt: now };
    var out = [];
    var notify = null;
    var add = function (person, op, extra) {
      var item = { person: person, op: op, tag: tag, byEmail: o.byEmail, done: false, created: now, tz: o.tz || null };
      for (var k in extra) item[k] = extra[k];
      out.push(item);
    };
    var tell = function (to, title, body) { notify = { to: to, kind: 'requests', title: title, body: body, link: '#requests' }; };
    if (answer === 'yes') {
      patch.status = 'yes';
      if (r.type === 'favour') {
        if (r.hold) both.forEach(function (p) { add(p, 'delete', {}); });
        if (r.when) add(r.to, 'create', { event: evFromWhen(r.title + ' (for ' + ((o.names && o.names[r.from]) || 'your partner') + ')', r.when, '19:00') });
      } else if (r.type === 'add') {
        if (r.when) add(r.to, 'create', { event: evFromWhen(r.title, r.when) });
      } else if (r.type !== 'heads' && r.when) {
        var title = eventTitle(r);
        both.forEach(function (p) {
          if (r.hold) add(p, 'update', { event: { title: title } });
          else add(p, 'create', { both: true, event: evFromWhen(title, r.when) });
        });
      }
      tell(r.from, meName + ' said yes', r.title || eventTitle(r));
    } else if (answer === 'no') {
      patch.status = 'no';
      if (r.hold) both.forEach(function (p) { add(p, 'delete', {}); });
      tell(r.from, meName + " can't this time", r.title || eventTitle(r));
    } else if (answer === 'maybe') {
      patch.status = 'maybe';
      tell(r.from, meName + " isn't sure yet", r.title || eventTitle(r));
    } else if (answer === 'seen') {
      patch.status = 'seen';
    } else if (answer === 'other') {
      patch.status = 'other';
      patch.counter = o.when;
      tell(r.from, meName + ' suggested another time', (r.title || eventTitle(r)) + ': ' + o.when.label);
    } else if (answer === 'accept-counter') {
      patch.status = 'yes';
      patch.when = r.counter;
      patch.counter = null;
      var t2 = eventTitle(r);
      both.forEach(function (p) {
        if (r.hold) add(p, 'delete', {});
        add(p, 'create', { both: true, event: evFromWhen(t2, r.counter) });
      });
      tell(r.to, meName + ' said yes to your time', (r.title || t2) + ': ' + r.counter.label);
    } else if (answer === 'cancel') {
      patch.status = 'cancelled';
      if (r.hold) both.forEach(function (p) { add(p, 'delete', {}); });
    } else if (answer === 'remind') {
      patch.reminded = now;
      tell(r.to, 'Reminder from ' + meName, r.title || eventTitle(r));
    } else if (answer === 'undo') {
      patch.status = 'waiting';
    }
    return { patch: patch, outbox: out, notify: notify };
  }

  root.CaledoniteOps = { buildAnswer: buildAnswer, evFromWhen: evFromWhen, eventTitle: eventTitle, plusHour: plusHour };
})(typeof self !== 'undefined' ? self : this);
