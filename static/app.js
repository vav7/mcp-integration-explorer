
/* MCP Integration Explorer - premium dashboard logic.
 * Live backend first (/api/snapshot + SSE); offline falls back to the embedded
 * real snapshot. All derived views (leaderboard, opportunities, export) are
 * computed client-side so they work with or without the backend.
 */
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const state = {
    snap: null, live: false, refreshing: false, firstRender: true,
    view: "explorer", q: "", cat: "", status: "", grade: "",
    sortKey: "readiness", sortDir: -1, es: null, lastSnapPull: 0,
    cmdk: { open: false, idx: 0, items: [], query: "", registry: [], regQuery: "", regLoading: false },
    compare: [], recent: [], unread: 0, trendMetric: "official", sigFilter: "",
    view_open: "", railTab: "changes", spyCur: "",
  };

  /* Full-screen deep-dive views. They behave exactly like the pricing view:
     opened from the toolbar, the drawer, the footer or a card on the main
     page, closed by Back / Esc / Home, deep-linkable through the hash. */
  const VIEWS = ["intelligence", "methodology", "help", "pricing"];
  const VIEW_EL = { intelligence: "#intelligenceView", methodology: "#methodologyView", help: "#helpView", pricing: "#pricingView" };
  const viewOpen = () => state.view_open || "";

  /* recent searches (localStorage) */
  const LS = "mcp_explorer_recent";
  function loadRecent() { try { state.recent = JSON.parse(localStorage.getItem(LS) || "[]"); } catch (e) { state.recent = []; } }
  function pushRecent(entry) {
    state.recent = [entry, ...state.recent.filter(r => r.name.toLowerCase() !== entry.name.toLowerCase())].slice(0, 8);
    try { localStorage.setItem(LS, JSON.stringify(state.recent)); } catch (e) {}
  }

  /* ---------------- helpers ---------------- */
  /* Dash purge (v13): em/en dashes never render anywhere on the site. Real
     registry data is NOT rewritten on disk; strings are sanitised at display
     time: on ingest (snapshot/SSE/activity/lookup) and again inside esc(). */
  const noDash = (s) => (s.indexOf("\u2014") < 0 && s.indexOf("\u2013") < 0) ? s
    : s.replace(/\s*\u2014\s*/g, " - ").replace(/\s*\u2013\s*/g, "-").replace(/[ \t]{2,}/g, " ");
  function sanitizeDashes(v) {
    if (typeof v === "string") return noDash(v);
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = sanitizeDashes(v[i]); return v; }
    if (v && typeof v === "object") { for (const k in v) { if (Object.prototype.hasOwnProperty.call(v, k)) v[k] = sanitizeDashes(v[k]); } }
    return v;
  }
  const esc = (s) => noDash(String(s == null ? "" : s)).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function timeAgo(iso) {
    if (!iso) return "-"; const t = new Date(iso).getTime(); if (isNaN(t)) return "-";
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 5) return "just now"; if (s < 60) return s + "s ago";
    const m = Math.round(s / 60); if (m < 60) return m + "m ago";
    const h = Math.round(m / 60); if (h < 24) return h + "h ago";
    return Math.round(h / 24) + "d ago";
  }
  const clock = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "-";
  const fmtNum = (n) => { n = n || 0; return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1000 ? (n / 1000).toFixed(n >= 1e4 ? 0 : 1) + "k" : String(n); };
  const hostname = (u) => { try { return (new URL(u.startsWith("http") ? u : "https://" + u)).hostname.replace(/^www\./, ""); } catch (e) { return ""; } };
  const initials = (n) => (n.replace(/[^A-Za-z0-9 ]/g, "").trim().split(/\s+/).map(w => w[0]).join("").slice(0, 2) || n.slice(0, 2)).toUpperCase();
  const dlOf = (a) => (a.packages || []).reduce((s, p) => s + (p.downloads_last_month || 0), 0);
  /* readiness score → ambient row tint: emerald (high) → lime → amber → orange → red (low).
     Rendered as a transparent left-to-right wash so the glass stays glassy. */
  const TINT_STOPS = [[0, 248, 113, 113], [26, 251, 146, 60], [48, 251, 191, 36], [68, 163, 230, 53], [84, 52, 211, 153], [100, 45, 212, 191]];
  function rowTint(score) {
    const s = Math.max(0, Math.min(100, Number(score) || 0));
    let i = 1; while (i < TINT_STOPS.length - 1 && TINT_STOPS[i][0] < s) i++;
    const a = TINT_STOPS[i - 1], b = TINT_STOPS[i], t = (s - a[0]) / ((b[0] - a[0]) || 1);
    const c = [1, 2, 3].map(k => Math.round(a[k] + (b[k] - a[k]) * t)).join(",");
    const A = (0.030 + 0.030 * (s / 100)).toFixed(3), A2 = (A * 0.38).toFixed(3);
    return `linear-gradient(90deg,rgba(${c},${A}) 0%,rgba(${c},${A2}) 48%,rgba(${c},0) 86%)`;
  }
  /* One shared rAF driver for every rolling number. A refresh can tick ~170
     values at once; a rAF chain per element meant ~170 layout-writing loops
     per frame. Same easing, same 780ms, one callback. */
  const TWEENS = new Set();
  let tweenRaf = 0;
  function tickTweens(t) {
    TWEENS.forEach(tw => {
      const p = Math.min(1, (t - tw.t0) / tw.dur), e = 1 - Math.pow(1 - p, 3);
      const v = Math.round(tw.from + (tw.to - tw.from) * e);
      if (tw.el.isConnected) tw.el.textContent = tw.fmt ? tw.fmt(v) : v.toLocaleString();
      else TWEENS.delete(tw);
      if (p >= 1) TWEENS.delete(tw);
    });
    tweenRaf = TWEENS.size ? requestAnimationFrame(tickTweens) : 0;
  }
  function countUp(el, to, fmt, from) {
    if (!el) return; to = Number(to) || 0;
    const start = from == null ? 0 : Number(from) || 0;
    TWEENS.forEach(tw => { if (tw.el === el) TWEENS.delete(tw); });
    TWEENS.add({ el, to, fmt, from: start, t0: performance.now(), dur: 780 });
    if (!tweenRaf) tweenRaf = requestAnimationFrame(tickTweens);
  }
  /* "juggling" numbers - when live data changes a value it rolls from the old
     figure to the new one and flashes, so updates are impossible to miss. */
  function setNum(sel, to, fmt) {
    const el = typeof sel === "string" ? $(sel) : sel; if (!el) return;
    to = Number(to) || 0; const prev = el._numv;
    if (prev == null) countUp(el, to, fmt, 0);
    else if (prev !== to) {
      countUp(el, to, fmt, prev);
      /* stock-ticker tick: green when it climbs, red when it slips */
      const dir = to > prev ? "numup" : "numdown";
      el.classList.remove("numup", "numdown", "numflash"); void el.offsetWidth; el.classList.add(dir);
    } else el.textContent = fmt ? fmt(to) : to.toLocaleString();
    el._numv = to;
  }

  /* An open dossier used to freeze until reopened. Its nodes persist across
     refreshes, so republish the live values onto them (keyed by data-nk) and let
     the memoised tick pass roll them - same stock-ticker behaviour as the page. */
  function syncOpenDossier() {
    const m = $("#modal");
    if (!m || !m.classList.contains("open") || m.classList.contains("cmpwin")) return;
    const id = state.modalAppId; if (id == null) return;
    const a = (state.snap.apps || []).find(x => x.app.id === id); if (!a) return;
    const gh = a.github || {}, lv = a.liveness || {}, mm = a.mcp || {};
    const commitDays = gh.pushed_at ? Math.round((Date.now() - new Date(gh.pushed_at)) / 86400000) : null;
    const vals = {
      dl: dlOf(a), stars: gh.stars, forks: gh.forks, issues: gh.open_issues,
      commit: commitDays, lat: lv ? lv.latency_ms : null,
      readiness: a.readiness.score, bar: a.readiness.score, matched: mm.matched,
    };
    $$("[data-nk]", m).forEach(el => {
      const k = el.dataset.nk || "";
      if (k.indexOf("rc:") === 0) {
        const comp = k.split(":")[2];
        const c = (a.readiness.components || {})[comp];
        if (c) el.dataset.num = String(Math.round(c.score * 100));
        return;
      }
      const suf = k.split(":").pop();
      if (suf in vals && vals[suf] != null) el.dataset.num = String(vals[suf]);
    });
    scanNums(m); scanBars(m);
  }

  /* Value memo: a refresh rebuilds the DOM, so without this every number would
     forget its previous figure and re-roll from zero. Keyed by data-nk (or the
     element id) the memo lets a live update roll prev -> new like a ticker. */
  const NUMMEMO = Object.create(null);
  const BARMEMO = Object.create(null);
  /* Stable identity for the value memo: an explicit data-nk, else the element
     id, else a positional path under the nearest ided ancestor (re-renders
     rebuild identical structure, so the path is stable across refreshes). */
  function numKeyOf(el) {
    if (!el || !el.dataset) return "";
    if (el.dataset.nk) return el.dataset.nk;
    if (el.id) return "#" + el.id;
    const path = [];
    let n = el;
    while (n && n !== document.body) {
      if (n.id) { path.unshift("#" + n.id); break; }
      const parent = n.parentElement; if (!parent) break;
      path.unshift(Array.prototype.indexOf.call(parent.children, n));
      n = parent;
    }
    return path.length ? path.join(">") : "";
  }

  /* v14: site-wide number juggling. Any element opts in with data-num
     (plus optional data-fmt="k|pct|dec1"). Numbers pre-roll to 0 and count up
     the first time they enter the viewport; later value changes roll from the
     old figure to the new one and flash. Falls back to plain final values
     when IntersectionObserver is missing or motion is reduced. */
  let numObs = null;
  const numFmt = (f) => f === "k" ? (v => fmtNum(v)) : f === "pct" ? (v => v + "%") : f === "dec1" ? (v => (v / 10).toFixed(1)) : null;
  function scanNums(root) {
    const scope = root || document; if (!scope) return;
    let els = [];
    try { if (scope.querySelectorAll) els = Array.from(scope.querySelectorAll("[data-num]")); } catch (e) { els = []; }
    try { if (scope.matches && scope.matches("[data-num]")) els.unshift(scope); } catch (e) {}
    if (!els.length) return;
    let hasIO = false; try { hasIO = "IntersectionObserver" in window; } catch (e) {}
    let reduced = false; try { reduced = matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
    els.forEach((el) => {
      if (!el || !el.dataset) return;
      const to = Number(el.dataset.num) || 0, fmt = numFmt(el.dataset.fmt);
      const key = numKeyOf(el);
      /* Seen before (or refreshed in place): tick from the remembered figure.
         Never seen: keep the first-time count-up from zero. */
      if (key && (key in NUMMEMO)) {
        const prev = NUMMEMO[key];
        el._numv = prev;
        setNum(el, to, fmt);
        NUMMEMO[key] = to;
        return;
      }
      if (key) NUMMEMO[key] = to;      /* remember the true value for the next render */
      if (!hasIO || reduced) {
        if (el._numv == null) { el.textContent = fmt ? fmt(to) : to.toLocaleString(); el._numv = to; }
        else if (el._numv !== to) setNum(el, to, fmt);
        return;
      }
      if (el._numReg) { if (el._numv != null && el._numv !== to) setNum(el, to, fmt); return; }
      el._numReg = 1; el.textContent = fmt ? fmt(0) : "0";
      if (!numObs) numObs = new IntersectionObserver((es) => {
        const fire = (e) => { if (e && e.isIntersecting && e.target && e.target.dataset) {
          try { numObs.unobserve(e.target); } catch (x) {}
          const k = numKeyOf(e.target);
          setNum(e.target, Number(e.target.dataset.num) || 0, numFmt(e.target.dataset.fmt));
          if (k) NUMMEMO[k] = Number(e.target.dataset.num) || 0; } };
        if (es && es.forEach) es.forEach(fire); else if (es) for (let i = 0; i < es.length; i++) fire(es[i]);
      }, { threshold: .3, rootMargin: "0px 0px -4px" });
      try { numObs.observe(el); } catch (e) { el.textContent = fmt ? fmt(to) : to.toLocaleString(); el._numv = to; }
    });
  }
  /* Bars slide from their previous width to the new one on live updates, and
     draw straight in the first time. [data-bar] carries the target percent. */
  const BAR_SEL = "[data-bar], .bar-track i, .score .sbar i, .sbar i, .sb-bar i, .lb-bar i, .rcomp-row .rt i, .an-ftrack i";
  function scanBars(root) {
    const scope = root || document; if (!scope || !scope.querySelectorAll) return;
    let els = [];
    try { els = Array.from(scope.querySelectorAll(BAR_SEL)); } catch (e) { return; }
    els.forEach((el) => {
      /* Latch the intended width on first sight. Without this, a second pass in
         the same tick reads the transient draw-in width ("0%") as the target and
         animates the bar down to nothing - which is exactly what made the
         analytics bars invisible. */
      if (el.dataset.bar == null) el.dataset.bar = String(parseFloat(el.style.width) || 0);
      const nw = Math.max(0, Math.min(100, Number(el.dataset.bar) || 0));
      const key = numKeyOf(el);
      const prev = key ? BARMEMO[key] : undefined;
      if (prev != null && Math.abs(prev - nw) > 0.01) {
        /* live update: slide from the remembered width to the new one */
        el.style.transition = "none";
        el.style.width = prev + "%";
        void el.offsetWidth;
        el.style.transition = "";
        requestAnimationFrame(() => { el.style.width = nw + "%"; });
      } else if (prev == null) {
        /* first sight: draw in from zero, once */
        el.style.transition = "none";
        el.style.width = "0%";
        void el.offsetWidth;
        el.style.transition = "";
        requestAnimationFrame(() => { el.style.width = nw + "%"; });
      } else {
        el.style.width = nw + "%";
      }
      if (key) BARMEMO[key] = nw;
    });
  }

  const STATUS_LABEL = { vendor_official: "Official", community: "Community", none: "None", unknown: "Unknown", pending: "Pending" };
  const STATUS_TITLE = {
    vendor_official: "Vendor official MCP server: the registry namespace resolves to the app's own domain",
    community: "Community built MCP server listed in the registry",
    none: "No MCP server detected in the registry yet",
    unknown: "MCP status unknown", pending: "Live fetch pending",
  };
  const B_IC = "viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'";
  const STATUS_ICON = {
    vendor_official: `<svg ${B_IC}><path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>`,
    community: `<svg ${B_IC}><circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-5 6-5s6 1.7 6 5"/><path d="M16 6.2A3 3 0 0118 12m1 8c0-2.4-1-4-2.5-4.7"/></svg>`,
    none: `<svg ${B_IC}><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6"/></svg>`,
    unknown: `<svg ${B_IC}><circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.8-.9 1.4v.4"/><path d="M12 16.8h.01"/></svg>`,
    pending: `<svg ${B_IC}><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 1.8"/></svg>`,
  };
  /* The registry's own search is keyword-based and occasionally returns nothing
     for a server that is genuinely published. When that happens the backend
     keeps the domain-verified server for one more cycle and marks it stale;
     the dashboard says so instead of pretending the record is fresh. */
  const staleTag = (s) => (s && s.stale)
    ? `<span class="tag stale" title="The registry search returned nothing for this app in the latest cycle, so this server is carried over from ${esc(s.last_seen || "the previous cycle")}. It is dropped if the next cycle is blank too.">carried over</span>`
    : "";
  const statusBadge = (st) => `<span class="badge ${esc(st)}" title="${esc(STATUS_TITLE[st] || "")}"><span class="bd">${STATUS_ICON[st] || ""}</span>${esc(STATUS_LABEL[st] || st)}</span>`;

  const ICON = {
    apps: '<rect x="3" y="3" width="7" height="7" rx="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.6"/><rect x="14" y="14" width="7" height="7" rx="1.6"/>',
    shield: '<path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
    users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-5 6-5s6 1.7 6 5"/><path d="M16 6.2A3 3 0 0118 12m1 8c0-2.4-1-4-2.5-4.7"/>',
    slash: '<circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6"/>',
    tools: '<path d="M14.5 5.5a3.5 3.5 0 004.6 4.6L21 12l-8.5 8.5a2.1 2.1 0 01-3-3L18 9"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2.4"/><path d="M8 10V7a4 4 0 018 0v3"/>',
    download: '<path d="M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5M4 20h16"/>',
    gauge: '<path d="M12 14l4-4"/><circle cx="12" cy="14" r="8"/><path d="M4 14a8 8 0 0116 0"/>',
    star: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.7l5.9-.8z"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18"/>',
    bolt: '<path d="M13 2L4.5 13H11l-1 9 8.5-11H12z"/>',
    box: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
    check: '<path d="M4 12.5l5 5L20 6.5"/>',
  };
  const svg = (k, w = 1.7) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${ICON[k] || ""}</svg>`;

  /* Favicon URLs are memoised per domain: a re-render must never make the
     browser re-request 100 icons (that churn is what made the compare picker
     and the palette feel laggy). */
  const FAV = Object.create(null);
  const favUrl = (dom) => {
    if (!dom) return "";
    if (!(dom in FAV)) FAV[dom] = "https://www.google.com/s2/favicons?sz=64&domain=" + encodeURIComponent(dom);
    return FAV[dom];
  };
  const logoImg = (dom) => dom ? `<img src="${favUrl(dom)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : "";
  /* Best available favicon domain for an app: its own website, then the site
     the registry publishes for one of its servers (this is what makes a
     looked-up app like "nvidia" show a real logo), then a dotted name. */
  /* Favicons are per registered domain: api.copilot.nsight.ngc.nvidia.com and
     developer.nvidia.com both want the nvidia.com mark, not a subdomain guess. */
  const favDom = (h) => { const p = String(h || "").split("."); return p.length > 2 ? p.slice(-2).join(".") : (h || ""); };
  function logoDomain(a) {
    const w = favDom(hostname(a && a.app ? a.app.website : ""));
    if (w) return w;
    const srvs = (a && a.mcp && a.mcp.servers) || [];
    const name = ((a && a.app && a.app.name) || "").toLowerCase();
    const toks = name.split(/[^a-z0-9]+/).filter(t => t.length >= 3);
    let first = "";
    for (let i = 0; i < srvs.length; i++) {
      const u = favDom(hostname(srvs[i].website_url || ""));
      if (!u) continue;
      /* prefer a site that actually carries the brand (nvidia -> developer.nvidia.com,
         not some aggregator's domain that happened to be listed first) */
      if (toks.some(t => u.indexOf(t) >= 0)) return u;
      if (!first) first = u;
    }
    if (first) return first;
    const n = (a && a.app && a.app.name) || "";
    return n.indexOf(".") > 0 ? n.toLowerCase() : "";
  }
  function logoHtml(a, cls = "") {
    const dom = logoDomain(a), ini = initials(a.app.name);
    return `<div class="applogo ${cls}"><span class="ini">${esc(ini)}</span>${logoImg(dom)}</div>`;
  }
  /* Same chip for anything that is not one of the tracked 100: a registry
     suggestion, a recent fetch, or a brand-new app typed into the palette. */
  function domainLogo(dom, name, cls = "") {
    return `<div class="applogo ${cls}"><span class="ini">${esc(initials(String(name || dom || "?")))}</span>${logoImg(dom)}</div>`;
  }
  function gaugeHtml(score, grade) {
    const r = 50, c = 2 * Math.PI * r, off = c * (1 - Math.max(0, Math.min(100, score)) / 100);
    return `<div class="gauge"><svg width="118" height="118" viewBox="0 0 118 118">
      <defs><linearGradient id="gg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5b8cff"/><stop offset=".55" stop-color="#8b5cf6"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs>
      <circle cx="59" cy="59" r="${r}" fill="none" stroke="rgba(140,150,180,.25)" stroke-width="9"/>
      <circle cx="59" cy="59" r="${r}" fill="none" stroke="url(#gg)" stroke-width="9" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" style="transition:stroke-dashoffset 1s cubic-bezier(.16,1,.3,1)"/>
    </svg><div class="gv"><div><b>${score}</b><span>GRADE ${esc(grade)}</span></div></div></div>`;
  }
  function toast(msg, icon = "check") {
    const t = $("#toast"); t.innerHTML = svg(icon) + "<span>" + esc(msg) + "</span>"; t.classList.add("show");
    clearTimeout(t._tm); t._tm = setTimeout(() => t.classList.remove("show"), 2600);
  }
  function opportunityScore(a) {
    if (a.mcp.status === "vendor_official") return -1;
    const stars = a.github.stars || 0, dl = dlOf(a);
    const lg = (v, c) => v > 0 ? Math.min(Math.log10(v + 1) / c, 1) : 0;
    return lg(stars, 4) * 40 + lg(dl, 5) * 40 + Math.min((a.mcp.servers || []).length, 10) * 2 + ((a.liveness && a.liveness.reachable) ? 10 : 0);
  }

  /* ---------------- theme ---------------- */
  const SUN = '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/>';
  const MOON = '<path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/>';
  function themeIcon() { const ic = $("#themeIcon"); if (ic) ic.innerHTML = document.documentElement.getAttribute("data-theme") === "light" ? SUN : MOON; }
  function toggleTheme() {
    const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    const root = document.documentElement;
    root.classList.add("theme-anim");
    root.setAttribute("data-theme", next);
    setTimeout(() => root.classList.remove("theme-anim"), 260);
    try { localStorage.setItem("mcp_theme", next); } catch (e) {}
    themeIcon(); toast(next === "light" ? "Light theme" : "Dark theme", "check");
  }
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  /* ---------------- data ---------------- */
  async function loadSnapshot() {
    // Pure offline builds (demo.html) carry the real snapshot inline and skip
    // the network entirely for an instant, robust render.
    if (window.__OFFLINE_DEMO__ && window.__SNAPSHOT__) {
      state.snap = window.__SNAPSHOT__; state.live = false; render(); return;
    }
    // Abort after a short timeout: in offline/sandboxed contexts the fetch can
    // hang instead of rejecting, which would block render(). Fall back to the
    // embedded real snapshot in that case.
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), 6000) : null;
    try {
      const r = await fetch("/api/snapshot", { cache: "no-store", signal: ctl ? ctl.signal : undefined });
      clearTimeout(timer);
      if (!r.ok) throw new Error("HTTP " + r.status);
      state.snap = sanitizeDashes(await r.json()); if (!state.live) { state.live = true; connectStream(); } render();
    } catch (e) {
      clearTimeout(timer);
      if (window.__SNAPSHOT__) { state.snap = sanitizeDashes(window.__SNAPSHOT__); state.live = false; render(); }
      else $("#viewContent").innerHTML = `<div class="empty" style="padding:30px">No backend reachable and no snapshot embedded. Run <code class="mono">uvicorn src.app:app</code> then reload.</div>`;
    }
  }
  function retryLive() {
    if (window.__OFFLINE_DEMO__) return;
    let tries = 0;
    const t = setInterval(async () => {
      tries++;
      if (state.live || tries > 8) { clearInterval(t); return; }
      try { const r = await fetch("/api/health", { cache: "no-store" }); if (r.ok) { clearInterval(t); await loadSnapshot(); } } catch (e) {}
    }, 2000);
  }

  function connectStream() {
    if (state.es || !("EventSource" in window)) return;
    try { state.es = new EventSource("/api/stream"); } catch (e) { return; }
    state.es.onmessage = (ev) => { let d; try { d = sanitizeDashes(JSON.parse(ev.data)); } catch (e) { return; }
      if (d.type === "activity") { pushEvent(d); maybePull(); }
      else if (d.type === "alert") { toast("🔔 " + (d.alert && d.alert.message ? d.alert.message : "Alert"), "shield"); loadSnapshot(); }
      else if (d.type === "ping") setLive(true, d.refresh_running);
      else if (d.type === "hello") setLive(true, state.refreshing); };
    state.es.onerror = () => setLive(true, state.refreshing, true);
  }
  function maybePull() { const n = Date.now(); if (n - state.lastSnapPull > 6000) { state.lastSnapPull = n; fetch("/api/snapshot", { cache: "no-store" }).then(r => r.json()).then(s => {
      /* during a refresh the stream emits many activity events; the snapshot
         only actually changes once, when generated_at moves. Ignore the rest. */
      if (state.snap && s && s.generated_at === state.snap.generated_at) return;
      state.snap = sanitizeDashes(s); render(true); invalidateScrollCaches(); }).catch(() => {}); } }

  /* ---------------- chrome ---------------- */
  function setLive(connected, refreshing, errored) {
    state.refreshing = !!refreshing;
    const led = $("#liveLed"), txt = $("#liveTxt"), hled = $("#heroLed");
    let word, cls;
    if (!state.live) { word = "Offline"; cls = "led off"; }
    else if (refreshing) { word = "Refreshing"; cls = "led busy"; }
    else if (errored) { word = "Degraded"; cls = "led off"; }
    else { word = "Live"; cls = "led live"; }
    led.className = cls; txt.textContent = word;
    if (hled) hled.className = cls;
    const dled = $("#dwLed"); if (dled) dled.className = cls;
    const dtxt = $("#dwStatus"); if (dtxt) dtxt.textContent = word === "Live" ? "Live · streaming" : word;
    const fled = $("#footLed"); if (fled) fled.className = cls;
    const fstat = $("#footStatus"); if (fstat) fstat.textContent = !state.live ? "snapshot mode · last real fetch" : word === "Live" ? "live · continuously refreshed" : word.toLowerCase();
    $("#refreshBtn").disabled = !!refreshing;
    $("#refreshLabel").textContent = refreshing ? "Refreshing" : "Refresh";
  }

  function populateHero(st) {
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    setNum("#hsApps", st.total_apps ?? 0);
    setNum("#hsServers", st.total_mcp_servers ?? 0);
    setNum("#hsOfficial", st.mcp_vendor_official ?? 0);
    const probed = st.probed_endpoints || 0, responded = (st.open_endpoints || 0) + (st.auth_gated_endpoints || 0);
    if (probed) setNum("#hsLive", Math.round(responded / probed * 100), v => v + "%"); else set("#hsLive", "-");
    const srcs = (state.snap && state.snap.sources) || [];
    const allUp = srcs.length && srcs.every(x => x.reachable);
    const ago = timeAgo(state.snap ? state.snap.generated_at : null);
    set("#heroUpdated", `Updated ${ago}`);
    set("#spVerified", ago);
    set("#spStatus", !state.live ? "Snapshot" : allUp ? "Operational" : "Degraded");
    const spl = $("#spLive"); if (spl) spl.innerHTML = `<span class="led ${state.live ? "live" : "off"}"></span>${state.live ? "live" : "snapshot"}`;
  }

  function populateEstate(st) {
    const el = $("#estateHealth"); if (!el) return;
    const srcs = (state.snap && state.snap.sources) || [];
    const SRC_URL = { "MCP Registry": "https://registry.modelcontextprotocol.io", "GitHub API": "https://docs.github.com/rest", "npm Registry": "https://www.npmjs.com", "npm": "https://www.npmjs.com", "PyPI": "https://pypi.org" };
    const rows = srcs.map(s => {
      const u = SRC_URL[s.name];
      const nm = u ? `<a class="eh-n" href="${u}" target="_blank" rel="noopener" title="Open ${esc(s.name)}">${esc(s.name)} ↗</a>` : `<span class="eh-n">${esc(s.name)}</span>`;
      return `<div class="eh-row"><span class="led ${s.reachable ? "live" : "off"}"></span>${nm}<span class="eh-v">${s.reachable ? (s.latency_ms != null ? s.latency_ms + "ms" : "up") : "down"}</span></div>`;
    }).join("");
    const meta = `<div class="eh-div"></div>
      <div class="eh-row"><span class="eh-n">Last refresh</span><span class="eh-v">${timeAgo(state.snap ? state.snap.generated_at : null)}</span></div>
      <div class="eh-row"><span class="eh-n">Endpoints probed</span><span class="eh-v">${st.probed_endpoints || 0} · ${st.open_endpoints || 0} open</span></div>
      <div class="eh-row"><span class="eh-n">Avg readiness</span><span class="eh-v">${st.avg_readiness ?? "-"}</span></div>`;
    el.innerHTML = rows + meta;
    const hh = $("#estateHint"); if (hh) hh.textContent = srcs.length ? srcs.filter(x => x.reachable).length + "/" + srcs.length + " sources up" : "";
  }

  function renderInsights(st) {
    const bc = st.by_category || {};
    const entries = Object.entries(bc);
    const el = $("#insightStrip"); if (!el) return;
    if (sigUnchanged("insights", entries.map(([k, c]) => k + (c.apps || 0) + (c.vendor_official || 0) + (c.community || 0) + (c.avg_readiness || 0)).join(","))) return;
    if (!entries.length) { el.innerHTML = ""; return; }
    const cov = ([, c]) => ((c.vendor_official || 0) + (c.community || 0)) / (c.apps || 1);
    const most = entries.reduce((a, b) => cov(b) > cov(a) ? b : a);
    const least = entries.reduce((a, b) => cov(b) < cov(a) ? b : a);
    const ready = entries.reduce((a, b) => (b[1].avg_readiness || 0) > (a[1].avg_readiness || 0) ? b : a);
    const cell = (l, v, sub, cat, i) => `<div class="ins${insDone ? "" : " ins-rev reveal"}" style="--i:${i}" data-cat="${esc(cat)}" role="link" tabindex="0" title="Filter the explorer to ${esc(cat)}">
      <span class="ins-l">${l}</span><span class="ins-v">${esc(v)}</span><span class="ins-s">${sub}</span><span class="ins-go">Explore category →</span></div>`;
    el.innerHTML = cell("Most covered category", most[0], `${Math.round(cov(most) * 100)}% have an MCP server`, most[0], 0) +
      cell("Highest readiness", ready[0], `avg score ${ready[1].avg_readiness ?? "-"}`, ready[0], 1) +
      cell("Lowest coverage", least[0], `${Math.round(cov(least) * 100)}% have an MCP server`, least[0], 2);
    bindInsCards(); observeReveal();
  }
  let insDone = false;
  function filterToCategory(cat) {
    state.cat = cat || ""; state.view = "explorer";
    const sel = $("#catFilter"); if (sel) sel.value = state.cat;
    renderView();
    if (viewOpen()) closeView();
    requestAnimationFrame(() => { const t = $("#apps"); if (t && t.scrollIntoView) t.scrollIntoView({ behavior: "smooth", block: "start" }); });
    if (cat) toast(`Filtered to ${cat}`, "apps");
  }
  let insBound = false;
  function bindInsCards() {
    if (insBound) return; insBound = true;
    const strip = $("#insightStrip"); if (!strip || !strip.addEventListener) return;
    const go = (e) => { const c = e.target && e.target.closest ? e.target.closest("[data-cat]") : null; if (c && c.dataset.cat) filterToCategory(c.dataset.cat); };
    strip.addEventListener("click", go);
    strip.addEventListener("keydown", e => { if (e.key === "Enter") go(e); });
  }

  /* ---------------- signals: the site-wide latest-signal feed ---------------- */
  const SIG_META = {
    servers: { icon: "box", cls: "reg", group: "registry", label: "Registry" },
    status: { icon: "shield", cls: "st", group: "registry", label: "Status" },
    tools: { icon: "bolt", cls: "tool", group: "endpoints", label: "Endpoint" },
    site: { icon: "globe", cls: "live", group: "liveness", label: "Liveness" },
    site_down: { icon: "slash", cls: "down", group: "liveness", label: "Liveness" },
    official_mcp: { icon: "shield", cls: "st", group: "alerts", label: "Alert" },
    score: { icon: "gauge", cls: "score", group: "alerts", label: "Alert" },
  };
  let sigDone = false;
  function renderSignals() {
    const s = state.snap, el = $("#signalList"); if (!s || !el) return;
    const ch = s.changes || [], al = s.alerts || [];
    if (sigUnchanged("signals", [state.sigFilter, ch.length, al.length, (ch[0] || {}).ts, (al[0] || {}).ts].join("|"))) return;
    const items = [];
    (s.changes || []).forEach(c => items.push({ ts: c.ts, app: c.app || "System", id: c.app_id, kind: c.kind || "servers", msg: c.message }));
    (s.alerts || []).forEach(a => items.push({ ts: a.ts, app: a.app || "System", id: a.app_id, kind: a.event || "score", msg: a.message }));
    items.sort((x, y) => new Date(y.ts || 0) - new Date(x.ts || 0));
    const g = state.sigFilter || "";
    const list = g ? items.filter(it => ((SIG_META[it.kind] || {}).group || "alerts") === g) : items;
    const cnt = $("#sigCount"); if (cnt) cnt.textContent = `${items.length} signal${items.length === 1 ? "" : "s"} · newest first`;
    el.innerHTML = list.slice(0, 6).map((it, i) => {
      const m = SIG_META[it.kind] || { icon: "bolt", cls: "score", label: "Signal" };
      return `<div class="sig${sigDone ? "" : " reveal"}" style="--i:${Math.min(i, 9)}"${it.id ? ` data-id="${it.id}"` : ""}>
        <span class="sig-ic ${m.cls}">${svg(m.icon, 1.8)}</span>
        <div class="sig-b"><div class="sig-top"><span class="sig-app">${esc(it.app)}</span><span class="sig-tag">${m.label}</span><span class="sig-ts">${esc(timeAgo(it.ts))}</span></div>
        <div class="sig-msg">${esc(it.msg)}</div></div>${it.id ? `<span class="sig-go">Open dossier →</span>` : ""}</div>`;
    }).join("") || `<div class="empty" style="padding:26px;text-align:center">No signals yet; they stream in with every live refresh.</div>`;
    bindSignalRows(); observeReveal();
  }
  let sigBound = false;
  function bindSignalRows() {
    if (sigBound) return; sigBound = true;
    const el = $("#signalList"); if (!el || !el.addEventListener) return;
    el.addEventListener("click", e => { const r = e.target && e.target.closest ? e.target.closest("[data-id]") : null; if (r && r.dataset.id) openModal(+r.dataset.id); });
  }

  function render(keepScroll) {
    const s = state.snap; if (!s) return;
    invalidateScrollCaches();
    const y = keepScroll ? window.scrollY : null;
    $("#tagline").textContent = "Live integration readiness";
    renderBanner(s); renderSources(s.sources || []); renderMetrics(s.stats || {}); populateHero(s.stats || {}); populateEstate(s.stats || {});
    populateCatFilter(s.apps || []); renderCatbars(s.stats || {}); renderGradebars(s.apps || [], s.stats || {});
    renderTrendTabs(); renderTrend(); renderInsights(s.stats || {}); renderSignals();
    const cAll = $("#cntAll"), cOpp = $("#cntOpp");
    if (cAll && cAll.dataset) { cAll._numReg = null; cAll._numv = null; cAll.dataset.num = String((s.apps || []).length); cAll.textContent = cAll.dataset.num; }
    if (cOpp && cOpp.dataset) { const no = (s.apps || []).filter(a => opportunityScore(a) >= 0).length; cOpp._numReg = null; cOpp._numv = null; cOpp.dataset.num = String(no); cOpp.textContent = cOpp.dataset.num; }
    renderView(); renderChanges(s.changes || []); renderAnalytics(); scanBars(document); syncOpenDossier();
    if (viewOpen() === "intelligence") { try { renderAnalytics(); setIvPart(state.ivPart || "supply"); } catch (e) {} }
    if (viewOpen() === "methodology") { try { populateMethodology(); } catch (e) {} }
    setLive(state.live, s.refresh_running);
    setUnread(); renderAlerts(); renderCompareBar();
    scanNums(document);
    $("#updatedHint").textContent = "updated " + timeAgo(s.generated_at);
    $("#footTime").textContent = "Last snapshot " + (s.generated_at ? new Date(s.generated_at).toLocaleString() : "-");
    state.firstRender = false;
    if (keepScroll && y != null) window.scrollTo(0, y);
  }

  function renderBanner(s) {
    const el = $("#modeBanner");
    if (!state.live) el.innerHTML = `<div class="banner snap">${svg("bolt", 2)}<div><b>Snapshot mode.</b> The live backend isn't reachable, so this is the <b>last real fetch</b> (${esc(s.generated_at ? new Date(s.generated_at).toLocaleString() : "unknown")}). Run <code class="mono">uvicorn src.app:app</code> for live streaming, on-demand refresh and endpoint probes.</div></div>`;
    else el.innerHTML = `<div class="banner">${svg("bolt", 2)}<div><b>Live.</b> ${esc(s.note || "")}</div></div>`;
  }
  function renderSources(sources) {
    const okc = sources.filter(s => s.reachable).length;
    $("#statusPill").title = sources.map(s => `${s.name}: ${s.reachable ? "up" : "down"}${s.latency_ms != null ? " (" + s.latency_ms + "ms)" : ""}`).join("\n") || "no source data";
    $("#liveTxt").dataset.sources = okc + "/" + sources.length;
  }

  function renderMetrics(st) {
    const hist = (state.snap && state.snap.history) || [];
    const prev = hist.length > 1 ? hist[hist.length - 2] : null;
    const responded = (st.open_endpoints || 0) + (st.auth_gated_endpoints || 0);
    const rows = [
      ["Applications", st.total_apps ?? 0, null, false, "#apps"],
      ["MCP servers", st.total_mcp_servers ?? 0, prev ? prev.servers : null, false, "signals"],
      ["Official servers", st.mcp_vendor_official ?? 0, prev ? prev.official : null, false, "vendor_official"],
      ["Community servers", st.mcp_community ?? 0, prev ? prev.community : null, false, "community"],
      ["No MCP detected", st.mcp_none ?? 0, prev ? prev.none : null, true, "none"],
      ["Live endpoints", responded, prev ? prev.responding : null, false, "trends"],
    ];
    const delta = (cur, pv, invert) => {
      if (pv == null) return `<span class="cov-delta flat">-</span>`;
      const d = cur - pv;
      if (d === 0) return `<span class="cov-delta flat">0</span>`;
      const good = invert ? d < 0 : d > 0;
      return `<span class="cov-delta ${good ? "up" : "down"}">${d > 0 ? "+" : ""}${d}</span>`;
    };
    $("#metrics").innerHTML = `<table class="cov-table"><thead><tr>
        <th>Metric</th><th class="num">Current</th><th class="num">Change</th></tr></thead><tbody>${
      rows.map(r => `<tr class="cov-link" data-goto="${r[4]}" title="Click to explore"><td class="cov-name">${r[0]}</td><td class="cov-val" data-num="${r[1] ?? 0}" data-nk="cov:${esc(r[0])}">${(r[1] ?? 0).toLocaleString()}</td><td class="num">${delta(r[1], r[2], r[3])}</td></tr>`).join("")
    }</tbody></table>`;
    scanNums($("#metrics"));
    bindMetrics();
  }
  let metricsBound = false;
  function bindMetrics() {
    if (metricsBound) return; metricsBound = true;
    const el = $("#metrics"); if (!el || !el.addEventListener) return;
    el.addEventListener("click", e => {
      const tr = e.target && e.target.closest ? e.target.closest("[data-goto]") : null;
      const g = tr && tr.dataset ? tr.dataset.goto : ""; if (!g) return;
      if (g === "signals" || g === "trends") {
        const t = document.getElementById(g);
        if (t && t.scrollIntoView) t.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      if (g === "analytics" || g === "landscape") { openView("intelligence"); return; }
      if (String(g).charAt(0) === "#") { const t = document.querySelector(g); if (t && t.scrollIntoView) t.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
      state.status = g; state.view = "explorer";
      $$("#statusChips .chipfilter").forEach(x => x.classList.toggle("active", x.dataset.status === g));
      renderView();
      const t = $("#apps"); if (t && t.scrollIntoView) t.scrollIntoView({ behavior: "smooth", block: "start" });
      toast(g === "none" ? "Showing apps with no MCP server yet" : `Filtered to ${STATUS_LABEL[g] || g} MCP servers`, "apps");
    });
  }

  function populateCatFilter(apps) {
    const sel = $("#catFilter"), cats = Array.from(new Set(apps.map(a => a.app.category))).sort();
    if (sel.options.length - 1 === cats.length) return;
    sel.innerHTML = `<option value="">All categories</option>` + cats.map(c => `<option value="${esc(c)}"${c === state.cat ? " selected" : ""}>${esc(c)}</option>`).join("");
  }
  function renderCatbars(st) {
    const bc = st.by_category || {};
    if (sigUnchanged("catbars", Object.entries(bc).map(([k, c]) => k + (c.apps || 0) + (c.vendor_official || 0) + (c.community || 0)).join(","))) return;
    $("#catbars").innerHTML = Object.entries(bc).map(([cat, c]) => {
      const t = c.apps || 1, o = (c.vendor_official || 0) / t * 100, cm = (c.community || 0) / t * 100, n = 100 - o - cm;
      const covered = Math.round(o + cm);
      return `<div class="bar-row cat-link" data-cat="${esc(cat)}" title="${c.vendor_official || 0} official · ${c.community || 0} community · ${c.none || 0} none · avg readiness ${c.avg_readiness ?? 0} · click to filter"><div class="bar-top"><span>${esc(cat)}</span><b data-num="${covered}" data-fmt="pct" data-nk="covpct:${esc(cat)}">${covered}%</b></div>
        <div class="bar-track"><i class="o" style="width:${o}%"></i><i class="c" style="width:${cm}%"></i><i class="n" style="width:${n}%"></i></div></div>`;
    }).join("") || `<div class="empty">No data yet.</div>`;
    bindCatbars();
  }
  let catbarsBound = false;
  function bindCatbars() {
    if (catbarsBound) return; catbarsBound = true;
    const el = $("#catbars"); if (!el || !el.addEventListener) return;
    el.addEventListener("click", e => { const r = e.target && e.target.closest ? e.target.closest("[data-cat]") : null; if (r && r.dataset.cat) filterToCategory(r.dataset.cat); });
  }
  function renderGradebars(apps, st) {
    const arEl = $("#avgReadiness");
    if (arEl) { const av = st.avg_readiness;
      if (av == null || av === "") { arEl.textContent = "-"; }
      else { arEl.dataset.num = String(Math.round(Number(av) * 10) || 0); arEl.dataset.fmt = "dec1"; scanNums(arEl); } }
    const grades = ["A", "B", "C", "D", "E"], counts = { A: 0, B: 0, C: 0, D: 0, E: 0 };
    apps.forEach(a => { const g = a.readiness && a.readiness.grade; if (g in counts) counts[g]++; });
    if (sigUnchanged("gradebars", grades.map(g => counts[g]).join(",") + "|" + st.avg_readiness)) return;
    const max = Math.max(1, ...Object.values(counts));
    const desc = { A: "80-100 · ready now", B: "60-79 · strong", C: "40-59 · partial", D: "20-39 · early", E: "0-19 · minimal" };
    const col = { A: "#34d399", B: "#5b8cff", C: "#fbbf24", D: "#ff8a4d", E: "#fb7185" };
    $("#gradebars").innerHTML = grades.map(g => `<div class="bar-row glink${state.grade === g ? " sel" : ""}" data-g="${g}" role="button" tabindex="0" title="Grade ${g}: ${counts[g]} apps · click to filter the explorer">
      <div class="bar-top"><span><span class="grade ${g}" style="display:inline-grid;width:20px;height:20px;font-size:11px;vertical-align:-5px;margin-right:7px">${g}</span>${desc[g]}</span><b data-num="${counts[g]}">${counts[g]}</b></div>
      <div class="bar-track"><i style="width:${counts[g] / max * 100}%;background:${col[g]}"></i></div></div>`).join("");
    bindGradebars();
  }
  let gradebarsBound = false;
  function bindGradebars() {
    if (gradebarsBound) return; const el = $("#gradebars");
    if (!el || !el.addEventListener) return; gradebarsBound = true;
    const hit = (e) => { const r = e.target && e.target.closest ? e.target.closest("[data-g]") : null;
      if (!r || !r.dataset || !r.dataset.g) return;
      state.grade = state.grade === r.dataset.g ? "" : r.dataset.g; state.view = "explorer";
      renderView(); renderGradebars((state.snap && state.snap.apps) || [], (state.snap && state.snap.stats) || {});
      markGradeSel(); gotoApps(state.grade ? `Filtered to grade ${state.grade}` : "Grade filter cleared"); };
    el.addEventListener("click", hit);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") hit(e); });
  }

  /* ---------------- trend chart (real time-series) ---------------- */
  const METRICS = {
    official: { label: "Official MCP", get: h => h.official, fmt: v => Math.round(v).toLocaleString() },
    community: { label: "Community MCP", get: h => h.community, fmt: v => Math.round(v).toLocaleString() },
    tools: { label: "Live tools", get: h => h.tools, fmt: v => fmtNum(Math.round(v)) },
    downloads: { label: "Downloads/mo", get: h => h.downloads, fmt: v => fmtNum(Math.round(v)) },
    stars: { label: "Repo stars", get: h => h.stars, fmt: v => fmtNum(Math.round(v)) },
    readiness: { label: "Avg readiness", get: h => h.avg_readiness, fmt: v => (+v).toFixed(1) },
    sites: { label: "Sites online", get: h => h.responding, fmt: v => Math.round(v).toLocaleString() },
  };
  function renderTrendTabs() {
    const el = $("#trendTabs"); if (!el) return;
    el.innerHTML = Object.entries(METRICS).map(([k, m]) =>
      `<button data-metric="${k}" class="${state.trendMetric === k ? "active" : ""}">${m.label}</button>`).join("");
    $$("#trendTabs button").forEach(b => b.onclick = () => { state.trendMetric = b.dataset.metric; renderTrendTabs(); renderTrend(); });
  }
  let trendSig = "";
  function renderTrend(force) {
    const hist = (state.snap && state.snap.history) || [];
    const wrap = $("#chart"); if (!wrap) return;
    const M = METRICS[state.trendMetric] || METRICS.official;
    /* While you are watching, an auto-refresh that changes nothing the chart
       plots must leave the graph perfectly still (no re-draw, no re-pop). */
    const sig = state.trendMetric + "|" + hist.map(h => M.get(h)).join(",") + "|" + (wrap.clientWidth || 0);
    if (!force && sig === trendSig && wrap.firstChild) return;
    trendSig = sig;
    $("#trendTitle").textContent = M.label + " over time";
    if (!hist.length) { $("#trendHint").textContent = ""; wrap.innerHTML = `<div class="chart-empty">No history yet; it builds with each live refresh.</div>`; return; }
    $("#trendHint").textContent = hist.length + " point" + (hist.length > 1 ? "s" : "") + " · real snapshots";
    const W = Math.max(320, wrap.clientWidth || 760), H = wrap.clientHeight || 288;
    const pad = { l: 52, r: 22, t: 22, b: 30 }, iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const vals = hist.map(M.get);
    let mn = Math.min(...vals), mx = Math.max(...vals);
    if (mn === mx) { const d = Math.abs(mx) * 0.15 || 1; mn -= d; mx += d; }
    const rng = (mx - mn) || 1; mn = Math.max(0, mn - rng * 0.25); mx = mx + rng * 0.2;
    const X = i => hist.length === 1 ? pad.l + iw / 2 : pad.l + (i / (hist.length - 1)) * iw;
    const Y = v => pad.t + ih - ((v - mn) / ((mx - mn) || 1)) * ih;
    const fmtD = ts => { const d = new Date(ts); return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };
    let grid = "", ylab = "";
    for (let g = 0; g <= 3; g++) { const v = mn + (mx - mn) * g / 3, yy = Y(v);
      grid += `<line class="ct-grid" x1="${pad.l}" y1="${yy.toFixed(1)}" x2="${pad.l + iw}" y2="${yy.toFixed(1)}"/>`;
      ylab += `<text class="ct-lab val" x="${pad.l - 9}" y="${(yy + 3).toFixed(1)}" text-anchor="end">${M.fmt(v)}</text>`; }
    let xlab = hist.length > 1
      ? `<text class="ct-lab" x="${pad.l}" y="${H - 9}">${fmtD(hist[0].ts)}</text><text class="ct-lab" x="${pad.l + iw}" y="${H - 9}" text-anchor="end">${fmtD(hist[hist.length - 1].ts)}</text>`
      : `<text class="ct-lab" x="${pad.l + iw / 2}" y="${H - 9}" text-anchor="middle">${fmtD(hist[0].ts)}</text>`;
    const pts = vals.map((v, i) => [X(i), Y(v)]);
    let line = "", area = "";
    if (pts.length > 1) {
      line = "M" + pts.map(p => p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" L ");
      area = line + ` L ${pts[pts.length - 1][0].toFixed(1)} ${(pad.t + ih).toFixed(1)} L ${pts[0][0].toFixed(1)} ${(pad.t + ih).toFixed(1)} Z`;
    }
    const dots = pts.map(p => `<circle class="ct-dot" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4"/>`).join("");
    const single = pts.length === 1 ? `<circle class="ct-single" cx="${pts[0][0].toFixed(1)}" cy="${pts[0][1].toFixed(1)}" r="6.5"/>` : "";
    const hitw = pts.length > 1 ? iw / (pts.length - 1) : iw;
    const hits = pts.map((p, i) => `<rect class="ct-hit" data-i="${i}" x="${(p[0] - hitw / 2).toFixed(1)}" y="${pad.t}" width="${hitw.toFixed(1)}" height="${ih}"/>`).join("");
    wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="none">
        <defs><linearGradient id="ctgrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#5b8cff" stop-opacity="0.34"/><stop offset="1" stop-color="#5b8cff" stop-opacity="0"/></linearGradient></defs>
        ${grid}<line class="ct-axis" x1="${pad.l}" y1="${pad.t + ih}" x2="${pad.l + iw}" y2="${pad.t + ih}"/>${ylab}${xlab}
        ${area ? `<path class="ct-area" d="${area}" fill="url(#ctgrad)"/>` : ""}
        ${line ? `<path class="ct-line" d="${line}"/>` : ""}${single}${dots}${hits}
      </svg><div class="chart-tip" id="chartTip"></div>`;
    const tip = $("#chartTip");
    $$("#chart .ct-hit").forEach(h => h.addEventListener("mousemove", () => {
      const i = +h.dataset.i, p = pts[i];
      tip.innerHTML = `<span class="tt-v">${M.fmt(vals[i])}</span><span class="tt-t">${fmtD(hist[i].ts)}</span>`;
      tip.style.left = p[0] + "px"; tip.style.top = p[1] + "px"; tip.classList.add("show");
      $$("#chart .ct-dot").forEach((d, di) => d.setAttribute("r", di === i ? 6 : 4));
    }));
    wrap.onmouseleave = () => { tip.classList.remove("show"); $$("#chart .ct-dot").forEach(d => d.setAttribute("r", 4)); };
  }

  /* ---------------- landscape analytics (v14) ----------------
     Every figure is computed in the browser from the live snapshot: registry
     classifications, repository metadata, package downloads, endpoint probes
     and liveness checks. Nothing is estimated and nothing is hardcoded. */
  const COMP_META = [
    ["official_mcp", "Official MCP", "#34D399"],
    ["capability", "Live capability", "#22D3EE"],
    ["adoption", "Adoption", "#A78BFA"],
    ["popularity", "Popularity", "#60A5FA"],
    ["maintenance", "Maintenance", "#FBBF24"],
    ["availability", "Availability", "#FB923C"],
  ];
  function anSetN(id, v) {
    /* Only publish the new target. The value memo (keyed by the element id)
       decides whether this is a first sight (roll from 0) or a live tick
       (roll prev -> new). Resetting _numv here was what made the instruments
       re-juggle from zero on every refresh. */
    const e = $(id); if (!e || !e.dataset) return;
    e.dataset.num = String(Math.round(Number(v) || 0));
  }
  /* Live line graphs for the three intelligence sections, drawn from the
     real refresh history. Redrawn only when a new point lands, so they update
     in front of your eyes on every refresh without replaying pointlessly. */
  let sparkSig = "";
  function sparkSvg(hist, series) {
    const W = 560, H = 74, padL = 4, padR = 4, padT = 8, padB = 8;
    const iw = W - padL - padR, ih = H - padT - padB;
    const n = hist.length;
    const X = i => n === 1 ? padL + iw / 2 : padL + (i / (n - 1)) * iw;
    let out = "";
    series.forEach((sr, si) => {
      const vals = hist.map(sr.get);
      let mn = Math.min(...vals), mx = Math.max(...vals);
      if (mn === mx) { mn -= 1; mx += 1; }
      const Y = v => padT + ih - ((v - mn) / (mx - mn)) * ih;
      const pts = vals.map((v, i) => [X(i), Y(v)]);
      const line = "M" + pts.map(p => p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" L ");
      const area = si === 0
        ? line + ` L ${pts[pts.length - 1][0].toFixed(1)} ${(padT + ih).toFixed(1)} L ${pts[0][0].toFixed(1)} ${(padT + ih).toFixed(1)} Z`
        : "";
      const last = pts[pts.length - 1];
      out += `${area ? `<path d="${area}" fill="${sr.color}" opacity="0.10"/>` : ""}
        <path d="${line}" fill="none" stroke="${sr.color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" class="ivs-line"/>
        <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3.2" fill="${sr.color}" class="ivs-dot"/>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" role="img" aria-label="history sparkline">${out}</svg>`;
  }
  function renderIntelSparks() {
    const hist = (state.snap && state.snap.history) || [];
    const box = $("#sparkSupply"); if (!box) return;
    const sig = hist.map(p => p.ts).join(",");
    const last = hist[hist.length - 1] || {};
    const put = (id, v, fmt) => { const e = $(id); if (!e) return; e.dataset.num = String(v == null ? 0 : v); if (fmt) e.dataset.fmt = fmt; };
    put("#spkOff", last.official); put("#spkCom", last.community);
    put("#spkTools", last.tools); put("#spkResp", last.responding);
    put("#spkDl", last.downloads, "k"); put("#spkStars", last.stars, "k");
    if (sig === sparkSig) { scanNums($("#intelligenceView")); return; }
    sparkSig = sig;
    if (hist.length < 2) {
      const msg = `<div class="ivs-empty">the line builds as refreshes land - one point so far</div>`;
      $("#sparkSupply").innerHTML = msg; $("#sparkHealth").innerHTML = msg; $("#sparkAdoption").innerHTML = msg;
      scanNums($("#intelligenceView"));
      return;
    }
    $("#sparkSupply").innerHTML = sparkSvg(hist, [
      { get: p => p.official, color: "#34D399" }, { get: p => p.community, color: "#A78BFA" }]);
    $("#sparkHealth").innerHTML = sparkSvg(hist, [
      { get: p => p.tools, color: "#22D3EE" }, { get: p => p.responding, color: "#FBBF24" }]);
    $("#sparkAdoption").innerHTML = sparkSvg(hist, [
      { get: p => p.downloads, color: "#5B8CFF" }, { get: p => p.stars, color: "#F59E0B" }]);
    scanNums($("#intelligenceView"));
  }

  function renderAnalytics() {
    const s = state.snap; if (!s) return;
    const apps = s.apps || []; if (!apps.length) return;
    const st = s.stats || {};
    if (sigUnchanged("analytics", [st.total_mcp_servers, st.mcp_vendor_official, st.mcp_community, st.mcp_none,
        st.total_tools, st.open_endpoints, st.auth_gated_endpoints, st.generic_gateways, st.total_downloads,
        st.github_repos_found, st.total_stars, st.maintained_repos, st.avg_readiness, st.probed_endpoints,
        st.websites_reachable, (s.history || []).length, (((s.history || []).slice(-1)[0]) || {}).ts
        ].join("|"))) { return; }
    anSetN("#anNAvg", (Number(st.avg_readiness) || 0) * 10);
    anSetN("#anNServers", st.total_mcp_servers);
    anSetN("#anNRepos", st.github_repos_found);
    anSetN("#anNTools", st.total_tools);
    renderAnScore(apps, st); renderAnProv(apps); renderAnFresh(apps); renderAnScatter(apps); renderAnProbe(apps, st);
    const up = $("#anUpdated"); if (up) up.textContent = `computed in-browser from the live snapshot · ${timeAgo(s.generated_at)}`;
    bindAnalytics(); markGradeSel(); renderIntelSparks(); scanNums($("#intelligenceView")); scanBars($("#intelligenceView"));
  }
  function renderAnScore(apps, st) {
    const el = $("#anScoreBody"); if (!el) return;
    const sum = {}, wmap = {}; let counted = 0;
    apps.forEach(a => {
      const cs = a.readiness && a.readiness.components; if (!cs) return; counted++;
      COMP_META.forEach(([k]) => { const c = cs[k]; if (!c) return;
        sum[k] = (sum[k] || 0) + (Number(c.score) || 0); wmap[k] = Number(c.weight) || 0; });
    });
    const rows = COMP_META.map(([k, l, c]) => {
      const avg = counted ? (sum[k] || 0) / counted : 0;
      return { k, l, c, avg, w: wmap[k] || 0, contrib: avg * (wmap[k] || 0) * 100 };
    });
    if (!rows.length) { el.innerHTML = ""; return; }
    const maxC = Math.max(0.001, ...rows.map(r => r.contrib));
    const weakest = rows.slice().sort((x, y) => x.avg - y.avg)[0];
    el.innerHTML = rows.map((r, i) => `
      <div class="an-frow" style="--i:${i}" title="${esc(r.l)}: average attainment ${Math.round(r.avg * 100)}% · model weight ${Math.round(r.w * 100)}% · contributes ${r.contrib.toFixed(1)} points">
        <span class="an-fl">${esc(r.l)}<em>w ${Math.round(r.w * 100)}%</em></span>
        <span class="an-ftrack"><i style="width:${Math.round(r.contrib / maxC * 100)}%;background:${r.c}"></i></span>
        <b class="an-fn" data-num="${Math.round(r.contrib * 10)}" data-fmt="dec1">${r.contrib.toFixed(1)}</b></div>`).join("") +
      `<div class="an-note">points each signal contributes to the landscape average of <b>${(Number(st.avg_readiness) || 0).toFixed(1)}</b> / 100 · weakest link: ${esc(weakest.l)} at ${Math.round(weakest.avg * 100)}% average attainment</div>`;
  }
  function renderAnProv(apps) {
    const el = $("#anProvBody"); if (!el) return;
    const pc = { vendor_official: 0, community: 0, none: 0 };
    apps.forEach(a => { const m = a.mcp && a.mcp.status; if (m in pc) pc[m]++; });
    const totalN = apps.length, total = Math.max(1, totalN);
    const segs = [["vendor_official", "Official", pc.vendor_official, "#34D399"],
                  ["community", "Community", pc.community, "#A78BFA"],
                  ["none", "No server yet", pc.none, "#94A3B8"]];
    const sig = segs.map(s => s[2]).join(",") + "/" + totalN;
    /* Nothing moved: leave the DOM (and its already-settled animation) alone. */
    if (el.dataset.sig === sig) return;
    const R = 52, C = 2 * Math.PI * R;
    const live = segs.filter(s => s[2] > 0);
    const existing = el.querySelectorAll(".an-seg");
    if (el.dataset.sig && existing.length === live.length) {
      /* Same shape, new numbers: slide the segments and tick the counters. */
      let start = 0;
      live.forEach(([k, l, v, c], i) => {
        const frac = v / total, len = Math.max(0.001, frac * C - 3);
        existing[i].setAttribute("stroke-dasharray", `${len.toFixed(1)} ${(C - len).toFixed(1)}`);
        existing[i].setAttribute("stroke-dashoffset", (-start * C).toFixed(1));
        const tt = existing[i].querySelector("title");
        if (tt) tt.textContent = `${l}: ${v} of ${totalN} apps`;
        start += frac;
      });
      segs.forEach(([k, l, v, c]) => {
        const row = el.querySelector(`.an-lg[data-v="${k}"]`); if (!row) return;
        /* only publish new targets; the memoised scanNums() pass at the end of
           renderAnalytics() does the single prev -> new roll */
        const n = row.querySelector(".an-lgn");
        if (n) n.dataset.num = String(v);
        const pp = row.querySelector(".an-lgp");
        if (pp) pp.dataset.num = String(Math.round(v / total * 100));
      });
      const dc = el.querySelector(".an-dc b");
      if (dc) dc.dataset.num = String(totalN);
      el.dataset.sig = sig;
      return;
    }
    let start = 0;
    const circles = live.map(([k, l, v, c], i) => {
      const frac = v / total, len = Math.max(0.001, frac * C - 3);
      const out = `<circle class="an-seg" cx="60" cy="60" r="${R}" fill="none" stroke="${c}" stroke-width="13" stroke-linecap="round"
        stroke-dasharray="${len.toFixed(1)} ${(C - len).toFixed(1)}" stroke-dashoffset="${(-start * C).toFixed(1)}"
        data-act="status" data-v="${k}" style="--i:${i}"><title>${esc(l)}: ${v} of ${totalN} apps</title></circle>`;
      start += frac; return out;
    }).join("");
    el.innerHTML = `<div class="an-donutwrap">
        <svg class="an-donut" viewBox="0 0 120 120" width="148" height="148" role="img" aria-label="Server provenance donut"><g transform="rotate(-90 60 60)">${circles}</g></svg>
        <div class="an-dc"><b data-num="${totalN}" data-nk="an:total">${totalN}</b><span>apps</span></div>
      </div>
      <div class="an-legend">${segs.map(([k, l, v, c]) => `
        <button class="an-lg" type="button" data-act="status" data-v="${k}" title="Filter the explorer to ${esc(l)}">
          <span class="an-lgd" style="background:${c};color:${c}"></span><span class="an-lgl">${esc(l)}</span>
          <span class="an-lgn" data-num="${v}" data-nk="anl:${k}">${v}</span><span class="an-lgp" data-num="${Math.round(v / total * 100)}" data-fmt="pct" data-nk="anp:${k}">${Math.round(v / total * 100)}%</span></button>`).join("")}</div>`;
    el.dataset.sig = sig;
  }
  function renderAnFresh(apps) {
    const el = $("#anFreshBody"); if (!el) return;
    const now = Date.now(), b = [0, 0, 0, 0, 0];
    apps.forEach(a => {
      const p = a.github && a.github.pushed_at, t = p ? new Date(p).getTime() : NaN;
      if (!t || isNaN(t)) { b[4]++; return; }
      const d = (now - t) / 864e5;
      if (d <= 30) b[0]++; else if (d <= 90) b[1]++; else if (d <= 365) b[2]++; else b[3]++;
    });
    const rows = [["Commit ≤ 30 days", b[0], "#34D399"], ["31 to 90 days", b[1], "#A3E635"],
      ["91 to 365 days", b[2], "#FBBF24"], ["Stale, over 1 year", b[3], "#FB7185"], ["No repo found", b[4], "#94A3B8"]];
    const max = Math.max(1, ...rows.map(r => r[1]));
    const repos = b[0] + b[1] + b[2] + b[3], fresh = b[0] + b[1];
    el.innerHTML = rows.map(([l, v, c], i) => `
      <div class="an-frow" style="--i:${i}" title="${esc(l)}: ${v} app${v === 1 ? "" : "s"}">
        <span class="an-fl">${esc(l)}</span>
        <span class="an-ftrack"><i style="width:${Math.round(v / max * 100)}%;background:${c}"></i></span>
        <b class="an-fn" data-num="${v}">${v}</b></div>`).join("") +
      `<div class="an-note">${fresh} of ${repos} discovered repos committed within 90 days · ${b[4]} apps expose no server repository</div>`;
  }
  let scatterSig = "";
  function renderAnScatter(apps, force) {
    const host = $("#anScatterBody"); if (!host) return;
    const pts = apps.map(a => ({ id: a.app.id, name: a.app.name, st: a.mcp.status, g: a.readiness.grade,
        dl: dlOf(a), stars: (a.github && a.github.stars) || 0 }))
      .filter(p => p.dl > 0 || p.stars > 0);
    const sig = pts.map(p => p.id + ":" + p.dl + ":" + p.stars).join(",") + "|" + (host.clientWidth || 0);
    if (!force && sig === scatterSig && host.firstChild) return;
    scatterSig = sig;
    const noData = Math.max(0, apps.length - pts.length);
    const note = $("#anScatterNote");
    if (note) note.textContent = noData ? `${noData} app${noData === 1 ? "" : "s"} show no adoption signal yet (no repo stars, no package downloads) and are not plotted.` : "";
    const W = Math.max(360, host.clientWidth || 680), H = 300;
    const pad = { l: 46, r: 16, t: 16, b: 34 }, iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const lg = v => (v > 0 ? Math.log10(v + 1) : 0);
    const maxD = pts.length ? Math.max(10, ...pts.map(p => p.dl)) : 10;
    const maxS = pts.length ? Math.max(10, ...pts.map(p => p.stars)) : 10;
    const LX = lg(maxD) || 1, LY = lg(maxS) || 1;
    const X = v => pad.l + 8 + (lg(v) / LX) * (iw - 16);
    const Y = v => pad.t + ih - 8 - (lg(v) / LY) * (ih - 16);
    const median = arr => { const a = arr.filter(v => v > 0).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };
    const md = median(pts.map(p => p.dl)), ms = median(pts.map(p => p.stars));
    const ticks = mx => [0, 10, 100, 1000, 10000, 100000, 1000000].filter(v => v <= mx * 1.5);
    let grid = "";
    ticks(maxS).forEach(v => { const y = Y(v);
      grid += `<line class="an-gx" x1="${pad.l}" y1="${y.toFixed(1)}" x2="${W - pad.r}" y2="${y.toFixed(1)}"/><text class="an-lb" x="${pad.l - 8}" y="${(y + 3).toFixed(1)}" text-anchor="end">${v === 0 ? "0" : fmtNum(v)}</text>`; });
    ticks(maxD).forEach(v => { const x = X(v);
      grid += `<text class="an-lb" x="${x.toFixed(1)}" y="${H - 12}" text-anchor="middle">${v === 0 ? "0" : fmtNum(v)}</text>`; });
    const meds = (md ? `<line class="an-med" x1="${X(md).toFixed(1)}" y1="${pad.t}" x2="${X(md).toFixed(1)}" y2="${(pad.t + ih).toFixed(1)}"/>` : "") +
      (ms ? `<line class="an-med" x1="${pad.l}" y1="${Y(ms).toFixed(1)}" x2="${(W - pad.r).toFixed(1)}" y2="${Y(ms).toFixed(1)}"/>` : "");
    const mx = md ? X(md) : pad.l + iw * .5;
    const quad = (md && ms) ? `
      <text class="an-ql" x="${((mx + W - pad.r) / 2).toFixed(0)}" y="${pad.t + 13}" text-anchor="middle">established</text>
      <text class="an-ql" x="${((pad.l + mx) / 2).toFixed(0)}" y="${pad.t + 13}" text-anchor="middle">community darlings</text>
      <text class="an-ql" x="${((mx + W - pad.r) / 2).toFixed(0)}" y="${(pad.t + ih - 8).toFixed(0)}" text-anchor="middle">quiet workhorses</text>
      <text class="an-ql" x="${((pad.l + mx) / 2).toFixed(0)}" y="${(pad.t + ih - 8).toFixed(0)}" text-anchor="middle">early</text>` : "";
    const dots = pts.map((p, i) => `<circle class="an-pt s-${esc(p.st)}" cx="${X(p.dl).toFixed(1)}" cy="${Y(p.stars).toFixed(1)}" r="4.6"
      data-act="app" data-v="${p.id}" style="--i:${Math.min(i, 45)}" data-n="${esc(p.name)}" data-d="${p.dl}" data-s="${p.stars}" data-g="${esc(p.g)}"><title>${esc(p.name)}</title></circle>`).join("");
    host.innerHTML = `<svg class="an-scatter" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Adoption scatter: repository stars versus monthly package downloads">
        ${grid}${meds}${quad}
        <line class="an-ax" x1="${pad.l}" y1="${pad.t + ih}" x2="${W - pad.r}" y2="${pad.t + ih}"/>
        <line class="an-ax" x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t + ih}"/>
        ${dots}
        <text class="an-lb" x="${W - pad.r}" y="${H - 1}" text-anchor="end">npm / PyPI downloads per month →</text>
        <text class="an-lb" x="${pad.l - 34}" y="${pad.t - 5}" text-anchor="start">↑ repo stars</text>
      </svg><div class="an-tip" id="anTip"></div>`;
    const tip = $("#anTip");
    $$(".an-pt", host).forEach(c => c.addEventListener("mousemove", () => {
      if (!tip || !tip.style) return;
      tip.innerHTML = `<span class="tt-v">${esc(c.dataset.n || "")}</span><span class="tt-t">★ ${fmtNum(+c.dataset.s || 0)} · ${fmtNum(+c.dataset.d || 0)}/mo · grade ${esc(c.dataset.g || "-")}</span>`;
      tip.style.left = (c.getAttribute("cx") || 0) + "px"; tip.style.top = (c.getAttribute("cy") || 0) + "px";
      tip.classList.add("show");
    }));
    host.onmouseleave = () => { if (tip && tip.classList) tip.classList.remove("show"); };
  }
  function renderAnProbe(apps, st) {
    const el = $("#anProbeBody"); if (!el) return;
    const probed = st.probed_endpoints || 0, open = st.open_endpoints || 0, gated = st.auth_gated_endpoints || 0, gw = st.generic_gateways || 0, tools = st.total_tools || 0;
    el.innerHTML = `<div class="an-stats">
        <div class="an-stat"><b data-num="${probed}">${probed}</b><span>endpoints probed</span></div>
        <div class="an-stat"><b data-num="${open}">${open}</b><span>open, tools listed</span></div>
        <div class="an-stat"><b data-num="${gated}">${gated}</b><span>auth-gated</span></div>
        <div class="an-stat"><b data-num="${gw}">${gw}</b><span>generic gateways</span></div>
      </div>
      <div class="an-sub">what the handshakes returned</div>
      <div class="an-note"><b>${tools}</b> live tools listed across <b>${open}</b> open endpoints · <b>${gated}</b> endpoints refused without credentials · <b>${gw}</b> shared gateways excluded from app-specific counts.</div>`;
    renderAnLatency(apps, st);
  }
  function renderAnLatency(apps, st) {
    const el = $("#anLatBody"); if (!el) return;
    const lat = apps.map(a => a.liveness && a.liveness.latency_ms).filter(v => v != null && v > 0);
    const lb = [0, 0, 0, 0];
    lat.forEach(v => { if (v < 250) lb[0]++; else if (v < 750) lb[1]++; else if (v < 1500) lb[2]++; else lb[3]++; });
    const rows = [["Under 250 ms", lb[0], "#34D399"], ["250 to 750 ms", lb[1], "#A3E635"],
      ["750 ms to 1.5 s", lb[2], "#FBBF24"], ["Over 1.5 s", lb[3], "#FB7185"]];
    const maxL = Math.max(1, ...rows.map(r => r[1]));
    const medLat = st.median_latency_ms != null ? st.median_latency_ms
      : (lat.length ? lat.slice().sort((x, y) => x - y)[Math.floor(lat.length / 2)] : null);
    anSetN("#anNLat", medLat != null ? medLat : 0);
    el.innerHTML = rows.map(([l, v, c], i) => `<div class="an-frow" style="--i:${i}" title="${esc(l)}: ${v} site${v === 1 ? "" : "s"}">
        <span class="an-fl">${esc(l)}</span><span class="an-ftrack"><i style="width:${Math.round(v / maxL * 100)}%;background:${c}"></i></span>
        <b class="an-fn" data-num="${v}">${v}</b></div>`).join("");
    const note = $("#anLatNote");
    if (note) note.textContent = `${lat.length} live vendor-site checks · median ${medLat != null ? medLat + " ms" : "unknown"}`;
  }
  let anBound = false;
  function bindAnalytics() {
    if (anBound) return; const grid = $("#intelligenceView");
    if (!grid || !grid.addEventListener) return; anBound = true;
    const act = (e) => {
      const t = e.target && e.target.closest ? e.target.closest("[data-act]") : null;
      if (!t || !t.dataset) return false;
      const kind = t.dataset.act, v = t.dataset.v;
      if (kind === "app") { openModal(+v); return true; }
      if (kind === "grade") {
        state.grade = state.grade === v ? "" : v; state.view = "explorer";
        renderView(); renderGradebars((state.snap && state.snap.apps) || [], (state.snap && state.snap.stats) || {});
        markGradeSel(); gotoApps(state.grade ? `Filtered to grade ${state.grade}` : "Grade filter cleared"); return true;
      }
      if (kind === "status") {
        state.status = v; state.view = "explorer";
        $$("#statusChips .chipfilter").forEach(x => x.classList.toggle("active", x.dataset.status === v));
        renderView(); gotoApps(`Filtered to ${esc(STATUS_LABEL[v] || v)} servers`); return true;
      }
      return false;
    };
    grid.addEventListener("click", act);
    grid.addEventListener("keydown", (e) => { if (e.key === "Enter") { if (act(e)) e.preventDefault(); } });
  }
  function markGradeSel() {
    $$(".glink[data-g]").forEach(el => { if (el && el.classList) el.classList.toggle("sel", !!state.grade && el.dataset.g === state.grade); });
  }
  function gotoApps(msg) {
    if (viewOpen()) closeView();
    requestAnimationFrame(() => {
      const t = $("#apps"); if (t && t.scrollIntoView) t.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    if (msg) toast(msg, "apps");
  }
  /* v14: the grade cross-filter always shows a dismissible chip so a filter
     applied from the analytics can never become invisible */
  function syncGradeChip() {
    const wrap = $("#statusChips"); if (!wrap) return;
    let c = $("#gradeChip");
    if (state.grade) {
      if (!c || !c.parentNode) { c = document.createElement("span"); c.id = "gradeChip"; wrap.appendChild(c); }
      c.className = "chipfilter active gchip";
      c.title = "Clear the grade filter";
      c.innerHTML = `Grade ${esc(state.grade)} <b aria-hidden="true">✕</b>`;
      c.onclick = () => { state.grade = ""; renderView(); };
    } else if (c && c.parentNode && c.remove) c.remove();
  }

  /* ---------------- views ---------------- */
  function renderView() {
    const apps = state.snap.apps || [];
    $$("#viewTabs button").forEach(b => b.classList.toggle("active", b.dataset.view === state.view));
    syncDrawerView(); syncGradeChip();
    $("#statusChips").style.display = state.view === "explorer" ? "" : "none";
    if (state.view === "explorer") renderExplorer(apps);
    else if (state.view === "leaderboard") renderLeaderboard(apps);
    else renderOpportunities(apps);
    scanNums($("#viewContent")); scanBars($("#viewContent"));
  }
  function match(a) {
    if (state.cat && a.app.category !== state.cat) return false;
    if (state.status && a.mcp.status !== state.status) return false;
    if (state.grade && (!a.readiness || a.readiness.grade !== state.grade)) return false;
    if (state.q) { const q = state.q.toLowerCase(); if (!(a.app.name.toLowerCase().includes(q) || a.app.category.toLowerCase().includes(q))) return false; }
    return true;
  }
  function toolsHtml(a) {
    if (a.tools_count) return `<span class="tools">${svg("tools", 2)} ${a.tools_count}${a.generic_gateway ? ` <span class="tag gen">gateway</span>` : ""}</span>`;
    if (a.auth_gated) return `<span class="tools"><span class="tag gated">auth</span></span>`;
    return `<span class="mut">-</span>`;
  }
  function siteHtml(a) {
    const lv = a.liveness; if (!lv) return `<span class="site na"><span class="led"></span>-</span>`;
    if (!lv.responded) return `<span class="site down" title="no response"><span class="led"></span>down</span>`;
    return `<span class="site ${lv.reachable ? "up" : "warn"}" title="${lv.reachable ? "reachable" : "responded " + lv.status_code}"><span class="led"></span>${lv.status_code ?? "?"}</span>`;
  }

  const viewSig = {};
  function sigUnchanged(key, sig) { if (viewSig[key] === sig) return true; viewSig[key] = sig; return false; }
  const rowSig = (a) => a.app.id + ":" + a.readiness.score + ":" + (a.tools_count || 0) + ":" + dlOf(a) +
    ":" + ((a.github && a.github.stars) || 0) + ":" + (a.liveness ? a.liveness.status_code : "") + ":" + a.mcp.status;

  function renderExplorer(apps) {
    $("#viewTitle").innerHTML = svg("apps") + ` Apps <span class="hint" id="countHint" style="margin-left:6px"></span>`;
    let rows = apps.filter(match);
    const sig = ["x", state.sortKey, state.sortDir, state.compare.join("."), rows.map(rowSig).join(",")].join("|");
    if (sigUnchanged("explorer", sig)) { bindRows(); return; }
    const k = state.sortKey, dir = state.sortDir;
    const val = (a) => ({ name: a.app.name.toLowerCase(), status: { vendor_official: 0, community: 1, unknown: 2, none: 3, pending: 4 }[a.mcp.status] ?? 5,
      readiness: a.readiness.score || 0, tools: a.tools_count || 0, downloads: dlOf(a), stars: (a.github && a.github.stars) || 0,
      site: a.liveness ? (a.liveness.reachable ? 0 : a.liveness.responded ? 1 : 2) : 3 }[k]);
    rows.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
    $("#countHint").textContent = `${rows.length} / ${apps.length}`;
    const cols = [["name", "Application", ""], ["status", "MCP", ""], ["readiness", "Readiness", ""], ["tools", "Live tools", "right"], ["downloads", "Adoption", "right"], ["stars", "Repository", "right"], ["site", "Liveness", ""]];
    $("#viewContent").innerHTML = `<div class="tablewrap"><table class="grid"><thead><tr>${cols.map(c =>
      `<th data-sort="${c[0]}" class="${state.sortKey === c[0] ? "sorted" : ""}" style="${c[2] ? "text-align:right" : ""}">${c[1]}<span class="arw">${state.sortKey === c[0] ? (dir > 0 ? "▲" : "▼") : "▲"}</span></th>`).join("")}</tr></thead>
      <tbody>${rows.map(a => {
        const gh = a.github && a.github.status === "found" && a.github.stars != null ? `<span class="stars">${svg("star", 2)} <b data-num="${a.github.stars}" data-fmt="k" data-nk="app:${a.app.id}:stars">${fmtNum(a.github.stars)}</b></span>` : `<span class="mut">-</span>`;
        const dl = dlOf(a);
        const rtitle = `Readiness ${a.readiness.score}/100 · grade ${a.readiness.grade} · open the app for the component breakdown & evidence`;
        return `<tr data-id="${a.app.id}">
          <td><div class="appcell">${logoHtml(a)}<div class="appmeta"><div class="appname">${esc(a.app.name)}</div><div class="appcat">${esc(a.app.category)}</div></div>
            <button class="cmpbtn ${state.compare.includes(a.app.id) ? "on" : ""}" data-cmp="${a.app.id}" title="Add to compare" style="margin-left:auto">${state.compare.includes(a.app.id) ? "✓" : "+"}</button></div></td>
          <td data-label="MCP">${statusBadge(a.mcp.status)}</td>
          <td data-label="Readiness"><span class="score" title="${esc(rtitle)}"><span class="snum" data-num="${a.readiness.score}" data-nk="app:${a.app.id}:readiness">${a.readiness.score}</span><span class="sbar"><i data-bar="${a.readiness.score}" data-nk="app:${a.app.id}:bar" style="width:${a.readiness.score}%"></i></span><span class="grade ${esc(a.readiness.grade)}">${esc(a.readiness.grade)}</span></span></td>
          <td data-label="Live tools" style="text-align:right">${toolsHtml(a)}</td>
          <td data-label="Adoption" style="text-align:right">${dl ? `<span class="dl"><b data-num="${dl}" data-fmt="k" data-nk="app:${a.app.id}:dl">${fmtNum(dl)}</b>/mo</span>` : `<span class="mut">-</span>`}</td>
          <td data-label="Repository" style="text-align:right">${gh}</td>
          <td data-label="Liveness">${siteHtml(a)}</td></tr>`;
      }).join("") || `<tr><td colspan="7"><div class="empty" style="padding:30px;text-align:center">No apps match those filters.</div></td></tr>`}</tbody></table></div>`;
    bindRows(); bindSort();
  }

  function renderLeaderboard(apps) {
    $("#viewTitle").innerHTML = svg("gauge") + ` Readiness leaderboard`;
    let rows = apps.filter(match).slice().sort((x, y) => y.readiness.score - x.readiness.score);
    if (sigUnchanged("lb", ["l", state.compare.join("."), rows.map(rowSig).join(",")].join("|"))) { bindRows(); return; }
    $("#viewContent").innerHTML = `<div class="tablewrap lbwrap"><div class="lb">${rows.map((a, i) => `
      <div class="lb-row" data-id="${a.app.id}" data-rank="${i + 1}">
        <div class="lb-rank">${i + 1}</div>
        <div class="lb-id">${logoHtml(a)}<div style="min-width:0"><div class="lb-name">${esc(a.app.name)}</div>
          <div class="lb-sub">${esc(a.app.category)} · ${STATUS_LABEL[a.mcp.status]}${a.tools_count ? ` · <b data-num="${a.tools_count}" data-nk="app:${a.app.id}:tools">${a.tools_count}</b>${a.generic_gateway ? " generic" : ""} tools` : ""}${dlOf(a) ? ` · <b data-num="${dlOf(a)}" data-fmt="k" data-nk="app:${a.app.id}:dl">${fmtNum(dlOf(a))}</b>/mo` : ""}${a.github.stars ? ` · ★<b data-num="${a.github.stars}" data-fmt="k" data-nk="app:${a.app.id}:stars">${fmtNum(a.github.stars)}</b>` : ""}</div></div></div>
        <div class="lb-bar"><i data-bar="${a.readiness.score}" data-nk="app:${a.app.id}:bar" style="width:${a.readiness.score}%"></i></div>
        <div class="lb-score"><span class="grade ${esc(a.readiness.grade)}">${esc(a.readiness.grade)}</span><b data-num="${a.readiness.score}" data-nk="app:${a.app.id}:readiness">${a.readiness.score}</b></div>
      </div>`).join("") || `<div class="empty" style="padding:24px">No apps match.</div>`}</div></div>`;
    bindRows();
  }

  function renderOpportunities(apps) {
    $("#viewTitle").innerHTML = svg("bolt") + ` Opportunities <span class="hint" id="oppHint" style="margin-left:6px">demand but no official MCP</span>`;
    let rows = apps.filter(match).map(a => ({ a, s: opportunityScore(a) })).filter(x => x.s >= 0).sort((x, y) => y.s - x.s);
    const maxS = Math.max(1, ...rows.map(r => r.s));
    if (sigUnchanged("opp", ["o", rows.map(r => r.a.app.id + ":" + Math.round(r.s) + ":" + r.a.readiness.score).join(",")].join("|"))) { bindRows(); return; }
    $("#viewContent").innerHTML = `<div class="tablewrap oppwrap"><div class="opps">${rows.map(({ a, s }) => {
      const dl = dlOf(a), why = [];
      if (a.github.stars) why.push(`★${fmtNum(a.github.stars)} repo`);
      if (dl) why.push(`${fmtNum(dl)} dl/mo`);
      if (a.mcp.matched) why.push(`${a.mcp.matched} community server${a.mcp.matched > 1 ? "s" : ""}`);
      if (a.liveness && a.liveness.reachable) why.push("site live");
      return `<div class="opp" data-id="${a.app.id}" style="--rowbg:${rowTint(a.readiness.score)}">
        <div class="opp-top">${logoHtml(a)}<div style="min-width:0;flex:1"><h4>${esc(a.app.name)}</h4><div class="ocat">${esc(a.app.category)}</div></div>
          <div class="demandring" style="--p:${Math.round(s / maxS * 100)}%"><span data-num="${Math.round(s)}">${Math.round(s)}</span></div></div>
        <div class="opp-stats">
          <div class="opp-stat"><b data-num="${a.readiness.score}">${a.readiness.score}</b><span>Ready</span></div>
          <div class="opp-stat"><b${a.tools_count ? ` data-num="${a.tools_count}" data-nk="app:${a.app.id}:tools"` : ""}>${a.tools_count ? (a.generic_gateway ? a.tools_count + "*" : a.tools_count) : "-"}</b><span>Tools</span></div>
          <div class="opp-stat"><b${a.github.stars ? ` data-num="${a.github.stars}" data-fmt="k" data-nk="app:${a.app.id}:stars"` : ""}>${a.github.stars ? fmtNum(a.github.stars) : "-"}</b><span>Stars</span></div>
        </div>
        <div class="opp-why">No vendor-official MCP. ${why.length ? esc(why.join(" · ")) : "Listed but quiet."}${a.generic_gateway ? " *via shared gateway." : ""}</div>
      </div>`;
    }).join("") || `<div class="empty" style="padding:24px">No opportunities match.</div>`}</div></div>`;
    const oh = $("#oppHint"); if (oh) oh.textContent = `${rows.length} apps · demand but no official MCP`;
    bindRows();
  }
  let cmdkBound = false;
  function bindCmdk() {
    if (cmdkBound) return; cmdkBound = true;
    const res = $("#cmdkRes");
    const select = (el) => { state.cmdk.idx = +el.dataset.i; $$("#cmdkRes .cmdk-item[data-i]").forEach(x => x.classList.toggle("sel", +x.dataset.i === state.cmdk.idx)); };
    res.addEventListener("click", (e) => { const it = e.target.closest(".cmdk-item[data-i]"); if (it) runCmdkItem(state.cmdk.items[+it.dataset.i]); });
    res.addEventListener("mouseover", (e) => { const it = e.target.closest(".cmdk-item[data-i]"); if (it && +it.dataset.i !== state.cmdk.idx) select(it); });
  }

  let rowsBound = false;
  function bindRows() {
    if (rowsBound) return;
    rowsBound = true;
    $("#viewContent").addEventListener("click", (e) => {
      const cmp = e.target.closest("[data-cmp]");
      if (cmp) { e.stopPropagation(); toggleCompare(+cmp.dataset.cmp); return; }
      const row = e.target.closest("[data-id]");
      if (row) openModal(+row.dataset.id);
    });
  }
  function bindSort() { $$("table.grid th[data-sort]").forEach(th => th.addEventListener("click", () => { const k = th.dataset.sort; if (state.sortKey === k) state.sortDir *= -1; else { state.sortKey = k; state.sortDir = k === "name" ? 1 : -1; } renderView(); })); }

  /* ---------------- feeds ---------------- */
  function pushEvent(d) {
    const feed = $("#feed"); if (!feed) return;
    railNoteActivity();
    const el = document.createElement("div");
    el.className = "evt " + (d.status || d.kind || "info");
    el.innerHTML = `<span class="ebar"></span><div class="ebody"><div class="etop"><span class="ename">${esc(d.app || "System")}</span><span class="ets">${esc(clock(d.ts))}</span></div><div class="emsg">${esc(d.message || "")}</div></div>`;
    feed.prepend(el); while (feed.children.length > 50) feed.removeChild(feed.lastChild);
  }
  function renderChanges(changes) {
    const el = $("#changesFeed"); if (!el) return;
    if (sigUnchanged("changes", [(changes || []).length, ((changes || [])[0] || {}).ts].join("|"))) return;
    const cn = $("#railChangesN"); if (cn) cn.textContent = (changes || []).length;
    if (!changes || !changes.length) { el.innerHTML = `<div class="empty">No changes yet; diffs appear after the next live refresh detects differences.</div>`; return; }
    el.innerHTML = changes.slice(0, 40).map(c => `<div class="chg ${esc(c.kind)}"><span class="cdot2"></span><div class="cbody">
      <div class="crow"><span class="cname">${esc(c.app || "System")}</span><span class="cts">${esc(timeAgo(c.ts))}</span></div>
      <div class="cmsg">${esc(c.message)}</div></div></div>`).join("");
  }
  /* ---- explorer rail: one panel, two tabs (What changed / Activity) ---- */
  function setRailTab(which) {
    state.railTab = which === "activity" ? "activity" : "changes";
    $$(".rail-tab").forEach(b => {
      const on = b.dataset.rail === state.railTab;
      b.classList.toggle("active", on); b.setAttribute("aria-selected", on ? "true" : "false");
    });
    const c = $("#railPaneChanges"), a = $("#railPaneActivity");
    if (c) c.classList.toggle("active", state.railTab === "changes");
    if (a) a.classList.toggle("active", state.railTab === "activity");
    const dot = $("#railDot"); if (dot) dot.hidden = true;
  }
  function railNoteActivity() {
    if (state.railTab === "activity") return;
    const dot = $("#railDot"); if (dot) dot.hidden = false;
  }

  async function loadActivity() { if (!state.live) return; try { const r = await fetch("/api/activity?limit=22", { cache: "no-store" }); const d = sanitizeDashes(await r.json()); (d.events || []).slice().reverse().forEach(pushEvent); } catch (e) {} }

  /* ---------------- modal ---------------- */
  function openModal(id) { const a = (state.snap.apps || []).find(x => x.app.id === id); if (a) openModalData(a, { pinned: true }); }
  function openModalData(a, opts = {}) {
    closeCommCard();
    const pinned = opts.pinned !== false;
    const m = a.mcp || {}, gh = a.github || {}, lv = a.liveness, r = a.readiness || {};
    const servers = (m.servers || []).slice().sort((x, y) => (x.classification === "vendor_official" ? -1 : 1) - (y.classification === "vendor_official" ? -1 : 1));
    const offServers = servers.filter(s => s.classification === "vendor_official");
    const comServers = servers.filter(s => s.classification !== "vendor_official");

    const srvCard = (s) => {
      const pr = s.probe;
      let probe = "", chips = "";
      if (pr && pr.result === "open") {
        probe = `<div class="probe-line open">${svg("bolt", 2)} ${pr.tools_count} live tools${pr.generic_gateway ? " · shared gateway" : ""} · ${pr.latency_ms ?? "?"}ms</div>`;
        if (pr.tool_names && pr.tool_names.length) chips = `<div class="toolchips">${pr.tool_names.slice(0, 14).map(t => `<span class="toolchip"><span class="tdot"></span>${esc(t)}</span>`).join("")}${pr.tool_names.length > 14 ? `<span class="toolchip more">+${pr.tool_names.length - 14} more</span>` : ""}</div>`;
      } else if (pr && ["auth_required", "payment_required", "forbidden"].includes(pr.result)) {
        probe = `<div class="probe-line gated">${svg("lock", 2)} endpoint requires credentials (${pr.http_status})</div>`;
      } else if (pr && pr.http_status === 429) {
        probe = `<div class="probe-line err">${svg("slash", 2)} endpoint rate-limited this probe (HTTP 429) · retry shortly</div>`;
      } else if (pr && (pr.result === "timeout" || pr.result === "error")) {
        probe = `<div class="probe-line err">${svg("slash", 2)} endpoint didn't answer (${esc(pr.result)})</div>`;
      }
      const links = [];
      if (s.repository_url) links.push(`<a class="lnk" href="${esc(s.repository_url)}" target="_blank" rel="noopener">${svg("box", 2)} repo</a>`);
      (s.remote_urls || []).slice(0, 1).forEach(u => links.push(`<a class="lnk" href="${esc(u)}" target="_blank" rel="noopener">${svg("globe", 2)} endpoint</a>`));
      if ((s.remote_urls || [])[0]) links.push(`<button class="lnk compat-run" type="button" data-compat="${esc(s.remote_urls[0])}" title="Run the MCP compatibility test against this endpoint">${svg("bolt", 2)} test compatibility</button>`);
      (s.packages || []).slice(0, 2).forEach(p => links.push(`<span class="lnk">${svg("download", 2)} ${esc(p)}</span>`));
      return `<div class="srvcard ${s.classification === "vendor_official" ? "official" : ""}">
        <div class="srv-head"><span class="srv-name">${esc(s.name)}</span>${statusBadge(s.classification === "vendor_official" ? "vendor_official" : "community")}${staleTag(s)}</div>
        ${s.description ? `<div class="srv-desc">${esc(s.description)}</div>` : ""}${probe}${chips}
        ${(links.length || s.version || s.namespace_matches_vendor) ? `<div class="srv-links">${links.join("")}${s.version ? `<span class="lnk">v${esc(s.version)}</span>` : ""}${s.namespace_matches_vendor ? `<span class="lnk" style="color:var(--ok)">${svg("shield", 2)} domain-verified</span>` : ""}</div>` : ""}</div>`;
    };
    let capCards = offServers.map(srvCard).join("");
    if (!offServers.length) capCards += `<div class="empty">No vendor-official MCP server found in the registry for this app: an honest "none".</div>`;
    if (comServers.length) capCards += `
      <div class="comm-inline" id="commInline">
        <button class="ci-toggle" type="button" id="ciToggle" aria-expanded="false">
          ${svg("users", 2)}<span>Community servers</span><span class="ci-n">${comServers.length}</span>
          <span class="ci-note">matched in the MCP registry · tap to list</span>
          <span class="ci-chev" aria-hidden="true">▾</span>
        </button>
        <div class="ci-wrap"><div class="ci-wrapin"><div class="ci-rows">${comServers.map(commInlineRow).join("")}</div></div></div>
      </div>`;

    const compOrder = ["official_mcp", "capability", "adoption", "popularity", "maintenance", "availability"];
    const rcomp = compOrder.filter(k => r.components && r.components[k]).map((k, ri) => { const c = r.components[k];
      return `<div class="rcomp-row" style="--ri:${ri};--rowbg:${rowTint(Math.round(c.score * 100))}"><span class="rn">${k.replace(/_/g, " ")}</span><span class="rt"><i data-bar="${Math.round(c.score * 100)}" data-nk="rc:${a.app.id}:${k}" style="width:${Math.round(c.score * 100)}%"></i></span><span class="rv" data-num="${Math.round(c.score * 100)}" data-nk="rc:${a.app.id}:${k}">${Math.round(c.score * 100)}</span><span class="rd">${esc(c.detail)} · weight ${Math.round(c.weight * 100)}%</span></div>`; }).join("");

    const dl = dlOf(a);
    const adopt = `<div class="statgrid">
      <div class="stat" style="--si:0"><div class="si">${svg("download")}</div><b${dl ? ` data-num="${dl}" data-fmt="k" data-nk="d:${a.app.id}:dl"` : ""}>${dl ? fmtNum(dl) : "-"}</b><span>downloads / mo</span></div>
      <div class="stat gold" style="--si:1"><div class="si">${svg("star")}</div><b${gh.stars != null ? ` data-num="${gh.stars}" data-fmt="k" data-nk="d:${a.app.id}:stars"` : ""}>${gh.stars != null ? fmtNum(gh.stars) : "-"}</b><span>repo stars</span></div>
      <div class="stat" style="--si:2"><div class="si">${svg("users")}</div><b${gh.forks != null ? ` data-num="${gh.forks}" data-fmt="k" data-nk="d:${a.app.id}:forks"` : ""}>${gh.forks != null ? fmtNum(gh.forks) : "-"}</b><span>forks</span></div>
      <div class="stat ${gh.open_issues ? "warn" : ""}" style="--si:3"><div class="si">${svg("slash")}</div><b${gh.open_issues != null ? ` data-num="${gh.open_issues}" data-nk="d:${a.app.id}:issues"` : ""}>${gh.open_issues ?? "-"}</b><span>open issues</span></div>
    </div>`;

    const commitDays = gh.pushed_at ? Math.round((Date.now() - new Date(gh.pushed_at)) / 86400000) : null;
    const health = gh.status === "found" ? `<div class="statgrid">
      <div class="stat ${commitDays != null && commitDays <= 90 ? "ok" : "warn"}" style="--si:0"><div class="si">${svg("bolt")}</div><b${commitDays != null ? ` data-num="${commitDays}" data-nk="d:${a.app.id}:commit"` : ""}>${commitDays != null ? commitDays + "d" : "-"}</b><span>since commit</span></div>
      <div class="stat" style="--si:1"><div class="si">${svg("box")}</div><b style="font-size:14px">${esc(gh.language || "-")}</b><span>language</span></div>
      <div class="stat" style="--si:2"><div class="si">${svg("shield")}</div><b style="font-size:14px">${esc(gh.license || "-")}</b><span>license</span></div>
      <div class="stat ${gh.archived ? "danger" : ""}" style="--si:3"><div class="si">${svg("check")}</div><b style="font-size:14px">${gh.archived ? "Archived" : "Active"}</b><span>status</span></div>
      <div style="grid-column:1/-1"><a class="lnk" href="${esc(gh.html_url)}" target="_blank" rel="noopener">${svg("box", 2)} ${esc(gh.full_name)} ↗</a></div>
    </div>` : `<div class="empty">No repository published in the registry for this app's servers${gh.status === "rate_limited" ? " (GitHub rate-limited this cycle)" : ""}.</div>`;

    const live = lv ? `<div class="statgrid">
      <div class="stat ${lv.reachable ? "ok" : lv.responded ? "warn" : "danger"}" style="--si:0"><div class="si">${svg("globe")}</div><b>${lv.status_code ?? "ERR"}</b><span>${lv.reachable ? "reachable" : lv.responded ? "up · non-2xx" : "unreachable"}</span></div>
      <div class="stat" style="--si:1"><div class="si">${svg("gauge")}</div><b${lv.latency_ms != null ? ` data-num="${lv.latency_ms}" data-nk="d:${a.app.id}:lat"` : ""}>${lv.latency_ms != null ? lv.latency_ms : "-"}</b><span>ms latency</span></div>
      <div class="stat" style="--si:2"><div class="si">${svg("check")}</div><b style="font-size:14px">${lv.responded ? "Yes" : "No"}</b><span>responded</span></div>
    </div>` : `<div class="empty">Site not checked yet.</div>`;

    $("#modal").innerHTML = `
      <div class="modal-hero">
        <div class="mh-top">
          ${logoHtml(a, "lg")}
          <div class="mh-id"><h3>${esc(a.app.name)} ${statusBadge(m.status)}</h3>
            <div class="mh-sub"><span>${esc(a.app.category)}</span>
              ${a.app.website ? `<span class="sepdot"></span><a href="${esc(a.app.website)}" target="_blank" rel="noopener">${esc(hostname(a.app.website) || a.app.website)} ↗</a>` : ""}
              <span class="sepdot"></span><span><b data-num="${m.matched || 0}" data-nk="d:${a.app.id}:matched">${m.matched || 0}</b> registry server${m.matched === 1 ? "" : "s"}</span></div></div>
          <div class="mh-score">
            <div class="mhs-l"><span class="sb-num" data-num="${r.score || 0}" data-nk="d:${a.app.id}:readiness">${r.score || 0}</span><span class="mhs-of">/100</span></div>
            <div class="mhs-r"><span class="sb-label">Readiness</span>
              <span class="mhs-gb"><span class="sb-bar"><i data-bar="${r.score || 0}" data-nk="d:${a.app.id}:bar" style="width:${r.score || 0}%"></i></span><span class="sb-grade grade ${esc(r.grade || "E")}">${esc(r.grade || "-")}</span></span></div>
          </div>
          <button class="xbtn" id="closeModal" aria-label="Close">✕</button>
        </div>
      </div>
      <div class="modal-body">
        ${pinned ? `<div class="mtabs segmented" id="mTabs" role="tablist" aria-label="Dossier sections">
          <button type="button" role="tab" class="active" data-mtab="evidence" aria-selected="true">Evidence</button>
          <button type="button" role="tab" data-mtab="changes" aria-selected="false">Changes</button>
        </div><div id="mPaneEvidence">` : `<div id="mPaneEvidence">`}
        <div class="mcols">
          <div class="mcol">
            <div class="scoreblock">
              <div class="sb-title">Signal breakdown</div>
              <div class="rcomp">${rcomp}</div>
            </div>
            <div class="msect"><div class="msect-h">${svg("tools")} What it can do · MCP servers &amp; live tools <span class="line"></span></div>${capCards}</div>
            <div class="msect"><div class="msect-h">${svg("shield")} Provenance <span class="line"></span></div>
              <div class="prov">Registry queries: ${(m.queries || []).map(q => `<code>${esc(q)}</code>`).join(" ")}<br>
                MCP fetched <code>${esc(m.fetched_at || "-")}</code>${m.source_url ? ` · <a href="${esc(m.source_url)}" target="_blank" rel="noopener">registry source ↗</a>` : ""}${m.error ? ` · <span style="color:var(--warn)">${esc(m.error)}</span>` : ""}<br>
                GitHub fetched <code>${esc(gh.fetched_at || "-")}</code> · Site fetched <code>${esc(lv && lv.fetched_at || "-")}</code>${a.cached ? `<br><span style="color:var(--warn)">Served from cache (${a.cache_age_s}s old) to avoid hammering the registry · fresh run available in ${a.retry_after_s}s</span>` : ""}</div></div>
          </div>
          <div class="mcol">
            <div class="msect"><div class="msect-h">${svg("download")} Adoption <span class="line"></span></div>${adopt}</div>
            <div class="msect"><div class="msect-h">${svg("box")} Repository health <span class="line"></span></div>${health}</div>
            <div class="msect"><div class="msect-h">${svg("globe")} Website liveness <span class="line"></span></div>${live}</div>
          </div>
        </div>
        </div>
        <div id="mPaneChanges" hidden></div>
        ${state.live ? `<div class="modal-foot">
          ${pinned
            ? `<button class="btn btn-ghost" id="watchBtn">${svg("shield", 2)} ${isWatched(a.app.id) ? "Watching" : "Watch"}</button>
               <button class="btn btn-ghost" id="cmpOne">${svg("apps", 2)} ${state.compare.includes(a.app.id) ? "In compare" : "Compare"}</button>
               <button class="btn btn-ghost" id="copyLink">${svg("box", 2)} Copy link</button>`
            : `<button class="btn btn-ghost" id="pinApp">${svg("star", 2)} Pin to list</button>`}
          <button class="btn btn-primary" id="refreshOne">${svg("bolt", 2)} ${pinned ? "Re-fetch live" : "Re-run lookup"}</button>
        </div>` : ""}
      </div>`;
    $("#modal").classList.remove("cmpwin"); $("#modal").classList.add("open"); $("#backdrop").classList.add("open"); lockWindowScroll("modal");
    const sbn = $("#modal .sb-num"); if (sbn) countUp(sbn, r.score || 0, v => String(v));
    if (pinned) pushRecent({ name: a.app.name, id: a.app.id, domain: hostname(a.app.website || "") });
    $("#closeModal").onclick = closeModal;
    const cit = $("#ciToggle");
    if (cit) cit.onclick = () => { const ci = $("#commInline"); if (!ci) return; const open = ci.classList.toggle("open"); cit.setAttribute("aria-expanded", open ? "true" : "false"); };
    const modalEl = $("#modal");
    if (modalEl) modalEl.addEventListener("click", (e) => {
      const cb = e.target.closest ? e.target.closest("[data-compat]") : null;
      if (cb && cb.dataset.compat) { runCompat(cb.dataset.compat); return; }
      const tb = e.target.closest ? e.target.closest("[data-mtab]") : null;
      if (tb) { setMTab(tb.dataset.mtab); return; }
      const gd = e.target.closest ? e.target.closest("[data-chgdiff]") : null;
      if (gd) {
        const id = +gd.dataset.chgdiff, f = $("#chgFrom"), t = $("#chgTo");
        const q = `?from=${encodeURIComponent(f ? f.value : "prev")}&to=${encodeURIComponent(t ? t.value : "latest")}`;
        const box = $("#chgDiff"); if (box) box.innerHTML = `<div class="empty">Comparing…</div>`;
        fetch(`/api/integrations/${id}/diff${q}`, { cache: "no-store" }).then(r => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))
          .then(d => { const dd = $("#chgDiff"); if (dd) dd.innerHTML = diffHtml(sanitizeDashes(d)); })
          .catch(err => { const dd = $("#chgDiff"); if (dd) dd.innerHTML = `<div class="empty">${esc(String(err.message || err))}</div>`; });
      }
    });
    const ro = $("#refreshOne");
    if (ro) ro.onclick = () => pinned ? refreshIds([a.app.id]) : lookupApp(a.app.name, a.app.website);
    const cl = $("#copyLink"); if (cl) cl.onclick = () => { const u = location.origin + "/app/" + a.app.id; navigator.clipboard && navigator.clipboard.writeText(u); toast("Deep link copied: /app/" + a.app.id); };
    const pa = $("#pinApp"); if (pa) pa.onclick = () => pinApp(a);
    const wb = $("#watchBtn"); if (wb) { wb.onclick = () => toggleWatch(a); if (isWatched(a.app.id)) wb.style.color = "var(--ok)"; }
    const co = $("#cmpOne"); if (co) co.onclick = () => { toggleCompare(a.app.id); co.innerHTML = svg("apps", 2) + (state.compare.includes(a.app.id) ? " In compare" : " Compare"); };
    state.modalAppId = pinned ? a.app.id : null;
    state.changesCache = null;
    scanNums($("#modal"));
    try { if (pinned && history.pushState) history.pushState({}, "", "/app/" + a.app.id); } catch (e) {}
  }
  function closeModal() {
    if (state.lkTimer) { clearInterval(state.lkTimer); state.lkTimer = null; } closeCommCard(); $("#modal").classList.remove("open", "cmpwin"); $("#backdrop").classList.remove("open"); unlockWindowScroll("modal"); try { if (history.pushState && location.pathname.startsWith("/app/")) history.pushState({}, "", "/"); } catch (e) {} }

  /* ---------------- historical diff / breaking changes (client side) ---------------- */
  const CHG_ICON = { add: `<span class="cg-ic ok">+</span>`, rem: `<span class="cg-ic bad">✗</span>`,
    mod: `<span class="cg-ic warn">~</span>`, brk: `<span class="cg-ic bad">⚠</span>` };
  function chgList(title, items, icon, fmt) {
    if (!items || !items.length) return "";
    return `<div class="chg-group"><div class="chg-gt">${title}</div>` +
      items.map(x => `<div class="chg-item">${icon}<span>${fmt(x)}</span></div>`).join("") + `</div>`;
  }
  function diffHtml(d) {
    if (!d) return `<div class="empty">No stored snapshots yet for this integration. Run a live refresh to start its history.</div>`;
    const s = d.summary || {};
    const brk = (d.breaking_changes || []).filter(b => b.breaking);
    const notes = (d.breaking_changes || []).filter(b => !b.breaking);
    const ts = d.timestamps || {};
    const fmtName = x => `<b>${esc(x.name)}</b>${x.kind && x.kind !== "tool" ? ` <i class="cg-k">${esc(x.kind)}</i>` : ""}`;
    const fmtMod = x => `<b>${esc(x.name)}</b> <i class="cg-k">${esc(x.field || "")}</i>` +
      (x.from != null || x.to != null ? ` <span class="cg-arrow">${esc(String(x.from))} → ${esc(String(x.to))}</span>` : "");
    return `
      <div class="chg-head">
        <div class="chg-k">Change detected</div>
        <div class="chg-counts">
          <span class="cc add">+ ${s.added || 0} added</span>
          <span class="cc rem">− ${s.removed || 0} removed</span>
          <span class="cc mod">~ ${s.modified || 0} modified</span>
          ${brk.length ? `<span class="cc brk">⚠ ${brk.length} potential breaking</span>` : `<span class="cc okc">no breaking changes</span>`}
        </div>
        <div class="chg-ts">${esc(ts.from || "?")} → ${esc(ts.to || "now")}</div>
      </div>
      ${brk.length ? `<div class="chg-brk">${brk.map(b => `<div class="cb-row sev-${esc(b.severity)}">${CHG_ICON.brk}
          <div><b>${esc(b.severity.toUpperCase())} · potential breaking change</b><span>${esc(b.message)}</span></div></div>`).join("")}</div>` : ""}
      ${chgList("Added", d.added, CHG_ICON.add, fmtName)}
      ${chgList("Removed", d.removed, CHG_ICON.rem, fmtName)}
      ${chgList("Modified", d.modified, CHG_ICON.mod, fmtMod)}
      ${notes.length ? `<div class="chg-group"><div class="chg-gt">Also noted (not breaking)</div>` +
        notes.map(b => `<div class="chg-item">${CHG_ICON.mod}<span>${esc(b.message)}</span></div>`).join("") + `</div>` : ""}
      ${(d.not_comparable || []).length ? `<div class="chg-nc">Not comparable between these snapshots (not probed on one side): ${esc((d.not_comparable || []).join(", "))}</div>` : ""}
      ${!s.changed ? `<div class="chg-same">No differences between these two snapshots.</div>` : ""}`;
  }
  function timelineHtml(tl) {
    if (!tl || !tl.length) return "";
    return `<div class="chg-tl"><div class="chg-gt">History timeline</div>` + tl.map(r => `
      <div class="tl-row"><span class="tl-day">${esc(r.day)}</span>
        <span class="tl-dot${r.breaking ? " brk" : r.changes ? "" : " quiet"}"></span>
        <span class="tl-txt">${r.breaking ? `${r.breaking} breaking change${r.breaking === 1 ? "" : "s"}` : r.changes ? `${r.changes} change${r.changes === 1 ? "" : "s"}` : "No changes"}</span>
      </div>`).join("") + `</div>`;
  }
  function renderChangesTab(id, payload, diffOverride) {
    const pane = $("#mPaneChanges"); if (!pane) return;
    const snaps = (payload && payload.snapshots) || [];
    const d = diffOverride !== undefined ? diffOverride : (payload && payload.latest);
    const opts = snaps.map((s, i) => `<option value="${esc(s.ts)}">${esc(s.ts)}${s.changed ? " · changed" : " · same"}</option>`).join("");
    const defFrom = snaps.length > 1 ? snaps[snaps.length - 2].ts : (snaps[0] || {}).ts;
    const defTo = snaps.length ? snaps[snaps.length - 1].ts : "";
    pane.innerHTML = `
      <div class="msect"><div class="msect-h">${svg("bolt")} Historical diff <span class="line"></span>
        <span class="cp-note">deterministic · normalised ordering</span></div>
        <div id="chgDiff">${diffHtml(d)}</div>
        ${snaps.length > 1 ? `<div class="chg-cmp">
          <div class="selectwrap"><select id="chgFrom" aria-label="Compare from">${opts}</select><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg></div>
          <span class="cg-arrow">→</span>
          <div class="selectwrap"><select id="chgTo" aria-label="Compare to">${opts}</select><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg></div>
          <button class="btn btn-ghost btn-sm" type="button" data-chgdiff="${id}">Compare snapshots</button>
        </div>` : ""}
      </div>
      ${timelineHtml(payload && payload.timeline)}`;
    const f = $("#chgFrom"), t = $("#chgTo");
    if (f && defFrom) f.value = defFrom;
    if (t && defTo) t.value = defTo;
  }
  async function loadChangesTab(id, force) {
    if (!state.live) { const p = $("#mPaneChanges"); if (p) p.innerHTML = `<div class="empty">Start the backend to load change history.</div>`; return; }
    if (!force && state.changesCache && state.changesCache.id === id) { renderChangesTab(id, state.changesCache.payload); return; }
    const pane = $("#mPaneChanges"); if (pane) pane.innerHTML = `<div class="empty">Loading change history…</div>`;
    try {
      const r = await fetch(`/api/integrations/${id}/changes`, { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const payload = sanitizeDashes(await r.json());
      state.changesCache = { id, payload };
      renderChangesTab(id, payload);
    } catch (e) {
      if (pane) pane.innerHTML = `<div class="empty">Could not load change history: ${esc(String(e.message || e))}</div>`;
    }
  }
  function setMTab(which) {
    const ev = $("#mPaneEvidence"), ch = $("#mPaneChanges");
    if (!ev || !ch) return;
    const onChanges = which === "changes";
    ev.hidden = onChanges; ch.hidden = !onChanges;
    $$("#mTabs [data-mtab]").forEach(b => {
      const on = b.dataset.mtab === which;
      b.classList.toggle("active", on); b.setAttribute("aria-selected", on ? "true" : "false");
    });
    if (onChanges) { const id = state.modalAppId; if (id != null) loadChangesTab(id); }
  }

  /* ---------------- MCP compatibility tester (client side) ---------------- */
  const COMPAT_ICON = {
    pass: `<span class="cp-ic ok">${svg("check", 2.6)}</span>`,
    warning: `<span class="cp-ic warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l9 16H3z"/><path d="M12 10v4m0 3h.01"/></svg></span>`,
    fail: `<span class="cp-ic bad">${svg("slash", 2.6)}</span>`,
    skip: `<span class="cp-ic mut"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 12h12"/></svg></span>`,
  };
  function compatPanel() {
    let el = $("#compatPanel");
    if (el) return el;
    const body = $("#modal .modal-body"); if (!body) return null;
    el = document.createElement("div");
    el.className = "msect compat-panel";
    el.id = "compatPanel";
    const foot = $("#modal .modal-foot");
    if (foot) body.insertBefore(el, foot); else body.appendChild(el);
    return el;
  }
  function compatRows(report) {
    return (report.checks || []).map(c => `
      <div class="cp-row ${esc(c.status)}">
        ${COMPAT_ICON[c.status] || COMPAT_ICON.skip}
        <div class="cp-txt"><b>${esc(c.name)}</b><span>${esc(c.message)}</span></div>
        <span class="cp-ms">${c.latency_ms != null ? c.latency_ms + " ms" : ""}</span>
      </div>`).join("");
  }
  function renderCompat(report, url) {
    const el = compatPanel(); if (!el) return;
    const pct = report.compatibility_pct || 0;
    const ring = pct >= 80 ? "var(--ok)" : pct >= 50 ? "var(--warn)" : "var(--dan)";
    el.innerHTML = `
      <div class="msect-h">${svg("bolt")} MCP Compatibility <span class="line"></span>
        <span class="cp-note">behavioural test · not an official certification</span></div>
      <div class="compat-head">
        <div class="compat-ring" style="--p:${pct}%;--ring:${ring}">
          <span class="cr-v">${pct}<i>%</i></span>
        </div>
        <div class="compat-meta">
          <div class="cm-row"><b>${report.passed}</b><span>passed</span></div>
          <div class="cm-row"><b class="w">${report.warnings}</b><span>warnings</span></div>
          <div class="cm-row"><b class="f">${report.failed}</b><span>failed</span></div>
          <div class="cm-row"><b class="s">${report.skipped}</b><span>skipped</span></div>
          <div class="cm-row"><b>${report.total}</b><span>checks</span></div>
        </div>
        <div class="compat-url" title="${esc(url)}">${esc(hostname(url))}</div>
      </div>
      <div class="compat-list">${compatRows(report)}</div>
      ${report.error ? `<div class="cp-err">${svg("slash", 2)} ${esc(report.error)}</div>` : ""}
      <div class="compat-foot">
        <button class="btn btn-ghost btn-sm" type="button" id="compatAgain" data-compat="${esc(url)}">${svg("bolt", 2)} Run again</button>
        <span class="hint">${esc(timeAgo(report.tested_at))}</span>
      </div>`;
    scanNums(el);
  }
  function renderCompatLoading(url) {
    const el = compatPanel(); if (!el) return;
    el.innerHTML = `
      <div class="msect-h">${svg("bolt")} MCP Compatibility <span class="line"></span></div>
      <div class="compat-loading">
        <span class="spin" style="width:22px;height:22px;border-width:3px;border-color:rgba(255,255,255,.15);border-top-color:var(--acc)"></span>
        <div><b>Testing ${esc(hostname(url))}</b>
        <span>reachable · TLS · handshake · protocol · capabilities · tools / resources / prompts · schemas · JSON-RPC · errors · auth</span></div>
      </div>`;
  }
  async function runCompat(url) {
    if (!state.live) { toast("Start the backend to run compatibility tests", "bolt"); return; }
    renderCompatLoading(url);
    try {
      const r = await fetch("/api/mcp/compatibility-test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!r.ok) {
        let msg = "HTTP " + r.status;
        try { msg = (await r.json()).detail || msg; } catch (e) {}
        throw new Error(msg);
      }
      renderCompat(sanitizeDashes(await r.json()), url);
    } catch (e) {
      const el = compatPanel();
      if (el) el.innerHTML = `<div class="msect-h">${svg("bolt")} MCP Compatibility <span class="line"></span></div>
        <div class="cp-err">${svg("slash", 2)} ${esc(String(e.message || e))}</div>
        <div class="compat-foot"><button class="btn btn-ghost btn-sm" type="button" data-compat="${esc(url)}">${svg("bolt", 2)} Run again</button></div>`;
    }
  }

  /* ---------------- floating community card (draggable · no dimming, no blur) ---------------- */
  function closeCommCard() { const c = $("#commCard"); if (c) c.classList.remove("open"); }
  /* Community servers listed INLINE in the app dossier - styled like the app
     rows in the explorer (dark glass, violet tint, hover lift). No floating
     card, no extra click, nothing whitish. */
  function commInlineRow(s) {
    const pr = s.probe;
    /* tier: live = green (shining) · low = low green (gateway / not probed yet)
       gated = light red (auth wall) · err = red (endpoint dead) */
    const tier = (pr && pr.result === "open") ? (pr.generic_gateway ? "low" : "live")
      : (pr && ["auth_required", "payment_required", "forbidden"].includes(pr.result)) ? "gated"
      : (pr && (pr.result === "timeout" || pr.result === "error")) ? "err" : "low";
    let tools;
    if (pr && pr.result === "open") tools = `<span class="cc-tools open">${svg("bolt", 2)} ${pr.tools_count} live tool${pr.tools_count === 1 ? "" : "s"}${pr.generic_gateway ? " · gateway" : ""}</span>`;
    else if (pr && ["auth_required", "payment_required", "forbidden"].includes(pr.result)) tools = `<span class="cc-tools gated">${svg("lock", 2)} auth gated</span>`;
    else if (pr && (pr.result === "timeout" || pr.result === "error")) tools = `<span class="cc-tools err">${svg("slash", 2)} no answer</span>`;
    else tools = `<span class="cc-tools idle">${svg("box", 2)} not probed</span>`;
    const links = [];
    if (s.repository_url) links.push(`<a class="lnk" href="${esc(s.repository_url)}" target="_blank" rel="noopener">${svg("box", 2)} repo</a>`);
    (s.remote_urls || []).slice(0, 1).forEach(u => links.push(`<a class="lnk" href="${esc(u)}" target="_blank" rel="noopener">${svg("globe", 2)} endpoint</a>`));
    (s.packages || []).slice(0, 2).forEach(p => links.push(`<span class="lnk">${svg("download", 2)} ${esc(p)}</span>`));
    const chips = pr && pr.result === "open" && pr.tool_names && pr.tool_names.length
      ? `<div class="toolchips">${pr.tool_names.slice(0, 10).map(t => `<span class="toolchip"><span class="tdot"></span>${esc(t)}</span>`).join("")}${pr.tool_names.length > 10 ? `<span class="toolchip more">+${pr.tool_names.length - 10} more</span>` : ""}</div>` : "";
    const ini = initials(String(s.name || "?").replace(/[-_./]/g, " "));
    return `<div class="ci-row ci-${tier}">
      <div class="ci-logo">${esc(ini)}</div>
      <div class="ci-main">
        <div class="ci-name">${esc(s.name)}${staleTag(s)}</div>
        ${s.description ? `<div class="ci-desc">${esc(s.description)}</div>` : ""}
        ${chips}
      </div>
      <div class="ci-side">${tools}${links.length ? `<div class="ci-links">${links.join("")}</div>` : ""}</div>
    </div>`;
  }
  function commSrvRow(s) {
    const pr = s.probe;
    let tools = "";
    if (pr && pr.result === "open") tools = `<span class="cc-tools open">${pr.tools_count} live tools${pr.generic_gateway ? " · gw" : ""}</span>`;
    else if (pr && ["auth_required", "payment_required", "forbidden"].includes(pr.result)) tools = `<span class="cc-tools gated">auth gated</span>`;
    else if (pr && (pr.result === "timeout" || pr.result === "error")) tools = `<span class="cc-tools err">no answer</span>`;
    const links = [];
    if (s.repository_url) links.push(`<a class="lnk" href="${esc(s.repository_url)}" target="_blank" rel="noopener">${svg("box", 2)} repo</a>`);
    (s.remote_urls || []).slice(0, 1).forEach(u => links.push(`<a class="lnk" href="${esc(u)}" target="_blank" rel="noopener">${svg("globe", 2)} endpoint</a>`));
    (s.packages || []).slice(0, 2).forEach(p => links.push(`<span class="lnk">${svg("download", 2)} ${esc(p)}</span>`));
    const chips = pr && pr.result === "open" && pr.tool_names && pr.tool_names.length
      ? `<div class="toolchips">${pr.tool_names.slice(0, 10).map(t => `<span class="toolchip"><span class="tdot"></span>${esc(t)}</span>`).join("")}${pr.tool_names.length > 10 ? `<span class="toolchip more">+${pr.tool_names.length - 10}</span>` : ""}</div>` : "";
    return `<div class="cc-srv"><div class="cc-top"><span class="cc-name">${esc(s.name)}</span>${tools}</div>
      ${s.description ? `<div class="cc-desc">${esc(s.description)}</div>` : ""}${chips}
      ${links.length ? `<div class="cc-links">${links.join("")}</div>` : ""}</div>`;
  }
  function openCommCard(servers, appName, anchor) {
    let c = $("#commCard");
    if (!c) { c = document.createElement("div"); c.id = "commCard"; c.className = "comm-card"; document.body.appendChild(c); }
    c.innerHTML = `<div class="cc-head">
        <span class="cc-grip" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></span>
        <div class="cc-t"><b>Community servers</b><span>${esc(appName)} · ${servers.length} matched</span></div>
        <span class="cc-move">drag to move</span>
        <button class="cc-x" type="button" aria-label="Close card">✕</button></div>
      <div class="cc-body">${servers.map(commSrvRow).join("")}</div>`;
    c.classList.add("open");
    try {
      const w = c.offsetWidth || 430, h = c.offsetHeight || 320;
      const b = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
      let x = b ? b.left - 80 : (window.innerWidth - w) / 2, y = b ? b.bottom + 12 : (window.innerHeight - h) / 2;
      x = Math.max(10, Math.min(window.innerWidth - w - 10, x));
      y = Math.max(10, Math.min(Math.max(10, window.innerHeight - h - 10), y));
      c.style.left = Math.round(x) + "px"; c.style.top = Math.round(y) + "px";
    } catch (e) {}
  }
  function bindCommCard() {
    const c = $("#commCard"); if (!c || c._bound) return; c._bound = true;
    c.addEventListener("click", (e) => { if (e.target.closest && e.target.closest(".cc-x")) closeCommCard(); });
    c.addEventListener("pointerdown", (e) => {
      const head = e.target.closest ? e.target.closest(".cc-head") : null;
      if (!head || (e.target.closest && e.target.closest(".cc-x"))) return;
      e.preventDefault();
      const r = c.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top, w = r.width;
      c.classList.add("drag");
      const move = (ev) => {
        let x = ev.clientX - dx, y = ev.clientY - dy;
        x = Math.max(8, Math.min(window.innerWidth - w - 8, x));
        y = Math.max(8, Math.min(window.innerHeight - 46, y));
        c.style.left = Math.round(x) + "px"; c.style.top = Math.round(y) + "px";
      };
      const up = () => { c.classList.remove("drag"); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    });
  }

  /* ---------------- fetch ANY app live ---------------- */
  const LOOKUP_STEPS = [
    ["Searching the MCP registry", "box"],
    ["Handshaking live endpoints", "bolt"],
    ["Resolving repository &amp; package adoption", "star"],
    ["Checking the website", "globe"],
    ["Scoring integration readiness", "gauge"],
  ];
  function lookupProgressHtml(name, website) {
    const dom = website ? hostname(website) : (String(name).indexOf(".") > 0 ? String(name).toLowerCase() : "");
    return `<button class="xbtn" id="closeModal" style="position:absolute;top:14px;right:14px;z-index:3" aria-label="Close">✕</button>
      <div class="modal-body lk-body">
        <div class="lk-head">
          ${domainLogo(dom, name, "lg")}
          <div style="min-width:0"><div class="cmp2-kicker">Live lookup</div>
            <h3 style="margin:0">Fetching “${esc(name)}”</h3>
            <div class="mh-sub"><span>Not one of the tracked 100 · real sources only</span></div></div>
          <div class="lk-timer"><b id="lkElapsed">0.0</b><span>seconds</span></div>
        </div>
        <ol class="lk-steps">${LOOKUP_STEPS.map((s, k) => `<li class="lk-step pending" data-k="${k}">
            <span class="lk-ic">${svg(s[1], 1.9)}</span><span class="lk-t">${s[0]}</span>
            <span class="lk-s"></span></li>`).join("")}</ol>
        <div class="lk-bar"><i id="lkBar"></i></div>
        <p class="lk-note">Nothing is guessed. Every field you are about to see comes from the registry, a real endpoint handshake, GitHub, npm / PyPI or a direct HTTP check - and links back to it. A brand-new application usually takes 10-20s.</p>
      </div>`;
  }
  function startLookupTicker() {
    const t0 = performance.now();
    const tick = () => {
      const el = $("#lkElapsed"); if (!el) return;
      el.textContent = ((performance.now() - t0) / 1000).toFixed(1);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  function stepLookup(k, st) {
    const li = $(`.lk-step[data-k="${k}"]`); if (!li) return;
    li.classList.remove("pending", "active", "done", "err"); li.classList.add(st);
    const s = li.querySelector(".lk-s");
    if (s) s.innerHTML = st === "active" ? `<i class="lk-spin"></i>` : st === "done" ? svg("check", 2.6) : st === "err" ? svg("slash", 2.6) : "";
    const bar = $("#lkBar");
    if (bar) bar.style.width = Math.round(((k + (st === "done" ? 1 : 0.5)) / LOOKUP_STEPS.length) * 100) + "%";
  }
  async function lookupApp(name, website) {
    if (!state.live) { toast("Start the backend to fetch any app live", "bolt"); return; }
    closeCmdk();
    $("#modal").innerHTML = lookupProgressHtml(name, website);
    $("#modal").classList.remove("cmpwin"); $("#modal").classList.add("open"); $("#backdrop").classList.add("open"); lockWindowScroll("modal");
    $("#closeModal").onclick = closeModal;
    startLookupTicker();
    /* the five stages below are the real pipeline the backend runs; the walker
       only makes the wait legible, it never invents a result */
    let stage = 0;
    const walker = setInterval(() => {
      if (stage >= LOOKUP_STEPS.length) return;
      if (stage) stepLookup(stage - 1, "done");
      stepLookup(stage, "active"); stage++;
    }, 1500);
    const finishSteps = (ok) => {
      clearInterval(walker);
      for (let k = 0; k < LOOKUP_STEPS.length; k++) stepLookup(k, ok ? "done" : (k < stage ? "done" : "err"));
      const bar = $("#lkBar"); if (bar) bar.style.width = "100%";
    };
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), 45000) : null;
    try {
      const r = await fetch("/api/lookup?name=" + encodeURIComponent(name) + (website ? "&website=" + encodeURIComponent(website) : ""), { cache: "no-store", signal: ctl ? ctl.signal : undefined });
      clearTimeout(timer);
      if (!r.ok) {
        const err = new Error("HTTP " + r.status);
        err.status = r.status;
        err.retryAfter = parseInt(r.headers.get("Retry-After") || "0", 10) || 0;
        try { const j = await r.json(); if (j && j.detail) err.detail = String(j.detail); } catch (_) { /* body was not JSON */ }
        throw err;
      }
      const al = sanitizeDashes(await r.json());
      finishSteps(true);
      pushRecent({ name: al.app.name, id: null, domain: hostname(al.app.website || "") });
      await new Promise(res => setTimeout(res, 300));
      openModalData(al, { pinned: false });
      toast(al.cached ? `“${al.app.name}” served from cache (${al.cache_age_s}s old)` : `Fetched “${al.app.name}” · MCP ${al.mcp.status} · readiness ${al.readiness.score}`, "bolt");
    } catch (e) {
      finishSteps(false);
      await new Promise(res => setTimeout(res, 420));
      lookupFailureCard(e, name, website);
    }
  }
  function lookupFailureCard(e, name, website) {
    if (state.lkTimer) { clearInterval(state.lkTimer); state.lkTimer = null; }
    const status = e && e.status;
    const aborted = e && e.name === "AbortError";
    const dom = website ? hostname(website) : (String(name).indexOf(".") > 0 ? String(name).toLowerCase() : "");
    let kicker = "HTTP " + status, title = "Lookup failed", secs = 0;
    let body = esc((e && e.message) || "unknown error");
    if (status === 429) {
      secs = (e && e.retryAfter) || 30;
      const ours = /our own rate limit/i.test((e && e.detail) || "");
      kicker = ours ? "Our own rate limit \u00b7 HTTP 429" : "Upstream throttled \u00b7 HTTP 429";
      title = ours ? "Slow down, not broken" : "Rate limited upstream";
      body = ours
        ? `This exact lookup ran seconds ago, so this explorer throttled the repeat to protect the public registry APIs it calls. Nothing is wrong with <b>${esc(name)}</b>; the identical request goes through when the counter hits zero.`
        : `The upstream APIs (registry / GitHub / npm) are rate-limiting this server's IP. Every request is retried automatically with backoff before you see this; if it still failed, the limit is sustained. Deploying with a <code>GITHUB_TOKEN</code> raises the GitHub ceiling on your own instance.`;
      if (e && e.detail) body += `<div class="lk-fail-note">${esc(e.detail)}</div>`;
    } else if (status === 502 || status === 504 || aborted) {
      kicker = aborted ? "Timed out after 45s" : "Live discovery failed";
      title = "The sources didn't answer";
      body = aborted
        ? `No answer within 45s: the registry or one of the upstream APIs is slow or unreachable right now. That is not a verdict on <b>${esc(name)}</b>; the app may well have an MCP server. Try again shortly.`
        : `The live pipeline (registry search, GitHub, npm/PyPI, site probe, MCP handshake) could not complete. Upstream 429s and 5xx are retried with backoff before we give up, so this usually means a source is down or throttling this IP. Nothing about <b>${esc(name)}</b> was invented or assumed missing.`;
    }
    const timerHtml = secs
      ? `<div class="lk-timer warn"><b id="lkWait">${secs}</b><span>seconds to retry</span></div>`
      : "";
    const retryLabel = secs ? "Retry in " + secs + "s" : "Try again";
    $("#modal").innerHTML = `<button class="xbtn" id="closeModal" style="position:absolute;top:14px;right:14px;z-index:3" aria-label="Close">\u2715</button>
      <div class="modal-body lk-body">
        <div class="lk-head">
          ${domainLogo(dom, name, "lg")}
          <div style="min-width:0"><div class="cmp2-kicker lk-fail-k">${esc(kicker)}</div>
            <h3 style="margin:0">${esc(title)}</h3>
            <div class="mh-sub"><span>live pipeline: registry, GitHub, npm/PyPI, site probe, MCP handshake</span></div></div>
          ${timerHtml}
        </div>
        <div class="lk-fail-body">${body}</div>
        <div class="lk-actions">
          <button class="btn btn-primary" id="lkRetry" type="button"${secs ? " disabled" : ""}>${svg("bolt", 1.9)}<span id="lkRetryLabel">${retryLabel}</span></button>
          <button class="btn btn-ghost" id="lkDismiss" type="button">${svg("slash", 1.9)}<span>Close</span></button>
        </div>
      </div>`;
    $("#closeModal").onclick = closeModal;
    const dis = $("#lkDismiss"); if (dis) dis.onclick = closeModal;
    const btn = $("#lkRetry");
    if (btn) btn.onclick = () => lookupApp(name, website);
    if (secs && btn) {
      let left = secs;
      state.lkTimer = setInterval(() => {
        left -= 1;
        const w = $("#lkWait"); if (w) w.textContent = String(Math.max(left, 0));
        const lbl = $("#lkRetryLabel"); if (lbl) lbl.textContent = left > 0 ? "Retry in " + left + "s" : "Try again now";
        if (left <= 0) {
          clearInterval(state.lkTimer); state.lkTimer = null;
          btn.disabled = false;
          const t = $(".lk-timer"); if (t) { t.classList.remove("warn"); t.classList.add("ready"); }
        }
      }, 1000);
    }
  }
  async function pinApp(a) {
    try {
      const r = await fetch("/api/apps", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: a.app.name, website: a.app.website, category: "Discovered" }) });
      const d = sanitizeDashes(await r.json());
      toast(`Pinned “${a.app.name}”, fetching live…`, "star");
      closeModal();
      setTimeout(async () => { await loadSnapshot(); if (d.id) openModal(d.id); }, 4500);
    } catch (e) { toast("Pin failed", "slash"); }
  }

  /* ---------------- compare ---------------- */
  function toggleCompare(id) {
    const i = state.compare.indexOf(id);
    if (i >= 0) state.compare.splice(i, 1);
    else { if (state.compare.length >= 4) { toast("Compare up to 4 apps", "slash"); return; } state.compare.push(id); }
    renderCompareBar();
    $$(`[data-cmp="${id}"]`).forEach(b => { const on = state.compare.includes(id); b.classList.toggle("on", on); b.textContent = on ? "✓" : "+"; });
  }
  function renderCompareBar() {
    const bar = $("#compareBar"); if (!bar) return;
    if (!state.compare.length) { bar.classList.remove("show"); }
    else bar.classList.add("show");
    const apps = state.compare.map(id => (state.snap.apps || []).find(a => a.app.id === id)).filter(Boolean);
    $("#compareChips").innerHTML = apps.map(a => `<span class="cb-chip">${esc(a.app.name)}<button data-rm="${a.app.id}" title="Remove">×</button></span>`).join("");
    $$("#compareChips [data-rm]").forEach(b => b.onclick = () => toggleCompare(+b.dataset.rm));
    $("#compareGo").disabled = false;
    renderDrawerCompare(apps);
  }
  /* ---------------- dashboard drawer (hamburger) ---------------- */
  function setDrawer(open) {
    const d = $("#drawer"); if (!d) return;
    d.classList.toggle("open", !!open);
    const sc = $("#drawerScrim"); if (sc) sc.classList.toggle("open", !!open);
    const b = $("#drawerBtn"); if (b && b.setAttribute) b.setAttribute("aria-expanded", open ? "true" : "false");
    try { localStorage.setItem("mcp_drawer", open ? "1" : "0"); } catch (e) {}
  }
  function drawerOpen() { const d = $("#drawer"); return !!(d && d.classList.contains("open")); }
  function syncDrawerView() {
    $$("[data-dview]").forEach(b => b.classList.toggle("active", b.dataset.dview === state.view));
    const c = $("#dwCount"); if (c && state.snap) c.textContent = (state.snap.apps || []).length + " apps";
  }
  function renderDrawerCompare(apps) {
    const n = $("#dwCmpN"); if (n) n.textContent = state.compare.length;
    const chips = $("#dwChips");
    if (chips) {
      chips.innerHTML = apps.length
        ? apps.map(a => `<span class="dw-chip">${esc(a.app.name)}<button data-rm="${a.app.id}" title="Remove">×</button></span>`).join("")
        : `<span class="dw-empty">Tap + on any app row</span>`;
      $$("#dwChips [data-rm]").forEach(b => b.onclick = () => toggleCompare(+b.dataset.rm));
    }
    const go = $("#dwCompare"); if (go) go.disabled = false;
  }
  /* ---------------- compare window: search-and-add picker + live grid ---------------- */
  function cmpApps() { return state.compare.map(id => ((state.snap && state.snap.apps) || []).find(a => a.app.id === id)).filter(Boolean); }
  function cmpGridHtml(apps) {
    const n = apps.length, showBest = n > 1;
    /* the grid always owns the full width: an app column appears when an app is
       added and the only extra track is the slim "add" rail on the right, so
       there is never a reserved empty slot waiting for the next pick */
    const cols = `104px repeat(${n}, minmax(96px,1fr)) 40px`;
    const daysSince = iso => iso ? (Date.now() - new Date(iso).getTime()) / 86400000 : null;
    const rows = [
      ["Readiness", a => a.readiness.score, a => `<b class="cv-num" data-num="${a.readiness.score}">${a.readiness.score}</b> <span class="cv-grade ${a.readiness.grade}">${a.readiness.grade}</span>`, true],
      ["MCP status", a => ({ vendor_official: 3, community: 2, unknown: 1, none: 0 }[a.mcp.status] ?? 0), a => statusBadge(a.mcp.status), true],
      ["Registry servers", a => a.mcp.matched || 0, a => `<span class="cv-num" data-num="${a.mcp.matched || 0}">${a.mcp.matched || 0}</span>`, true],
      ["Live tools", a => (a.tools_count && !a.generic_gateway) ? a.tools_count : 0, a => a.tools_count ? `<span class="cv-num"${a.generic_gateway ? "" : ` data-num="${a.tools_count}"`}>${a.tools_count}</span>${a.generic_gateway ? ' <span class="tag gen">gw</span>' : ""}` : `<span class="mut">-</span>`, true],
      ["Downloads / mo", a => dlOf(a), a => dlOf(a) ? `<span class="cv-num" data-num="${dlOf(a)}" data-fmt="k">${fmtNum(dlOf(a))}</span>` : `<span class="mut">-</span>`, true],
      ["Repository stars", a => a.github.stars || 0, a => a.github.stars != null ? `<span class="cv-star">★</span><span class="cv-num" data-num="${a.github.stars || 0}" data-fmt="k">${fmtNum(a.github.stars)}</span>` : `<span class="mut">-</span>`, true],
      ["Last commit", a => { const d = daysSince(a.github.pushed_at); return d == null ? -1 : -d; }, a => a.github.pushed_at ? `<span class="cv-num">${timeAgo(a.github.pushed_at)}</span>` : `<span class="mut">-</span>`, true],
      ["License", a => 0, a => `<span class="cv-num">${esc(a.github.license || "-")}</span>`, false],
      ["Site", a => a.liveness && a.liveness.reachable ? 1 : 0, a => siteHtml(a), true],
    ];
    const head = `<div class="cmp2-head" style="grid-template-columns:${cols}">
      <div class="cmp2-corner">Compare</div>
      ${apps.map(a => `<div class="cmp2-app">${logoHtml(a, "lg")}<span class="cmp2-name">${esc(a.app.name)}</span>
        <span class="cmp2-score">${a.readiness.score}<small>/100</small></span></div>`).join("")}
      <div class="cmp2-addhead">${n < 4 ? `<button class="cac-plus" type="button" data-caddfocus title="Add another application">+</button><span class="cac-s">${4 - n} left</span>` : ""}</div></div>`;
    const body = rows.map(([label, num, disp, best], ri) => {
      const vals = apps.map(num); const mx = Math.max(...vals); const unique = vals.filter(v => v === mx).length === 1;
      return `<div class="cmp2-row" style="grid-template-columns:${cols}">
        <div class="cmp2-label">${label}</div>
        ${apps.map((a, i) => { const isBest = showBest && best && mx > 0 && unique && vals[i] === mx;
          return `<div class="cmp2-cell${isBest ? " best" : ""}" style="animation-delay:${(ri * 22 + i * 34)}ms">${disp(a)}${isBest ? `<span class="best-tag">Best</span>` : ""}</div>`; }).join("")}
        <div class="cmp2-cell cmp2-addcell"></div></div>`;
    }).join("");
    return head + body;
  }
  function renderCmp3Count(shown) {
    const c = $("#cmp3Count");
    if (c) c.textContent = `${state.compare.length} of 4 selected${state.compare.length < 4 ? ` · ${4 - state.compare.length} free` : " · board full"}`;
    const f = $("#cmp3PickCount");
    if (f && shown != null) f.textContent = `${shown} shown`;
  }
  const CMP3_LIMIT = 60;
  function cmp3ItemHtml(a) {
    const on = state.compare.includes(a.app.id);
    return `<button class="cmp3-item${on ? " on" : ""}" type="button" data-cadd="${a.app.id}"
      data-n="${esc(a.app.name.toLowerCase())}" data-c="${esc(a.app.category.toLowerCase())}" data-s="${a.readiness.score}">
      ${logoHtml(a)}<span class="cmp3-n">${esc(a.app.name)}</span>
      <span class="grade ${esc(a.readiness.grade)}">${esc(a.readiness.grade)}</span>
      <span class="cmp3-add">${on ? "✓" : "+"}</span></button>`;
  }
  /* Build the picker ONCE per modal open. Filtering only toggles [hidden] and
     re-orders with flexbox, so typing never rebuilds 100 rows + 100 icons. */
  function renderCmp3List() {
    const el = $("#cmp3List"); if (!el) return;
    const apps = ((state.snap && state.snap.apps) || []).slice().sort((x, y) => y.readiness.score - x.readiness.score);
    el.innerHTML = apps.map(cmp3ItemHtml).join("") +
      `<button class="cmp3-more" type="button" id="cmp3More" hidden>Show all</button>` +
      `<div class="empty" id="cmp3None" style="padding:18px;text-align:center" hidden>No applications match that search.</div>`;
    const more = $("#cmp3More");
    if (more) more.onclick = () => { el.dataset.all = "1"; more.hidden = true; applyCmp3Filter(el); renderCmp3Count(countShown(el)); };
    const shown = applyCmp3Filter(el);
    renderCmp3Count(shown);
  }
  const countShown = (el) => $$(".cmp3-item", el).filter(x => !x.hidden).length;
  function applyCmp3Filter(el) {
    const items = $$(".cmp3-item", el);
    const open = el.dataset.all === "1";
    let matched = 0, shown = 0;
    items.forEach((it) => {
      if (it.dataset.filtered === "1") return;              /* excluded by the search */
      matched++;
      const sel = state.compare.includes(+it.dataset.cadd);
      it.style.order = sel ? "0" : "1";                     /* picks float to the top */
      if (!sel && !open && shown >= CMP3_LIMIT) { it.hidden = true; return; }
      it.hidden = false; shown++;
    });
    const more = $("#cmp3More", el);
    if (more) { more.hidden = open || matched <= shown; more.textContent = `Show all ${matched} applications`; }
    const none = $("#cmp3None", el);
    if (none) none.hidden = matched !== 0;
    return shown;
  }
  function filterCmp3List(q) {
    const el = $("#cmp3List"); if (!el) return;
    const ql = String(q || "").trim().toLowerCase();
    $$(".cmp3-item", el).forEach(it => {
      const hit = !ql || (it.dataset.n || "").indexOf(ql) >= 0 || (it.dataset.c || "").indexOf(ql) >= 0;
      it.dataset.filtered = hit ? "0" : "1";
      if (!hit) it.hidden = true;
    });
    const shown = applyCmp3Filter(el);
    renderCmp3Count(shown);
  }
  function renderCmp3View() {
    const v = $("#cmp3View"); if (!v) return;
    const apps = cmpApps(), n = apps.length;
    if (!n) {
      v.innerHTML = `<div class="cmp3-empty">${svg("apps", 1.4)}<div><b>Build your comparison</b>
        <span>Search the list and click applications to add them: the grid appears the moment you pick the first app, up to 4 side by side, best value highlighted per metric.</span></div></div>`;
      return;
    }
    v.innerHTML = `<div class="cmp-flex"><div class="cmp-gridpart n${n}">${cmpGridHtml(apps)}</div></div>` +
      `<div class="cmp2-foot">${n > 1 ? "Best value is highlighted per metric." : "One app on the board with every live metric."}` +
      `${n < 4 ? " Add another from the list, or press the + rail in the grid." : " All four slots in use."}` +
      ` Click an app header to open its full evidence dossier.</div>`;
    $$("#modal .cmp2-app").forEach((el, i) => el.addEventListener("click", () => openModal(apps[i].app.id)));
    const ac = $("#modal [data-caddfocus]");
    if (ac) ac.onclick = (e) => { e.stopPropagation(); const si = $("#cmp3Search"); if (si) { si.focus(); if (si.scrollIntoView) si.scrollIntoView({ block: "nearest" }); } };
    scanNums(v);
  }
  function openCompare() {
    $("#modal").classList.add("cmpwin");
    $("#modal").innerHTML = `
      <div class="mhead cmp3-mhead">
        <div><div class="cmp2-kicker">Comparison</div><h3>Compare applications</h3>
          <div class="mh-sub"><span id="cmp3Count">0 of 4 selected · best value highlighted per metric</span></div></div>
        <button class="xbtn" id="closeModal" aria-label="Close">✕</button>
      </div>
      <div class="cmp3">
        <aside class="cmp3-pick">
          <div class="cmp3-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.2-3.2"/></svg>
            <input id="cmp3Search" placeholder="Search apps to add…" autocomplete="off" spellcheck="false">
          </div>
          <div class="cmp3-list" id="cmp3List"></div>
          <div class="cmp3-pickfoot"><span>Up to 4 · click to add / remove</span><span class="cmp3-count" id="cmp3PickCount"></span></div>
        </aside>
        <div class="cmp3-view" id="cmp3View"></div>
      </div>`;
    $("#modal").classList.add("open"); $("#backdrop").classList.add("open"); lockWindowScroll("modal");
    $("#closeModal").onclick = closeModal;
    const si = $("#cmp3Search");
    if (si) si.oninput = () => filterCmp3List(si.value);
    const lst = $("#cmp3List");
    if (lst) lst.onclick = (e) => {
      const b = e.target.closest ? e.target.closest("[data-cadd]") : null; if (!b) return;
      const id = +b.dataset.cadd, had = state.compare.includes(id);
      if (!had && state.compare.length >= 4) { toast("Compare up to 4 apps", "slash"); return; }
      toggleCompare(id);
      b.classList.toggle("on", !had);
      const add = b.querySelector(".cmp3-add"); if (add) add.textContent = !had ? "✓" : "+";
      if (!had) { b.classList.remove("justadded"); void b.offsetWidth; b.classList.add("justadded"); }
      applyCmp3Filter(lst); renderCmp3Count(countShown(lst)); renderCmp3View();
    };
    /* Render picker + grid one frame later so the modal's rise animation is
       never blocked by list layout: this is what fixes the open lag. */
    requestAnimationFrame(() => { renderCmp3List(); renderCmp3View(); });
  }

  function setUnread() { state.unread = ((state.snap && state.snap.alerts) || []).filter(a => !a.read).length; renderBell(); }
  function renderBell() { const b = $("#bellBadge"); if (!b) return; b.textContent = state.unread > 99 ? "99+" : state.unread; b.classList.toggle("show", state.unread > 0);
    const dn = $("#dwAlertN"); if (dn) { dn.textContent = b.textContent; dn.classList.toggle("show", state.unread > 0); } }
  function renderAlerts() {
    const list = (state.snap && state.snap.alerts) || [], el = $("#alertsList"); if (!el) return;
    if (!list.length) { el.innerHTML = `<div class="empty" style="padding:20px;text-align:center">No alerts yet. Open an app and hit <b>Watch</b> to be notified when it ships an official MCP or goes down.</div>`; return; }
    el.innerHTML = list.map(a => `<div class="alert ${a.read ? "" : "unread"} ${esc(a.event)}" ${a.app_id ? `data-id="${a.app_id}"` : ""}>
      <div class="aic">${svg(a.event === "site_down" ? "slash" : a.event === "official_mcp" ? "shield" : "bolt")}</div>
      <div class="abody"><div class="atop"><span class="aname">${esc(a.app || "System")}</span><span class="ats">${esc(timeAgo(a.ts))}</span></div>
      <div class="amsg">${esc(a.message)}</div></div></div>`).join("");
    $$("#alertsList .alert[data-id]").forEach(x => x.onclick = () => { $("#bellWrap").classList.remove("open"); openModal(+x.dataset.id); });
  }
  async function markAlertsRead() {
    if (state.live) { try { await fetch("/api/alerts/read", { method: "POST" }); } catch (e) {} await loadSnapshot(); }
    else { ((state.snap && state.snap.alerts) || []).forEach(a => a.read = true); state.unread = 0; renderBell(); renderAlerts(); }
  }
  function isWatched(id) { return ((state.snap && state.snap.watches) || []).some(w => w.app_id === id); }
  async function toggleWatch(a) {
    if (!state.live) { toast("Start the backend to watch apps", "bolt"); return; }
    const watching = isWatched(a.app.id);
    try {
      if (watching) { await fetch("/api/watch/" + a.app.id, { method: "DELETE" }); toast("Stopped watching " + a.app.name); }
      else { await fetch("/api/watch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app_id: a.app.id, events: ["official_mcp", "site_down", "any"] }) }); toast("Watching " + a.app.name + " · official MCP, downtime & changes", "shield"); }
      await loadSnapshot(); openModal(a.app.id);
    } catch (e) { toast("Watch failed", "slash"); }
  }


  /* ---------------- command palette (universal, live) ---------------- */
  function openCmdk() {
    setDrawer(false);
    state.cmdk.open = true; state.cmdk.idx = 0; state.cmdk.query = ""; state.cmdk.registry = []; state.cmdk.regQuery = ""; state.cmdk.regLoading = false;
    $("#cmdk").classList.add("open"); $("#cmdkInput").value = ""; renderCmdk(); setTimeout(() => $("#cmdkInput").focus(), 20);
  }
  function closeCmdk() { state.cmdk.open = false; $("#cmdk").classList.remove("open"); }

  function cmdkOnInput(val) {
    state.cmdk.query = val; state.cmdk.idx = 0;
    renderCmdk();                                  // instant curated matches
    clearTimeout(state.cmdk._t);
    const q = val.trim();
    if (state.live && q.length >= 2) {
      state.cmdk.regLoading = true; renderCmdk();
      state.cmdk._t = setTimeout(() => fetchRegistry(q), 320);   // debounced live registry
    } else { state.cmdk.registry = []; state.cmdk.regQuery = q; state.cmdk.regLoading = false; renderCmdk(); }
  }
  async function fetchRegistry(q) {
    try {
      const r = await fetch("/api/search?q=" + encodeURIComponent(q) + "&limit=7", { cache: "no-store" });
      const d = sanitizeDashes(await r.json());
      if (state.cmdk.query.trim() === q) { state.cmdk.registry = d.registry || []; state.cmdk.regQuery = q; }
    } catch (e) { if (state.cmdk.query.trim() === q) { state.cmdk.registry = []; state.cmdk.regQuery = q; } }
    state.cmdk.regLoading = false; renderCmdk();
  }

  function renderCmdk() {
    const q = (state.cmdk.query || "").trim(), ql = q.toLowerCase();
    const apps = (state.snap && state.snap.apps) || [];
    const items = [];
    let html = "", i = 0;
    const row = (inner, idx) => `<div class="cmdk-item ${idx === state.cmdk.idx ? "sel" : ""}" data-i="${idx}" style="--i:${Math.min(idx, 14)}">${inner}</div>`;
    const trackedInner = (a) => `${logoHtml(a)}<div style="min-width:0"><div class="ci-name">${esc(a.app.name)}</div><div class="ci-cat">${esc(a.app.category)}${a.tools_count ? ` · ${a.tools_count} live tools` : ""}${dlOf(a) ? ` · ${fmtNum(dlOf(a))}/mo` : ""}</div></div><div class="ci-right"><span class="ci-go">open</span>${statusBadge(a.mcp.status)}<span class="grade ${esc(a.readiness.grade)}" style="width:22px;height:22px;font-size:11px">${esc(a.readiness.grade)}</span></div>`;
    const freeInner = (name, sub, dom) => `${domainLogo(dom, name, "grad")}<div style="min-width:0"><div class="ci-name">${esc(name)}</div><div class="ci-cat">${esc(sub)}</div></div><div class="ci-right"><span class="ci-go">live</span><span class="kbd">fetch</span></div>`;
    const pushTracked = (a) => { items.push({ type: "tracked", id: a.app.id, a }); html += row(trackedInner(a), i++); };
    const pushFree = (name, sub, dom) => { items.push({ type: "fetch", name, website: dom ? "https://" + dom : "" }); html += row(freeInner(name, sub, dom), i++); };

    if (!q) {
      if (state.recent.length) {
        html += `<div class="cmdk-group">Recent</div>`;
        state.recent.slice(0, 6).forEach(r => {
          const a = apps.find(x => x.app.id === r.id || x.app.name.toLowerCase() === String(r.name).toLowerCase());
          if (a) pushTracked(a); else pushFree(r.name, "Recent · fetch live", r.domain || "");
        });
      }
      const pop = (state.snap && state.snap.popular) || [];
      if (pop.length) {
        html += `<div class="cmdk-group">Popular fetches</div>`;
        pop.slice(0, 6).forEach(p => {
          const a = apps.find(x => x.app.name.toLowerCase() === p.name.toLowerCase());
          if (a) pushTracked(a); else pushFree(p.name, `Fetched ${p.count}× · live lookup`, p.domain || "");
        });
      }
      if (!items.length) {
        html += `<div class="cmdk-group">Top apps</div>`;
        apps.slice().sort((x, y) => y.readiness.score - x.readiness.score).slice(0, 8).forEach(pushTracked);
      }
    } else {
      const tracked = apps.filter(a => a.app.name.toLowerCase().includes(ql) || a.app.category.toLowerCase().includes(ql)).slice(0, 12);
      tracked.forEach(pushTracked);
      const reg = (state.cmdk.regQuery === q) ? (state.cmdk.registry || []) : [];
      if (state.cmdk.regLoading) html += `<div class="cmdk-group">Live from MCP registry</div>` +
        [0, 1].map(k => `<div class="cmdk-skel"><span class="applogo"><span class="ini">··</span></span><span style="min-width:0;flex:1"><i style="width:${58 - k * 16}%"></i></span></div>`).join("");
      if (reg.length) {
        html += `<div class="cmdk-group">Live from MCP registry</div>`;
        reg.forEach(r => { items.push({ type: "registry", ...r }); html += row(`${domainLogo(r.domain || hostname(r.repository_url || ""), r.label)}<div style="min-width:0"><div class="ci-name">${esc(r.label)} ${r.vendor_like ? `<span class="tag" style="color:#5ff0bb;background:var(--ok-bg);border:1px solid rgba(52,211,153,.25)">vendor-like</span>` : ""}</div><div class="ci-cat">${esc(r.server)}${r.description ? " · " + esc(r.description) : ""}</div></div><div class="ci-right"><span class="ci-go">fetch live</span><span class="kbd">↵</span></div>`, i++); });
      }
      const exact = tracked.some(a => a.app.name.toLowerCase() === ql);
      if (q.length >= 2 && !exact) { html += `<div class="cmdk-group">Anywhere</div>`; pushFree(q, "Not in the tracked 100 · live registry lookup, endpoint probe & score", q.indexOf(".") > 0 ? q.toLowerCase() : ""); }
    }
    state.cmdk.items = items;
    $("#cmdkRes").innerHTML = html || `<div class="empty" style="padding:24px;text-align:center">Type to search your apps, the live MCP registry, or fetch any app.</div>`;
    $("#cmdkCount").textContent = q ? `${items.length} result${items.length === 1 ? "" : "s"}` : `${items.length} recent & popular`;
    // item listeners are delegated once in bindCmdk() - re-rendering results
    // only replaces markup, never re-binds, so typing stays lag-free.
  }

  function runCmdkItem(item) {
    if (!item) return;
    if (item.type === "tracked") { closeCmdk(); openModal(item.id); }
    else if (item.type === "registry") { closeCmdk(); lookupApp(item.slug || item.label); }
    else if (item.type === "fetch") { closeCmdk(); lookupApp(item.name); }
  }
  function cmdkMove(d) {
    const n = state.cmdk.items.length; if (!n) return;
    state.cmdk.idx = (state.cmdk.idx + d + n) % n;
    $$("#cmdkRes .cmdk-item[data-i]").forEach(x => x.classList.toggle("sel", +x.dataset.i === state.cmdk.idx));
    const sel = $("#cmdkRes .cmdk-item.sel"); if (sel) sel.scrollIntoView({ block: "nearest" });
  }


  /* ---------------- export ---------------- */
  function doExport(fmt) {
    const apps = state.snap.apps || []; let blob, filename;
    if (fmt === "json") { blob = new Blob([JSON.stringify({ generated_at: state.snap.generated_at, app_name: state.snap.app_name, stats: state.snap.stats, apps }, null, 2)], { type: "application/json" }); filename = "mcp-integration-data.json"; }
    else {
      const head = ["id", "name", "category", "website", "mcp_status", "mcp_servers", "official_servers", "live_tools", "generic_gateway", "auth_gated", "github_repo", "stars", "last_commit", "license", "language", "archived", "downloads_last_month", "site_status", "readiness_score", "readiness_grade"];
      const q = v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
      const lines = apps.map(a => [a.app.id, a.app.name, a.app.category, a.app.website, a.mcp.status, a.mcp.matched,
        a.mcp.servers.filter(s => s.classification === "vendor_official").map(s => s.name).join("; "), a.tools_count || "", a.generic_gateway ? "yes" : "no", a.auth_gated ? "yes" : "no",
        a.github.full_name || "", a.github.stars ?? "", a.github.pushed_at || "", a.github.license || "", a.github.language || "", a.github.archived ? "yes" : "no", dlOf(a), a.liveness ? (a.liveness.status_code ?? "") : "", a.readiness.score, a.readiness.grade].map(q).join(","));
      blob = new Blob([[head.map(q).join(","), ...lines].join("\n")], { type: "text/csv" }); filename = "mcp-integration-data.csv";
    }
    const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url);
    toast("Exported " + apps.length + " apps → " + filename, "download");
  }

  /* ---------------- refresh ---------------- */
  async function refreshAll() {
    if (!state.live) { toast("Snapshot mode; start the backend to refresh live", "bolt"); return; }
    $("#refreshBtn").disabled = true; $("#refreshLabel").textContent = "Refreshing";
    state.refreshing = true; setLive(true, true);
    $("#refreshLabel").textContent = "Refreshing";
    try { await fetch("/api/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); toast("Live refresh started, streaming updates", "bolt"); }
    catch (e) { state.refreshing = false; setLive(true, false); toast("Refresh failed; is the backend running?", "slash"); }
  }
  async function refreshIds(ids) {
    if (!state.live) return;
    const m = $("#modal"); if (m) m.classList.add("refreshing");
    try {
      await fetch("/api/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
      toast("Re-fetching app…", "bolt");
      await new Promise(res => setTimeout(res, 3500));
      await loadSnapshot();
      if (m) m.classList.remove("refreshing");
      openModal(ids[0]);
    } catch (e) { if (m) m.classList.remove("refreshing"); toast("Refresh failed", "slash"); }
  }

  /* ---------------- methodology: live figures + expandable stages ---------------- */
  const METH_LIVE = {
    official: (st) => [st.mcp_vendor_official, ""],
    community: (st) => [st.mcp_community, ""],
    tools: (st) => [st.total_tools, ""],
    adoption: (st) => [st.total_downloads, "k"],
    health: (st) => [st.maintained_repos, ""],
    liveness: (st) => [st.websites_reachable, ""],
    score: (st) => [Math.round((Number(st.avg_readiness) || 0) * 10), "dec1"],
  };
  function populateMethodology() {
    const s = state.snap; if (!s) return;
    const st = s.stats || {};
    $$("[data-methlive]").forEach(el => {
      const fn = METH_LIVE[el.dataset.methlive]; if (!fn) return;
      const [v, fmt] = fn(st);
      setNum(el, v, fmt === "k" ? (x => fmtNum(x)) : fmt === "dec1" ? (x => (x / 10).toFixed(1)) : null);
    });
    const avg = Number(st.avg_readiness) || 0;
    const arc = $("#msArc");
    if (arc) arc.style.strokeDashoffset = String(314.16 * (1 - Math.max(0, Math.min(100, avg)) / 100));
    const mv = $("#msAvg");
    if (mv) setNum(mv, Math.round(avg * 10), (x) => (x / 10).toFixed(1));
  }
  let methViewCache = null;
  function updateSpine() {
    const v = methViewCache || (methViewCache = $("#methodologyView"));
    if (!v || !v.classList.contains("open")) return;
    const ol = $(".pipeline", v); if (!ol) return;
    const r = ol.getBoundingClientRect(), vh = window.innerHeight || 800;
    const p = Math.max(0, Math.min(1, (vh * 0.8 - r.top) / (r.height || 1)));
    ol.style.setProperty("--spine", p.toFixed(3));
  }
  let methBound = false;
  function bindMethodology() {
    if (methBound) return; methBound = true;
    const ol = $("#methodologyView .pipeline"); if (!ol || !ol.addEventListener) return;
    ol.addEventListener("click", (e) => {
      const hit = e.target.closest ? e.target.closest(".pipe-hit") : null; if (!hit) return;
      const li = hit.closest(".pipe"); if (!li) return;
      const open = li.classList.toggle("open");
      hit.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  /* ---------------- full-screen views (the pricing pattern, generalised) ---------------- */
  /* v36: the REAL window scroll-lock. Since v32 pinned html{overflow-x:hidden},
     body{overflow:hidden} no longer propagates to the viewport, so opening a
     view from a mid-page place (dive card, footer, metrics tile) left the
     WINDOW itself scrollable behind the opaque sheet: two scrollbar thumbs, a
     retained offset, the dashboard sliding under the view. Lock the ROOT
     element alone: never the body, because a body scroll box would
     detach position:sticky and drop the nav while a view is open.
     Remember exactly where the reader was and put them back there on
     close. Reason-keyed, so views and modals may overlap safely. */
  const scrollLocks = new Set();
  let pvScrollY = 0;
  function lockWindowScroll(who) {
    if (scrollLocks.size === 0) pvScrollY = window.scrollY || window.pageYOffset || 0;
    scrollLocks.add(who);
    document.documentElement.style.overflow = "hidden";
    document.body.classList.add("scroll-locked");
  }
  function unlockWindowScroll(who) {
    if (!scrollLocks.has(who)) return;
    scrollLocks.delete(who);
    if (scrollLocks.size) return;
    document.documentElement.style.overflow = "";
    document.body.classList.remove("scroll-locked");
    try {
      const st = document.documentElement.style, prev = st.scrollBehavior;
      st.scrollBehavior = "auto";                  /* the restore must never animate */
      window.scrollTo(0, pvScrollY);
      st.scrollBehavior = prev;
    } catch (e) {}
  }
  function closeAllViews() {
    VIEWS.forEach(v => { const el = $(VIEW_EL[v]); if (el) el.classList.remove("open"); });
    state.view_open = "";
    document.body.classList.remove("pv-on");
    unlockWindowScroll("view");
    syncViewChrome();
  }
  function syncViewChrome() {
    const open = viewOpen();
    $$(".nav-links a[data-nav]").forEach(a => {
      const wants = a.dataset.view ? (a.dataset.view === open) : (!open && a.dataset.nav === state.spyCur);
      a.classList.toggle("active", !!wants);
    });
    $$("[data-openview]").forEach(b => b.classList.toggle("active", b.dataset.openview === open));
  }
  function renderChartsNow() {
    /* the trend line and the adoption scatter are measured from their container,
       so they must be redrawn once the view they live in is actually visible */
    try { renderTrend(true); } catch (e) {}
    try { if (state.snap && state.snap.apps) renderAnScatter(state.snap.apps, true); } catch (e) {}
  }
  /* Intelligence now groups its six instruments into three tabs of two, so the
     window reads as three compact spreads instead of one long stack. */
  function setIvPart(part) {
    const next = ["supply", "health", "adoption"].indexOf(part) >= 0 ? part : "supply";
    state.ivPart = next;
    $$("#ivTabs [data-ivpart]").forEach(b => {
      const on = b.dataset.ivpart === next;
      b.classList.toggle("active", on); b.setAttribute("aria-selected", on ? "true" : "false");
    });
    [["supply", "#ivpSupply"], ["health", "#ivpHealth"], ["adoption", "#ivpAdoption"]].forEach(([k, sel]) => {
      const p = $(sel); if (p) p.hidden = k !== next;
    });
    const pane = next === "supply" ? $("#ivpSupply") : next === "health" ? $("#ivpHealth") : $("#ivpAdoption");
    if (pane) {
      scanNums(pane);
      $$(".reveal", pane).forEach(e => { e.classList.remove("out"); e.classList.add("in"); });
      if (next === "adoption") requestAnimationFrame(() => { try { if (state.snap && state.snap.apps) renderAnScatter(state.snap.apps); } catch (e) {} });
    }
  }
  function openView(name, tab) {
    if (VIEWS.indexOf(name) < 0) return;
    if (name === "pricing") { openPricing(); return; }
    closeModal(); closeCommCard(); setDrawer(false); closeCmdk();
    VIEWS.forEach(v => { const el = $(VIEW_EL[v]); if (el) el.classList.toggle("open", v === name); });
    state.view_open = name;
    document.body.classList.add("pv-on");
    lockWindowScroll("view");
    if (name === "intelligence") {
      try { renderAnalytics(); } catch (e) {}
      setIvPart(tab && ["supply", "health", "adoption"].indexOf(tab) >= 0 ? tab : (state.ivPart || "supply"));
    }
    if (name === "methodology") { try { populateMethodology(); } catch (e) {} requestAnimationFrame(updateSpine); }
    const el = $(VIEW_EL[name]); if (el) el.scrollTop = 0;
    try { if (history.replaceState) history.replaceState(null, "", "#" + name); } catch (e) {}
    /* replay the entrance motion every single time the window is opened */
    $$(".reveal", el).forEach(e => { e.classList.remove("in"); e.classList.add("out"); });
    void (el && el.offsetWidth);
    requestAnimationFrame(() => { $$(".reveal", el).forEach(e => e.classList.remove("out")); revealVisible(); observeReveal(); });
    syncViewChrome();
  }
  function closeView() {
    const was = viewOpen();
    if (!was) return false;
    closeAllViews();
    try {
      if (history.replaceState && (location.hash || "").slice(1) === was) {
        history.replaceState(null, "", location.pathname + (location.search || ""));
      }
    } catch (e) {}
    return true;
  }

  /* ---------------- pricing view (full-screen; header + chrome stay) ---------------- */
  function pricingOpen() { const v = $("#pricingView"); return !!(v && v.classList.contains("open")); }
  function openPricing() {
    const v = $("#pricingView"); if (!v) return;
    closeModal(); closeCommCard(); setDrawer(false); closeCmdk();
    VIEWS.forEach(x => { const el = $(VIEW_EL[x]); if (el && x !== "pricing") el.classList.remove("open"); });
    state.view_open = "pricing";
    v.scrollTop = 0; v.classList.add("open");
    if (document.body.classList) document.body.classList.add("pv-on");
    lockWindowScroll("view");
    try { if (history.replaceState) history.replaceState(null, "", "#pricing"); } catch (e) {}
    syncViewChrome();
  }
  function closePricing() { closeView(); }

  /* ---------------- reveal ---------------- */
  let io;
  let reducedMotion = false;
  try { reducedMotion = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e) {}
  const markIn = (e) => {
    e.classList.remove("out");
    e.classList.add("in");
    rearmListCache = null;   /* it now belongs in the re-arm set */
    if (e.classList.contains("ins-rev")) insDone = true;
    if (e.classList.contains("sig")) sigDone = true;
  };
  /* Only elements that opted in with [data-replay] ever re-arm, so nothing that
     is mid-read can flicker: the whole page never re-animates, the hero panels,
     cards and charts do. */
  const markOut = (e) => {
    if (reducedMotion || !e.dataset || !("replay" in e.dataset)) return;
    if (!e.classList.contains("in") || e.classList.contains("out")) return;
    e.classList.remove("in"); e.classList.add("out");
    revealListCache = null;  /* it now belongs in the reveal set */
    void e.offsetWidth;   /* restart any entrance animation keyed off .in */
  };
  /* Scroll-path caches: the handler used to re-query the DOM and force several
     layouts on every animation frame. Lists and scrollHeight are cached and
     invalidated by render()/resize; the reveal work is throttled to ~120ms. */
  let revealListCache = null, rearmListCache = null, spyElCache = null, scrollMaxCache = -1, lastRevealPass = 0;
  function invalidateScrollCaches() { revealListCache = null; rearmListCache = null; spyElCache = null; scrollMaxCache = -1; methViewCache = null; }
  const revealList = () => (revealListCache || (revealListCache = $$(".reveal:not(.in)")));
  const rearmList = () => (rearmListCache || (rearmListCache = $$(".reveal.in[data-replay]")));
  function markRevealed(e) { if (revealListCache) revealListCache = revealListCache.filter(x => x !== e); };

  /* Re-arm once the element has fully left the viewport in EITHER direction, so
     scrolling away and back replays the entrance instead of showing a dead page.
     Only [data-replay] elements opt in, and only outside the viewport, so
     nothing that is currently being read can flicker. */
  function rearmOffscreen() {
    if (reducedMotion) return;
    const vh = window.innerHeight || 800;
    const list = rearmList();
    const hit = [];
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e.getBoundingClientRect) continue;
      const r = e.getBoundingClientRect();
      if (r.bottom < -140 || r.top > vh + 240) hit.push(e);
    }
    for (let i = 0; i < hit.length; i++) markOut(hit[i]);
  }
  const rearmAbove = rearmOffscreen;
  /* Position-based reveal: guarantees scroll-triggered entrances even where
     IntersectionObserver callbacks never fire (sandboxed/headless previews),
     and only ever reveals what is actually on screen - below-fold content
     keeps animating in AS you scroll. */
  function revealVisible() {
    const vh = window.innerHeight || 800;
    const list = revealList();
    /* phase 1: pure geometry reads (one layout for the whole batch) */
    const hit = [];
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e.getBoundingClientRect) { hit.push(e); continue; }
      const r = e.getBoundingClientRect();
      if (r.top < vh * 0.94 && r.bottom > 0) hit.push(e);
    }
    /* phase 2: writes only - never interleave with reads (layout thrash) */
    for (let i = 0; i < hit.length; i++) { markIn(hit[i]); markRevealed(hit[i]); }
  }
  function observeReveal() {
    if (!("IntersectionObserver" in window)) { $$(".reveal:not(.in)").forEach(markIn); return; }
    if (!io) io = new IntersectionObserver((es) => es.forEach(e => { if (e.isIntersecting) { markIn(e.target); io.unobserve(e.target); } }), { threshold: .08, rootMargin: "0px 0px -40px" });
    $$(".reveal:not(.in)").forEach(e => io.observe(e));
    setTimeout(revealVisible, 900);
  }

  /* ---------------- events ---------------- */
  function bind() {
    $("#refreshBtn").onclick = refreshAll;
    $("#backdrop").onclick = closeModal;
    $("#searchOpen").onclick = openCmdk;
    $("#cmdk").addEventListener("click", e => { if (e.target.id === "cmdk") closeCmdk(); });
    $("#cmdkInput").addEventListener("input", e => cmdkOnInput(e.target.value));
    $("#catFilter").addEventListener("change", e => { state.cat = e.target.value; renderView(); });
    $$("#statusChips .chipfilter").forEach(p => p.addEventListener("click", () => { $$("#statusChips .chipfilter").forEach(x => x.classList.remove("active")); p.classList.add("active"); state.status = p.dataset.status; renderView(); }));
    $$("#viewTabs button").forEach(b => b.addEventListener("click", () => { state.view = b.dataset.view; renderView(); }));
    $$(".nav-links a").forEach(a => a.addEventListener("click", () => { const v = a.dataset.nav; if (["explorer", "leaderboard", "opportunities"].includes(v)) { state.view = v; renderView(); } }));
    const closeDropdowns = () => $$(".dropdown").forEach(d => d.classList.remove("open"));
    $("#exportBtn").onclick = e => { e.stopPropagation(); const d = $("#exportBtn").closest(".dropdown"); const o = d.classList.contains("open"); closeDropdowns(); d.classList.toggle("open", !o); };
    $("#bellBtn").onclick = e => { e.stopPropagation(); const d = $("#bellWrap"); const o = d.classList.contains("open"); closeDropdowns(); d.classList.toggle("open", !o); if (!o) { renderAlerts(); if (state.unread) markAlertsRead(); } };
    $("#markRead").onclick = e => { e.stopPropagation(); markAlertsRead(); };
    document.addEventListener("click", closeDropdowns);
    $$("#exportMenu a").forEach(a => a.addEventListener("click", e => { e.preventDefault(); doExport(a.dataset.fmt); closeDropdowns(); }));
    $("#compareGo").onclick = () => openCompare();
    $("#compareClear").onclick = () => { state.compare = []; renderCompareBar(); renderView(); };
    const ufb = $("#useFreeBtn"); if (ufb) ufb.onclick = () => toast("You're on the free Explorer tier ✦", "check");
    const fcta = $("#pvFreeCta"); if (fcta) fcta.onclick = () => toast("You're on the free Explorer tier: everything above, no card needed ✦", "check");
    const mcpL = $("#mcpLink"); if (mcpL) mcpL.onclick = e => { e.preventDefault(); toast("Run: python -m src.mcp_server", "bolt"); };
    const fcsv = $("#fCsv"); if (fcsv) fcsv.onclick = e => { e.preventDefault(); doExport("csv"); };
    const fjson = $("#fJson"); if (fjson) fjson.onclick = e => { e.preventDefault(); doExport("json"); };
    /* ---- signals feed tabs ---- */
    $$("#sigTabs .chipfilter").forEach(c => c.addEventListener("click", () => {
      $$("#sigTabs .chipfilter").forEach(x => x.classList.remove("active")); c.classList.add("active");
      state.sigFilter = c.dataset.sig || ""; renderSignals();
    }));
    /* ---- pricing view: every pricing entry point opens the dedicated view ---- */
    $$("[data-pricing]").forEach(a => a.addEventListener("click", e => { e.preventDefault(); closeDropdowns(); setDrawer(false); closeModal(); openPricing(); }));
    const pvBack = $("#pvBack"); if (pvBack) pvBack.onclick = closePricing;
    document.addEventListener("keydown", e => {
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !/input|textarea/i.test(document.activeElement.tagName) && !state.cmdk.open)) { e.preventDefault(); state.cmdk.open ? closeCmdk() : openCmdk(); return; }
      if (e.key === "Escape") { if (viewOpen()) closeView(); else if (drawerOpen()) setDrawer(false); else { const cc = $("#commCard"); if (cc && cc.classList.contains("open")) closeCommCard(); else if (state.cmdk.open) closeCmdk(); else closeModal(); } }
      if (state.cmdk.open) {
        if (e.key === "ArrowDown") { e.preventDefault(); cmdkMove(1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); cmdkMove(-1); }
        else if (e.key === "Enter") { e.preventDefault(); runCmdkItem(state.cmdk.items[state.cmdk.idx]); }
      }
    });
    let scrollTick = false;
    const sp = $("#scrollProgress");
    const ambDeep = $("#ambDeep"), meth = $("#methodology");
    const updateDeep = () => {
      if (!ambDeep || !meth || typeof meth.getBoundingClientRect !== "function") return;
      const vh = window.innerHeight || 800;
      const r = meth.getBoundingClientRect();
      ambDeep.classList.toggle("on", r.top < vh * 0.92);
    };
    const updateSP = () => {
      const h = document.documentElement;
      if (scrollMaxCache < 0) scrollMaxCache = h.scrollHeight - h.clientHeight;
      const max = scrollMaxCache;
      const p = max > 0 ? Math.min(1, (window.scrollY || h.scrollTop) / max) : 0;
      if (sp) sp.style.transform = "scaleX(" + p + ")";
    };
    /* ---- scrollspy: nav always mirrors where you are ---- */
    const SPY = [["overview", "#overview"], ["explorer", "#apps"], ["insights", "#insights"], ["dive", "#dive"]];
    const updateSpy = () => {
      if (!spyElCache) spyElCache = SPY.map(([k, sel]) => [k, document.querySelector(sel)]);
      let cur = "";
      for (let i = 0; i < spyElCache.length; i++) { const el = spyElCache[i][1]; if (el && el.getBoundingClientRect && el.getBoundingClientRect().top <= 140) cur = spyElCache[i][0]; }
      const next = cur === "dive" ? "insights" : cur;
      if (next !== state.spyCur) { state.spyCur = next; syncViewChrome(); }
    };
    window.addEventListener("scroll", () => {
      if (scrollTick) return; scrollTick = true;
      requestAnimationFrame(() => {
        /* per-frame work is now just a class toggle + one transform write
           (both layout-free); everything that reads geometry runs at ~8Hz,
           which is imperceptible for a scrollspy dot, an ambient orb and a
           gradient spine, and removes the forced layouts from the scroll path */
        $("#nav").classList.toggle("scrolled", window.scrollY > 8);
        updateSP();
        const now = performance.now();
        if (now - lastRevealPass > 120) {
          lastRevealPass = now;
          updateDeep(); updateSpy(); updateSpine(); revealVisible(); rearmOffscreen();
        }
        scrollTick = false;
      });
    }, { passive: true });
    window.addEventListener("resize", () => { invalidateScrollCaches(); updateSP(); updateDeep(); updateSpy(); }, { passive: true });
    updateSP(); updateDeep(); updateSpy();
    $("#themeBtn").onclick = toggleTheme;
    $("#heroSearch").onclick = openCmdk;
    /* ---- home: the one obvious way back to the top of the dashboard ---- */
    const goHome = () => {
      closeAllViews(); closeModal(); closeCommCard(); setDrawer(false);
      window.scrollTo({ top: 0, behavior: "smooth" });
      try { if (history.replaceState) history.replaceState(null, "", location.pathname + (location.search || "")); } catch (e) {}
    };
    const hb = $("#homeBtn"); if (hb) hb.onclick = goHome;
    const lgl = $("#logoLink");
    if (lgl) lgl.addEventListener("click", e => { if (viewOpen()) { e.preventDefault(); goHome(); } });
    $$("[data-home]").forEach(a => a.addEventListener("click", e => { e.preventDefault(); goHome(); }));
    /* ---- deep-dive views: from the toolbar, drawer, footer or a card ---- */
    $$("[data-view]").forEach(a => a.addEventListener("click", e => {
      e.preventDefault(); closeDropdowns(); setDrawer(false);
      openView(a.dataset.view, a.dataset.tab || "");
    }));
    $$("[data-openview]").forEach(b => b.addEventListener("click", () => openView(b.dataset.openview, b.dataset.tab || "")));
    $$("[data-closeview]").forEach(b => b.addEventListener("click", () => closeView()));
    $$(".rail-tab").forEach(b => b.addEventListener("click", () => setRailTab(b.dataset.rail)));
    /* help accordion: one smooth grid-rows expand per question */
    const hv = $("#helpView");
    if (hv) hv.addEventListener("click", (e) => {
      const t = e.target.closest ? e.target.closest("[data-hjump]") : null;
      if (t) {
        const g = document.getElementById(t.dataset.hjump);
        if (g) { g.scrollIntoView({ behavior: "smooth", block: "start" }); g.classList.remove("ping"); void g.offsetWidth; g.classList.add("ping"); }
        return;
      }
      const q = e.target.closest ? e.target.closest(".hq") : null; if (!q) return;
      const item = q.closest(".hq-item"); if (!item) return;
      const open = item.classList.toggle("open");
      q.setAttribute("aria-expanded", open ? "true" : "false");
    });
    $$("#ivTabs [data-ivpart]").forEach(b => b.addEventListener("click", () => setIvPart(b.dataset.ivpart)));
    bindMethodology();
    /* the methodology window scrolls its own container, not the page */
    const mv = $("#methodologyView");
    if (mv) mv.addEventListener("scroll", () => updateSpine(), { passive: true });
    bindCmdk(); bindCommCard(); syncViewChrome();
    /* ---- dashboard drawer ---- */
    let dwOpen = false;
    try { dwOpen = localStorage.getItem("mcp_drawer") === "1"; } catch (e) {}
    setDrawer(dwOpen); syncDrawerView();
    const dBtn = $("#drawerBtn"); if (dBtn) dBtn.onclick = () => setDrawer(!drawerOpen());
    const dClose = $("#drawerClose"); if (dClose) dClose.onclick = () => setDrawer(false);
    const dScrim = $("#drawerScrim"); if (dScrim) dScrim.onclick = () => setDrawer(false);
    $$("[data-dnav]").forEach(a => a.addEventListener("click", () => setDrawer(false)));
    $$("[data-dview]").forEach(b => b.addEventListener("click", () => { state.view = b.dataset.dview; renderView(); setDrawer(false); const t = $("#apps"); if (t && t.scrollIntoView) t.scrollIntoView({ behavior: "smooth", block: "start" }); }));
    const dws = $("#dwSearch"); if (dws) dws.onclick = () => { setDrawer(false); openCmdk(); };
    const dwr = $("#dwRefresh"); if (dwr) dwr.onclick = () => refreshAll();
    const dwc = $("#dwCsv"); if (dwc) dwc.onclick = () => doExport("csv");
    const dwj = $("#dwJson"); if (dwj) dwj.onclick = () => doExport("json");
    const dwt = $("#dwTheme"); if (dwt) dwt.onclick = () => toggleTheme();
    const dwa = $("#dwAlerts"); if (dwa) dwa.onclick = (e) => { e.stopPropagation(); setDrawer(false); const bw = $("#bellWrap"); if (bw) { bw.classList.add("open"); renderAlerts(); if (state.unread) markAlertsRead(); } };
    const dwgo = $("#dwCompare"); if (dwgo) dwgo.onclick = () => { setDrawer(false); setTimeout(openCompare, 300); };
    const dwcl = $("#dwClear"); if (dwcl) dwcl.onclick = () => { state.compare = []; renderCompareBar(); renderView(); };
    $("#navToggle").onclick = e => { e.stopPropagation(); const d = $("#navToggle").closest(".dropdown"); const o = d.classList.contains("open"); closeDropdowns(); d.classList.toggle("open", !o); };
    $$("#navMenu a").forEach(a => a.addEventListener("click", () => closeDropdowns()));
    window.addEventListener("resize", debounce(() => { renderTrend(true); if (viewOpen() === "intelligence") renderChartsNow(); }, 200), { passive: true });
  }

  async function init() {
    loadRecent(); themeIcon();
    await loadSnapshot();
    try { bind(); } catch (e) { if (window.console) console.error("bind failed:", e); }
    await loadActivity(); observeReveal();
    const mm = location.pathname.match(/\/app\/(\d+)/); if (mm) openModal(+mm[1]);
    const h0 = (location.hash || "").replace(/^#/, "");
    if (h0 === "pricing") openPricing();
    else if (h0 === "methodology") openView("methodology");
    else if (h0 === "analytics" || h0 === "intelligence") openView("intelligence");
    else if (h0 === "help") openView("help");
    if (!state.live) retryLive();
    // hero snapshot numbers keep juggling with live data between full renders
    setInterval(() => {
      if (!state.live || document.hidden) return;
      fetch("/api/stats", { cache: "no-store" }).then(r => r.json()).then(st => {
        setNum("#hsApps", st.total_apps ?? 0);
        setNum("#hsServers", st.total_mcp_servers ?? 0);
        setNum("#hsOfficial", st.mcp_vendor_official ?? 0);
        const probed = st.probed_endpoints || 0, resp = (st.open_endpoints || 0) + (st.auth_gated_endpoints || 0);
        if (probed) setNum("#hsLive", Math.round(resp / probed * 100), v => v + "%");
      }).catch(() => {});
    }, 12000);
    if (state.live) {
      setInterval(() => { if (state.snap) $("#updatedHint").textContent = "updated " + timeAgo(state.snap.generated_at); }, 15000);
      setInterval(() => { fetch("/api/health", { cache: "no-store" }).then(r => r.json()).then(h => {
        if (state.refreshing && !h.refresh_running) { state.refreshing = false; loadSnapshot(); }
        else setLive(true, h.refresh_running);
        /* pick up a server-side refresh we did not start: same data => no-op */
        if (!h.refresh_running && state.snap && h.generated_at && h.generated_at !== state.snap.generated_at) loadSnapshot();
      }).catch(() => {}); }, 5000);
    }
  }
  /* Minimal hook so the behaviour is testable from the browser harness. */
  window.__mcpx = { setNum, scanNums, scanBars, NUMMEMO, BARMEMO, state, render, renderAnalytics, renderView };

  init();
})();


