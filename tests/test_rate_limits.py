#!/usr/bin/env python3
"""Offline tests for 429 / rate-limit handling.

Everything runs against in-process fakes (a scripted client for the fetchers, an
ASGI transport for the API), so no sockets are opened and no upstream service is
touched. Covers the three layers that absorb throttling:

  1. registry response cache    -> we do not re-ask the same question
  2. bounded retries + backoff  -> honours Retry-After, never caches a 429
  3. lookup result cache        -> a repeat lookup is served, not rejected

Plus honest reporting: a throttled probe says "rate limited", and our own 429
says whose limit it is and when to come back.

Run: python3 tests/test_rate_limits.py
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("NO_AUTO_REFRESH", "1")

import httpx  # noqa: E402

from src import config, fetchers  # noqa: E402

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


# --- fakes ------------------------------------------------------------------
class FakeResp:
    def __init__(self, status_code=200, body=None, headers=None):
        self.status_code = status_code
        self._body = body
        self.headers = headers or {}
        self.text = json.dumps(body) if body is not None else ""

    def json(self):
        if self._body is None:
            raise ValueError("no JSON body")
        return self._body


class FakeClient:
    """Scripted stand-in for httpx.AsyncClient: pops one response per call."""

    def __init__(self, script):
        self.script = list(script)
        self.gets = 0
        self.posts = 0
        self.urls = []

    def _next(self, default):
        if self.script:
            item = self.script.pop(0)
            if isinstance(item, Exception):
                raise item
            return item
        return default

    async def get(self, url, timeout=None, **kw):
        self.gets += 1
        self.urls.append(url)
        return self._next(FakeResp(200, {"servers": []}))

    async def post(self, url, json=None, headers=None, timeout=None, **kw):
        self.posts += 1
        self.urls.append(url)
        return self._next(FakeResp(200, {"result": {}}))


def reset_cache():
    fetchers._REGISTRY_CACHE.clear()


# --- layer 2: backoff -------------------------------------------------------
def test_retry_delay():
    print("\n[backoff]")
    check("honours an upstream Retry-After hint", abs(fetchers.retry_delay("2", 0) - 2.0) < 1e-6)
    check("caps an absurd Retry-After",
          fetchers.retry_delay("9999", 0) <= config.UPSTREAM_BACKOFF_MAX_S * 3)
    check("ignores a non-numeric Retry-After",
          0 <= fetchers.retry_delay("Wed, 21 Oct 2026 07:28:00 GMT", 0) <= config.UPSTREAM_BACKOFF_MAX_S)
    d0 = [fetchers.retry_delay(None, 0) for _ in range(40)]
    d2 = [fetchers.retry_delay(None, 2) for _ in range(40)]
    check("backoff grows with the attempt", min(d2) > min(d0), (min(d0), min(d2)))
    check("backoff is jittered (not a fixed sleep)", len({round(x, 6) for x in d0}) > 5)
    check("backoff never exceeds the configured ceiling",
          max(d0 + d2) <= config.UPSTREAM_BACKOFF_MAX_S + 1e-9)


# --- layers 1+2: registry_get ----------------------------------------------
def test_registry_get():
    print("\n[registry_get: retries + cache]")
    url = "https://registry.test/v0/servers?search=cachetest&limit=50"
    reset_cache()
    config.UPSTREAM_RETRIES = 2
    # 429 with Retry-After: 0, then success
    c = FakeClient([FakeResp(429, None, {"Retry-After": "0"}),
                    FakeResp(200, {"servers": [{"server": {"name": "com.x/mcp"}}]})])
    status, data = asyncio.run(fetchers.registry_get(c, url, timeout=1.0))
    check("a 429 is retried and the retry succeeds", status == 200 and isinstance(data, dict), status)
    check("exactly two upstream calls were made (1 retry, no storm)", c.gets == 2, c.gets)

    # cache: the identical URL is not fetched again
    c2 = FakeClient([])
    status2, data2 = asyncio.run(fetchers.registry_get(c2, url, timeout=1.0))
    check("a cached registry response is served without a network call",
          status2 == 200 and c2.gets == 0 and data2 == data, (status2, c2.gets))

    # a throttled response must never be cached
    url429 = "https://registry.test/v0/servers?search=always429&limit=50"
    reset_cache()
    c3 = FakeClient([FakeResp(429, None, {"Retry-After": "0"})] * 3)
    status3, _ = asyncio.run(fetchers.registry_get(c3, url429, timeout=1.0))
    check("persistent 429 surfaces honestly as 429", status3 == 429, status3)
    check("retries are bounded by UPSTREAM_RETRIES", c3.gets == config.UPSTREAM_RETRIES + 1, c3.gets)
    c4 = FakeClient([FakeResp(429, None, {"Retry-After": "0"})] * 3)
    asyncio.run(fetchers.registry_get(c4, url429, timeout=1.0))
    check("a 429 is not cached (the next call really goes upstream again)",
          c4.gets == config.UPSTREAM_RETRIES + 1 and url429 not in fetchers._REGISTRY_CACHE,
          (c4.gets, url429 in fetchers._REGISTRY_CACHE))

    # non-retryable statuses fail fast
    url404 = "https://registry.test/v0/servers?search=gone&limit=50"
    reset_cache()
    c5 = FakeClient([FakeResp(404, None)])
    status5, _ = asyncio.run(fetchers.registry_get(c5, url404, timeout=1.0))
    check("a 404 is not retried", status5 == 404 and c5.gets == 1, (status5, c5.gets))

    # 5xx is retried, transport errors are reported with their real reason
    url500 = "https://registry.test/v0/servers?search=flaky&limit=50"
    reset_cache()
    c6 = FakeClient([FakeResp(503, None), FakeResp(200, {"servers": []})])
    status6, _ = asyncio.run(fetchers.registry_get(c6, url500, timeout=1.0))
    check("a 503 is retried", status6 == 200 and c6.gets == 2, (status6, c6.gets))
    urlerr = "https://registry.test/v0/servers?search=dead&limit=50"
    reset_cache()
    c7 = FakeClient([httpx.ConnectError("boom")] * 3)
    status7, data7 = asyncio.run(fetchers.registry_get(c7, urlerr, timeout=1.0))
    check("a transport error keeps its real reason (not a fake 'no MCP')",
          status7 is None and isinstance(data7, str) and "ConnectError" in data7, (status7, data7))

    # cache is bounded
    reset_cache()
    config.REGISTRY_CACHE_MAX = 5
    for i in range(9):
        u = f"https://registry.test/v0/servers?search=bound{i}&limit=50"
        asyncio.run(fetchers.registry_get(FakeClient([FakeResp(200, {"servers": []})]), u, timeout=1.0))
    check("the registry cache is bounded (oldest entries evicted)",
          len(fetchers._REGISTRY_CACHE) <= 5, len(fetchers._REGISTRY_CACHE))
    config.REGISTRY_CACHE_MAX = int(os.environ.get("REGISTRY_CACHE_MAX", "400"))
    reset_cache()


# --- fetch_mcp keeps a throttled registry call honest -----------------------
def test_fetch_mcp_error_text():
    print("\n[fetch_mcp: honest error on 429]")
    from src.models import App
    reset_cache()
    config.UPSTREAM_RETRIES = 0
    app = App(id=1, name="Rate Limit Test", website="https://ratelimit.test", category="Other",
              description="stub", docs_url=None, pricing_url=None, github_url=None, sources=[])
    client = FakeClient([FakeResp(429, None, {"Retry-After": "0"})] * 6)
    res = asyncio.run(fetchers.fetch_mcp(client, app))
    check("a throttled registry is reported as HTTP 429, not as 'no MCP found'",
          res.error and "429" in res.error, res.error)
    check("status stays unknown when the registry never answered", res.status == "unknown", res.status)
    check("no servers are invented from a failed call", not res.servers)
    config.UPSTREAM_RETRIES = int(os.environ.get("UPSTREAM_RETRIES", "2"))
    reset_cache()


# --- probe_mcp: a throttled endpoint is not "no MCP" ------------------------
def test_probe_429():
    print("\n[probe_mcp: throttled endpoint]")
    keep = config.BLOCK_PRIVATE_URLS
    config.BLOCK_PRIVATE_URLS = False
    url = "https://mcp.ratelimit.test/mcp"
    c = FakeClient([FakeResp(429, None, {"Retry-After": "0"}), FakeResp(429, None)])
    pr = asyncio.run(fetchers.probe_mcp(c, url))
    check("a persistently throttled endpoint retries once then reports 429",
          pr.http_status == 429 and pr.result == "error" and c.posts == 2, (pr.http_status, c.posts))
    check("the probe error names the rate limit", bool(pr.error) and "rate limited" in pr.error, pr.error)
    check("no tool count is invented", pr.tools_count is None)

    c2 = FakeClient([FakeResp(429, None, {"Retry-After": "0"}),
                     FakeResp(200, {"result": {"protocolVersion": "2025-06-18",
                                               "capabilities": {"tools": {}}}}),
                     FakeResp(200, {"result": {}}),
                     FakeResp(200, {"result": {"tools": [{"name": "search"}]}})])
    pr2 = asyncio.run(fetchers.probe_mcp(c2, url))
    check("a probe that survives one 429 still reports real tools",
          pr2.result == "open" and pr2.tools_count == 1, (pr2.result, pr2.tools_count))

    # fetch_mcp_detail must not fabricate a capability snapshot after a 429
    c3 = FakeClient([FakeResp(429, None, {"Retry-After": "0"}), FakeResp(429, None)])
    det = asyncio.run(fetchers.fetch_mcp_detail(c3, url))
    check("a throttled capability fetch returns None (caller keeps prior truth)", det is None)
    config.BLOCK_PRIVATE_URLS = keep


# --- layer 3: /api/lookup serves a repeat instead of 429-ing ----------------
class FakeAppLive:
    def __init__(self, servers=None, error=None):
        self._d = {
            "app": {"name": "Stub", "website": "https://stub.test"},
            "mcp": {"status": "official" if servers else "none", "servers": servers or [],
                    "error": error, "queries": ["stub"], "fetched_at": "2026-09-25T00:00:00Z"},
            "github": {}, "liveness": None, "readiness": {"score": 42},
        }

    def model_dump(self, mode="json"):
        return json.loads(json.dumps(self._d))


def test_lookup_api():
    print("\n[/api/lookup: cache before cooldown]")
    from src import app as appmod

    calls = {"n": 0}
    failing = {"on": False}

    async def fake_discover(client, name, website=""):
        calls["n"] += 1
        if failing["on"]:
            return FakeAppLive(error="registry HTTP 429")
        return FakeAppLive(servers=[{"name": "com.stub/mcp", "classification": "vendor_official"}])

    real_discover = appmod.discover_app
    real_bump = appmod.STORE.bump_popular
    real_cache_s = config.LOOKUP_CACHE_S
    real_cool_s = config.LOOKUP_COOLDOWN_S
    appmod.discover_app = fake_discover
    appmod.STORE.bump_popular = lambda name: None

    async def run():
        transport = httpx.ASGITransport(app=appmod.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            appmod._last_lookup.clear()
            appmod._lookup_cache.clear()
            config.LOOKUP_CACHE_S = 60.0
            config.LOOKUP_COOLDOWN_S = 30.0

            r1 = await c.get("/api/lookup", params={"name": "Stub"})
            check("first lookup runs the real pipeline", r1.status_code == 200 and calls["n"] == 1,
                  (r1.status_code, calls["n"]))
            check("first result is not labelled cached", not r1.json().get("cached"))

            r2 = await c.get("/api/lookup", params={"name": "Stub"})
            check("an immediate repeat is served, NOT rejected with 429",
                  r2.status_code == 200, r2.status_code)
            check("the repeat did not hit any upstream API", calls["n"] == 1, calls["n"])
            j2 = r2.json()
            check("the repeat is labelled as cached, with an age and a retry window",
                  j2.get("cached") is True and isinstance(j2.get("cache_age_s"), int)
                  and j2.get("retry_after_s", 0) > 0, {k: j2.get(k) for k in
                                                       ("cached", "cache_age_s", "retry_after_s")})

            # cache expired but the cooldown stamp is fresh -> honest 429
            config.LOOKUP_CACHE_S = 0.01
            await asyncio.sleep(0.05)
            r3 = await c.get("/api/lookup", params={"name": "Stub"})
            check("with no cached result the cooldown still answers 429", r3.status_code == 429,
                  r3.status_code)
            check("the 429 carries Retry-After so a client can back off itself",
                  int(r3.headers.get("Retry-After", "0")) >= 1, r3.headers.get("Retry-After"))
            detail = (r3.json() or {}).get("detail", "")
            check("the 429 says whose limit it is (not 'the registry')",
                  "our own rate limit" in detail, detail)
            check("the 429 did not consume an upstream call", calls["n"] == 1, calls["n"])

            # a failed lookup must not be cached (so the next click retries)
            appmod._last_lookup.clear()
            appmod._lookup_cache.clear()
            config.LOOKUP_CACHE_S = 60.0
            failing["on"] = True
            before = calls["n"]
            r4 = await c.get("/api/lookup", params={"name": "Broken"})
            check("a throttled lookup still returns 200 with an honest error",
                  r4.status_code == 200 and r4.json()["mcp"]["error"] == "registry HTTP 429",
                  (r4.status_code, r4.json()["mcp"].get("error")))
            check("the failed result was NOT put in the lookup cache",
                  "broken" not in appmod._lookup_cache and calls["n"] == before + 1,
                  list(appmod._lookup_cache))
            failing["on"] = False

            # validation still works
            r6 = await c.get("/api/lookup", params={"name": ""})
            check("an empty name is a 400, not a wasted upstream call", r6.status_code == 400,
                  r6.status_code)

    try:
        asyncio.run(run())
    finally:
        appmod.discover_app = real_discover
        appmod.STORE.bump_popular = real_bump
        config.LOOKUP_CACHE_S = real_cache_s
        config.LOOKUP_COOLDOWN_S = real_cool_s
        appmod._last_lookup.clear()
        appmod._lookup_cache.clear()


def main():
    print("429 / rate-limit handling")
    started = time.time()
    test_retry_delay()
    test_registry_get()
    test_fetch_mcp_error_text()
    test_probe_429()
    test_lookup_api()
    print()
    print("All %d checks passed in %.1fs." % (PASS, time.time() - started) if not FAIL
          else "%d of %d checks FAILED." % (FAIL, PASS + FAIL))
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
