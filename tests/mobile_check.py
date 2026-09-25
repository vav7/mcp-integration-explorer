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
import sys
from playwright.sync_api import sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8203").rstrip("/")
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
        r = pg.evaluate("""() => { const sc = document.querySelector('#viewContent');
            return {ox: getComputedStyle(sc).overflowX,
                    minw: getComputedStyle(sc.firstElementChild).minWidth}; }""")
        check("%dx%d table scrolls inside its plate, not the page" % (vw, vh),
              r["ox"] in ("auto", "scroll") and int((r["minw"] or "0").replace("px", "") or 0) > vw, r)
        r = pg.evaluate("""() => { const nr = document.querySelector('.nav-right').getBoundingClientRect();
            return {right: Math.round(nr.right), iw: innerWidth}; }""")
        check("%dx%d nav fits the viewport" % (vw, vh), r["right"] <= r["iw"] + 1, r)
        pg.close()
        b.close()

bad = [x for x in results if not x[1]]
print("\nRESULT: " + ("PASS - %d mobile checks" % len(results) if not bad
                     else "FAIL - %d/%d" % (len(bad), len(results))))
sys.exit(1 if bad else 0)
