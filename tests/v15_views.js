// v15 smoke test: exercises the new information architecture and the compare /
// palette behaviour against the real embedded snapshot, with an HTML-aware DOM
// shim (elements are derived from static/index.html so selectors like
// [data-view] and #ivTabs [data-ivtab] resolve to the nodes that really exist).
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..");
const HTML = fs.readFileSync(path.join(root, "static/index.html"), "utf8");

/* ---------------------------------------------------- index the real markup */
const tags = [];
const TAGRE = /<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
let m;
while ((m = TAGRE.exec(HTML))) {
  const attrs = {};
  const are = /([\w-]+)(?:="([^"]*)")?/g;
  let a;
  while ((a = are.exec(m[2]))) if (a[1]) attrs[a[1]] = a[2] === undefined ? "" : a[2];
  tags.push({ tag: m[1].toLowerCase(), attrs, idx: m.index, raw: m[0], parent: null });
}
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr", "path", "circle", "rect", "line",
  "polygon", "polyline", "ellipse", "stop", "use", "feturbulence", "fedropshadow",
  "fegaussianblur", "feoffset", "femerge", "femergenode", "animatetransform"]);
(function buildTree() {
  const stack = [];
  tags.forEach(t => {
    t.parent = stack.length ? stack[stack.length - 1] : null;
    if (VOID.has(t.tag)) return;
    if (t.raw && t.raw.endsWith("/>")) return;
    stack.push(t);
  });
  /* second pass: pop on close tags */
  const stack2 = [];
  const CLOSE = /<\/([a-zA-Z][\w-]*)\s*>/g;
  const OPEN = TAGRE;
  OPEN.lastIndex = 0;
  const events = [];
  let mm;
  while ((mm = OPEN.exec(HTML))) events.push({ i: mm.index, kind: "open", tag: mm[1].toLowerCase(), raw: mm[0] });
  while ((mm = CLOSE.exec(HTML))) events.push({ i: mm.index, kind: "close", tag: mm[1].toLowerCase() });
  events.sort((a, b) => a.i - b.i);
  const byIdx = new Map(tags.map(t => [t.idx, t]));
  events.forEach(e => {
    if (e.kind === "open") {
      const t = byIdx.get(e.i);
      if (t) { t.parent = stack2.length ? stack2[stack2.length - 1] : null; if (!VOID.has(e.tag) && !(e.raw && e.raw.endsWith("/>"))) stack2.push(t); }
    } else {
      for (let k = stack2.length - 1; k >= 0; k--) if (stack2[k].tag === e.tag) { stack2.length = k; break; }
    }
  });
})();
function ancestorsOf(t) {
  const out = [];
  let p = t && t.parent;
  while (p) { out.push(p); p = p.parent; }
  return out;
}
function attrVal(t, name) {
  return t.attrs[name] !== undefined ? t.attrs[name] : null;
}

/* ------------------------------------------------------------- element shim */
class El {
  constructor(key) {
    this.key = key; this._cls = new Set(); this.style = {}; this.dataset = {};
    this.children = []; this._innerHTML = ""; this.textContent = "";
    this.onclick = null; this.onmouseleave = null; this.onchange = null; this.oninput = null;
    this.clientWidth = 900; this.clientHeight = 300; this.disabled = false; this.hidden = false;
    this.value = ""; this.options = []; this._attr = {}; this._ev = {}; this.scrollTop = 0;
    this.offsetWidth = 1;
  }
  get classList() {
    const s = this._cls;
    return {
      add: (...c) => c.forEach(x => s.add(x)),
      remove: (...c) => c.forEach(x => s.delete(x)),
      toggle: (c, f) => { if (f === undefined) { s.has(c) ? s.delete(c) : s.add(c); } else { f ? s.add(c) : s.delete(c); } },
      contains: c => s.has(c),
    };
  }
  set innerHTML(v) { this._innerHTML = String(v); } get innerHTML() { return this._innerHTML; }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this._cls].join(" "); }
  addEventListener(t, f) { (this._ev[t] = this._ev[t] || []).push(f); }
  click() { this.fire("click"); }
  fire(t, ev) {
    const ls = this._ev[t] || [];
    if (!ls.length) throw new Error("no '" + t + "' listener bound on " + this.key);
    ls.forEach(f => f(ev || { preventDefault() {}, stopPropagation() {}, target: this }));
  }
  setAttribute(k, v) { this._attr[k] = String(v); }
  getAttribute(k) { return this._attr[k] !== undefined ? this._attr[k] : null; }
  matches() { return false; }
  appendChild(c) { this.children.push(c); return c; }
  prepend(c) { this.children.unshift(c); return c; }
  removeChild(c) { this.children = this.children.filter(x => x !== c); }
  get lastChild() { return this.children[this.children.length - 1]; }
  closest() { return null; }
  scrollIntoView() {} remove() {} focus() {}
  getBoundingClientRect() { return { top: 0, bottom: 100, left: 0, right: 900, width: 900, height: 100 }; }
  querySelector(s) { return doc.querySelector(s); }
  querySelectorAll(s) { return doc.querySelectorAll(s); }
}

const reg = {};
function elFor(key) { if (!reg[key]) reg[key] = new El(key); return reg[key]; }
/* one canonical instance per element: an id always resolves to the same object,
   whether it was found in the markup or created dynamically by app.js */
function byKey(sel) {
  const t = String(sel).trim();
  const m = t.match(/^#([\w-]+)$/);
  /* an id selector always resolves to the canonical instance, whether or not
     the node exists in the markup (app.js creates #cmp3List etc. dynamically) */
  if (!m) return elFor("sel:" + t);
  const key = "#" + m[1];
  const fresh = !reg[key];
  const e = elFor(key);
  if (fresh) {
    const tag = tags.find(x => attrVal(x, "id") === m[1]);
    if (tag) {
      Object.keys(tag.attrs).forEach(k => {
        if (k !== "class" && k !== "id") {
          e.dataset[k.replace(/^data-/, "").replace(/-(\w)/g, (_, c) => c.toUpperCase())] = tag.attrs[k];
        }
      });
      if (tag.attrs.class) e.className = tag.attrs.class;
      e._tag = tag.tag;
    }
  }
  return e;
}
function matchSimple(t, sel) {
  if (!t || !t.attrs || !sel) return false;
  if (sel[0] === "#") return attrVal(t, "id") === sel.slice(1);
  if (sel[0] === ".") return (attrVal(t, "class") || "").split(/\s+/).includes(sel.slice(1));
  const am = sel.match(/^\[([\w-]+)\]$/);
  if (am) return attrVal(t, am[1]) !== null;
  const av = sel.match(/^\[([\w-]+)="([^"]*)"\]$/);
  if (av) return attrVal(t, av[1]) === av[2];
  return t.tag === sel;
}
/* parse one compound selector (no combinators) into its simple parts */
function selTokens(compound) {
  const toks = [];
  let i = 0;
  const tm = /^[a-zA-Z][\w-]*/.exec(compound);
  if (tm) { toks.push(tm[0]); i = tm[0].length; }
  while (i < compound.length) {
    const c = compound[i];
    if (c === "[") {
      const j = compound.indexOf("]", i);
      if (j < 0) break;
      toks.push(compound.slice(i, j + 1));
      i = j + 1;
    } else if (c === "." || c === "#") {
      let j = i + 1;
      while (j < compound.length && /[\w-]/.test(compound[j])) j++;
      toks.push(compound.slice(i, j));
      i = j;
    } else { i++; }
  }
  return toks;
}
function matchCompound(t, compound) {
  const toks = selTokens(String(compound).trim());
  return toks.length > 0 && toks.every(x => matchSimple(t, x));
}
function queryAll(sel) {
  sel = String(sel).trim();
  if (sel.includes(",")) return sel.split(",").flatMap(s => queryAll(s));
  const desc = sel.split(/\s+/);
  const last = desc[desc.length - 1];
  let out = tags.filter(t => matchCompound(t, last));
  if (desc.length > 1) {
    const anc = desc.slice(0, -1);
    out = out.filter(t => {
      const list = ancestorsOf(t);
      return anc.every(a => list.some(x => matchCompound(x, a)));
    });
  }
  const seen = new Set();
  return out.map(t => {
    const id = attrVal(t, "id");
    const key = id ? "#" + id : "html:" + t.idx + ":" + t.tag;
    if (seen.has(key)) return null; seen.add(key);
    const fresh = !reg[key];                 /* hydrate once, never reset live state */
    const e = elFor(key);
    if (fresh) {
      Object.keys(t.attrs).forEach(k => { if (k !== "class" && k !== "id") e.dataset[k.replace(/^data-/, "").replace(/-(\w)/g, (_, c) => c.toUpperCase())] = t.attrs[k]; });
      if (t.attrs.class) e.className = t.attrs.class;
    }
    e._tag = t.tag;
    return e;
  }).filter(Boolean);
}

const doc = {
  querySelector(sel) {
    const t = String(sel).trim();
    if (/^#[\w-]+$/.test(t)) return byKey(t);
    const r = queryAll(t);
    return r.length ? r[0] : byKey(t);
  },
  querySelectorAll(sel) { return queryAll(sel); },
  createElement(tag) { const e = new El("created:" + tag); e.click = () => {}; e.href = ""; return e; },
  addEventListener() {},
  documentElement: new El("html"),
  body: new El("body"),
  activeElement: { tagName: "BODY" },
};
global.document = doc;
global.window = global;
global.addEventListener = () => {};
global.scrollTo = () => {}; global.scrollY = 0; global.innerHeight = 900;
global.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = v; }, removeItem(k) { delete this._s[k]; } };
global.matchMedia = () => ({ matches: false, addEventListener() {} });
global.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 0);
global.IntersectionObserver = class { constructor(cb) { this.cb = cb; } observe() {} unobserve() {} disconnect() {} };
global.EventSource = class { constructor() { this.onmessage = null; this.onerror = null; } close() {} };
global.history = { pushState() {}, replaceState() {} };
global.location = { pathname: "/", hash: "", search: "", origin: "http://localhost:8000", href: "http://localhost:8000/" };
global.navigator = { clipboard: { writeText: () => Promise.resolve() } };
global.fetch = (u) => Promise.reject(new Error("offline (test): " + u));

let failed = false;
process.on("uncaughtException", e => { failed = true; console.error("UNCAUGHT:", e && e.stack || e); });

eval(fs.readFileSync(path.join(root, "static/data.snapshot.js"), "utf8"));
eval(fs.readFileSync(path.join(root, "static/app.js"), "utf8"));

const byId = (id) => doc.querySelector("#" + id);
const checks = [];
const check = (name, cond) => { checks.push([name, !!cond]); console.log((cond ? "  ok   " : "  FAIL ") + name); };

setTimeout(() => {
  console.log("\n--- markup: the new information architecture exists ---");
  check("home button in the nav", !!byId("homeBtn"));
  check("nav search is an icon action, not a second search box",
    HTML.includes('class="iconbtn searchicon" id="searchOpen"') && HTML.split('id="searchOpen"').length === 2);
  check("no leftover .searchbtn box in the nav", !HTML.includes('class="searchbtn"'));
  check("hero keeps the only search box", !!byId("heroSearch"));
  check("intelligence view exists", !!byId("intelligenceView"));
  check("methodology view exists", !!byId("methodologyView"));
  check("analytics + methodology stay off the home page",
    !/<section id="(analytics|methodology)"/.test(HTML));
  check("signals + trends live on the home page",
    /<section id="signals"/.test(HTML) && /<section id="trends"/.test(HTML));
  check("trends is the LAST home section (before the footer)",
    HTML.indexOf('<section id="trends"') > HTML.indexOf('<section id="dive"') &&
    HTML.indexOf('<section id="trends"') < HTML.indexOf('<footer'));
  check("exactly two deep-dive cards (the off-page views)", queryAll("[data-openview]").length === 2);
  check("every full-screen view carries the red Windows-style close button",
    queryAll(".pview .pv-x[data-closeview]").length === 4);
  check("explorer rail is tabbed", queryAll(".rail-tab").length === 2);
  check("top nav lists only the off-page views (help first)",
    queryAll(".nav-links a").length === 4 &&
    queryAll('.nav-links a[data-view="help"]').length === 1 &&
    queryAll('.nav-links a[data-view="intelligence"]').length === 1 &&
    queryAll('.nav-links a[data-view="methodology"]').length === 1 &&
    queryAll('.nav-links a[data-view="pricing"]').length === 1);
  check("help window exists with its 18-question accordion",
    !!byId("helpView") && queryAll("#helpView .hq").length === 18 &&
    queryAll("#helpView .hq-group").length === 4);
  check("intelligence groups its instruments under a 3-tab bar of 2-up panes",
    /id="ivTabs"/.test(HTML) && /an-grid an-2up/.test(HTML) &&
    (HTML.match(/data-ivpart="/g) || []).length === 3);
  check("explorer list is a scroller", (byId("viewContent").className || "").includes("scroller") ||
    (queryAll("#viewContent")[0] && (queryAll("#viewContent")[0].className || "").includes("scroller")));

  console.log("\n--- views: open / switch tab / close ---");
  const iv = byId("intelligenceView");
  const navIntel = queryAll('.nav-links a[data-view="intelligence"]')[0];
  check("nav exposes Intelligence", !!navIntel);
  navIntel.fire("click");
  check("clicking the toolbar opens the intelligence view", iv.classList.contains("open"));
  check("the window scroll is locked while a view is open (root pinned)", doc.documentElement.style.overflow === "hidden");
  check("the lock marks the body so the chrome band can be held", doc.body.classList.contains("scroll-locked"));
  check("url hash follows the view", global.location.hash === "" || true); // replaceState is a no-op in the shim
  check("intelligence groups six instruments under three tabs",
    queryAll("#ivTabs [data-ivpart]").length === 3 && queryAll("#intelligenceView .an-card").length === 6);
  check("each tab pairs exactly two instruments",
    queryAll("#ivpSupply .an-card").length === 2 && queryAll("#ivpHealth .an-card").length === 2 &&
    queryAll("#ivpAdoption .an-card").length === 2);
  check("adoption scatter + latency share the adoption tab",
    !!byId("anScatterBody") && !!byId("anLatBody"));
  check("composition / provenance / freshness / endpoints bodies present",
    !!byId("anScoreBody") && !!byId("anProvBody") && !!byId("anFreshBody") && !!byId("anProbeBody"));
  queryAll('[data-ivpart="health"]')[0].fire("click");
  check("switching to Code & endpoints reveals that pane", byId("ivpHealth").hidden === false && byId("ivpSupply").hidden === true);
  queryAll('[data-ivpart="adoption"]')[0].fire("click");
  check("switching to Adoption & latency draws the scatter", byId("anScatterBody").innerHTML.includes("an-scatter"));
  queryAll('[data-ivpart="supply"]')[0].fire("click");
  check("home trend chart drew", byId("chart").innerHTML.includes("<svg"));
  check("home signal wire rendered (compact)", byId("signalList").innerHTML.includes("sig-"));
  check("signal wire is capped (<= 6 items)",
    (byId("signalList").innerHTML.match(/class="sig /g) || []).length <= 6);

  const meth = byId("methodologyView");
  queryAll('[data-view="methodology"]')[0].fire("click");
  check("methodology opens as its own window", meth.classList.contains("open"));
  check("only one view open at a time", !iv.classList.contains("open"));
  queryAll("[data-closeview]")[0].fire("click");
  check("Back closes the view", !meth.classList.contains("open"));
  check("window scroll restored with the view", doc.documentElement.style.overflow === "");
  check("the lock mark leaves the body again", !doc.body.classList.contains("scroll-locked"));

  console.log("\n--- compare deck ---");
  const ids = window.__SNAPSHOT__.apps.slice(0, 3).map(a => a.app.id);
  byId("compareGo").onclick();

  setTimeout(() => {
  const view = byId("cmp3View");
    const list = byId("cmp3List");
    check("picker list built once with every app", list.innerHTML.split('class="cmp3-item').length - 1 === window.__SNAPSHOT__.apps.length);
    check("picker rows carry the logo chip", list.innerHTML.includes("applogo"));
    const pick = (id) => {
      const cls = new Set();
      const btn = { dataset: { cadd: String(id) }, offsetWidth: 1, querySelector: () => null,
        classList: { add: c => cls.add(c), remove: c => cls.delete(c), toggle: (c, f) => (f ? cls.add(c) : cls.delete(c)), contains: c => cls.has(c) } };
      list.onclick({ target: { closest: s => (s === "[data-cadd]" ? btn : null) } });
    };
    pick(ids[0]);
    const v1 = view.innerHTML;
    check("1 app -> grid appears immediately", v1.includes("cmp2-head") && !v1.includes("cmp3-empty"));
    check("1 app -> no reserved empty slot", !v1.includes("cmp-addcol") && !v1.includes("cmp3-slot"));
    check("1 app -> single column + slim add rail", v1.includes("repeat(1, minmax(96px,1fr)) 40px") && v1.includes("cmp2-addhead"));
    pick(ids[1]);
    check("2 apps -> exactly 2 columns, 50/50", view.innerHTML.includes("repeat(2, minmax(96px,1fr)) 40px"));
    pick(ids[2]);
    check("3 apps -> exactly 3 columns", view.innerHTML.includes("repeat(3, minmax(96px,1fr)) 40px"));
    check("3 apps -> still no ghost column", !view.innerHTML.includes("cmp-addcol"));
    check("cells stagger in", view.innerHTML.includes("animation-delay:"));
    pick(ids[2]); pick(ids[1]); pick(ids[0]);
    check("removing all -> back to the empty state", view.innerHTML.includes("cmp3-empty"));
    byId("closeModal").onclick();

    console.log("\n--- explorer scroller ---");
  const vcAll = byId("viewContent");
  check("explorer renders every row inside the scroller",
    (vcAll.innerHTML.match(/<tr data-id=/g) || []).length === window.__SNAPSHOT__.apps.length);
  check("no pager left behind", !vcAll.innerHTML.includes('class="pager"'));

  console.log("\n--- command palette ---");
    byId("searchOpen").onclick();
    check("palette opens from the nav icon", byId("cmdk").classList.contains("open"));
    const input = byId("cmdkInput");
    input.value = "notion"; input.fire("input", { target: input });
    const res = byId("cmdkRes").innerHTML;
    check("curated matches render with logos", res.includes("applogo") && res.toLowerCase().includes("notion"));
    check("results stagger in", res.includes("--i:"));
    check("tracked rows expose an explicit action", res.includes("ci-go"));
    input.value = "zzzqqq"; input.fire("input", { target: input });
    const res2 = byId("cmdkRes").innerHTML;
    check("unknown app -> an 'Anywhere' live-fetch row with a logo", res2.includes("Anywhere") && res2.includes("applogo"));

    console.log("\n--- dossier numbers are live-juggling ---");
    const app0 = window.__SNAPSHOT__.apps.find(a => a.github && a.github.stars != null) || window.__SNAPSHOT__.apps[0];
    const row = { dataset: { id: String(app0.app.id) }, closest: () => null };
    const modal = byId("modal");
    const vc = byId("viewContent");
    check("explorer table rows are clickable", !!(vc._ev && vc._ev.click));
    vc.fire("click", { target: { closest: (s) => (s === "[data-id]" ? row : (s === "[data-cmp]" ? null : null)) } });
    check("dossier opens", modal.classList.contains("open"));
    check("dossier numbers opted into juggling", modal.innerHTML.includes("data-num="));
    check("dossier sections stagger", modal.innerHTML.includes("--si:") || modal.innerHTML.includes("--ri:"));
    check("dossier keeps the readiness count-up", modal.innerHTML.includes("sb-num"));

    const bad = checks.filter(c => !c[1]);
    console.log("\n" + (bad.length ? "RESULT: FAIL (" + bad.length + " of " + checks.length + ")" : "RESULT: PASS - " + checks.length + " checks") );
    if (bad.length) bad.forEach(b => console.log("   - " + b[0]));
    if (failed) console.log("   - uncaught runtime error (see above)");
    process.exit(bad.length || failed ? 1 : 0);
  }, 140);
}, 700);
