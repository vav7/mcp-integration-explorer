#!/usr/bin/env python3
"""Mobile regression: nothing may overflow the viewport horizontally.

Checks the heaviest surfaces (home, Intelligence, Help, Methodology, Pricing,
a dossier) at 390x844 and 360x740: page and body scrollWidth must equal the
viewport, the data table must scroll INSIDE its rounded plate rather than
stretching the page, and the nav must collapse to its essentials.

One browser per viewport: this sandbox's single-process Chromium cannot
reliably open a second page in an existing instance.

Run: python3 tests/mobile_check.py [http://127.0.0.1:PORT]
"""
from __future__ import annotations
import os
import sys
from playwright.sync_api import sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8203").rstrip("/")
OUT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "docs", "screenshots"))
os.makedirs(OUT, exist_ok=True)
results = []


def check(name, cond, extra=""):
    results.append((name, bool(cond)))
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else "  | " + str(extra)))


URLS = [("/", "home"), ("/#intelligence", "intelligence"), ("/#help", "help"),
        ("/#methodology", "methodology"), ("/#pricing", "pricing"), ("/app/64", "dossier")]

for vw, vh in ((390, 844), (360, 740)):
    with sync_playwright() as pw:
        b = pw.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage",
                                     "--js-flags=--jitless", "--single-process"])
        pg = b.new_page(viewport={"width": vw, "height": vh}, color_scheme="dark",
                        is_mobile=True, has_touch=True)
        for url, label in URLS:
            pg.goto("about:blank")
            pg.goto(BASE + url, wait_until="domcontentloaded")
            pg.wait_for_timeout(2400)
            r = pg.evaluate("() => ({sw: document.documentElement.scrollWidth,"
                            " bw: document.body.scrollWidth, iw: innerWidth})")
            check("%dx%d %-13s no horizontal overflow" % (vw, vh, label),
                  r["sw"] <= r["iw"] + 1 and r["bw"] <= r["iw"] + 1, r)
        pg.goto("about:blank")
        pg.goto(BASE + "/", wait_until="domcontentloaded")
        pg.wait_for_timeout(2400)
        r = pg.evaluate("""() => { const sc = document.querySelector('#viewContent');
            const vals = [...sc.querySelectorAll('td[data-label] > *')].map(e => e.getBoundingClientRect());
            return {ox: getComputedStyle(sc).overflowX, oy: getComputedStyle(sc).overflowY,
                    minw: getComputedStyle(sc.firstElementChild).minWidth, iw: innerWidth,
                    maxright: Math.round(Math.max(...vals.map(b => b.right))),
                    minleft: Math.round(Math.min(...vals.map(b => b.left))),
                    sh: sc.scrollHeight, ch: sc.clientHeight}; }""")
        check("%dx%d explorer cards keep every value on screen" % (vw, vh),
              int((r["minw"] or "0").replace("px", "") or 0) <= r["iw"]
              and r["minleft"] >= 0 and r["maxright"] <= r["iw"] + 1, r)
        check("%dx%d the app list scrolls inside its plate, not the page" % (vw, vh),
              r["ox"] in ("hidden", "clip") and r["oy"] in ("auto", "scroll") and r["sh"] > r["ch"], r)
        if vw == 390:
            pg.evaluate("window.scrollTo({top: 0, behavior: 'instant'})")
            pg.wait_for_timeout(300)
        r = pg.evaluate("""() => { const g = getComputedStyle(document.querySelector('.fgrid')).gridTemplateColumns;
            return {cols: g.split(' ').length}; }""")
        check("%dx%d footer stacks two-up, not one endless column" % (vw, vh), r["cols"] == 2, r)
        r = pg.evaluate("""() => { const row = document.querySelector('#gradebars .bar-row');
            const crow = document.querySelector('#catbars .bar-row');
            const lab = row.querySelector('.br-l'), clab = crow.querySelector('.br-l');
            const v = row.querySelector('.br-v').getBoundingClientRect();
            const full = e => e.scrollWidth <= e.clientWidth + 1;
            return {cols: getComputedStyle(row).gridTemplateColumns.split(' ').length,
                    areas: getComputedStyle(row).gridTemplateAreas.split('"').length > 2,
                    labFull: full(lab) && getComputedStyle(lab).whiteSpace === 'normal'
                             && lab.textContent.trim().length > 8,
                    catFull: [...document.querySelectorAll('#catbars .br-l')].every(full),
                    right: Math.round(v.right), iw: innerWidth,
                    panel: getComputedStyle(row.closest('.reveal')).borderRadius}; }""")
        check("%dx%d readiness bars stack full labels over a wide track" % (vw, vh),
              r["cols"] == 2 and r["areas"] and r["labFull"] and r["catFull"]
              and r["right"] <= r["iw"] + 1 and r["panel"] == "16px", r)
        pg.evaluate("""() => { [...document.querySelectorAll('#viewContent [data-cmp]')]
            .slice(0, 3).forEach(b => b.click()); }""")
        pg.wait_for_timeout(500)
        pg.evaluate("() => document.querySelector('#compareGo').click()")
        pg.wait_for_timeout(1000)
        # v39b: with a selection on the board the window opens already
        # reading the table; the add-apps panel waits above the fold.
        r = pg.evaluate("""() => { const c3 = document.querySelector('.cmp3');
            const mr = document.querySelector('#modal').getBoundingClientRect();
            const hd = document.querySelector('.cmp2-head').getBoundingClientRect();
            const pk = document.querySelector('.cmp3-pick').getBoundingClientRect();
            return {at: Math.round(c3.scrollTop), headTop: Math.round(hd.top),
                    mTop: Math.round(mr.top), mBot: Math.round(mr.bottom),
                    pickBottom: Math.round(pk.bottom)}; }""")
        check("%dx%d compare opens already reading the table, add-apps above the fold" % (vw, vh),
              r["at"] > 0 and r["mTop"] <= r["headTop"] <= r["mTop"] + 220
              and r["pickBottom"] <= r["headTop"] + 1, r)
        r = pg.evaluate("""() => { const f = document.querySelector('.cmp-flex');
            const c0 = Math.round(document.querySelector('.cmp2-corner').getBoundingClientRect().left);
            f.scrollLeft = 140;
            const c1 = Math.round(document.querySelector('.cmp2-corner').getBoundingClientRect().left);
            const lab = Math.round(document.querySelector('.cmp2-row .cmp2-label').getBoundingClientRect().left);
            return {sw: f.scrollWidth, cw: f.clientWidth, c0: c0, c1: c1, lab: lab, iw: innerWidth,
                    modalR: Math.round(document.querySelector('#modal').getBoundingClientRect().right)}; }""")
        check("%dx%d compare grid swipes inside the window, metric column pinned" % (vw, vh),
              r["sw"] > r["cw"] and r["c1"] >= 0 and abs(r["c1"] - r["c0"]) <= 2
              and 0 <= r["lab"] < 160 and r["modalR"] <= r["iw"] + 1, r)
        pg.evaluate("() => { document.querySelector('.cmp-flex').scrollLeft = 0; }")
        pg.wait_for_timeout(400)
        r = pg.evaluate("""() => { const f = document.querySelector('.cmp-flex');
            const cells = [...document.querySelectorAll('.cmp2-cell,.cmp2-app')];
            const cards = [...document.querySelectorAll('.cmp2-head .cmp2-app')].map(c => c.getBoundingClientRect());
            const fr = f.getBoundingClientRect();
            const peek = cards.some(c => c.right > fr.right + 2 && c.left < fr.right - 4);
            const fits = cards.every(c => c.right <= fr.right + 1);
            return {dim: cells.filter(c => parseFloat(getComputedStyle(c).opacity) < .99).length,
                    scrollable: f.scrollWidth > f.clientWidth, peek: peek, fits: fits}; }""")
        check("%dx%d compare deck shows every cell at once and peeks the next column" % (vw, vh),
              r["dim"] == 0 and (r["peek"] if r["scrollable"] else r["fits"]), r)
        # v39: the window body is a real vertical scroller: the add-apps panel
        # lifts away and the last row plus the foot note stay reachable.
        r = pg.evaluate("""() => { const c3 = document.querySelector('.cmp3');
            const md = document.querySelector('#modal');
            const cs = getComputedStyle(c3);
            c3.scrollTo({top: c3.scrollHeight, behavior: 'instant'});
            const foot = document.querySelector('.cmp2-foot').getBoundingClientRect();
            const rows = document.querySelectorAll('.cmp2-row');
            const last = rows[rows.length - 1].getBoundingClientRect();
            const mr = md.getBoundingClientRect();
            return {oy: cs.overflowY, sh: c3.scrollHeight, ch: c3.clientHeight,
                    at: Math.round(c3.scrollTop),
                    footIn: foot.bottom <= mr.bottom + 1 && foot.height > 0,
                    rowIn: last.bottom <= mr.bottom + 1}; }""")
        check("%dx%d compare window scrolls: add-apps lifts, last row + foot reachable" % (vw, vh),
              r["oy"] in ("auto", "scroll") and r["sh"] > r["ch"] and r["at"] > 0
              and r["footIn"] and r["rowIn"], r)
        # v39: no per-cell entrance animation, no column-width tween on phones
        r = pg.evaluate("""() => { const cell = document.querySelector('.cmp2-cell');
            const row = document.querySelector('.cmp2-row');
            return {cellAnim: getComputedStyle(cell).animationName,
                    rowTrans: getComputedStyle(row).transitionProperty}; }""")
        check("%dx%d compare cells render instantly, no stagger or column tween" % (vw, vh),
              r["cellAnim"] == "none" and r["rowTrans"] == "none", r)
        # v39: a URL-bar style height-only resize must never rebuild the grid
        pg.evaluate("() => { window.__gp = document.querySelector('.cmp-gridpart'); }")
        pg.set_viewport_size({"width": vw, "height": vh - 60})
        pg.wait_for_timeout(450)
        r = pg.evaluate("() => ({same: document.querySelector('.cmp-gridpart') === window.__gp})")
        check("%dx%d url-bar resize never rebuilds the grid mid-scroll" % (vw, vh), r["same"], r)
        pg.set_viewport_size({"width": vw, "height": vh})
        pg.wait_for_timeout(450)
        if vw == 390:
            # money shot: picker scrolled up, app cards + full table in view
            pg.evaluate("""() => { const c3 = document.querySelector('.cmp3');
                const p = document.querySelector('.cmp3-pick');
                c3.scrollTo({top: p.offsetHeight + 8, behavior: 'instant'}); }""")
            pg.wait_for_timeout(250)
            pg.screenshot(path=os.path.join(OUT, "v39-mobile-compare.png"))
            print("       shot -> v39-mobile-compare.png")
        # v39c: empty the board inside the open window, then add one app:
        # the fresh table must glide into view, never hide below the fold
        pg.evaluate("() => { document.querySelector('.cmp3').scrollTo({top: 0, behavior: 'instant'}); }")
        pg.wait_for_timeout(250)
        pg.evaluate("() => { [...document.querySelectorAll('.cmp3-item.on')].forEach(b => b.click()); }")
        pg.wait_for_timeout(500)
        pg.evaluate("() => { document.querySelector('.cmp3-item:not([hidden])').click(); }")
        pg.wait_for_timeout(1100)
        r = pg.evaluate("""() => { const c3 = document.querySelector('.cmp3');
            const hd = document.querySelector('.cmp2-head');
            const mr = document.querySelector('#modal').getBoundingClientRect();
            const hr = hd ? hd.getBoundingClientRect() : null;
            return {at: Math.round(c3.scrollTop), has: !!hd,
                    rows: document.querySelectorAll('.cmp2-row').length,
                    inView: !!hr && hr.top >= mr.top - 1 && hr.top < mr.bottom}; }""")
        check("%dx%d first add from an empty window glides straight to the table" % (vw, vh),
              r["has"] and r["rows"] >= 1 and r["at"] > 0 and r["inView"], r)
        pg.keyboard.press("Escape")
        pg.wait_for_timeout(400)
        r = pg.evaluate("""() => { const nr = document.querySelector('.nav-right').getBoundingClientRect();
            return {right: Math.round(nr.right), iw: innerWidth}; }""")
        check("%dx%d nav fits the viewport" % (vw, vh), r["right"] <= r["iw"] + 1, r)
        # v40: the dock itself, loaded straight from the home screen with all
        # four chips. The Compare button must sit whole inside the box, the
        # chips must stay on one scrollable row, and the box stays compact.
        pg.evaluate("() => { const c = document.querySelector('#compareClear'); if (c) c.click(); }")
        pg.wait_for_timeout(300)
        pg.evaluate("""() => { [...document.querySelectorAll('#viewContent [data-cmp]')]
            .slice(0, 4).forEach(b => b.click()); }""")
        pg.wait_for_timeout(500)
        r = pg.evaluate("""() => { const bar = document.querySelector('#compareBar');
            const br = bar.getBoundingClientRect();
            const go = document.querySelector('#compareGo').getBoundingClientRect();
            const clr = document.querySelector('#compareClear').getBoundingClientRect();
            const cw = document.querySelector('#compareChips');
            const chips = [...document.querySelectorAll('.cb-chip')].map(c => c.getBoundingClientRect());
            return {n: chips.length, barH: Math.round(br.height),
                    barL: Math.round(br.left), barR: Math.round(br.right), iw: innerWidth,
                    goIn: go.left >= br.left - 1 && go.right <= br.right + 1
                          && go.top >= br.top - 1 && go.bottom <= br.bottom + 1,
                    clrIn: clr.left >= br.left - 1 && clr.right <= br.right + 1,
                    oneRow: chips.every(c => Math.abs(c.top - chips[0].top) < 2),
                    scrollable: cw.scrollWidth > cw.clientWidth,
                    lab: document.querySelector('.cb-label').textContent}; }""")
        check("%dx%d dock with 4 apps: Compare whole inside the box, one chip row" % (vw, vh),
              r["n"] == 4 and r["goIn"] and r["clrIn"] and r["oneRow"]
              and r["barH"] <= 160 and r["barR"] <= r["iw"] + 1 and r["barL"] >= -1
              and r["lab"].endswith("/4"), r)
        if vw == 390:
            pg.screenshot(path=os.path.join(OUT, "v40-dock-4apps.png"))
            print("       shot -> v40-dock-4apps.png")
        pg.close()
        b.close()

# v39d: a landscape phone is wider than 760px, so the portrait perf rules
# never reached it. Probe 844x390: cells must never sit invisible waiting
# on a stagger delay, and the compare window must scroll to its foot while
# the page itself never grows sideways.
with sync_playwright() as pw:
    b = pw.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage",
                                 "--js-flags=--jitless", "--single-process"])
    pg = b.new_page(viewport={"width": 844, "height": 390}, color_scheme="dark",
                    is_mobile=True, has_touch=True)
    pg.goto("about:blank")
    pg.goto(BASE + "/", wait_until="domcontentloaded")
    pg.wait_for_timeout(2400)
    # v40: load the dock with all four chips first; the Compare button must
    # stay whole inside the box even in landscape, then open the window.
    pg.evaluate("""() => { [...document.querySelectorAll('#viewContent [data-cmp]')]
        .slice(0, 4).forEach(b => b.click()); }""")
    pg.wait_for_timeout(500)
    r = pg.evaluate("""() => { const br = document.querySelector('#compareBar').getBoundingClientRect();
        const go = document.querySelector('#compareGo').getBoundingClientRect();
        const chips = [...document.querySelectorAll('.cb-chip')].map(c => c.getBoundingClientRect());
        return {barH: Math.round(br.height), iw: innerWidth, n: chips.length,
                goIn: go.right <= br.right + 1 && go.left >= br.left - 1
                      && go.bottom <= br.bottom + 1 && go.top >= br.top - 1,
                oneRow: chips.every(c => Math.abs(c.top - chips[0].top) < 2),
                sw: document.documentElement.scrollWidth}; }""")
    check("844x390 dock keeps the Compare button whole inside the box",
          r["n"] == 4 and r["goIn"] and r["oneRow"] and r["barH"] <= 160
          and r["sw"] <= r["iw"] + 1, r)
    pg.evaluate("() => document.querySelector('#compareGo').click()")
    pg.wait_for_selector(".cmp2-cell", timeout=5000)
    r = pg.evaluate("""() => { const cells = [...document.querySelectorAll('.cmp2-cell,.cmp2-app')];
        return {n: cells.length,
                dim: cells.filter(c => parseFloat(getComputedStyle(c).opacity) < .99).length}; }""")
    check("844x390 compare cells never wait on a stagger delay",
          r["n"] > 10 and r["dim"] == 0, r)
    pg.wait_for_timeout(700)
    r = pg.evaluate("""() => { const c3 = document.querySelector('.cmp3');
        const md = document.querySelector('#modal').getBoundingClientRect();
        c3.scrollTo({top: c3.scrollHeight, behavior: 'instant'});
        const foot = document.querySelector('.cmp2-foot').getBoundingClientRect();
        return {oy: getComputedStyle(c3).overflowY, sh: c3.scrollHeight, ch: c3.clientHeight,
                footIn: foot.bottom <= md.bottom + 1,
                sw: document.documentElement.scrollWidth, iw: innerWidth}; }""")
    check("844x390 compare window scrolls to the foot, page never sideways",
          r["oy"] in ("auto", "scroll") and r["sh"] > r["ch"] and r["footIn"]
          and r["sw"] <= r["iw"] + 1, r)
    pg.close()
    b.close()

bad = [x for x in results if not x[1]]
print("\nRESULT: " + ("PASS - %d mobile checks" % len(results) if not bad
                     else "FAIL - %d/%d" % (len(bad), len(results))))
sys.exit(1 if bad else 0)
