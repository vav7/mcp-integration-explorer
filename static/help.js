/* MCP Integration Explorer - Field Guide engine (v60).
 * Owns the redesigned Help view: orb canvas, live search, accordion,
 * section scroll-spy, deep links, demos, helpfulness votes.
 * Vanilla JS, transform/opacity motion, reduced-motion respected.
 */
(() => {
  "use strict";
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  let reduced = false, coarse = false;
  try { reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
        coarse = matchMedia("(pointer: coarse)").matches; } catch (e) {}

  const view = document.getElementById("helpView");
  if (!view) return;

  /* ---------------- state ---------------- */
  const LS = "fg_helpful";
  const votes = (() => { try { return JSON.parse(localStorage.getItem(LS) || "{}"); } catch (e) { return {}; } })();
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
    const cp = e.target.closest(".ha-copy");
    if (cp) {
      const url = location.origin + location.pathname + "#help/" + cp.dataset.slug;
      (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject())
        .then(() => { cp.textContent = "Link copied"; setTimeout(() => cp.textContent = "Copy link", 1600); })
        .catch(() => {});
      return;
    }
    const v = e.target.closest("[data-vote]");
    if (v) {
      votes[v.dataset.slug] = +v.dataset.vote;
      try { localStorage.setItem(LS, JSON.stringify(votes)); } catch (err) {}
      const box = v.closest(".ha-vote");
      box.classList.add("voted");
      v.classList.add("picked");
      const fb = box.querySelector(".ha-fb") || (() => { const s = document.createElement("span"); s.className = "ha-fb"; box.appendChild(s); return s; })();
      fb.textContent = +v.dataset.vote === 1 ? "Thanks for the signal" : "Noted - we will improve this answer";
      return;
    }
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

  /* ---------------- live search ---------------- */
  const search = $("#fgSearch"), count = $("#fgCount");
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    let hits = 0;
    $$(".hq-group", view).forEach(g => {
      let groupHits = 0;
      $$(".hq-item", g).forEach(item => {
        const qEl = $(".hq-q", item), aEl = $(".ha-in", item);
        const text = (qEl.textContent + " " + aEl.textContent).toLowerCase();
        const hit = !q || text.includes(q);
        item.style.display = hit ? "" : "none";
        if (hit) { groupHits++; hits++; }
        /* highlight */
        if (q && hit) {
          const rx = new RegExp("(" + q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "ig");
          if (!qEl.dataset.raw) qEl.dataset.raw = qEl.textContent;
          qEl.innerHTML = qEl.dataset.raw.replace(rx, "<mark>$1</mark>");
        } else if (qEl.dataset.raw) { qEl.innerHTML = qEl.dataset.raw; }
      });
      g.style.display = groupHits ? "" : "none";
    });
    count.textContent = q ? hits + " match" + (hits === 1 ? "" : "es") : "";
    let empty = $("#fgEmpty");
    if (!hits && q) {
      if (!empty) {
        empty = document.createElement("div"); empty.id = "fgEmpty"; empty.className = "fg-empty";
        empty.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.2-3.2"/><path d="M8 11h6"/></svg><b>Nothing matches "<i></i>"</b><span>Try a shorter word - readiness, gateway, compare, export…</span>';
        $("#fgCanvas").appendChild(empty);
      }
      empty.querySelector("i").textContent = q;
      empty.style.display = "";
    } else if (empty) empty.style.display = "none";
  });

  /* keyboard: / focuses, Esc clears, arrows+enter navigate */
  document.addEventListener("keydown", (e) => {
    const helpOpen = view.classList.contains("open");
    if (!helpOpen) return;
    const inField = document.activeElement === search;
    if ((e.key === "/" && !inField) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k")) {
      e.preventDefault(); view.scrollTo({ top: 0 }); search.focus(); return;
    }
    if (e.key === "Escape" && inField) { search.value = ""; search.dispatchEvent(new Event("input")); search.blur(); return; }
    if (inField && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter")) {
      const items = $$(".hq-item", view).filter(i => i.style.display !== "none" && i.closest(".hq-group").style.display !== "none");
      if (!items.length) return;
      e.preventDefault();
      const cur = items.findIndex(i => i.classList.contains("sel"));
      const next = e.key === "Enter" ? Math.max(0, cur) : (cur + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      $$(".hq-item.sel", view).forEach(i => i.classList.remove("sel"));
      const it = items[cur < 0 && e.key !== "Enter" ? 0 : next];
      it.classList.add("sel");
      it.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
      if (e.key === "Enter") { setOpen(it, !it.classList.contains("open")); initDemosIn(it); }
    }
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
    size(); addEventListener("resize", () => { size(); if (!running) still(); }, { passive: true });
    function still() { running = true; frame(); running = false; }
    if (reduced || coarse) { still(); return; }
    wrap.addEventListener("pointermove", (e) => {
      const r = wrap.getBoundingClientRect();
      px = (e.clientX - r.left) / r.width - .5; py = (e.clientY - r.top) / r.height - .5;
    }, { passive: true });
    running = true; raf = requestAnimationFrame(frame);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { running = false; cancelAnimationFrame(raf); }
      else if (!running) { running = true; raf = requestAnimationFrame(frame); }
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
})();
