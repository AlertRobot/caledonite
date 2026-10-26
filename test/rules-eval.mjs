// A small stand-in for the Firestore rules engine, enough for firestore.rules (there's no emulator here), so the
// rules can be checked by what they let through, not just how they read. It knows the parts of the rules
// language the file uses: match paths, functions, allow, get/exists/getAfter, maps, lists, strings, ?:, is.
//   const rules = loadRules(text)
//   rules.allowed({ method: 'update', path: 'households/main/requests/r1', email, db, data })
// db: { 'households/main': {...}, ... } (paths below /databases/(default)/documents), data: the document as it
// would be after the write (create, update), or omitted (get, list, delete). getAfter sees db with the write made.

class RuleError extends Error {}
const fail = (m) => { throw new RuleError(m); };

// ---------- tokens ----------
function tokenize(src) {
  const out = [];
  let i = 0;
  const prevSig = () => out[out.length - 1];
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && (!prevSig() || ['(', ','].includes(prevSig().v))) {
      // a path literal: up to the closing bracket or comma, with $(...) inside it
      let depth = 0; let j = i;
      while (j < src.length) {
        if (src[j] === '$' && src[j + 1] === '(') { depth++; j += 2; continue; }
        if (src[j] === ')') { if (!depth) break; depth--; }
        if (src[j] === ',' && !depth) break;
        j++;
      }
      out.push({ t: 'path', v: src.slice(i, j).trim() }); i = j; continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1; let s = '';
      while (src[j] !== c) { if (src[j] === '\\') { s += src[j + 1]; j += 2; } else s += src[j++]; }
      out.push({ t: 'str', v: s }); i = j + 1; continue;
    }
    if (/[0-9]/.test(c)) { const m = src.slice(i).match(/^\d+(\.\d+)?/); out.push({ t: 'num', v: Number(m[0]) }); i += m[0].length; continue; }
    if (/[A-Za-z_]/.test(c)) { const m = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/); out.push({ t: 'id', v: m[0] }); i += m[0].length; continue; }
    const two = src.slice(i, i + 2);
    if (['&&', '||', '==', '!=', '<=', '>='].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
    if ('()[]{},.!<>?:+-*%'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    fail(`bad character ${c} in ${src.slice(i, i + 20)}`);
  }
  return out;
}

// ---------- expressions ----------
function parse(src) {
  const tk = tokenize(src);
  let p = 0;
  const peek = () => tk[p]; const next = () => tk[p++];
  const is = (v) => tk[p] && tk[p].v === v && tk[p].t !== 'str';
  const want = (v) => { if (!is(v)) fail(`expected ${v} at ${JSON.stringify(tk[p])} in ${src}`); return next(); };
  function ternary() {
    const c = or();
    if (is('?')) { next(); const a = ternary(); want(':'); const b = ternary(); return { k: '?', c, a, b }; }
    return c;
  }
  function or() { let l = and(); while (is('||')) { next(); l = { k: '||', l, r: and() }; } return l; }
  function and() { let l = cmp(); while (is('&&')) { next(); l = { k: '&&', l, r: cmp() }; } return l; }
  function cmp() {
    let l = add();
    for (;;) {
      if (['==', '!=', '<', '>', '<=', '>='].some((o) => is(o))) { const o = next().v; l = { k: 'cmp', o, l, r: add() }; continue; }
      if (is('in')) { next(); l = { k: 'in', l, r: add() }; continue; }
      if (is('is')) { next(); l = { k: 'is', l, type: next().v }; continue; }
      return l;
    }
  }
  function add() { let l = unary(); while (is('+') || is('-')) { const o = next().v; l = { k: 'arith', o, l, r: unary() }; } return l; }
  function unary() { if (is('!')) { next(); return { k: '!', e: unary() }; } if (is('-')) { next(); return { k: 'neg', e: unary() }; } return postfix(primary()); }
  function args() { const a = []; want('('); while (!is(')')) { a.push(ternary()); if (is(',')) next(); } want(')'); return a; }
  function postfix(e) {
    for (;;) {
      if (is('.')) {
        next(); const name = next().v;
        if (is('(')) e = { k: 'method', obj: e, name, args: args() };
        else e = { k: 'field', obj: e, name };
        continue;
      }
      if (is('[')) { next(); const idx = ternary(); want(']'); e = { k: 'index', obj: e, idx }; continue; }
      return e;
    }
  }
  function primary() {
    const t = next();
    if (!t) fail('unexpected end');
    if (t.t === 'str' || t.t === 'num') return { k: 'lit', v: t.v };
    if (t.t === 'path') return { k: 'path', v: t.v };
    if (t.v === '(') { const e = ternary(); want(')'); return e; }
    if (t.v === '{') {
      const entries = [];
      while (!is('}')) { const k = next().v; want(':'); entries.push([k, ternary()]); if (is(',')) next(); }
      want('}'); return { k: 'map', entries };
    }
    if (t.v === '[') { const items = []; while (!is(']')) { items.push(ternary()); if (is(',')) next(); } want(']'); return { k: 'list', items }; }
    if (t.t === 'id') {
      if (t.v === 'true' || t.v === 'false') return { k: 'lit', v: t.v === 'true' };
      if (t.v === 'null') return { k: 'lit', v: null };
      if (is('(')) return { k: 'call', name: t.v, args: args() };
      return { k: 'var', name: t.v };
    }
    fail(`unexpected ${t.v}`);
  }
  const e = ternary();
  if (p !== tk.length) fail(`left over in ${src}: ${JSON.stringify(tk.slice(p, p + 3))}`);
  return e;
}

// ---------- values ----------
const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Diff);
class Diff { constructor(a, b) { this.a = a; this.b = b; } }
function eq(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => eq(x, b[i]));
  if (isMap(a) && isMap(b)) { const ka = Object.keys(a); return ka.length === Object.keys(b).length && ka.every((k) => k in b && eq(a[k], b[k])); }
  return a === b;
}
function method(obj, name, a) {
  if (typeof obj === 'string') {
    if (name === 'lower') return obj.toLowerCase();
    if (name === 'upper') return obj.toUpperCase();
    if (name === 'size') return obj.length;
    if (name === 'matches') return new RegExp(`^(?:${a[0]})$`).test(obj);
  }
  if (Array.isArray(obj)) {
    if (name === 'size') return obj.length;
    if (name === 'hasAny') return a[0].some((x) => obj.some((y) => eq(x, y)));
    if (name === 'hasAll') return a[0].every((x) => obj.some((y) => eq(x, y)));
    if (name === 'hasOnly') return obj.every((x) => a[0].some((y) => eq(x, y)));
  }
  if (obj instanceof Diff && name === 'affectedKeys') {
    const keys = new Set([...Object.keys(obj.a), ...Object.keys(obj.b)]);
    return [...keys].filter((k) => !(k in obj.a) || !(k in obj.b) || !eq(obj.a[k], obj.b[k]));
  }
  if (isMap(obj)) {
    if (name === 'get') return a[0] in obj ? obj[a[0]] : a[1];
    if (name === 'keys') return Object.keys(obj);
    if (name === 'size') return Object.keys(obj).length;
    if (name === 'diff') { if (!isMap(a[0])) fail('diff of a non-map'); return new Diff(obj, a[0]); }
  }
  fail(`no ${name}() on ${JSON.stringify(obj)}`);
}

// ---------- the rules file ----------
function stripComments(s) { return s.replace(/\/\/[^\n]*/g, ''); }
function block(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (!depth) return i; }
    else if (text[i] === "'") { i = text.indexOf("'", i + 1); }
  }
  fail('unbalanced braces');
}
function readBody(text, funcs) {
  const node = { allows: [], matches: [] };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    let m;
    if ((m = rest.match(/^\s*match\s+(\S+)\s*\{/))) {
      const open = i + m[0].length - 1; const close = block(text, open);
      const child = readBody(text.slice(open + 1, close), funcs);
      child.path = m[1].replace(/^\//, '').split('/');
      node.matches.push(child); i = close + 1; continue;
    }
    if ((m = rest.match(/^\s*function\s+(\w+)\s*\(([^)]*)\)\s*\{/))) {
      const open = i + m[0].length - 1; const close = block(text, open);
      const body = text.slice(open + 1, close).trim().replace(/^return\s+/, '').replace(/;\s*$/, '');
      funcs[m[1]] = { params: m[2].split(',').map((x) => x.trim()).filter(Boolean), body: parse(body) };
      i = close + 1; continue;
    }
    if ((m = rest.match(/^\s*allow\s+([a-z, ]+):\s*if\s+/))) {
      const end = text.indexOf(';', i + m[0].length);
      node.allows.push({ methods: m[1].split(',').map((x) => x.trim()), cond: parse(text.slice(i + m[0].length, end)) });
      i = end + 1; continue;
    }
    if (/^\s*$/.test(rest)) break;
    fail(`can't read rules at: ${rest.slice(0, 60)}`);
  }
  return node;
}

export function loadRules(src) {
  const text = stripComments(src);
  const funcs = {};
  const start = text.indexOf('match /databases/{database}/documents');
  const open = text.indexOf('{', start + 'match /databases/{database}/documents'.length); const close = block(text, open);
  const root = readBody(text.slice(open + 1, close), funcs);
  root.path = [];

  const ALIAS = { get: ['read', 'get'], list: ['read', 'list'], create: ['write', 'create'], update: ['write', 'update'], delete: ['write', 'delete'] };

  function evaluate(e, env, ctx) {
    const ev = (x) => evaluate(x, env, ctx);
    switch (e.k) {
      case 'lit': return e.v;
      case 'list': return e.items.map(ev);
      case 'map': return Object.fromEntries(e.entries.map(([k, x]) => [k, ev(x)]));
      case 'var': if (e.name in env) return env[e.name]; fail(`unknown ${e.name}`);
      case 'path': return '/' + e.v.replace(/\$\(([^)]*)\)/g, (_, x) => String(evaluate(parse(x), env, ctx))).replace(/^\/+/, '');
      case 'field': { const o = ev(e.obj); if (!isMap(o) || !(e.name in o)) fail(`no field ${e.name}`); return o[e.name]; }
      case 'index': { const o = ev(e.obj); const i = ev(e.idx); if (Array.isArray(o) && i < o.length) return o[i]; if (isMap(o) && i in o) return o[i]; fail('bad index'); }
      case 'method': return method(ev(e.obj), e.name, e.args.map(ev));
      case '!': { const v = ev(e.e); if (typeof v !== 'boolean') fail('! of a non-bool'); return !v; }
      case 'neg': return -ev(e.e);
      case 'arith': { const a = ev(e.l); const b = ev(e.r); return e.o === '+' ? a + b : a - b; }
      case 'cmp': {
        const a = ev(e.l); const b = ev(e.r);
        if (e.o === '==') return eq(a, b);
        if (e.o === '!=') return !eq(a, b);
        if (typeof a !== typeof b || a === null) fail('compare');
        return e.o === '<' ? a < b : e.o === '>' ? a > b : e.o === '<=' ? a <= b : a >= b;
      }
      case 'in': { const a = ev(e.l); const b = ev(e.r); if (Array.isArray(b)) return b.some((x) => eq(x, a)); if (isMap(b)) return a in b; fail('in on a non-list'); }
      case 'is': {
        const v = ev(e.l);
        return { list: Array.isArray(v), map: isMap(v), string: typeof v === 'string', bool: typeof v === 'boolean', number: typeof v === 'number', int: Number.isInteger(v) }[e.type] ?? fail(`is ${e.type}`);
      }
      case '&&': case '||': {
        const and = e.k === '&&';
        let l; let lerr = null;
        try { l = ev(e.l); if (typeof l !== 'boolean') fail('not a bool'); } catch (err) { if (!(err instanceof RuleError)) throw err; lerr = err; }
        if (!lerr && l === !and) return l;
        const r = ev(e.r);
        if (typeof r !== 'boolean') fail('not a bool');
        if (lerr) { if (r === !and) return r; throw lerr; }
        return r;
      }
      case '?': { const c = ev(e.c); if (typeof c !== 'boolean') fail('?: of a non-bool'); return c ? ev(e.a) : ev(e.b); }
      case 'call': {
        const a = e.args.map(ev);
        if (e.name === 'get' || e.name === 'getAfter') {
          ctx.reads++;
          const store = e.name === 'get' ? ctx.db : ctx.after;
          const key = a[0].replace(/^\/?databases\/[^/]+\/documents\//, '');
          return key in store ? { data: store[key] } : null;
        }
        if (e.name === 'exists') { ctx.reads++; return a[0].replace(/^\/?databases\/[^/]+\/documents\//, '') in ctx.db; }
        const f = funcs[e.name];
        if (!f) fail(`no function ${e.name}`);
        const fenv = Object.assign({}, env);
        f.params.forEach((p, i) => { fenv[p] = a[i]; });
        return evaluate(f.body, fenv, ctx);
      }
      default: fail(`can't evaluate ${e.k}`);
    }
  }

  // every allow that matches the path and method, with the path's variables
  function candidates(node, segs, vars, out) {
    for (const a of node.allows) if (!segs.length) out.push({ a, vars });
    for (const m of node.matches) {
      if (m.path.length > segs.length) continue;
      const v = Object.assign({}, vars); let ok = true;
      m.path.forEach((p, i) => { const w = p.match(/^\{(\w+)\}$/); if (w) v[w[1]] = segs[i]; else if (p !== segs[i]) ok = false; });
      if (ok) candidates(m, segs.slice(m.path.length), v, out);
    }
    return out;
  }

  return {
    // true if any matching allow says yes (an error in one counts as no)
    allowed({ method: verb, path, email, verified = true, db = {}, data }) {
      const after = Object.assign({}, db);
      if (verb === 'delete') delete after[path]; else if (data !== undefined) after[path] = data;
      const ctx = { db, after, reads: 0 };
      const existing = path in db ? { data: db[path], id: path.split('/').pop() } : null;
      const env = {
        database: '(default)',
        request: { auth: email ? { uid: 'u', token: { email, email_verified: verified } } : null, resource: data !== undefined ? { data } : null, method: verb },
        resource: existing
      };
      const list = candidates({ allows: [], matches: [Object.assign({}, root, { path: ['databases', '{database}', 'documents'] })] }, ['databases', '(default)', 'documents', ...path.split('/')], {}, []);
      for (const { a, vars } of list) {
        if (!a.methods.some((m) => ALIAS[verb].includes(m))) continue;
        try { if (evaluate(a.cond, Object.assign({}, env, vars), ctx) === true) return true; } catch (err) { if (!(err instanceof RuleError)) throw err; }
      }
      return false;
    }
  };
}
