// Regression test for the compare-window bug: clicking "add" inside the open
// compare modal must update the grid IN PLACE (previously toggleCompare threw
// a TypeError - `$` instead of `$$` - so the view only refreshed after a
// close/reopen cycle).
const fs = require("fs");
const path = require("path");

class El {
  constructor(sel) {
    this.sel = sel; this._cls = new Set(); this.style = {}; this.dataset = {};
    this.children = []; this._innerHTML = ""; this.textContent = "";
    this.onclick = null; this.onmouseleave = null; this.onchange = null; this.oninput = null;
    this.clientWidth = 760; this.clientHeight = 288; this.disabled = false;
    this.value = ""; this.options = []; this._attr = {}; this._ev = {}; this.scrollTop = 0;
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
global.location = { pathname: "/", hash: "", origin: "http://localhost:8000", href: "http://localhost:8000/" };
global.navigator = { clipboard: { writeText: () => Promise.resolve() } };
global.fetch = () => Promise.reject(new Error("offline (test)"));

let failed = false;
process.on("uncaughtException", e => { failed = true; console.error("UNCAUGHT:", e.message); });

const root = path.resolve(__dirname, "..");
eval(fs.readFileSync(path.join(root, "static/data.snapshot.js"), "utf8"));
eval(fs.readFileSync(path.join(root, "static/app.js"), "utf8"));

const ids = window.__SNAPSHOT__.apps.slice(0, 2).map(a => a.app.id);
const names = window.__SNAPSHOT__.apps.slice(0, 2).map(a => a.app.name);

function clickAdd(id) {
  const cls = new Set();
  const btn = {
    dataset: { cadd: String(id) },
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), toggle: (c, f) => { f ? cls.add(c) : cls.delete(c); }, contains: (c) => cls.has(c) },
    querySelector: () => null,
    offsetWidth: 1,
  };
  reg["#cmp3List"].onclick({ target: { closest: (s) => (s === "[data-cadd]" ? btn : null) } });
}

setTimeout(() => {
  // open the compare window from the bottom dock
  reg["#compareGo"].onclick();
  const modal = reg["#modal"];
  console.log("modal opened:", modal.classList.contains("open"));
  console.log("rises from bottom (cmpwin kept):", modal.classList.contains("cmpwin"));

  // add app #1 → the grid must appear IMMEDIATELY, filling the width: one real
  // column + the slim add rail, and no reserved slot for a second app
  clickAdd(ids[0]);
  const v1 = reg["#cmp3View"].innerHTML;
  const oneUp = v1.includes("cmp2-head") && v1.includes(names[0]) && v1.includes("cmp2-addhead") && !v1.includes("cmp3-empty");
  const noGhost = !v1.includes("cmp-addcol") && !/repeat\(2,/.test(v1) && !v1.includes("cmp3-slot");
  console.log("after add #1 - single-app grid visible in place:", oneUp);
  console.log("after add #1 - no reserved empty slot:", noGhost);

  // add app #2 → both columns side by side WITHOUT closing/reopening
  clickAdd(ids[1]);
  const v2 = reg["#cmp3View"].innerHTML;
  const gridUp = v2.includes("cmp2-head") && v2.includes("cmp2-row") && v2.includes(names[0]) && v2.includes(names[1]);
  const twoCols = /repeat\(2, minmax\(96px,1fr\)\) 40px/.test(v2);
  console.log("after add #2 - comparison visible in place:", gridUp);
  console.log("after add #2 - exactly 2 columns, grid owns the width:", twoCols);
  console.log("count label live:", (reg["#cmp3Count"] || {}).textContent);

  // remove #1 → the grid stays up with the remaining app
  clickAdd(ids[0]);
  const v3 = reg["#cmp3View"].innerHTML;
  const staysUp = v3.includes("cmp2-head") && v3.includes(names[1]) && !v3.includes(names[0]);
  console.log("after remove #1 - remaining app still on the board:", staysUp);

  // remove #2 → back to the empty state in place
  clickAdd(ids[1]);
  const v4 = reg["#cmp3View"].innerHTML;
  console.log("after remove #2 - back to empty state in place:", v4.includes("cmp3-empty"));

  const ok = !failed && modal.classList.contains("open") && modal.classList.contains("cmpwin")
    && oneUp && noGhost && gridUp && twoCols && staysUp && v4.includes("cmp3-empty");
  console.log(ok ? "RESULT: PASS - compare window updates live" : "RESULT: FAIL");
  process.exit(ok ? 0 : 1);
}, 600);
