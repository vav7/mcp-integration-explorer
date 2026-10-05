/* MCP Integration Explorer - MotionFX (v47).
 * A tiny shared-element engine: captures a source element's box, flies a
 * lightweight ghost across the document with a spring-decel curve, and hands
 * off to the destination. Used for row -> dossier morphs and compare capture
 * flights. WAAPI-driven (compositor-only transforms), reduced-motion aware,
 * zero dependencies. Loaded after app.js; app.js reads window.MotionFX.
 */
(() => {
  "use strict";
  if (window.MotionFX) return;
  let reduced = false;
  try { reduced = matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}

  function fly(fromEl, toEl, opts = {}) {
    const done = () => { if (opts.onDone) opts.onDone(); };
    let small = false, coarse = false;
    try { small = matchMedia("(max-width: 920px)").matches;
          coarse = matchMedia("(pointer: coarse)").matches; } catch (e) {}
    if (!fromEl || !toEl || reduced || small || coarse || typeof fromEl.animate !== "function") { done(); return; }
    const a = fromEl.getBoundingClientRect();
    const b = toEl.getBoundingClientRect();
    if (!a.width || !b.width) { done(); return; }
    const ghost = document.createElement("div");
    ghost.className = "fx-fly";
    ghost.innerHTML = opts.html != null ? opts.html : fromEl.outerHTML;
    const g = ghost.firstElementChild || ghost;
    if (g && g.style) { g.style.margin = "0"; g.style.width = "100%"; g.style.height = "100%"; }
    ghost.style.cssText = `position:fixed;left:0;top:0;width:${a.width}px;height:${a.height}px;`
      + `z-index:9999;pointer-events:none;margin:0;will-change:transform,opacity;`
      + `transform-origin:top left`;
    document.body.appendChild(ghost);
    const dx = (b.left + b.width / 2) - (a.left + a.width / 2);
    const dy = (b.top + b.height / 2) - (a.top + a.height / 2);
    const s = Math.max(.2, Math.min(2.6, (b.width / a.width) || 1));
    const anim = ghost.animate([
      { transform: `translate3d(${a.left}px,${a.top}px,0) scale(1)`, opacity: 1 },
      { transform: `translate3d(${a.left + dx * 0.6}px,${a.top + dy * 0.72}px,0) scale(${1 + (s - 1) * 0.55})`, opacity: .96, offset: .62 },
      { transform: `translate3d(${b.left}px,${b.top}px,0) scale(${s})`, opacity: .35 },
    ], { duration: opts.dur || 560, easing: "cubic-bezier(.3,.9,.28,1)" });
    const finish = () => {
      /* land: a soft blink on the destination so the handoff reads as one object */
      try {
        toEl.animate(
          [{ transform: "scale(1.14)", filter: "brightness(1.35)" }, { transform: "scale(1)", filter: "brightness(1)" }],
          { duration: 260, easing: "cubic-bezier(.34,1.56,.64,1)" });
      } catch (e) {}
      ghost.remove(); done();
    };
    if (typeof anim.finished === "function" || (anim.finished && anim.finished.then)) {
      anim.finished.then(finish).catch(finish);
    } else { anim.onfinish = finish; }
  }

  /* FLIP: record positions, let the DOM change, play the deltas. */
  const rects = new Map();
  function record(container, sel) {
    rects.clear();
    if (!container) return;
    container.querySelectorAll(sel).forEach(el => {
      const key = el.dataset.id != null ? el.dataset.id : el.dataset.flipKey;
      if (key != null) rects.set(String(key), el.getBoundingClientRect());
    });
  }
  function play(container, sel, opts = {}) {
    if (reduced || !container) return;
    container.querySelectorAll(sel).forEach(el => {
      const key = el.dataset.id != null ? el.dataset.id : el.dataset.flipKey;
      const prev = key != null ? rects.get(String(key)) : null;
      if (!prev) return;
      const now = el.getBoundingClientRect();
      const dx = prev.left - now.left, dy = prev.top - now.top;
      if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      try {
        el.animate(
          [{ transform: `translate3d(${dx}px,${dy}px,0)` }, { transform: "translate3d(0,0,0)" }],
          { duration: opts.dur || 420, easing: "cubic-bezier(.3,.9,.28,1)" });
      } catch (e) {}
    });
    rects.clear();
  }

  window.MotionFX = { fly, record, play };
})();
