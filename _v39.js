/* v3.39 verification: clean strip, atlas->dossier speed, scroll fps */
const { chromium } = require('playwright-core');
const fs = require('fs');
const EXE = '/tmp/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell';
const fps = (page, ms) => page.evaluate((ms) => new Promise(res => {
  let f = 0; const t0 = performance.now();
  const loop = () => { f++; if (performance.now() - t0 < ms) requestAnimationFrame(loop); else res(Math.round(f / (ms / 1000))); };
  requestAnimationFrame(loop);
}), ms);
(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://localhost:8023/index.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(900);
  const bb = await p.evaluate(() => { const el = document.querySelector('#boot .boot-bar'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  if (bb) await p.screenshot({ path: '_shots/v39-strip.png', clip: { x: bb.x - 30, y: bb.y - 30, width: bb.w + 60, height: bb.h + 60 } });
  const tail = await p.evaluate(() => {
    const t = document.getElementById('bootTail');
    return { kids: t.children.length, beforeAnim: getComputedStyle(t, '::before').animationName, afterDisp: getComputedStyle(t, '::after').display };
  });
  console.log('tail:', JSON.stringify(tail));
  try { await p.waitForFunction(() => !document.getElementById('boot'), { timeout: 15000 }); } catch (e) {}
  await p.waitForTimeout(1000);

  // atlas click -> dossier timing (canvas hit-test: scan a grid for a node)
  const cbox = await p.evaluate(() => { const q = document.querySelector('#atlasCanvas').getBoundingClientRect(); return { x: q.x, y: q.y, w: q.width, h: q.height }; });
  let hit = null;
  outer: for (let gy = 0.2; gy <= 0.85; gy += 0.13) {
    for (let gx = 0.08; gx <= 0.92; gx += 0.07) {
      await p.mouse.click(cbox.x + cbox.w * gx, cbox.y + cbox.h * gy);
      if (await p.evaluate(() => document.getElementById('modal').classList.contains('open'))) { hit = { gx, gy }; break outer; }
    }
  }
  console.log('atlas hit at:', JSON.stringify(hit));
  let openMs = null;
  if (hit) {
    await p.keyboard.press('Escape'); await p.waitForTimeout(500);
    await p.evaluate(() => {
      window.__openMs = -1; window.__t0 = 0;
      const m = document.getElementById('modal');
      const obs = new MutationObserver(() => {
        if (m.classList.contains('open') && window.__t0) { window.__openMs = performance.now() - window.__t0; obs.disconnect(); }
      });
      obs.observe(m, { attributes: true, attributeFilter: ['class'] });
    });
    await p.evaluate(() => { window.__t0 = performance.now(); });
    await p.mouse.click(cbox.x + cbox.w * hit.gx, cbox.y + cbox.h * hit.gy);
    await p.waitForTimeout(600);
    openMs = await p.evaluate(() => Math.round(window.__openMs));
  }
  console.log('atlas->dossier open ms:', openMs);
  await p.waitForTimeout(600);
  const mb = await p.evaluate(() => { const q = document.querySelector('.modal-body').getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 2 }; });
  await p.mouse.move(mb.x, mb.y);
  const dP = fps(p, 2000); for (let i = 0; i < 10; i++) { await p.mouse.wheel(0, 300); await p.waitForTimeout(170); }
  const dDown = await dP;
  const uP = fps(p, 2000); for (let i = 0; i < 10; i++) { await p.mouse.wheel(0, -300); await p.waitForTimeout(170); }
  const dUp = await uP;
  console.log('FPS dossier down/up:', dDown, dUp);
  const blur = await p.evaluate(() => getComputedStyle(document.getElementById('modal')).backdropFilter);
  console.log('modal backdrop-filter:', blur);
  await p.keyboard.press('Escape'); await p.waitForTimeout(400);

  // compare
  await p.evaluate(() => document.querySelector('[data-view="explorer"]').click());
  await p.waitForTimeout(700);
  await p.evaluate(() => document.querySelector('.cmpbtn[data-cmp]').click());
  await p.waitForTimeout(250);
  await p.evaluate(() => document.getElementById('compareGo').click());
  await p.waitForTimeout(800);
  const lb = await p.evaluate(() => { const r = document.querySelector('#cmp3List').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await p.mouse.move(lb.x, lb.y);
  const cP = fps(p, 2000); for (let i = 0; i < 10; i++) { await p.mouse.wheel(0, 300); await p.waitForTimeout(170); }
  const cD = await cP;
  const cU = fps(p, 2000); for (let i = 0; i < 10; i++) { await p.mouse.wheel(0, -300); await p.waitForTimeout(170); }
  const cUp = await cU;
  console.log('FPS picker down/up:', cD, cUp);
  console.log('ERRORS:', errs.length ? errs.join('|').slice(0, 200) : 'none');
  console.log('SHOTS:', fs.readdirSync('_shots').filter(f => f.startsWith('v39')).join(', '));
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
