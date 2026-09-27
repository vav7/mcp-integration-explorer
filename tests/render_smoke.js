// Headless DOM smoke test: executes app.js init()+render() against the real
// embedded snapshot to catch runtime errors without a browser.
const fs = require("fs");
const path = require("path");

class El {
  constructor(sel) {
    this.sel = sel; this._cls = new Set(); this.style = {}; this.dataset = {};
    this.children = []; this._innerHTML = ""; this.textContent = "";
    this.onclick = null; this.onmouseleave = null; this.onchange = null; this.oninput = null;
    this.clientWidth = 760; this.clientHeight = 288; this.disabled = false;
    this.value = ""; this.options = []; this._attr = {}; this._ev = {};
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
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); } get className() { return [...this._cls].join(" "); }
  addEventListener(t, f) { (this._ev[t] = this._ev[t] || []).push(f); }
  setAttribute(k, v) { this._attr[k] = v; } getAttribute(k) { return this._attr[k]; }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter(x => x !== c); }
  get lastChild() { return this.children[this.children.length - 1]; }
  closest() { return this; } scrollIntoView() {} remove() {} focus() {}
  querySelector(s) { return doc.querySelector(s); } querySelectorAll(s) { return doc.querySelectorAll(s); }
}
const reg = {};
const doc = {
  querySelector(sel) { if (!reg[sel]) reg[sel] = new El(sel); return reg[sel]; },
  querySelectorAll(sel) { return [new El(sel), new El(sel), new El(sel)]; },
  createElement(tag) { return new El(tag); },
  addEventListener() {},
  documentElement: new El("html"),
  body: new El("body"),
  activeElement: { tagName: "BODY" },
};

global.document = doc;
global.window = global;
global.addEventListener = () => {};
global.scrollTo = () => {}; global.scrollY = 0;
global.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = v; }, removeItem(k) { delete this._s[k]; } };
global.matchMedia = () => ({ matches: false, addEventListener() {} });
global.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 0);
global.IntersectionObserver = class { constructor(cb) { this.cb = cb; } observe() {} unobserve() {} disconnect() {} };
global.EventSource = class { constructor() { this.onmessage = null; this.onerror = null; } close() {} };
global.history = { pushState() {}, replaceState() {} };
global.location = { pathname: "/app/32", origin: "http://localhost:8000", href: "http://localhost:8000/app/32" };
global.navigator = { clipboard: { writeText: () => Promise.resolve() } };
global.fetch = () => Promise.reject(new Error("offline (smoke test)"));

let failed = false;
process.on("uncaughtException", e => { failed = true; console.error("UNCAUGHT:", e.message); });
process.on("unhandledRejection", e => { failed = true; console.error("UNHANDLED:", (e && e.message) || e); });

// load the real snapshot then the app
const root = path.resolve(__dirname, "..");
eval(fs.readFileSync(path.join(root, "static/data.snapshot.js"), "utf8"));
try {
  eval(fs.readFileSync(path.join(root, "static/app.js"), "utf8"));
} catch (e) {
  failed = true; console.error("EVAL ERROR:", e.message);
}

setTimeout(() => {
  const metrics = reg["#metrics"] && reg["#metrics"].innerHTML;
  const view = reg["#viewContent"] && reg["#viewContent"].innerHTML;
  const chart = reg["#chart"] && reg["#chart"].innerHTML;
  const catbars = reg["#catbars"] && reg["#catbars"].innerHTML;
  const modal = reg["#modal"] && reg["#modal"].innerHTML;
  console.log("metrics rendered:", !!(metrics && metrics.length > 50), `(${(metrics || "").length} chars)`);
  console.log("view (table) rendered:", !!(view && view.length > 50), `(${(view || "").length} chars)`);
  console.log("trend chart rendered:", !!(chart && chart.includes("<svg")), `(${(chart || "").length} chars)`);
  console.log("category bars rendered:", !!(catbars && catbars.length > 20));
  console.log("app modal rendered:", !!(modal && modal.includes("mcols") && modal.includes("mh-score") && modal.includes("sb-num") && modal.includes("Signal breakdown")), `(${(modal || "").length} chars)`);
  console.log("community toggle rendered:", !!(modal && modal.includes("ci-toggle") && modal.includes("ci-wrap") && modal.includes("ci-rows")));
  console.log("liveTxt:", reg["#liveTxt"] && reg["#liveTxt"].textContent);
  // ---- v12 checks ----
  const sigs = reg["#signalList"] && reg["#signalList"].innerHTML;
  console.log("signals feed rendered:", !!(sigs && sigs.includes("sig-ic") && sigs.includes("data-id")), `(${(sigs || "").length} chars)`);
  const strip = reg["#insightStrip"] && reg["#insightStrip"].innerHTML;
  console.log("insight cards clickable+reveal:", !!(strip && strip.includes("ins-rev") && strip.includes("data-cat") && strip.includes("ins-go")));
  console.log("catbars clickable:", !!(catbars && catbars.includes("cat-link") && catbars.includes("data-cat")));
  // ---- v14: landscape analytics must render from the real snapshot ----
  const ansco = reg["#anScoreBody"] && reg["#anScoreBody"].innerHTML;
  const anprov = reg["#anProvBody"] && reg["#anProvBody"].innerHTML;
  const ansc = reg["#anScatterBody"] && reg["#anScatterBody"].innerHTML;
  const anfresh = reg["#anFreshBody"] && reg["#anFreshBody"].innerHTML;
  const anprobe = reg["#anProbeBody"] && reg["#anProbeBody"].innerHTML;
  console.log("analytics score anatomy:", !!(ansco && ansco.includes("an-frow")));
  console.log("analytics provenance donut:", !!(anprov && anprov.includes("an-seg")));
  console.log("analytics adoption scatter:", !!(ansc && ansc.includes("an-pt")));
  console.log("analytics freshness:", !!(anfresh && anfresh.includes("an-frow")));
  console.log("analytics probe truth:", !!(anprobe && anprobe.includes("an-stat")));
  console.log("metrics rows linked:", !!(metrics && metrics.includes("cov-link") && metrics.includes("data-goto")));
  console.log("sigCount set:", !!(reg["#sigCount"] && reg["#sigCount"].textContent && reg["#sigCount"].textContent.includes("signal")));
  // ---- v13: no em/en dashes may survive anywhere in rendered output ----
  let dashHits = 0;
  for (const k of Object.keys(reg)) {
    const e = reg[k];
    const h = String(e._innerHTML || "") + "|" + String(e.textContent || "");
    if (h.includes("\u2014") || h.includes("\u2013")) dashHits++;
  }
  console.log("no em/en dashes in rendered DOM:", dashHits === 0, `(${dashHits} elements still showing dashes)`);
  if (failed || !(modal && modal.includes("mcols") && modal.includes("ci-toggle"))
      || !(sigs && sigs.includes("sig-ic")) || !(strip && strip.includes("ins-rev"))
      || !(catbars && catbars.includes("cat-link")) || !(metrics && metrics.includes("cov-link"))
      || !(ansco && ansco.includes("an-frow")) || !(anprov && anprov.includes("an-seg"))
      || !(ansc && ansc.includes("an-pt")) || dashHits !== 0) { console.log("RESULT: FAIL"); process.exit(1); }
  console.log("RESULT: PASS - init+render completed with no runtime errors");
  process.exit(0);
}, 600);
