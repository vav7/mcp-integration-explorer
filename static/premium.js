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
  const small = matchMedia("(max-width: 920px)").matches;
  const OK = !reduced && !coarse && !small;
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
    const panel = $(".snap-panel", hero);
    if (panel) panel.classList.add("pr-panel");
  }

  /* ---------- 2. pointer-tracked 3D tilt + glare on premium cards ---------- */
  const TILT_SEL = ".dive-card, .pv-card, .snap-panel, .estate-panel";
  const MAX_DEG = 4.2;          // deliberate: felt, never gimmicky
  const GLARE_MAX = 0.09;
  const tiltTargets = new Set();
  let tiltRaf = 0;

  function bindTilt() {
    if (!OK) return;
    $$(TILT_SEL).forEach(el => {
      /* the hero snapshot panel keeps its one-shot 3D entrance instead of
         pointer tilt - two transforms fighting over it would look broken */
      if (tiltTargets.has(el) || el.dataset.prTilt || el.closest(".hero")) return;
      el.dataset.prTilt = "1";
      el.classList.add("pr-tilt");
      tiltTargets.add(el);
    });
  }
  function onTiltMove(e) {
    const el = e.target && e.target.closest ? e.target.closest(TILT_SEL) : null;
    if (!el || !tiltTargets.has(el)) return;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
    el.style.setProperty("--ry", ((px - 0.5) * MAX_DEG).toFixed(2) + "deg");
    el.style.setProperty("--rx", ((0.5 - py) * MAX_DEG).toFixed(2) + "deg");
    el.style.setProperty("--gx", (px * 100).toFixed(1) + "%");
    el.style.setProperty("--gy", (py * 100).toFixed(1) + "%");
    el.style.setProperty("--glare", GLARE_MAX.toFixed(3));
  }
  function onTiltLeave(e) {
    const el = e.target && e.target.closest ? e.target.closest(TILT_SEL) : null;
    if (!el) return;
    el.style.setProperty("--ry", "0deg");
    el.style.setProperty("--rx", "0deg");
    el.style.setProperty("--glare", "0");
  }

  /* ---------- 3. ambient orbs: scroll parallax with critical damping ---------- */
  const orbs = [];
  function bindOrbs() {
    $$("#ambDeep .orb").forEach((o, i) => orbs.push({ el: o, depth: 0.028 + i * 0.013, x: 0, y: 0, tx: 0, ty: 0 }));
  }
  let scrollY = window.scrollY || 0, orbRaf = 0;
  function orbTick() {
    scrollY = lerp(scrollY, window.scrollY || 0, 0.08);
    orbs.forEach(o => {
      o.tx = -scrollY * o.depth;
      o.ty = scrollY * o.depth * 0.6;
      o.x = lerp(o.x, o.tx, 0.12); o.y = lerp(o.y, o.ty, 0.12);
      if (Math.abs(o.x - o.tx) > 0.05 || Math.abs(o.y - o.ty) > 0.05)
        o.el.style.transform = `translate3d(${o.x.toFixed(2)}px,${o.y.toFixed(2)}px,0)`;
    });
    if (orbs.length) orbRaf = requestAnimationFrame(orbTick);
  }

  /* ---------- 4. magnetic primary buttons ---------- */
  function bindMagnetic() {
    if (!OK) return;
    $$(".btn-primary, .hero-search").forEach(el => {
      if (el.dataset.prMag) return;
      el.dataset.prMag = "1";
      let r = null;
      el.addEventListener("pointermove", (e) => {
        r = r || el.getBoundingClientRect();
        const dx = (e.clientX - r.left - r.width / 2) / r.width;
        const dy = (e.clientY - r.top - r.height / 2) / r.height;
        el.style.setProperty("--mx", (dx * 7).toFixed(2) + "px");
        el.style.setProperty("--my", (dy * 5).toFixed(2) + "px");
      });
      el.addEventListener("pointerleave", () => {
        el.style.setProperty("--mx", "0px"); el.style.setProperty("--my", "0px");
        r = null;
      });
    });
  }

  /* ---------- 5. boot ---------- */
  /* (scroll progress + ambient toggle stay owned by app.js; this layer only
     adds what app.js doesn't already do.) */
  function init() {
    heroEntrance();
    bindTilt(); bindMagnetic(); bindOrbs();
    if (OK) {
      document.addEventListener("pointermove", onTiltMove, { passive: true });
      document.addEventListener("pointerout", onTiltLeave, { passive: true });
      if (orbs.length && !orbRaf) orbRaf = requestAnimationFrame(orbTick);
    }
    /* new dashboard content (rendered rows, re-opened views) opts in late */
    const mo = new MutationObserver(() => { bindTilt(); bindMagnetic(); });
    mo.observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
