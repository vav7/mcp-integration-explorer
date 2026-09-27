#!/usr/bin/env python3
"""Offline regression tests for the data-integrity fixes.

These lock in three real bugs found by re-fetching the live registry:

1. The MCP registry's `search` parameter does not match multi-word queries at
   all - a query containing a space returns ZERO hits even when the server is
   published. Verified against the live registry:
       search="se ranking"         -> 0 results   search="seranking"        -> com.seranking/mcp
       search="youtube transcript" -> 0 results   search="youtubetranscript"-> 2 servers
       search="bright data"        -> 0 results   search="brightdata"       -> brightdata-mcp
   Without a squashed variant those apps silently flip between "vendor official"
   and "no MCP found" from one refresh to the next.

2. The relevance gate must accept the squashed brand form too, or fixing the
   search would still drop the server.

3. A domain-verified vendor-official server must not be deleted by one blank
   registry cycle: it is kept, marked stale, and only dropped after two.

Run: python3 tests/test_registry_recall.py   (no network, no key)
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src import config                                      # noqa: E402
from src.fetchers import (                                   # noqa: E402
    _word_in,
    build_search_terms,
    relevance_terms,
    url_is_public,
)
from src.models import App, McpResult, McpServer              # noqa: E402
from src.pipeline import EMPTY_CYCLES_BEFORE_DROP, _merge_mcp  # noqa: E402

PASS = 0
FAIL = 0


def check(label: str, cond: bool) -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  ok   " + label)
    else:
        FAIL += 1
        print("  FAIL " + label)


def app(name: str, website: str) -> App:
    return App(id=1, name=name, category="test", website=website)


print("registry search recall (the registry ignores spaced queries)")
CASES = [
    ("SE Ranking", "https://seranking.com/api", "seranking"),
    ("YouTube Transcript", "https://transcriptapi.com", "youtubetranscript"),
    ("Bright Data", "https://brightdata.com", "brightdata"),
    ("Zoho Cliq", "https://zoho.com/cliq", "cliq"),
    ("MongoDB Atlas", "https://mongodb.com/docs/atlas/api", "mongodb"),
    ("Help Scout", "https://helpscout.com", "helpscout"),
]
for name, site, want in CASES:
    terms = build_search_terms(app(name, site))
    check("%-20s -> queries include %r  (%s)" % (name, want, ", ".join(terms)), want in terms)

check("single-word brands are unchanged", build_search_terms(app("Stripe", "https://stripe.com/docs/api")) == ["stripe"])
check("a spaced query is never the only query",
      all(len(build_search_terms(app(n, w))) > 1 for n, w in
          [("SE Ranking", "https://seranking.com/api"), ("Bright Data", "https://brightdata.com")]))
check("query fan-out stays bounded", len(build_search_terms(app("Salesforce Commerce Cloud", "https://developer.salesforce.com/docs/commerce"))) <= config.MAX_SEARCH_TERMS)
check("registry page size raised for recall", config.REGISTRY_LIMIT >= 50)

print("\nrelevance gate accepts the squashed brand, and nothing else")
REL = [
    ("SE Ranking", "https://seranking.com/api", "com.seranking/mcp official SE Ranking server", True),
    ("SE Ranking", "https://seranking.com/api", "io.github.someone/unrelated marketing tooling", False),
    ("YouTube Transcript", "https://transcriptapi.com", "com.getyoutubetranscript/youtube-transcript", True),
    ("YouTube Transcript", "https://transcriptapi.com", "io.github.foo/slack-transcript-helper", False),
    ("LinkedIn Ads", "https://learn.microsoft.com/linkedin/marketing", "com.microsoft/azure official server", False),
    ("Bright Data", "https://brightdata.com", "io.github.brightdata/brightdata-mcp", True),
]
for name, site, text, want in REL:
    rt = relevance_terms(app(name, site))
    got = any(_word_in(t, text) for t in rt)
    check("%-19s vs %-52s -> %s" % (name, text[:52], got), got is want)

check("squashed relevance never matches inside a longer word",
      not any(_word_in(t, "io.github.x/useserankingtools") for t in relevance_terms(app("SE Ranking", "https://seranking.com/api"))))

print("\nverified servers survive one blank registry cycle (anti-flap)")


def verified() -> McpResult:
    return McpResult(status="vendor_official", matched=1,
                     servers=[McpServer(name="com.seranking/mcp", namespace="com.seranking",
                                        classification="vendor_official",
                                        namespace_matches_vendor=True)],
                     queries=["seranking"], fetched_at="2026-09-24T12:00:00Z")


def blank() -> McpResult:
    return McpResult(status="none", matched=0, servers=[],
                     queries=["se ranking", "seranking"], fetched_at="2026-09-24T16:00:00Z")


c1 = _merge_mcp(verified(), blank())
check("cycle 1: still vendor_official", c1.status == "vendor_official")
check("cycle 1: server kept and flagged stale", len(c1.servers) == 1 and c1.servers[0].stale is True)
check("cycle 1: stamped with when it was last seen", c1.servers[0].last_seen == "2026-09-24T12:00:00Z")
check("cycle 1: the reason is recorded, not hidden", bool(c1.error) and "registry search returned nothing" in c1.error)
check("cycle 1: strike counter advanced", c1.empty_cycles == 1)

c2 = _merge_mcp(c1, blank())
check("cycle %d: blank twice in a row is accepted as 'none'" % EMPTY_CYCLES_BEFORE_DROP, c2.status == "none" and not c2.servers)

rec = _merge_mcp(c1, verified())
check("a good cycle clears the stale flag and the strike counter",
      rec.status == "vendor_official" and rec.servers[0].stale is False and rec.empty_cycles == 0)

community = McpResult(status="community", matched=2,
                      servers=[McpServer(name="io.github.a/b", classification="community")],
                      queries=["x"])
check("community results are never sticky (only domain-verified ones are)",
      _merge_mcp(community, blank()).status == "none")
check("an unknown (unreachable source) cycle still keeps known data",
      _merge_mcp(verified(), McpResult(status="unknown", error="registry HTTP 503")).status == "vendor_official")

print("\nSSRF guard: the pipeline never dials a private address")
PUBLIC = ["https://stripe.com/docs/api", "https://mcp.stripe.com", "https://registry.modelcontextprotocol.io/v0/servers"]
PRIVATE = ["http://127.0.0.1:8000/x", "http://localhost/", "http://169.254.169.254/latest/meta-data/",
           "http://10.0.0.5/", "http://192.168.1.1/", "http://172.16.0.9/", "http://[::1]/", "http://0.0.0.0/"]
for u in PUBLIC:
    check("public  %s" % u, url_is_public(u) is True)
for u in PRIVATE:
    check("blocked %s" % u, url_is_public(u) is False)
check("unresolvable hosts are refused, not dialled", url_is_public("http://nonexistent.invalid/") is False)
check("the guard is on by default", config.BLOCK_PRIVATE_URLS is True)

print("\ndeployment guardrails exist")
check("write endpoints can be key-gated", hasattr(config, "API_KEY"))
check("pinned apps are capped", config.MAX_CUSTOM_APPS > 0)
check("the type-ahead memo is bounded", config.SEARCH_CACHE_MAX > 0)
check("read-only mode is available for ephemeral hosts", hasattr(config, "NO_AUTO_REFRESH"))
check("lookup cooldown outlasts the lookup itself (>=10s): %s" % config.LOOKUP_COOLDOWN_S,
      config.LOOKUP_COOLDOWN_S >= 10.0)

print()
print("All %d checks passed." % PASS if not FAIL else "%d of %d checks FAILED." % (FAIL, PASS + FAIL))
sys.exit(1 if FAIL else 0)
