/* MCP Integration Explorer - Field Guide + Methodology engine (v2.1 premium).
 * Owns: help accordion, guide rail + scroll-spy, deep links, inline demos,
 * the hero constellation canvas (fixed: every radius clamped, frame-guarded),
 * the signal-wire pipeline (DOM/CSS, auto-advancing handoff), and the
 * methodology ladder + score-composition spectrum.
 * Vanilla JS. Transform/opacity motion only. prefers-reduced-motion respected.
 * Nothing in here may throw: a single bad frame must never kill a loop.
 */
(() => {
  "use strict";
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  let reduced = false, coarse = false;
  try {
    reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    coarse = matchMedia("(pointer: coarse)").matches;
  } catch (e) {}

  const view = document.getElementById("helpView");
  const mview = document.getElementById("methodologyView");
  if (!view) return;

  /* offsetTop is relative to the nearest POSITIONED ancestor (our cards are
     position:relative), so measure against the scrolling view instead. */
  function scrollTopOf(el) {
    try {
      return el.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop;
    } catch (e) { return 0; }
  }

  /* stagger indices for the CSS entrance choreography */
  $$("#fgStages .fg2-stage", view).forEach((el, i) => el.style.setProperty("--si", i));
  $$("#helpView .fg2-fcard").forEach((el, i) => el.style.setProperty("--fi", i));

  /* ======================================================================
     1. accordion
     ====================================================================== */
  let expandedAll = false;
  function setOpen(item, open) {
    const btn = $(".hq", item);
    item.classList.toggle("open", open);
    if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
  }
  function openItem(item, scroll) {
    if (!item) return;
    if (!expandedAll) $$(".hq-item.open", view).forEach(i => { if (i !== item) setOpen(i, false); });
    setOpen(item, true);
    initDemosIn(item);
    const g = item.closest(".hq-group");
    if (g) activateGroup(g.id, false);
    if (scroll) {
      view.scrollTo({ top: Math.max(0, scrollTopOf(item) - 90), behavior: reduced ? "auto" : "smooth" });
      item.classList.remove("ping"); void item.offsetWidth; item.classList.add("ping");
    }
  }
  view.addEventListener("click", (e) => {
    const jump = e.target.closest("[data-fgjump]");
    if (jump) { e.preventDefault(); expandSlug(jump.dataset.fgjump, true); return; }
    const q = e.target.closest(".hq");
    if (!q) return;
    const item = q.closest(".hq-item");
    const willOpen = !item.classList.contains("open");
    if (!expandedAll) $$(".hq-item.open", view).forEach(i => { if (i !== item) setOpen(i, false); });
    setOpen(item, willOpen);
    if (willOpen) initDemosIn(item);
  });
  function expandSlug(slug, scroll) {
    openItem(view.querySelector('.hq-item[data-slug="' + slug + '"]'), scroll);
  }
  const expandBtn = $("#fgExpand");
  if (expandBtn) expandBtn.addEventListener("click", () => {
    expandedAll = !expandedAll;
    expandBtn.textContent = expandedAll ? "Collapse all" : "Expand all";
    expandBtn.setAttribute("aria-pressed", String(expandedAll));
    $$(".hq-item", view).forEach(i => setOpen(i, expandedAll));
    if (expandedAll) $$(".hq-item", view).forEach(initDemosIn);
    syncCount();
  });
  function syncCount() {
    const c = $("#fgCount");
    if (!c) return;
    const open = $$(".hq-item.open", view).length;
    c.textContent = open ? open + " / 18 open" : "18 answers";
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && view.classList.contains("open")) {
      $$(".hq-item.open", view).forEach(i => setOpen(i, false));
      syncCount();
    }
  });

  /* ======================================================================
     2. rail: jump + scroll-spy + active state
     ====================================================================== */
  const rail = $("#fgNav");
  function activateGroup(id, scroll) {
    $$(".fg2-nav-item", rail || view).forEach(b => b.classList.toggle("active", b.dataset.group === id));
    if (scroll) {
      const g = document.getElementById(id);
      if (g) view.scrollTo({ top: Math.max(0, scrollTopOf(g) - 70), behavior: reduced ? "auto" : "smooth" });
    }
  }
  if (rail) rail.addEventListener("click", (e) => {
    const b = e.target.closest(".fg2-nav-item");
    if (b) activateGroup(b.dataset.group, true);
  });
  if ("IntersectionObserver" in window) {
    const spy = new IntersectionObserver((es) => {
      es.forEach(en => { if (en.isIntersecting) activateGroup(en.target.id, false); });
    }, { root: view, rootMargin: "-18% 0px -62% 0px" });
    $$(".hq-group", view).forEach(g => spy.observe(g));
  }

  /* ======================================================================
     3. inline demos (built lazily on first open)
     ====================================================================== */
  const demoBuilt = new Set();
  function initDemosIn(item) {
    ["demoScore", "demoStates", "demoFresh"].forEach(id => {
      if (item.querySelector("#" + id)) buildDemo(id);
    });
  }
  function buildDemo(id) {
    if (demoBuilt.has(id)) return;
    const box = document.getElementById(id);
    if (!box) return;
    demoBuilt.add(id);
    if (id === "demoScore") {
      const W = [["Official MCP", 28], ["Live capability", 14], ["Adoption", 16], ["Popularity", 14], ["Maintenance", 16], ["Availability", 12]];
      box.innerHTML = '<div class="fg-sliders">' + W.map(([l, w], i) =>
        '<label><span>' + l + ' <em>w ' + w + '%</em></span><input type="range" min="0" max="100" value="' + (55 + i * 6) + '" data-w="' + w + '" aria-label="' + l + ' attainment"></label>').join("") +
        '</div><div class="fg-gauge"><svg viewBox="0 0 96 96"><defs><linearGradient id="fgGaugeGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8B9DFF"/><stop offset="1" stop-color="#8B5CF6"/></linearGradient></defs><circle class="g-track" cx="48" cy="48" r="40"/><circle class="g-val" cx="48" cy="48" r="40"/></svg><div><b id="fgScoreN">0</b><span id="fgScoreG">grade C</span></div></div>';
      const upd = () => {
        let sum = 0;
        $$("input", box).forEach(s => { sum += (+s.value) * (+s.dataset.w) / 100; });
        const score = Math.round(sum);
        const g = score >= 80 ? "A" : score >= 60 ? "B" : score >= 40 ? "C" : score >= 20 ? "D" : "E";
        const n = $("#fgScoreN", box), gl = $("#fgScoreG", box);
        if (n) n.textContent = String(score);
        if (gl) gl.textContent = "grade " + g;
        const cval = $(".g-val", box), c = 2 * Math.PI * 40;
        if (cval) {
          cval.style.strokeDasharray = String(c);
          cval.style.strokeDashoffset = String(c * (1 - Math.max(0, Math.min(100, score)) / 100));
        }
      };
      box.addEventListener("input", upd); upd();
    } else if (id === "demoStates") {
      box.innerHTML = '<div class="fg-seg" role="tablist"><button class="on" data-s="official">Official</button><button data-s="community">Community</button><button data-s="none">None</button></div>' +
        '<div class="fg-appcard"><span class="badge official">Official</span><b>Acme</b><p></p></div>';
      const states = {
        official: { cls: "official", badge: "Official · domain-verified", p: "com.acme/mcp resolves to acme.com - the vendor ships this server itself." },
        community: { cls: "community", badge: "Community", p: "A third party built an Acme server; the registry text genuinely mentions Acme." },
        none: { cls: "none", badge: "None", p: "Nothing in the registry - a coverage gap, not proof the server does not exist." },
      };
      const card = $(".fg-appcard", box), seg = $(".fg-seg", box);
      const set = (k) => {
        const s = states[k]; if (!s || !card || !seg) return;
        card.className = "fg-appcard " + s.cls;
        const bd = $(".badge", card); if (bd) { bd.className = "badge " + s.cls; bd.textContent = s.badge; }
        const pp = $("p", card); if (pp) pp.textContent = s.p;
        $$("button", seg).forEach(b => b.classList.toggle("on", b.dataset.s === k));
      };
      seg.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) set(b.dataset.s); });
      set("official");
    } else if (id === "demoFresh") {
      box.innerHTML = '<div class="fg-fresh"><span class="led live"></span><b>last refresh: <i>—</i></b><span>the same clock the whole dashboard runs on</span></div>';
      const tick = () => {
        const st = window.__mcpx && window.__mcpx.state;
        const t = st && st.snap ? st.snap.generated_at : null;
        const el = $("i", box);
        if (!el) return;
        if (!t) { el.textContent = "snapshot mode"; return; }
        const s = Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 1000));
        el.textContent = s < 60 ? s + "s ago" : Math.round(s / 60) + "m ago";
      };
      tick(); setInterval(tick, 5000);
    }
  }

  /* ======================================================================
     4. hero constellation canvas  (the fixed "signal balls")
        - every radius goes through R() so a negative/NaN value can never
          reach ctx.arc (the old crash that killed the whole loop)
        - the rAF loop is re-armed in a finally{}, so one bad frame cannot
          freeze the animation again
     ====================================================================== */
  const R = (v, min, max) => {
    const n = Number(v);
    if (!isFinite(n)) return min;
    return n < min ? min : (n > max ? max : n);
  };
  const rgba = (hex, a) => {
    const h = String(hex || "").replace("#", "");
    if (h.length < 6) return "rgba(139,157,255," + a + ")";
    const n = parseInt(h.slice(0, 6), 16);
    return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
  };
  function bootOrb() {
    const cv = document.getElementById("fgOrb");
    if (!cv || cv._on) return;
    cv._on = true;
    let ctx;
    try { ctx = cv.getContext("2d"); } catch (e) { return; }
    if (!ctx) return;
    const wrap = cv.parentElement;
    let W = 0, H = 0, raf = 0, t = 0, running = false;
    const N = 34;
    const nodes = Array.from({ length: N }, (_, i) => ({
      a: (i / N) * Math.PI * 2 + (i % 3) * 0.35,
      ring: i % 3,
      sp: (0.00022 + (i % 3) * 0.00012) * (i % 2 ? 1 : -1),
      gold: i % 6 === 0,
      ph: (i * 1.7) % 6.28,
      jx: ((i * 37) % 11) - 5,
      jy: ((i * 53) % 9) - 4,
    }));
    const RINGS = [0.30, 0.42, 0.54];           // fraction of min(W,H)
    function size() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = Math.max(1, wrap.clientWidth);
      H = Math.max(1, wrap.clientHeight);
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function frame() {
      try {
        t += 1;
        ctx.clearRect(0, 0, W, H);
        const cx = W / 2, cy = H / 2, base = Math.min(W, H);
        const P = nodes.map(n => {
          n.a += n.sp * 16;
          const rr = RINGS[n.ring] * base + Math.sin(t * 0.008 + n.ph) * 5;
          const x = cx + Math.cos(n.a) * rr + n.jx;
          const y = cy + Math.sin(n.a) * rr * 0.72 + n.jy;
          const depth = 0.62 + 0.38 * (0.5 + 0.5 * Math.sin(n.a + 1.2));   // fake z
          return { x, y, d: depth, g: n.gold, ph: n.ph };
        });
        /* links */
        ctx.lineWidth = 1;
        for (let i = 0; i < P.length; i++) {
          for (let j = i + 1; j < P.length; j++) {
            const dx = P[i].x - P[j].x, dy = P[i].y - P[j].y;
            const d2 = dx * dx + dy * dy;
            if (d2 > 7200) continue;
            const a = 0.17 * (1 - d2 / 7200) * Math.min(P[i].d, P[j].d);
            if (a < 0.01) continue;
            ctx.strokeStyle = "rgba(139,157,255," + a.toFixed(3) + ")";
            ctx.beginPath(); ctx.moveTo(P[i].x, P[i].y); ctx.lineTo(P[j].x, P[j].y); ctx.stroke();
          }
        }
        /* central core: the signal every orbit answers to */
        const cr = R(base * 0.085 + Math.sin(t * 0.02) * 2, 4, 60);
        const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, cr * 2.4);
        cg.addColorStop(0, "rgba(190,200,255,.50)");
        cg.addColorStop(.35, "rgba(139,92,246,.26)");
        cg.addColorStop(1, "rgba(139,92,246,0)");
        ctx.beginPath(); ctx.fillStyle = cg; ctx.arc(cx, cy, cr * 2.4, 0, 6.2832); ctx.fill();
        ctx.beginPath(); ctx.strokeStyle = "rgba(139,157,255,.32)"; ctx.lineWidth = 1;
        ctx.arc(cx, cy, R(cr * 1.55, 2, 140), 0, 6.2832); ctx.stroke();
        ctx.beginPath(); ctx.fillStyle = "rgba(232,238,255,.92)";
        ctx.arc(cx, cy, R(cr * 0.32, 1, 22), 0, 6.2832); ctx.fill();
        /* nodes: halo + core, radius always clamped positive */
        for (const p of P) {
          const pulse = 0.7 + 0.3 * Math.sin(t * 0.03 + p.ph);
          const core = R((p.g ? 3.1 : 2.1) * p.d * (0.85 + 0.3 * pulse), 0.6, 8);
          const halo = R(core * 3.4, 1, 26);
          const col = p.g ? "232,194,122" : "139,157,255";
          ctx.beginPath();
          ctx.fillStyle = "rgba(" + col + "," + (0.14 * pulse * p.d).toFixed(3) + ")";
          ctx.arc(p.x, p.y, halo, 0, 6.2832); ctx.fill();
          ctx.beginPath();
          ctx.fillStyle = "rgba(" + col + "," + (0.85 * pulse * p.d).toFixed(3) + ")";
          ctx.arc(p.x, p.y, core, 0, 6.2832); ctx.fill();
        }
      } catch (e) { /* never let a frame kill the loop */ }
      finally {
        if (running) raf = requestAnimationFrame(frame);
      }
    }
    function start() {
      if (running || document.hidden) return;
      running = true;
      size();
      if (reduced || coarse) { frame(); running = false; return; }
      raf = requestAnimationFrame(frame);
    }
    function stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }
    cv._start = start; cv._stop = stop;
    size();
    if ("ResizeObserver" in window) new ResizeObserver(() => { size(); if (!running) { running = true; frame(); running = false; } }).observe(wrap);
    addEventListener("resize", () => { size(); if (!running) { running = true; frame(); running = false; } }, { passive: true });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) stop();
      else if (view.classList.contains("open")) start();
    });
    start();
  }

  /* ======================================================================
     5. the signal wire: six stages, one travelling handoff
     ====================================================================== */
  const STAGES = [
    { t: "App enters", d: "100 curated apps, or any app you search for, enter the tracked estate. Each becomes a living record the pipeline keeps fresh.", fig: "100 tracked applications" },
    { t: "Registry match", d: "The official MCP registry is searched with brand terms, filtered to genuine mentions, and classified vendor-official only when the namespace resolves to the app's own domain.", fig: "domain-verified classification" },
    { t: "Live probe", d: "A real MCP handshake (initialize, then tools/list) against published endpoints. Open endpoints reveal true tool counts; gated ones report their auth wall.", fig: "real tool counts / auth state" },
    { t: "Evidence", d: "The server's repository goes through GitHub (stars, commits, license) and its packages through npm and PyPI (downloads, versions). Every figure links home.", fig: "adoption + maintenance signals" },
    { t: "Readiness", d: "All signals combine into a transparent weighted score - official 28%, capability 14%, adoption 16%, popularity 14%, maintenance 16%, availability 12% - graded A-E.", fig: "0-100 score + grade" },
    { t: "Watched live", d: "Each refresh diffs against the last: registry moves, tool changes, liveness flips stream to open dashboards and fire watched alerts.", fig: "the live signal wire" },
  ];
  const stagesWrap = $("#fgStages");
  const stageEls = $$(".fg2-stage", stagesWrap || view);
  const detail = $("#howDetail");
  const wire = $(".fg2-wire", view);
  const laser = $(".fg2-laser", view);
  let stageIdx = -1;

  /* ---- laser geometry: one transform per hop, measured once per resize -- */
  let laserX = [];
  function measureWire() {
    if (!wire || !laser || !stageEls.length) return;
    try {
      const wr = wire.getBoundingClientRect();
      laserX = stageEls.map(el => {
        const r = el.getBoundingClientRect();
        return r.left + r.width / 2 - wr.left;
      });
    } catch (e) { laserX = []; }
  }
  function laserTo(i, fast) {
    if (!laser || !laserX.length) return;
    const x = Math.max(0, (laserX[i] || 0) - 32);
    laser.classList.toggle("sweep", !!fast);
    laser.classList.add("live");
    laser.style.transform = "translate3d(" + x.toFixed(1) + "px,0,0)";
  }
  function laserOff() { if (laser) laser.classList.remove("live"); }
  function zap(el) {
    if (!el) return;
    el.classList.remove("zap"); void el.offsetWidth; el.classList.add("zap");
    setTimeout(() => el.classList.remove("zap"), 700);
  }

  function showStage(i, user) {
    if (!stageEls.length || !detail) return;
    i = Math.max(0, Math.min(stageEls.length - 1, i));
    if (i === stageIdx && !user) return;
    stageIdx = i;
    stageEls.forEach((el, k) => {
      el.classList.toggle("on", k === i);
      const b = $(".fg2-stage-hit", el);
      if (b) b.setAttribute("aria-expanded", k === i ? "true" : "false");
    });
    const st = STAGES[i] || STAGES[0];
    detail.hidden = false;
    detail.innerHTML = '<div class="hd-in"><span class="hd-n">0' + (i + 1) + '</span><div class="hd-b"><b>' +
      st.t + '</b><p>' + st.d + '</p><span class="hd-p">' + st.fig + '</span></div></div>';
  }

  /* ---- the sequencer: laser hops box to box, each box reveals + triggers - */
  let seqTimer = 0, seqIdle = 0;
  const HOP = 430;            /* ms between stations: blazing but legible */
  function seqStop() { if (seqTimer) { clearTimeout(seqTimer); seqTimer = 0; } }
  function seqStart() {
    seqStop();
    if (!stageEls.length) return;
    if (reduced) {
      stageEls.forEach(el => { el.classList.remove("dim"); el.classList.add("seen"); });
      laserOff(); showStage(0, false); return;
    }
    measureWire();
    stageEls.forEach(el => { el.classList.add("dim"); el.classList.remove("seen", "on", "zap"); });
    stageIdx = -1;
    laserTo(0, true);
    seqTimer = setTimeout(() => hop(0), 240);
  }
  function hop(i) {
    seqTimer = 0;
    if (!view.classList.contains("open") || document.hidden) return;
    laserTo(i, false);
    showStage(i, false);
    const el = stageEls[i];
    if (el) { el.classList.remove("dim"); el.classList.add("seen"); zap(el); }
    if (i < stageEls.length - 1) seqTimer = setTimeout(() => hop(i + 1), HOP);
    else seqTimer = setTimeout(() => {           /* seamless loop: sweep home */
      stageEls.forEach(e2 => e2.classList.remove("on"));
      laserTo(0, true);
      seqTimer = setTimeout(() => hop(0), 300);
    }, 1200);
  }
  function userPick(i) {
    seqStop();
    if (seqIdle) clearTimeout(seqIdle);
    measureWire();
    laserTo(i, true);
    showStage(i, true);
    const el = stageEls[i];
    if (el) { el.classList.remove("dim"); el.classList.add("seen"); zap(el); }
    /* hand the wheel back to the sequencer after a beat */
    seqIdle = setTimeout(() => {
      if (view.classList.contains("open")) {
        seqTimer = setTimeout(() => hop((i + 1) % stageEls.length), HOP);
      }
    }, 5200);
  }
  if (stagesWrap) {
    stagesWrap.addEventListener("click", (e) => {
      const hit = e.target.closest(".fg2-stage-hit");
      if (!hit) return;
      userPick(stageEls.indexOf(hit.closest(".fg2-stage")));
    });
  }
  addEventListener("resize", () => { measureWire(); if (stageIdx >= 0) laserTo(stageIdx, true); }, { passive: true });

  /* ======================================================================
     6. methodology ladder + score-composition spectrum
     ====================================================================== */
  const COMPOSITION = [
    { n: "Official MCP", w: 28, c: "#34D399", stage: 0 },
    { n: "Live capability", w: 14, c: "#8B9DFF", stage: 2 },
    { n: "Adoption", w: 16, c: "#8B5CF6", stage: 3 },
    { n: "Popularity", w: 14, c: "#C084FC", stage: 3 },
    { n: "Maintenance", w: 16, c: "#FBBF24", stage: 4 },
    { n: "Availability", w: 12, c: "#38BDF8", stage: 5 },
  ];
  let ropeRaf = 0;
  /* the rope ladder: a glowing line is thrown top->bottom and every rung it
     passes springs into existence - one continuous gesture, ~1.4s */
  function ropeDrop() {
    const ladder = $(".mt2-ladder", mview);
    const rope = $(".mt2-rope", mview);
    if (!mview || !ladder || !rope) return;
    const cards = $$(".mt2-pipe", ladder);
    if (!cards.length || !ladder.clientHeight) return;   /* not laid out yet */
    if (ropeRaf) { cancelAnimationFrame(ropeRaf); ropeRaf = 0; }
    if (reduced) { cards.forEach(c => c.classList.add("seen")); return; }
    ladder.classList.add("dropping");
    cards.forEach(c => c.classList.remove("seen"));
    rope.classList.add("live");
    rope.style.opacity = "";
    rope.style.height = "0px";
    const lr = ladder.getBoundingClientRect();
    const H = Math.max(120, ladder.clientHeight - 36);
    /* thresholds in ladder space, measured the unambiguous way; the rope tip
       sits at 18px + y, so a rung fires the moment the tip reaches its middle */
    const th = cards.map(c => {
      const r = c.getBoundingClientRect();
      return (r.top - lr.top) + Math.min(r.height * 0.5, 70) - 18;
    });
    const fired = cards.map(() => false);
    const t0 = performance.now(), DUR = 1400;
    const step = (ts) => {
      ropeRaf = 0;
      const k = Math.min(1, (ts - t0) / DUR);
      const e = 1 - Math.pow(1 - k, 3);
      const y = e * H;
      rope.style.height = y.toFixed(1) + "px";
      cards.forEach((c, i) => {
        if (!fired[i] && y >= th[i]) { fired[i] = true; c.classList.add("seen"); }
      });
      if (k < 1) { ropeRaf = requestAnimationFrame(step); }
      else {
        cards.forEach(c => c.classList.add("seen"));
        setTimeout(() => {
          ladder.classList.remove("dropping");
          rope.classList.remove("live");
          rope.style.opacity = "0";
          rope.style.height = "0px";
        }, 520);
      }
    };
    ropeRaf = requestAnimationFrame(step);
  }

  function bootMethodology() {
    if (!mview || mview._on) return;
    mview._on = true;
    const cards = $$(".mt2-pipe", mview);
    const spec = $("#deckSpectrum", mview);
    const legend = $("#mt2Legend", mview);
    const hint = $("#mt2SpecHint", mview);
    function setCard(i, open) {
      cards.forEach((c, k) => {
        const on = open && k === i;
        c.classList.toggle("open", on);
        const hit = $(".pipe-hit", c);
        if (hit) {
          hit.setAttribute("aria-expanded", on ? "true" : "false");
          hit.setAttribute("aria-current", on ? "step" : "false");
        }
      });
      if (spec) Array.prototype.forEach.call(spec.children, (s, k) => {
        const target = COMPOSITION[k] ? COMPOSITION[k].stage : k;
        s.classList.toggle("on", open && target === i);
      });
      if (legend) $$("button", legend).forEach((b, k) => {
        b.classList.toggle("on", open && COMPOSITION[k] && COMPOSITION[k].stage === i);
      });
    }
    cards.forEach((c, i) => {
      const hit = $(".pipe-hit", c);
      if (!hit) return;
      hit.addEventListener("click", () => {
        const was = c.classList.contains("open");
        setCard(i, !was);
      });
    });
    if (spec) {
      spec.innerHTML = COMPOSITION.map((k, i) =>
        '<span data-i="' + i + '" style="flex:' + k.w +
        ';--c1:' + rgba(k.c, 0.34) + ';--c2:' + rgba(k.c, 0.10) + ';--cb:' + rgba(k.c, 0.42) +
        '" title="' + k.n + ' · ' + k.w + '%"></span>').join("");
      spec.addEventListener("click", (e) => {
        const s = e.target.closest("[data-i]");
        if (!s) return;
        const comp = COMPOSITION[Number(s.dataset.i)];
        if (!comp) return;
        setCard(comp.stage, true);
        const card = cards[comp.stage];
        if (card) mview.scrollTo({ top: Math.max(0, card.offsetTop - 120), behavior: reduced ? "auto" : "smooth" });
      });
      spec.addEventListener("mouseover", (e) => {
        const s = e.target.closest("[data-i]");
        if (!s || !hint) return;
        const comp = COMPOSITION[Number(s.dataset.i)];
        if (comp) hint.textContent = comp.n + " · " + comp.w + "% of the score";
      });
      spec.addEventListener("mouseleave", () => {
        if (hint) hint.textContent = "hover a band · click to jump to its stage";
      });
    }
    if (legend) {
      legend.innerHTML = COMPOSITION.map((k, i) =>
        '<button type="button" data-i="' + i + '" style="--c:' + k.c + '"><i></i>' + k.n + ' <b>' + k.w + '%</b></button>').join("");
      legend.addEventListener("click", (e) => {
        const b = e.target.closest("[data-i]");
        if (!b) return;
        const comp = COMPOSITION[Number(b.dataset.i)];
        if (!comp) return;
        setCard(comp.stage, true);
        const card = cards[comp.stage];
        if (card) mview.scrollTo({ top: Math.max(0, card.offsetTop - 120), behavior: reduced ? "auto" : "smooth" });
      });
    }
    mview.addEventListener("keydown", (e) => {
      if (!mview.classList.contains("open")) return;
      const cur = cards.findIndex(c => c.classList.contains("open"));
      if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); setCard(Math.min(cards.length - 1, cur + 1), true); }
      else if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); setCard(Math.max(0, cur - 1), true); }
      else if (e.key === "Home") { e.preventDefault(); setCard(0, true); }
      else if (e.key === "End") { e.preventDefault(); setCard(cards.length - 1, true); }
    });
    setCard(0, true);
  }

  /* ======================================================================
     7. open / close orchestration
     ====================================================================== */
  let booted = false;
  function boot() {
    if (booted) return;
    booted = true;
    bootOrb();
    activateGroup("hg-1", false);
    syncCount();
    const st = window.__mcpx && window.__mcpx.state;
    const fl = $("#fgLive");
    if (fl) fl.innerHTML = st && st.snap
      ? '<span class="led live"></span>live data · refreshed ' + (st.snap.generated_at ? new Date(st.snap.generated_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—") +
        (st.live ? "" : " · snapshot mode")
      : '<span class="led off"></span>snapshot mode';
  }
  function onHelpOpen() {
    boot();
    const orb = document.getElementById("fgOrb");
    if (orb && orb._start) orb._start();
    seqStart();
  }
  function onHelpClose() {
    const orb = document.getElementById("fgOrb");
    if (orb && orb._stop) orb._stop();
    seqStop();
    laserOff();
  }
  new MutationObserver(() => {
    if (view.classList.contains("open")) onHelpOpen(); else onHelpClose();
  }).observe(view, { attributes: true, attributeFilter: ["class"] });
  if (mview) new MutationObserver(() => {
    if (mview.classList.contains("open")) { bootMethodology(); ropeDrop(); }
  }).observe(mview, { attributes: true, attributeFilter: ["class"] });
  if (view.classList.contains("open")) onHelpOpen();
  if (mview && mview.classList.contains("open")) { bootMethodology(); ropeDrop(); }

  /* deep-link + jump API (used by app.js hash router and the footer) */
  window.__fghelp = {
    expand(slug) {
      boot();
      expandSlug(slug, true);
      syncCount();
    },
  };
})();
