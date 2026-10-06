/* MCP Integration Explorer - signature motion layer (v41).
 * Pure add-on: never touches app.js state, only reads the DOM and drives
 * compositor-friendly transforms (transform/opacity only, everything rAF-lerped
 * so scrolling stays 60fps). Fully disabled for touch devices, small viewports
 * and prefers-reduced-motion.
 */
(() => {
  "use strict";
  if (typeof matchMedia === "undefined") return;

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const coarse = matchMedia("(pointer: coarse)").matches;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const lerp = (a, b, t) => a + (b - a) * t;

  /* ---------- 1. hero entrance: orchestrated rise + deblur ----------
     The classes only carry the stagger delays; the animation itself is pure
     CSS (`both` fill), so content is visible even if this script never runs. */
  function heroEntrance() {
    const hero = $(".hero");
    if (!hero || hero.dataset.prDone) return;
    hero.dataset.prDone = "1";
    const seq = [
      [".eyebrow", 0], [".hero h1", 1], [".hero .lede", 2],
      [".hero-search", 3], [".status-strip", 4],
    ];
    seq.forEach(([sel, i]) => {
      const el = $(sel, hero);
      if (!el) return;
      el.classList.add("pr-rise");
      el.style.setProperty("--prd", (i * 90) + "ms");
    });
    /* the lede types in word by word, fast (24ms cadence), desktop only */
    const words = $$(".lede .tw", hero);
    const phone = window.innerWidth < 700;
    words.forEach((w, i) => {
      if (phone) { w.classList.add("tw-in"); return; }
      w.style.transitionDelay = (240 + i * 24) + "ms";
      requestAnimationFrame(() => requestAnimationFrame(() => w.classList.add("tw-in")));
    });
    const panel = $(".snap-panel", hero);
    if (panel) {
      panel.classList.add("pr-panel");
      /* when the entrance lands, hand the panel to the 3D tilt system:
         `.pr-done` retires the fill-forwards animation so both transforms
         never fight over the element */
      panel.addEventListener("animationend", () => panel.classList.add("pr-done"), { once: true });
    }
  }

  /* ---------- 2. ambient orbs: scroll parallax with critical damping ---------- */
  const orbs = [];
  function bindOrbs() {
    $$("#ambDeep .orb").forEach((o, i) => orbs.push({ el: o, depth: 0.028 + i * 0.013, x: 0, y: 0, tx: 0, ty: 0 }));
  }
  let scrollY = window.scrollY || 0, orbRaf = 0, orbTarget = scrollY;
  function orbTick() {
    orbRaf = 0;
    orbTarget = window.scrollY || 0;
    scrollY = lerp(scrollY, orbTarget, 0.08);
    orbs.forEach(o => {
      o.tx = -scrollY * o.depth;
      o.ty = scrollY * o.depth * 0.6;
      o.x = lerp(o.x, o.tx, 0.12); o.y = lerp(o.y, o.ty, 0.12);
      if (Math.abs(o.x - o.tx) > 0.05 || Math.abs(o.y - o.ty) > 0.05)
        o.el.style.transform = `translate3d(${o.x.toFixed(2)}px,${o.y.toFixed(2)}px,0)`;
    });
    if (orbs.length && Math.abs(scrollY - orbTarget) > 0.05) orbRaf = requestAnimationFrame(orbTick);
  }

  function wakeOrbs() {
    orbTarget = window.scrollY || 0;
    if (orbs.length && !orbRaf) orbRaf = requestAnimationFrame(orbTick);
  }

  /* ---------- 3b. THE CONSTELLATION: a live 3D app/servers network ----------
   * A real perspective-projected 3D point field: every node is an "app",
   * every line a possible MCP link. It drifts, breathes, and recedes with
   * scroll - the signature depth layer
   * of the site. Canvas 2D (no WebGL dependency), DPR-capped, paused when the
   * tab is hidden, drawn once statically for touch/reduced-motion users.
   */
  function initConstellation() {
    /* phones and small viewports: the layer is decoration - skip it entirely */
    if (reduced || coarse || window.innerWidth < 700) return;
    const existing = document.getElementById("prConstellation");
    if (existing) return;
    const canvas = document.createElement("canvas");
    canvas.id = "prConstellation";
    canvas.setAttribute("aria-hidden", "true");
    document.body.appendChild(canvas);

    const ctx = canvas.getContext("2d", { alpha: true });
    let W = 0, H = 0, DPR = 1;
    const N = window.innerWidth < 1400 ? 64 : 84;   // node count by viewport
    const nodes = [];
    for (let i = 0; i < N; i++) {
      nodes.push({
        x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z: Math.random() * 2 - 1,
        vx: (Math.random() - 0.5) * 0.0011, vy: (Math.random() - 0.5) * 0.0011,
        vz: (Math.random() - 0.5) * 0.0009,
        r: 1.1 + Math.random() * 1.7,
        hue: Math.random() < 0.78 ? 0 : 1,       // 0 = cyan, 1 = violet
        ph: Math.random() * Math.PI * 2,         // pulse phase
      });
    }
    let running = true, last = performance.now(), t = 0;

    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 1.5);
      W = window.innerWidth; H = window.innerHeight;
      canvas.width = W * DPR; canvas.height = H * DPR;
      canvas.style.width = W + "px"; canvas.style.height = H + "px";
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    }
    resize();
    addEventListener("resize", resize, { passive: true });

    const FOCAL = 1.9, DIST = 3.2;               // perspective constants
    function project(p) {
      /* fixed perspective; node drift provides the motion without pointer input */
      const zz = p.z + DIST;
      const s = FOCAL / zz;
      return { sx: W / 2 + p.x * s * (W / 2.6), sy: H / 2 + p.y * s * (H / 2.2), s, z: zz };
    }

    function frame(now) {
      if (!running) return;
      const dt = Math.min(50, now - last); last = now;
      t += dt * 0.001;
      ctx.clearRect(0, 0, W, H);
      const sy = Math.min(1, (window.scrollY || 0) / Math.max(1, H));  // recede on scroll

      /* physics */
      for (const n of nodes) {
        n.x += n.vx * dt * 0.06; n.y += n.vy * dt * 0.06; n.z += n.vz * dt * 0.06;
        if (n.x > 1.05 || n.x < -1.05) n.vx *= -1;
        if (n.y > 1.05 || n.y < -1.05) n.vy *= -1;
        if (n.z > 1.05 || n.z < -1.05) n.vz *= -1;
      }

      /* project once per node */
      const P = nodes.map(project);

      /* links: depth-fogged, alpha peaks for mid-distance pairs */
      ctx.lineWidth = 1;
      for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
          const a = P[i], b = P[j];
          const dx = a.sx - b.sx, dy = a.sy - b.sy;
          const d2 = dx * dx + dy * dy;
          if (d2 > 26000) continue;
          const near = 1 - d2 / 26000;
          const depth = (1 - (Math.abs(a.z - DIST) + Math.abs(b.z - DIST)) / 2.6) * (1 - sy * 0.55);
          const al = near * near * depth * 0.20;
          if (al < 0.008) continue;
          ctx.strokeStyle = (nodes[i].hue === nodes[j].hue)
            ? `rgba(120,190,235,${al.toFixed(3)})`
            : `rgba(150,140,235,${(al * 0.8).toFixed(3)})`;
          ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
        }
      }

      /* nodes: core + halo, pulse via phase */
      for (let i = 0; i < N; i++) {
        const p = P[i], n = nodes[i];
        if (p.s <= 0 || p.sx < -20 || p.sx > W + 20 || p.sy < -20 || p.sy > H + 20) continue;
        const pulse = 0.72 + 0.28 * Math.sin(t * 0.9 + n.ph);
        const fade = (1 - sy * 0.55) * Math.max(0, Math.min(1, (DIST + 1.6 - p.z) * 0.8));
        if (fade <= 0.02) continue;
        const r = n.r * p.s * 1.35;
        const col = n.hue === 0 ? "34,211,238" : "139,92,246";
        ctx.beginPath();
        ctx.fillStyle = `rgba(${col},${(0.075 * pulse * fade).toFixed(3)})`;
        ctx.arc(p.sx, p.sy, r * 3.4, 0, 6.2832); ctx.fill();
        ctx.beginPath();
        ctx.fillStyle = `rgba(${col},${(0.62 * pulse * fade).toFixed(3)})`;
        ctx.arc(p.sx, p.sy, r, 0, 6.2832); ctx.fill();
      }

      requestAnimationFrame(frame);
    }

    /* one still frame for coarse pointers (phones): depth without battery burn */
    if (coarse) {
      running = false;
      const still = () => { running = true; frame(performance.now()); running = false; };
      still();
      addEventListener("resize", still, { passive: true });
      return;
    }
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { running = false; }
      else if (!running) { running = true; last = performance.now(); requestAnimationFrame(frame); }
    });
    /* paint the first constellation frame synchronously so the page never
       exposes an empty canvas while the animation loop is being scheduled. */
    frame(performance.now());
  }

  /* ---------- 3c. section titles: 3D fold-in ---------- */
  function bindSectFold() {
    $$(".sect-head").forEach(el => {
      if (el.classList.contains("pr3-sect")) return;
      el.classList.add("pr3-sect");
      const r = el.getBoundingClientRect();
      if (r.top < (window.innerHeight || 800) && r.bottom > 0) el.classList.add("pr3-in");
      else if ("IntersectionObserver" in window) {
        const io = new IntersectionObserver((es) => {
          es.forEach(x => { if (x.isIntersecting) { x.target.classList.add("pr3-in"); io.disconnect(); } });
        }, { threshold: .2 });
        io.observe(el);
      } else el.classList.add("pr3-in");
    });
  }

  /* ---------- 3b. section fold-in: 3D perspective entrance on scroll ---------- */
  function bindFoldIn() {
    const sel = ".insight-grid > *, .cov-grid > *, .sig-compact, .meth-strip, .chart-wrap";
    const targets = $$(sel);
    if (!targets.length || !("IntersectionObserver" in window)) return;
    targets.forEach((el, i) => {
      if (el.classList.contains("pr3")) return;
      el.classList.add("pr3");
      el.style.setProperty("--pr3d", Math.min(i, 6) * 70 + "ms");
    });
    const io = new IntersectionObserver((es) => {
      es.forEach(e => {
        if (e.isIntersecting) { e.target.classList.add("pr3-in"); io.unobserve(e.target); }
      });
    }, { threshold: 0.15, rootMargin: "0px 0px -6% 0px" });
    targets.forEach(el => {
      /* anything already on screen reveals immediately - no waiting on the
         observer, so content can never sit hidden waiting for a callback */
      const r = el.getBoundingClientRect();
      if (r.top < (window.innerHeight || 800) && r.bottom > 0) el.classList.add("pr3-in");
      else io.observe(el);
    });
  }

  /* ---------- 5. boot ---------- */
  /* (scroll progress + ambient toggle stay owned by app.js; this layer only
     adds what app.js doesn't already do.) */
  function init() {
    heroEntrance();
    initConstellation();
    bindOrbs(); bindFoldIn(); bindSectFold();
    if (orbs.length) {
      addEventListener("scroll", wakeOrbs, { passive: true });
      wakeOrbs();
    }
    /* new dashboard content (rendered rows, re-opened views) opts in late.
       rAF-debounced: render() mutates hundreds of nodes and a per-mutation
       scan on a phone is real jank. */
    let moQueued = false;
    const mo = new MutationObserver(() => {
      if (moQueued) return;
      moQueued = true;
      requestAnimationFrame(() => { moQueued = false; bindFoldIn(); bindSectFold(); });
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
