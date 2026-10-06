/* MCP Integration Explorer - Field Guide engine (v60).
 * Owns the redesigned Help view: orb canvas, live search, accordion,
 * section scroll-spy, deep links, demos, helpfulness votes.
 * Vanilla JS, transform/opacity motion, reduced-motion respected.
 */
(() => {
  "use strict";
  try {
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  let reduced = false, coarse = false;
  try { reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
        coarse = matchMedia("(pointer: coarse)").matches; } catch (e) {}

  const view = document.getElementById("helpView");
  if (!view) return;

  /* ---------------- state ---------------- */
  let expanded = false;
  let booted = false;

  /* ---------------- accordion ---------------- */
  function setOpen(item, open) {
    const btn = $(".hq", item);
    item.classList.toggle("open", open);
    if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
  }
  view.addEventListener("click", (e) => {
    const jump = e.target.closest("[data-fgjump]");
    if (jump) { e.preventDefault(); expand(jump.dataset.fgjump, true); return; }
    const q = e.target.closest(".hq");
    if (!q) return;
    const item = q.closest(".hq-item");
    const willOpen = !item.classList.contains("open");
    if (!expanded) $$(".hq-item.open", view).forEach(i => { if (i !== item) setOpen(i, false); });
    setOpen(item, willOpen);
    if (willOpen) initDemosIn(item);
  });

  function expand(slug, scroll) {
    const item = view.querySelector(`.hq-item[data-slug="${slug}"]`);
    if (!item) return;
    if (expanded === false) $$(".hq-item.open", view).forEach(i => setOpen(i, false));
    setOpen(item, true);
    initDemosIn(item);
    const g = item.closest(".hq-group");
    if (g) activateGroup(g.id, false);
    if (scroll) {
      view.scrollTo({ top: item.offsetTop - 90, behavior: reduced ? "auto" : "smooth" });
      item.classList.remove("ping"); void item.offsetWidth; item.classList.add("ping");
    }
  }

  $("#fgExpand").addEventListener("click", () => {
    expanded = !expanded;
    const btn = $("#fgExpand");
    btn.textContent = expanded ? "Collapse all" : "Expand all";
    btn.setAttribute("aria-pressed", String(expanded));
    $$(".hq-item", view).forEach(i => setOpen(i, expanded));
    if (expanded) $$(".hq-item", view).forEach(initDemosIn);
  });

  /* keyboard: Esc closes open answers */
  document.addEventListener("keydown", (e) => {
    if (!view.classList.contains("open")) return;
    if (e.key === "Escape") { $$(".hq-item.open", view).forEach(i => setOpen(i, false)); }
  });

  /* ---------------- rail: jump + scroll-spy + gliding indicator ---------------- */
  const rail = $("#fgNav");
  const ind = document.createElement("span"); ind.className = "fg-ind"; rail.appendChild(ind);
  function moveInd(btn) {
    ind.style.top = btn.offsetTop + "px";
    ind.style.height = btn.offsetHeight + "px";
  }
  function activateGroup(id, scroll) {
    $$(".fg-nav-item", rail).forEach(b => {
      const on = b.dataset.group === id;
      b.classList.toggle("active", on);
      if (on) moveInd(b);
    });
    if (scroll) {
      const g = document.getElementById(id);
      if (g) view.scrollTo({ top: g.offsetTop - 70, behavior: reduced ? "auto" : "smooth" });
    }
  }
  rail.addEventListener("click", (e) => {
    const b = e.target.closest(".fg-nav-item");
    if (b) activateGroup(b.dataset.group, true);
  });
  /* scroll-spy */
  const spy = new IntersectionObserver((es) => {
    es.forEach(en => { if (en.isIntersecting) activateGroup(en.target.id, false); });
  }, { root: view, rootMargin: "-20% 0px -60% 0px" });
  $$(".hq-group", view).forEach(g => spy.observe(g));

  /* ---------------- demos (progressive, built on open) ---------------- */
  const demoBuilt = new Set();
  function initDemosIn(item) {
    ["demoScore", "demoStates", "demoFresh"].forEach(id => {
      if (item.querySelector("#" + id)) buildDemo(id);
    });
  }
  function buildDemo(id) {
    if (demoBuilt.has(id)) return;
    demoBuilt.add(id);
    if (id === "demoScore") {
      const W = [["Official MCP", 28], ["Live capability", 14], ["Adoption", 16], ["Popularity", 14], ["Maintenance", 16], ["Availability", 12]];
      const box = document.getElementById(id);
      box.innerHTML = '<div class="fg-sliders">' + W.map(([l, w], i) =>
        `<label><span>${l} <em>w ${w}%</em></span><input type="range" min="0" max="100" value="${55 + i * 6}" data-w="${w}" aria-label="${l} attainment"></label>`).join("") +
        '</div><div class="fg-gauge"><svg viewBox="0 0 96 96"><defs><linearGradient id="fgGaugeGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#E8C27A"/><stop offset="1" stop-color="#7C6CFF"/></linearGradient></defs><circle class="g-track" cx="48" cy="48" r="40"/><circle class="g-val" cx="48" cy="48" r="40"/></svg><div><b id="fgScoreN">0</b><span id="fgScoreG">grade C</span></div></div>';
      const upd = () => {
        let sum = 0;
        $$("input", box).forEach(s => sum += (+s.value) * (+s.dataset.w) / 100);
        const score = Math.round(sum);
        const g = score >= 80 ? "A" : score >= 60 ? "B" : score >= 40 ? "C" : score >= 20 ? "D" : "E";
        $("#fgScoreN", box).textContent = score;
        $("#fgScoreG", box).textContent = "grade " + g;
        const cval = $(".g-val", box), c = 2 * Math.PI * 40;
        cval.style.strokeDasharray = c;
        cval.style.strokeDashoffset = c * (1 - score / 100);
      };
      box.addEventListener("input", upd); upd();
    } else if (id === "demoStates") {
      const box = document.getElementById(id);
      box.innerHTML = '<div class="fg-seg" role="tablist"><button class="on" data-s="official">Official</button><button data-s="community">Community</button><button data-s="none">None</button></div>' +
        '<div class="fg-appcard"><span class="fg-badge"></span><b>Acme</b><p></p></div>';
      const states = {
        official: { cls: "official", badge: "Official · domain-verified", p: "com.acme/mcp resolves to acme.com - the vendor ships this server itself." },
        community: { cls: "community", badge: "Community", p: "A third party built an Acme server; the registry text genuinely mentions Acme." },
        none: { cls: "none", badge: "None", p: "Nothing in the registry - a coverage gap, not proof the server does not exist." },
      };
      const card = $(".fg-appcard", box), seg = $(".fg-seg", box);
      const set = (k) => {
        const s = states[k];
        card.className = "fg-appcard " + s.cls;
        $(".fg-badge", card).textContent = s.badge;
        $("p", card).textContent = s.p;
        $$("button", seg).forEach(b => b.classList.toggle("on", b.dataset.s === k));
      };
      seg.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) set(b.dataset.s); });
      set("official");
    } else if (id === "demoFresh") {
      const box = document.getElementById(id);
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

  /* ---------------- the orb: a small living constellation ---------------- */
  function bootOrb() {
    const cv = document.getElementById("fgOrb"); if (!cv || cv._on) return;
    cv._on = true;
    const ctx = cv.getContext("2d");
    const wrap = cv.parentElement;
    let W = 0, H = 0, raf = 0, t = 0, running = false;
    const N = 26;
    const nodes = Array.from({ length: N }, (_, i) => ({
      a: (i / N) * Math.PI * 2, r: 28 + (i % 5) * 16,
      sp: .0016 + (i % 4) * .0006, gold: i % 7 === 0, y: (i % 3 - 1) * 10,
    }));
    let px = 0, py = 0;
    function size() {
      const dpr = Math.min(devicePixelRatio || 1, 1.6);
      W = wrap.clientWidth; H = wrap.clientHeight;
      cv.width = W * dpr; cv.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function frame() {
      if (!running) return;
      t += 1;
      ctx.clearRect(0, 0, W, H);
      const cx = W / 2 + px * 10, cy = H / 2 + py * 8;
      const P = nodes.map(n => {
        n.a += n.sp;
        return { x: cx + Math.cos(n.a) * n.r * (W / 340), y: cy + Math.sin(n.a) * n.r * .52 + n.y, g: n.gold };
      });
      for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
        const dx = P[i].x - P[j].x, dy = P[i].y - P[j].y, d2 = dx * dx + dy * dy;
        if (d2 > 9000) continue;
        ctx.strokeStyle = `rgba(139,157,255,${(.16 * (1 - d2 / 9000)).toFixed(3)})`;
        ctx.beginPath(); ctx.moveTo(P[i].x, P[i].y); ctx.lineTo(P[j].x, P[j].y); ctx.stroke();
      }
      P.forEach(p => {
        const col = p.g ? "232,194,122" : "139,157,255";
        const pulse = p.g ? .75 + .25 * Math.sin(t * .06 + p.x) : .9;
        ctx.beginPath(); ctx.fillStyle = `rgba(${col},${(.14 * pulse).toFixed(3)})`;
        ctx.arc(p.x, p.y, p.g ? 9 : 6.5, 0, 6.29); ctx.fill();
        ctx.beginPath(); ctx.fillStyle = `rgba(${col},${(.7 * pulse).toFixed(3)})`;
        ctx.arc(p.x, p.y, p.g ? 3 : 2.2, 0, 6.29); ctx.fill();
      });
      raf = requestAnimationFrame(frame);
    }
    function startOrb() {
      if (reduced || coarse || running || document.hidden) return;
      running = true; raf = requestAnimationFrame(frame);
    }
    function stopOrb() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }
    cv._start = startOrb;
    cv._stop = stopOrb;
    size(); addEventListener("resize", () => { size(); if (!running) still(); }, { passive: true });
    function still() { running = true; frame(); running = false; }
    if (reduced || coarse) { still(); return; }
    wrap.addEventListener("pointermove", (e) => {
      const r = wrap.getBoundingClientRect();
      px = (e.clientX - r.left) / r.width - .5; py = (e.clientY - r.top) / r.height - .5;
    }, { passive: true });
    startOrb();
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) stopOrb();
      else if (view.classList.contains("open")) startOrb();
    });
  }

  /* ---------------- boot once the view opens ---------------- */
  function boot() {
    if (booted) return;
    booted = true;
    bootOrb();
    activateGroup("hg-1", false);
    const st = window.__mcpx && window.__mcpx.state;
    const fl = $("#fgLive");
    if (fl) fl.innerHTML = st && st.snap
      ? `<span class="led live"></span>live data · refreshed ${st.snap.generated_at ? new Date(st.snap.generated_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}` +
        (st.live ? "" : " · snapshot mode")
      : `<span class="led off"></span>snapshot mode`;
  }
  new MutationObserver(() => { if (view.classList.contains("open")) boot(); })
    .observe(view, { attributes: true, attributeFilter: ["class"] });
  if (view.classList.contains("open")) boot();



  /* ================= C1: the 3D pipeline constellation =================
     Six dark glass spheres on a 3D arc, pre-rendered as sprites. They
     materialize one by one (shockwave + settle), hairline links draw
     between them, data packets drift along. Mouse tilts the scene;
     hover/tap brings a sphere forward and opens its story. */
  const STAGES = [
    { t: "App enters", d: "100 curated apps, or any app you search for, enter the tracked estate. Each becomes a living record the pipeline keeps fresh.", fig: "100 tracked applications" },
    { t: "Registry match", d: "The official MCP registry is searched with brand terms, filtered to genuine mentions, and classified vendor-official only when the namespace resolves to the app's own domain.", fig: "domain-verified classification" },
    { t: "Live probe", d: "A real MCP handshake (initialize, then tools/list) against published endpoints. Open endpoints reveal true tool counts; gated ones report their auth wall.", fig: "real tool counts / auth state" },
    { t: "Evidence", d: "The server's repository goes through GitHub (stars, commits, license) and its packages through npm and PyPI (downloads, versions). Every figure links home.", fig: "adoption + maintenance signals" },
    { t: "Readiness", d: "All signals combine into a transparent weighted score - official 28%, capability 14%, adoption 16%, popularity 14%, maintenance 16%, availability 12% - graded A-E.", fig: "0-100 score + grade" },
    { t: "Watched live", d: "Each refresh diffs against the last: registry moves, tool changes, liveness flips stream to open dashboards and fire watched alerts.", fig: "the live signal wire" },
  ];
  const GLYPHS = [
    (c) => { c.strokeRect(-7, -7, 6, 6); c.strokeRect(1, -7, 6, 6); c.strokeRect(-7, 1, 6, 6); c.strokeRect(1, 1, 6, 6); },
    (c) => { c.beginPath(); c.moveTo(0, -9); c.lineTo(8, -4); c.lineTo(8, 5); c.lineTo(0, 9); c.lineTo(-8, 5); c.lineTo(-8, -4); c.closePath(); c.moveTo(0, -9); c.lineTo(0, 9); c.moveTo(-8, -4); c.lineTo(0, 0); c.lineTo(8, -4); },
    (c) => { c.beginPath(); c.moveTo(2, -9); c.lineTo(-6, 1); c.lineTo(-1, 1); c.lineTo(-2, 9); c.lineTo(6, -1); c.lineTo(1, -1); c.closePath(); },
    (c) => { for (let k = 0; k < 5; k++) { const a = -Math.PI / 2 + k * (Math.PI * 2 / 5); const b = a + Math.PI * 2 / 5 * 2; c.moveTo(Math.cos(a) * 8, Math.sin(a) * 8); c.lineTo(Math.cos(b) * 8, Math.sin(b) * 8); } },
    (c) => { c.beginPath(); c.arc(0, 0, 8, Math.PI * .85, Math.PI * 2.15); c.moveTo(4, -3); c.lineTo(0, 2); c.lineTo(-3, -1); },
    (c) => { c.beginPath(); c.moveTo(0, -9); c.lineTo(7, -6); c.lineTo(7, 2); c.quadraticCurveTo(7, 8, 0, 10); c.quadraticCurveTo(-7, 8, -7, 2); c.lineTo(-7, -6); c.closePath(); c.moveTo(-3, 0); c.lineTo(-1, 3); c.lineTo(3, -3); },
  ];

  function makeSprite(idx, size) {
    const s = document.createElement("canvas");
    s.width = s.height = size * 2;
    const c = s.getContext("2d");
    c.scale(2, 2);
    const r = size / 2;
    const g = c.createRadialGradient(r - r * .35, r - r * .45, r * .1, r, r, r);
    g.addColorStop(0, "#1B1B2E"); g.addColorStop(.62, "#101020"); g.addColorStop(1, "#08080F");
    c.fillStyle = g;
    c.beginPath(); c.arc(r, r, r - 1, 0, 6.29); c.fill();
    c.strokeStyle = "rgba(165,155,242,.5)"; c.lineWidth = 1.2;
    c.beginPath(); c.arc(r, r, r - 1.2, Math.PI * .7, Math.PI * 1.9); c.stroke();
    c.fillStyle = "rgba(255,255,255,.14)";
    c.beginPath(); c.ellipse(r - r * .3, r - r * .48, r * .34, r * .16, -.5, 0, 6.29); c.fill();
    c.strokeStyle = "rgba(195,194,255,.85)"; c.lineWidth = 1.3;
    c.lineCap = "round"; c.lineJoin = "round";
    c.save(); c.translate(r, r + 1); GLYPHS[idx](c); c.restore();
    c.fillStyle = "rgba(195,194,255,.7)";
    c.font = "600 7px ui-monospace, monospace"; c.textAlign = "center";
    c.fillText("0" + (idx + 1), r, size - 5);
    return s;
  }

  function bootPipeline() {
    const wrap = document.querySelector(".fg3d-wrap");
    const cv = document.getElementById("fg3d");
    if (!wrap || !cv || cv._on) return;
    cv._on = true;
    const ctx = cv.getContext("2d");
    const detail = document.getElementById("howDetail");
    let W = 0, H = 0, raf = 0, running = false, started = false;
    let mx = 0, my = 0, hov = -1;
    const SP = 132, DPR = Math.min(devicePixelRatio || 1, 2);
    const sprites = STAGES.map((_, i) => makeSprite(i, SP));
    const N = STAGES.length;
    let cheap = false, frameTimes = [], landed = [];
    let pointerRaf = 0, pendingPointer = null, lastHover = -2, wrapRect = null;

    function size() {
      W = wrap.clientWidth; H = Math.max(300, Math.min(430, W * .42));
      cv.width = W * DPR; cv.height = H * DPR;
      cv.style.height = H + "px";
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      wrapRect = wrap.getBoundingClientRect();
    }
    function project(i, w, h) {
      const spread = Math.min(w * .16, 190);
      const x = (i - (N - 1) / 2) * spread;
      const z = Math.abs(i - (N - 1) / 2) * 55;
      const y = -Math.pow(z / 55, 2) * 12 + 18;
      return { x: w / 2 + x, y: h * .52 + y, s: 320 / (320 + z) };
    }

    function draw(ts) {
      if (!running) return;
      ctx.clearRect(0, 0, W, H);
      if (!cheap) {
        ctx.fillStyle = "rgba(165,155,242,.35)";
        for (let i = 0; i < 26; i++) {
          const sx = (i * 97.3) % W, sy = (i * 61.7) % H;
          const tw = .25 + .2 * Math.sin(ts / 900 + i);
          ctx.globalAlpha = tw * .5;
          ctx.beginPath(); ctx.arc(sx, sy, 1, 0, 6.29); ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
      const proj = STAGES.map((_, i) => {
        const p = project(i, W, H);
        const age = ts - landed[i];
        const born = age >= 0 ? Math.min(1, age / 320) : 0;
        const settle = 1 - Math.pow(1 - born, 3);
        const focus = age >= 0 ? Math.max(0, 1 - Math.abs(age - 230) / 190) : 0;
        return { ...p, born: born >= 1 ? 1 : 0, a: settle, focus, sz: SP * p.s * (.58 + .42 * settle + .18 * focus) };
      });
      for (let i = 0; i < N - 1; i++) {
        if (proj[i].born < 1 || proj[i + 1].a <= 0) continue;
        const a = proj[i], b = proj[i + 1];
        ctx.strokeStyle = "rgba(125,128,214," + (.16 * Math.min(a.a, b.a)).toFixed(3) + ")"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      /* A single quiet signal packet moves into the newly active station.
         It is intentionally bounded to the entrance window, so the animation
         reads as a handoff rather than a perpetual neon effect. */
      for (let i = 1; i < N; i++) {
        const age = ts - landed[i];
        if (age < 0 || age > 340 || proj[i - 1].born < 1) continue;
        const k0 = Math.min(1, age / 340), k = 1 - Math.pow(1 - k0, 2);
        const a = proj[i - 1], b = proj[i], px2 = a.x + (b.x - a.x) * k, py2 = a.y + (b.y - a.y) * k;
        ctx.fillStyle = "rgba(151,153,241,.58)";
        ctx.beginPath(); ctx.arc(px2, py2, 2.2, 0, 6.29); ctx.fill();
      }
      const order = proj.map((p, i) => i).sort((a, b) => proj[a].s - proj[b].s);
      order.forEach(i => {
        const p = proj[i];
        if (p.a <= 0) return;
        const x = p.x + mx * 14 * p.s, y = p.y + my * 10 * p.s;
        const sz = p.sz * (i === hov ? 1.14 : 1);
        ctx.globalAlpha = p.a;
        if (p.focus > 0) {
          ctx.fillStyle = "rgba(104,101,205," + (.08 * p.focus).toFixed(3) + ")";
          ctx.beginPath(); ctx.arc(x, y, sz * (.72 + .18 * p.focus), 0, 6.29); ctx.fill();
          ctx.strokeStyle = "rgba(145,146,235," + (.24 * p.focus).toFixed(3) + ")";
          ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.arc(x, y, sz * (.64 + .22 * p.focus), 0, 6.29); ctx.stroke();
        }
        if (i === hov) {
          ctx.beginPath(); ctx.fillStyle = "rgba(124,111,224,.08)";
          ctx.arc(x, y, sz * .72, 0, 6.29); ctx.fill();
        }
        ctx.drawImage(sprites[i], x - sz / 2, y - sz / 2, sz, sz);
        ctx.globalAlpha = 1;
        ctx.font = "600 11px ui-monospace, monospace"; ctx.textAlign = "center";
        ctx.fillStyle = i === hov ? "#DAD6FF" : "rgba(163,161,184,.9)";
        ctx.fillText(STAGES[i].t, x, y + sz / 2 + 18);
        ctx.fillStyle = "rgba(124,111,224,.9)";
        ctx.font = "500 8.5px ui-monospace, monospace";
        ctx.fillText(STAGES[i].fig, x, y + sz / 2 + 31);
      });
      STAGES.forEach((_, i) => {
        if (landed[i] < 0) return;
        const age = ts - landed[i];
        if (age < 620) {
          const p = proj[i];
          const k = age / 620;
          ctx.strokeStyle = "rgba(145,146,235," + (.28 * (1 - k)).toFixed(3) + ")";
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(p.x, p.y, SP * p.s * (.5 + k * .9), 0, 6.29); ctx.stroke();
        }
      });
      raf = requestAnimationFrame(draw);
    }

    function start() {
      size();
      const t0 = performance.now();
      landed = new Array(N).fill(-1).map((_, i) => t0 + 120 + i * 280);
      if (reduced) { landed = landed.map(() => t0 - 1000); still(); return; }
      if (!running) { running = true; raf = requestAnimationFrame(draw); }
      frameTimes = [];
      const watchdog = (ts) => {
        if (frameTimes.length < 60) {
          frameTimes.push(ts);
          if (frameTimes.length > 1 && ts - frameTimes[frameTimes.length - 2] > 20) cheap = true;
          requestAnimationFrame(watchdog);
        }
      };
      requestAnimationFrame(watchdog);
    }
    function still() { running = true; draw(performance.now()); running = false; }

    size();
    /* the view opens with a scale animation: keep the canvas in sync with
       the box's real size via ResizeObserver, not a one-shot measure */
    if ("ResizeObserver" in window) {
      new ResizeObserver(() => { size(); if (!running) still(); }).observe(wrap);
    }
    addEventListener("resize", () => { size(); if (!running) still(); }, { passive: true });
    const io = new IntersectionObserver((es) => {
      es.forEach(en => {
        if (en.isIntersecting && !started) { started = true; start(); }
        else if (!en.isIntersecting && running) { running = false; cancelAnimationFrame(raf); }
        else if (en.isIntersecting && started && !running) { running = true; raf = requestAnimationFrame(draw); }
      });
    }, { threshold: .25 });
    io.observe(wrap);
    /* Some mobile WebViews do not deliver the first IntersectionObserver
       notification while a fixed view is opening. Start one frame later as a
       safe fallback; the observer still owns pause/resume afterwards. */
    if (view.classList.contains("open")) requestAnimationFrame(() => {
      if (!started) { started = true; start(); }
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { running = false; cancelAnimationFrame(raf); }
      else if (started && !running) { running = true; raf = requestAnimationFrame(draw); }
    });
    function showDetail(i) {
      if (!detail || i === lastHover) return;
      lastHover = i;
      if (i < 0) { detail.hidden = true; return; }
      const st = STAGES[i];
      detail.hidden = false;
      detail.innerHTML = '<div class="hd-in"><span class="hd-n">0' + (i + 1) + '</span><div class="hd-b"><b>' + st.t + '</b><p>' + st.d + '</p><span class="hd-p">' + st.fig + '</span></div></div>';
    }
    if (!coarse) wrap.addEventListener("pointermove", (e) => {
      pendingPointer = e;
      if (pointerRaf) return;
      pointerRaf = requestAnimationFrame(() => {
        pointerRaf = 0;
        const ev = pendingPointer; if (!ev) return;
        const r = wrapRect || (wrapRect = wrap.getBoundingClientRect());
        const cx2 = ev.clientX - r.left, cy2 = ev.clientY - r.top;
        mx = (cx2 / r.width - .5) * 2; my = (cy2 / r.height - .5) * 2;
        hov = -1;
        STAGES.forEach((_, i) => {
          const p = project(i, W, H);
          if (Math.hypot(cx2 - p.x, cy2 - p.y) < SP * p.s * .62) hov = i;
        });
        showDetail(hov);
      });
    }, { passive: true });
    wrap.addEventListener("pointerenter", () => { wrapRect = wrap.getBoundingClientRect(); });
    wrap.addEventListener("pointerleave", () => { pendingPointer = null; hov = -1; showDetail(-1); });
    wrap.addEventListener("click", (e) => {
      const r = wrapRect || (wrapRect = wrap.getBoundingClientRect());
      const cx2 = e.clientX - r.left, cy2 = e.clientY - r.top;
      STAGES.forEach((_, i) => {
        const p = project(i, W, H);
        if (Math.hypot(cx2 - p.x, cy2 - p.y) < SP * p.s * .62) showDetail(i);
      });
    });
    cv._restart = () => { started = true; start(); };
  }

  /* ================= C3: methodology card deck ================= */
  function bootDeck() {
    const mv = document.getElementById("methodologyView");
    const deck = mv ? mv.querySelector(".pipeline.deck") : null;
    const spec = document.getElementById("deckSpectrum");
    if (!mv || !deck || deck._on) return;
    deck._on = true;
    const cards = Array.from(deck.querySelectorAll(".pipe"));
    const weights = [28, null, 14, 16, 16, 12];
    const names = cards.map(c => (c.querySelector(".pipe-b h4") || {}).textContent || "");
    if (spec) {
      spec.innerHTML = cards.map((_, i) => {
        const w = weights[i];
        return '<span data-i="' + i + '" style="flex:' + (w ? w : 4) + '" title="' + (names[i] || "") + (w ? " · " + w + "%" : " · signal") + '"></span>';
      }).join("");
    }
    let active = 0;
    function render() {
      cards.forEach((c, i) => {
        c.style.zIndex = i === active ? "2" : "1";
        c.style.transform = "";
        c.style.opacity = "";
        c.classList.toggle("is-active", i === active);
        const hit = c.querySelector(".pipe-hit");
        if (hit) {
          hit.setAttribute("aria-expanded", i === active ? "true" : "false");
          hit.setAttribute("aria-current", i === active ? "step" : "false");
        }
      });
      if (spec) Array.prototype.forEach.call(spec.children, (s, i) => s.classList.toggle("on", i === active));
      cards.forEach((c, i) => {
        const x = c.querySelector(".pipe-x");
        if (x) x.classList.toggle("open", i === active);
      });
    }
    cards.forEach((c, i) => {
      (c.querySelector(".pipe-hit") || c).addEventListener("click", () => { active = i; render(); });
    });
    if (spec) spec.addEventListener("click", (e) => {
      const target = e.target.closest("[data-i]");
      if (target) { active = Math.max(0, Math.min(cards.length - 1, Number(target.dataset.i) || 0)); render(); }
    });
    mv.addEventListener("keydown", (e) => {
      if (!mv.classList.contains("open")) return;
      if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); active = Math.min(cards.length - 1, active + 1); render(); }
      else if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); active = Math.max(0, active - 1); render(); }
      else if (e.key === "Home") { e.preventDefault(); active = 0; render(); }
      else if (e.key === "End") { e.preventDefault(); active = cards.length - 1; render(); }
    });
    render();
  }

  new MutationObserver(() => {
    if (view.classList.contains("open")) {
      boot();
      const orb = document.getElementById("fgOrb");
      if (orb && orb._start) orb._start();
      const pipe = document.getElementById("fg3d");
      if (pipe && pipe._restart) pipe._restart(); else bootPipeline();
    } else {
      const orb = document.getElementById("fgOrb");
      if (orb && orb._stop) orb._stop();
    }
    const mv = document.getElementById("methodologyView");
    if (mv && mv.classList.contains("open")) bootDeck();
  }).observe(view, { attributes: true, attributeFilter: ["class"] });
  const mvEl = document.getElementById("methodologyView");
  if (mvEl) new MutationObserver(() => { if (mvEl.classList.contains("open")) bootDeck(); })
    .observe(mvEl, { attributes: true, attributeFilter: ["class"] });

  /* deep-link + jump API */
  window.__fghelp = {
    expand(slug) {
      boot();
      const item = view.querySelector(`.hq-item[data-slug="${slug}"]`);
      if (!item) return;
      $$(".hq-item.open", view).forEach(i => setOpen(i, false));
      setOpen(item, true);
      initDemosIn(item);
      const g = item.closest(".hq-group");
      if (g) activateGroup(g.id, false);
      setTimeout(() => view.scrollTo({ top: item.offsetTop - 90, behavior: reduced ? "auto" : "smooth" }), 60);
      item.classList.remove("ping"); void item.offsetWidth; item.classList.add("ping");
    },
  };
  } catch (e) { window.__helpErr = e.message + " || " + String(e.stack || "").slice(0, 400); }
})();
