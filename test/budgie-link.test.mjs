// Caledonite's Budgie link against Budgie's local test server. In the Budgie repo: PORT=8790 node test/server.js, make a Caledonite link
// there (app.link), then: node test/budgie-link.test.mjs <its app_caledonite_ key>
const store = {}; globalThis.localStorage = {getItem: k => k in store ? store[k] : null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; }};
globalThis.location = {href: "https://alertrobot.github.io/caledonite/"};
const L = await import(new URL("../js/linked.js", import.meta.url));
const mk = (u, k) => "https://alertrobot.github.io/caledonite/#connect=" + Buffer.from(JSON.stringify({u, k})).toString("base64url");
const real = globalThis.fetch, PORT = process.env.PORT || 8790;
globalThis.fetch = (u, o) => real(String(u).startsWith("https://script.google.com/macros/s/TEST/exec") ? "http://localhost:" + PORT + "/exec" : u, o);
const res = [];
const ok = (n, c, x) => res.push((c ? "PASS " : "FAIL ") + n + (c ? "" : " " + JSON.stringify(x).slice(0, 200)));
const full = "a".repeat(64), app = process.argv[2];
ok("refuses Budgie's full key", L.parseBudgieLink(mk("https://script.google.com/macros/s/TEST/exec", full)) === null);
ok("refuses plain http", L.parseBudgieLink(mk("http://script.google.com/macros/s/TEST/exec", app)) === null);
ok("refuses other hosts", L.parseBudgieLink(mk("https://evil.example/exec", app)) === null);
const cfg = L.parseBudgieLink(mk("https://script.google.com/macros/s/TEST/exec", app));
ok("takes its own link", cfg && cfg.k === app);
L.setBudgieLink(cfg); const b = await L.loadBudgie();
ok("reads paydays and bills", b.found && !b.error && Object.keys(b.days).length > 0, b);
L.setBudgieLink({u: cfg.u, k: "app_caledonite_" + "0".repeat(64)}); localStorage.setItem("cal.budgieCache", JSON.stringify(b));
const r = await L.loadBudgie();
ok("a switched-off link says so and forgets the old answer", /turned this link down/.test(r.error || "") && localStorage.getItem("cal.budgieCache") === null, r);
console.log(res.join("\n"));
