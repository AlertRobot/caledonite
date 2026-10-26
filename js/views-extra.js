// Jobs (chores, including ones you do together) and the ideas jar.
import { esc, dayKey, addDays, fromDayKey, fmtDate, fmtTime, atTime, relDay } from './util.js';
import { jobWho, repeatLabel, nextBothFree } from './logic.js';
import { icon, seg, empty } from './ui.js';
import { ui } from './uistate.js';

// ---------------- JOBS ----------------
export function viewJobs(state) {
  const todayK = dayKey(new Date());
  const open = state.jobs.filter((j) => !j.done).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const due = open.filter((j) => j.day <= todayK);
  const week = open.filter((j) => j.day > todayK && j.day <= dayKey(addDays(new Date(), 7)));
  const later = open.filter((j) => j.day > dayKey(addDays(new Date(), 7)));
  const done = state.jobs.filter((j) => j.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, 10);
  const section = (title, list, emptyText) => `<section class="stack-s"><h2 class="label">${esc(title)}</h2>
    ${list.length ? `<div class="card flush">${list.map((j) => jobRow(state, j, todayK)).join('')}</div>` : empty(emptyText)}</section>`;
  return `<a href="#today" class="back-link">${icon.back(20)}Today</a>
    <h1 class="h1">Jobs</h1>
    <a href="#add" class="btn big-btn" data-act="addJobNew">${icon.plus(20)} Add a job</a>
    ${section('Today', due, 'Nothing to do today.')}
    ${section('This week', week, 'Nothing else this week.')}
    ${later.length ? section('Later', later, '') : ''}
    ${done.length ? `<details class="older"><summary class="b">Done (${done.length})</summary><div class="card flush">${done.map((j) => jobRow(state, j, todayK)).join('')}</div></details>` : ''}`;
}
export function jobRow(state, j, todayK, compact = false) {
  const late = !j.done && j.day < todayK;
  const when = j.done ? 'Done' : (j.day === todayK ? 'Today' : late ? `Was due ${fmtDate(fromDayKey(j.day))}` : relDay(fromDayKey(j.day)));
  const time = j.time && !j.done ? `, ${fmtTime(atTime(j.day, j.time))}` : '';
  const rep = j.repeat ? `. ${repeatLabel(j.repeat)}` : '';
  return `<div class="list-row job-row ${j.done ? 'faded' : ''}">
    <button type="button" class="tick-btn ${j.done ? 'on' : ''}" aria-pressed="${!!j.done}" aria-label="${j.done ? 'Done' : 'Mark as done'}: ${esc(j.title)}" data-act="jobDone" data-id="${esc(j.id)}">${icon.check(20)}</button>
    <span class="grow col"><span class="b">${esc(j.title)}</span><span class="small ${late ? 'ink-bad b' : 'muted'}">${esc(jobWho(state, j))}. ${esc(when + time + (compact ? '' : rep))}</span></span>
    ${compact ? '' : `<button type="button" class="icon-btn plain" aria-label="Remove ${esc(j.title)}" data-act="jobDelete" data-id="${esc(j.id)}">${icon.close(20)}</button>`}
  </div>`;
}

// ---------------- IDEAS JAR ----------------
// Starter ideas, roughly priced for two. Edit or remove any of them.
export const STARTER_IDEAS = [
  ['Walk on Southampton Common, then a coffee', 8, 'out'], ['Cinema night out', 30, 'out'], ['Bowling and a burger', 45, 'out'],
  ['Crazy golf', 20, 'out'], ['Board game night in', 0, 'home'], ['Cook a new recipe together', 15, 'home'],
  ['Film night with homemade popcorn', 3, 'home'], ['Build some Lego together', 0, 'home'], ['Pizza from scratch', 10, 'home'],
  ['Pub quiz', 20, 'out'], ['Picnic in the park', 12, 'out'], ['New Forest walk and a pub lunch', 40, 'trip'],
  ['Spot the ponies in the New Forest', 5, 'trip'], ['Isle of Wight day trip', 90, 'trip'], ['Winchester for the day', 30, 'trip'],
  ['Bournemouth beach day', 25, 'trip'], ['Sunset walk along the water', 0, 'out'], ['Try a new restaurant', 60, 'out'],
  ['Breakfast out', 25, 'out'], ['Afternoon tea', 45, 'out'], ['Escape room', 60, 'out'],
  ['Climbing or bouldering taster', 40, 'out'], ['Swimming, then hot chocolate', 15, 'out'], ['Museum or gallery afternoon', 10, 'out'],
  ['Karaoke night in', 0, 'home'], ['Write songs together', 0, 'home'], ['Spa evening at home', 10, 'home'],
  ['Make a photo album of the year', 15, 'home'], ['Plan your next holiday together', 0, 'home'], ['Takeaway and a box set', 30, 'home'],
  ['Bake something ambitious', 10, 'home'], ['Learn a dance from a video', 0, 'home'], ['Puzzle and podcasts', 12, 'home'],
  ['Stargazing on a clear night', 0, 'out'], ['Comedy night', 40, 'out'], ['See a gig', 60, 'out'],
  ['Theatre show', 70, 'out'], ['Charity shop challenge: outfit for £10 each', 20, 'out'], ['Car boot sale wander', 10, 'out'],
  ['Farmers market and cook what you find', 25, 'out'], ['Go-karting', 70, 'out'], ['Trampoline park', 30, 'out'],
  ['Arcade night', 20, 'out'], ['Cocktail making at home', 25, 'home'], ['Wine and cheese night in', 25, 'home'],
  ['Pottery or painting class', 60, 'out'], ['Bike ride and a picnic', 10, 'out'], ['Walk a coastal path', 5, 'trip'],
  ['Visit a castle', 30, 'trip'], ['Garden centre and cake', 15, 'out'], ['Pick-your-own fruit (in season)', 15, 'trip'],
  ['Ice skating (in winter)', 30, 'out'], ['Christmas market (in December)', 30, 'out'], ['Fireworks display (in November)', 10, 'out'],
  ['Breakfast in bed, then a lazy morning', 8, 'home'], ['No-phones evening with a card game', 0, 'home'], ['Tapas night at home', 20, 'home'],
  ['Visit family together', 15, 'trip'], ['Sunday roast out', 45, 'out'], ['Take a train somewhere new for the day', 50, 'trip']
].map(([title, cost, where], i) => ({ id: `seed${String(i + 1).padStart(2, '0')}`, title, cost, where }));

const WHERE = { home: 'At home', out: 'Going out', trip: 'Day trip' };
const money = (n) => (n ? `about £${n}` : 'free');

export function jarBudget(state) {
  const b = state.linked && state.linked.budgie;
  if (!b || !b.fun) return null;
  return b.fun;
}
export function pickIdea(state, maxCost, where) {
  const pool = state.ideas.filter((i) => (maxCost === null || (Number(i.cost) || 0) <= maxCost) && (!where || where === 'all' || i.where === where));
  if (!pool.length) return null;
  // ideas you've done less often come up more
  const weights = pool.map((i) => 1 / (1 + (i.used || 0)));
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let k = 0; k < pool.length; k++) { r -= weights[k]; if (r <= 0) return pool[k]; }
  return pool[pool.length - 1];
}

export function viewJar(state) {
  const fun = jarBudget(state);
  const j = ui.jar;
  const pick = j.pick && state.ideas.find((i) => i.id === j.pick);
  const nf = nextBothFree(state, new Date());
  const out = [];
  out.push(`<a href="#today" class="back-link">${icon.back(20)}Today</a><h1 class="h1">Ideas jar</h1>`);
  if (!state.ideas.length) {
    out.push(`<div class="card stack pad"><p>The jar is empty. Fill it with ${STARTER_IDEAS.length} ideas to start with? You can change or remove any of them.</p>
      <button type="button" class="btn self-start" data-act="jarSeed">Fill the jar</button></div>`);
    return out.join('');
  }
  out.push(`<div class="card stack pad jar-card">
    <span class="b">${fun ? `${esc(money(Math.floor(fun.left)).replace('about ', ''))} left for fun until payday${fun.until ? `, ${esc(fmtDate(fromDayKey(fun.until)))}` : ''}. From Budgie.` : 'Budgie isn’t on this phone, so ideas aren’t matched to your budget.'}</span>
    ${seg(['all', 'home', 'out', 'trip'].map((v) => ({ v, label: { all: 'Any', home: 'Home', out: 'Out', trip: 'Trip' }[v], on: j.filter === v })), { act: 'jarFilter', label: 'What kind of idea', cls: 'seg-full seg-sm' })}
    <button type="button" class="btn big-btn" data-act="jarPick">${icon.heart(20)} Pick something for us</button>
    ${pick ? `<div class="idea-pick stack-s"><span class="small b muted">${esc(WHERE[pick.where] || '')}, ${esc(money(pick.cost))}</span><span class="h2">${esc(pick.title)}</span>
      ${nf ? `<span class="small">You're next both free ${esc(nf.label.charAt(0).toLowerCase() + nf.label.slice(1))}.</span>` : ''}
      <div class="row-wrap"><a href="#ask" class="btn tog" data-act="jarPlan" data-id="${esc(pick.id)}">Plan it</a><button type="button" class="btn sec" data-act="jarPick">Pick again</button></div></div>` : ''}
    ${fun && j.pickNone ? '<p class="small note-box">Nothing in the jar fits what’s left this time. Try something at home.</p>' : ''}
  </div>`);
  // add your own
  out.push(`<section class="stack-s"><h2 class="label">Add an idea</h2>
    <div class="card stack-s pad">
      <div class="field"><label for="idea-title">Idea</label><input id="idea-title" type="text" data-bind="jar.draft.title" value="${esc(j.draft.title)}" placeholder="For example: Kayaking" autocomplete="off"></div>
      <div class="grid2"><div class="field"><label for="idea-cost">Rough cost for two (£)</label><input id="idea-cost" type="number" inputmode="numeric" min="0" data-bind="jar.draft.cost" value="${esc(j.draft.cost)}"></div>
      <div class="field"><label for="idea-where">Kind</label><select id="idea-where" data-bind="jar.draft.where">${Object.entries(WHERE).map(([v, l]) => `<option value="${v}" ${j.draft.where === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
      <button type="button" class="btn self-start" data-act="jarAdd">Add to the jar</button></div></section>`);
  const list = state.ideas.filter((i) => j.filter === 'all' || i.where === j.filter);
  out.push(`<section class="stack-s"><h2 class="label">In the jar (${list.length})</h2><div class="card flush">${list.map((i) => `<div class="list-row">
    <span class="grow col"><span class="b">${esc(i.title)}</span><span class="small muted">${esc(WHERE[i.where] || '')}, ${esc(money(i.cost))}${Number(i.used) > 0 ? `. Done ${Number(i.used)} time${Number(i.used) === 1 ? '' : 's'}` : ''}</span></span>
    <button type="button" class="icon-btn plain" aria-label="Remove ${esc(i.title)}" data-act="jarRemove" data-id="${esc(i.id)}">${icon.close(20)}</button></div>`).join('')}</div>
    <p class="small muted">Costs are rough guesses for two. Change one by removing it and adding it again.</p></section>`);
  return out.join('');
}
