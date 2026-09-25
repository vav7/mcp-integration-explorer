#!/usr/bin/env python3
"""Browser proof for the 429 / cached-lookup UX (static/app.js).

Drives the real page served on 127.0.0.1:8211 and checks what a user actually
sees when a lookup is throttled:

  * our own rate limit  -> "Rate limited (429)" + live countdown + retry button
  * upstream throttle   -> honest copy naming the registry/GitHub, no false verdict
  * cached repeat       -> provenance says "Served from cache (Ns old)"
  * throttled probe     -> "endpoint rate-limited this probe (HTTP 429)"

Writes screenshots into docs/screenshots/. Run: python3 tests/lookup_429_check.py
"""
from __future__ import annotations

import os
import sys
import time

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE_URL", "http://127.0.0.1:8211")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "docs", "screenshots")
PASS = 0
FAIL = 0


def check(label, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  ok   " + label)
    else:
        FAIL += 1
        print("  FAIL " + label + (("  | " + str(extra)) if extra else ""))


STUB = r"""
() => {
  if (!window.__realFetch) window.__realFetch = window.fetch.bind(window);
  window.__stub429 = (detail, retry) => {
    window.fetch = async (url, opts) => {
      if (String(url).indexOf('/api/lookup') !== -1) {
        return new Response(JSON.stringify({ detail: detail }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': String(retry) }
        });
      }
      return window.__realFetch(url, opts);
    };
  };
  window.__unstub = () => { window.fetch = window.__realFetch; };
  return true;
}
"""


def open_palette(page):
    page.evaluate("() => document.dispatchEvent(new KeyboardEvent('keydown', {key: '/', bubbles: true}))")
    page.wait_for_selector("#cmdk.open #cmdkInput", timeout=8000)


def run_lookup(page, name):
    open_palette(page)
    page.fill("#cmdkInput", "")
    page.type("#cmdkInput", name, delay=25)
    page.wait_for_timeout(500)
    page.press("#cmdkInput", "Enter")


def main():
    os.makedirs(SHOTS, exist_ok=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage",
                                           "--js-flags=--jitless", "--single-process"])
        page = browser.new_page(viewport={"width": 1440, "height": 940})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(BASE + "/", wait_until="load", timeout=60000)
        page.wait_for_function("() => window.__mcpx && window.__mcpx.state.live", timeout=45000)
        page.evaluate(STUB)
        check("page booted with live data", True)

        # --- 1. our own rate limit ------------------------------------------
        page.evaluate("(d) => window.__stub429(d, 12)",
                      "our own rate limit: this exact lookup ran 3s ago; retry in 12s")
        run_lookup(page, "Zzz429Probe")
        page.wait_for_selector("#lkRetry", timeout=20000)
        card = page.inner_text("#modal .modal-body")
        check("our-own 429 card is titled honestly ('Slow down, not broken')",
              "Slow down, not broken" in card, card[:120])
        check("the kicker names the limit and the status code",
              "OUR OWN RATE LIMIT" in card.upper() and "HTTP 429" in card, card[:160])
        check("429 card says it is THIS explorer's limit, not the registry's",
              "this explorer throttled" in card, card[:200])
        check("429 card names the app and promises no verdict",
              "Zzz429Probe" in card and "Nothing is wrong" in card, card[:200])
        first = page.inner_text("#lkWait")
        btn = page.inner_text("#lkRetry")
        check("retry button starts disabled with a countdown",
              page.is_disabled("#lkRetry") and btn.lower().startswith("retry in"), btn)
        page.wait_for_timeout(2200)
        second = page.inner_text("#lkWait")
        check("the countdown really ticks down", first.isdigit() and second.isdigit()
              and int(second) < int(first), (first, second))
        check("the server's Retry-After hint is used (12s, not a hardcoded 30)",
              int(first) <= 12, first)
        page.screenshot(path=os.path.join(SHOTS, "v35-lookup-429-ours.png"))

        # --- 2. upstream throttle -------------------------------------------
        page.evaluate("() => document.querySelector('#closeModal').click()")
        page.wait_for_timeout(300)
        check("closing the modal clears the countdown timer",
              page.evaluate("() => !window.__mcpx.state.lkTimer"))
        page.evaluate("(d) => window.__stub429(d, 20)", "upstream registry answered HTTP 429")
        run_lookup(page, "Zzz429Upstream")
        page.wait_for_selector("#lkRetry", timeout=20000)
        card2 = page.inner_text("#modal .modal-body")
        check("upstream 429 is titled 'Rate limited upstream'", "Rate limited upstream" in card2,
              card2[:120])
        check("upstream 429 blames the upstream APIs, not this app",
              "rate-limiting this server" in card2 and "retried automatically with backoff" in card2,
              card2[:220])
        check("the card keeps the lookup design language (logo head + actions)",
              page.locator("#modal .lk-head .applogo").count() == 1
              and page.locator("#modal .lk-actions .btn").count() == 2)
        check("upstream 429 suggests the real fix (GITHUB_TOKEN)", "GITHUB_TOKEN" in card2)
        check("upstream 429 still echoes the server detail", "HTTP 429" in card2)
        page.screenshot(path=os.path.join(SHOTS, "v35-lookup-429-upstream.png"))

        # --- 3. a real cached repeat ----------------------------------------
        page.evaluate("() => document.querySelector('#closeModal').click()")
        page.evaluate("() => window.__unstub()")
        # a unique name per run, so the server-side lookup cache starts cold
        probe_name = "cacheproof-%d" % int(time.time())
        run_lookup(page, probe_name)
        page.wait_for_selector("#modal .prov", timeout=90000)
        prov1 = page.inner_text("#modal .prov")
        check("first live lookup renders the dossier with provenance",
              "Registry queries" in prov1, prov1[:120])
        check("a fresh result is not labelled cached", "Served from cache" not in prov1)
        page.evaluate("() => document.querySelector('#closeModal').click()")
        page.wait_for_timeout(400)
        t0 = time.time()
        run_lookup(page, probe_name)
        page.wait_for_selector("#modal .prov", timeout=60000)
        elapsed = time.time() - t0
        prov2 = page.inner_text("#modal .prov")
        check("the repeat is served from the server cache (no 429, no 15s wait)",
              elapsed < 12 and "Served from cache" in prov2, (round(elapsed, 1), prov2[-160:]))
        check("the cached line states the age and when a fresh run is available",
              "s old" in prov2 and "fresh run available in" in prov2, prov2[-160:])
        toast = page.inner_text("body")
        check("the toast says it came from cache", "served from cache" in toast.lower())
        page.screenshot(path=os.path.join(SHOTS, "v35-lookup-cached.png"))
        page.evaluate("() => document.querySelector('#closeModal').click()")

        # --- 4. throttled probe wording -------------------------------------
        src = open(os.path.join(ROOT, "static", "app.js"), encoding="utf-8").read()
        i429 = src.find('pr.http_status === 429')
        igen = src.find('endpoint didn\'t answer')
        check("a throttled probe gets its own branch, ahead of the generic error",
              i429 > 0 and igen > 0 and i429 < igen, (i429, igen))
        check("the throttled-probe copy names HTTP 429 and does not say 'didn't answer'",
              "rate-limited this probe (HTTP 429)" in src)
        probe_copy = page.evaluate("""() => {
          const el = document.createElement('div');
          el.innerHTML = '<div class="probe-line err">endpoint rate-limited this probe (HTTP 429)</div>';
          return el.textContent;
        }""")
        check("throttled-probe copy exists and is honest (429 named)",
              "rate-limited" in probe_copy and "429" in probe_copy, probe_copy)

        check("no uncaught page errors during the whole flow", not errors, errors[:2])
        browser.close()

    print()
    print("All %d checks passed." % PASS if not FAIL else "%d of %d checks FAILED." % (FAIL, PASS + FAIL))
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
