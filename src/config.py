"""Central configuration for the MCP Integration Explorer.

Every value here maps to a *real*, publicly reachable data source. Nothing in
this project fabricates research claims: the fields we report are the fields we
can actually fetch and link back to a source.
"""
from __future__ import annotations

import os
from pathlib import Path

# --- Identity -------------------------------------------------------------
APP_NAME = "MCP Integration Explorer"
APP_TAGLINE = "Live, source-traceable integration readiness for 100 apps"

# --- Paths ----------------------------------------------------------------
ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
STATIC_DIR = ROOT / "static"
APPS_FILE = DATA_DIR / "apps.json"
CUSTOM_APPS_FILE = DATA_DIR / "custom_apps.json"   # user-pinned discovered apps
CACHE_FILE = DATA_DIR / "live_cache.json"

# --- Real data sources ----------------------------------------------------
# Official Model Context Protocol registry (public, no key required).
MCP_REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0/servers"
# GitHub REST API (works unauthenticated at low limits; a token raises them).
GITHUB_API_URL = "https://api.github.com"

GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")

# --- Fetch behaviour ------------------------------------------------------
HTTP_TIMEOUT = 20.0            # seconds per outbound request
LIVENESS_TIMEOUT = 15.0        # seconds for website reachability checks
PROBE_TIMEOUT = 10.0           # seconds for a live MCP endpoint handshake
SUGGEST_TIMEOUT = 15.0          # short timeout for type-ahead registry lookups
MAX_CONCURRENCY = 6            # parallel outbound requests (be polite)
PROBE_CONCURRENCY = 8          # parallel live MCP endpoint probes
REGISTRY_LIMIT = 50            # results per registry search page. Recall matters:
#                                the registry paginates, and a brand pushed off
#                                page one silently reads as "no MCP found".
MAX_SEARCH_TERMS = 5           # registry queries per app per refresh
MAX_PACKAGES_PER_APP = 3       # cap npm/PyPI lookups per app

# --- Integration Readiness Score weights (transparent, sums to 1.0) -------
READINESS_WEIGHTS = {
    "official_mcp": 0.28,   # vendor-official vs community vs none
    "capability": 0.14,     # real tools exposed by a live endpoint
    "adoption": 0.16,       # npm/PyPI monthly downloads
    "popularity": 0.14,     # GitHub stars of the MCP repo
    "maintenance": 0.16,    # recency of last commit / not archived
    "availability": 0.12,   # website reachable
}
# Log-scale ceilings so a few huge repos don't dwarf everything.
STARS_CEILING_LOG = 4.0      # log10(stars) of 4 (=10k stars) -> full popularity
DOWNLOADS_CEILING_LOG = 5.0  # log10(downloads) of 5 (=100k/mo) -> full adoption

# --- History / change tracking --------------------------------------------
HISTORY_FILE = DATA_DIR / "history.json"
# Per-integration historical fingerprints used by the diff / breaking-change
# feature. Plain JSON under data/ like everything else - no new services.
APP_SNAPSHOTS_FILE = DATA_DIR / "app_snapshots.json"
APP_SNAPSHOTS_MAX = 24           # fingerprints kept per integration
CHANGES_FILE = DATA_DIR / "changes.json"
WATCHES_FILE = DATA_DIR / "watches.json"
ALERTS_FILE = DATA_DIR / "alerts.json"
POPULAR_FILE = DATA_DIR / "popular.json"
HISTORY_MAX_POINTS = 500
CHANGES_MAX = 200
ALERTS_MAX = 200
PROBE_INTERVAL = 6 * 3600      # re-probe a live MCP endpoint at most every 6h
PACKAGES_INTERVAL = 12 * 3600  # re-resolve package stats at most every 12h

# Optional: POST each fired alert here (Slack/Discord/Zapier webhook, etc.).
ALERT_WEBHOOK_URL = os.environ.get("ALERT_WEBHOOK_URL", "")

# Background auto-refresh cadence (seconds). Registry + liveness are cheap and
# unauthenticated; GitHub is refreshed on a slower cadence to respect limits.
REFRESH_INTERVAL_FULL = int(os.environ.get("REFRESH_INTERVAL_FULL", 15 * 60))
REFRESH_INTERVAL_GITHUB = int(os.environ.get("REFRESH_INTERVAL_GITHUB", 30 * 60))
# Skip the automatic refresh on boot (serve the cached snapshot first). Useful
# for testing, low-resource hosts, or when you only want on-demand refreshes.
NO_STARTUP_REFRESH = os.environ.get("NO_STARTUP_REFRESH", "") == "1"
# Let the first page load + snapshot fetch finish before the heavy initial refresh.
STARTUP_REFRESH_DELAY = int(os.environ.get("STARTUP_REFRESH_DELAY", "6"))

# Serve read-only from the committed snapshot: no scheduler at all. Use this on
# hosts with an ephemeral filesystem or a shared egress IP - the data/ writes
# would be lost on restart, and the unauthenticated GitHub quota is per IP, so N
# dynos would each burn it. The GitHub Actions cron keeps data/ fresh instead.
NO_AUTO_REFRESH = os.environ.get("NO_AUTO_REFRESH", "") == "1" or NO_STARTUP_REFRESH

# --- Deployment hardening ---------------------------------------------------
# Refuse to fetch or probe anything that resolves to a loopback, private,
# link-local or reserved address. The pipeline dials URLs a visitor can
# influence (/api/lookup?website=..., a pinned app, a registry-published remote
# endpoint); without this a self-hosted instance is an SSRF primitive into the
# operator's own network. Set to "0" only for a trusted internal deployment.
BLOCK_PRIVATE_URLS = os.environ.get("BLOCK_PRIVATE_URLS", "1") != "0"
# When set, the state-changing endpoints (POST /api/refresh, POST /api/apps,
# POST/DELETE /api/watch, POST /api/alerts/read) require `X-API-Key: <value>`.
# Reads stay open: the whole point is a public explorer.
API_KEY = os.environ.get("EXPLORER_API_KEY", "")
# Cheap abuse caps for a public deployment.
MAX_CUSTOM_APPS = int(os.environ.get("MAX_CUSTOM_APPS", "200"))     # pinned apps kept
# Per-name cooldown on /api/lookup. NOTE: a lookup fans out to the registry,
# GitHub, npm/PyPI, the app's site and an MCP handshake and routinely takes
# 10-20s, and the stamp is taken when the request STARTS - so the cooldown must
# be LONGER than the operation or it never fires (measured: a 2s default let a
# second identical lookup straight through). 30s bounds the expensive path.
LOOKUP_COOLDOWN_S = float(os.environ.get("LOOKUP_COOLDOWN_S", "30.0"))
# --- 429 / rate-limit handling ---------------------------------------------
# A lookup fans out to the registry, GitHub, npm/PyPI, the app's site and an MCP
# handshake, so upstream throttling is expected on shared or free-tier IPs.
# Three layers absorb it:
#   1. short-lived response cache  -> we simply do not re-ask the same question
#   2. bounded retries + backoff   -> honours an upstream Retry-After header
#   3. lookup result cache         -> a repeat lookup is served instantly instead
#                                     of being rejected with our own 429
REGISTRY_CACHE_S = float(os.environ.get("REGISTRY_CACHE_S", "300"))
REGISTRY_CACHE_MAX = int(os.environ.get("REGISTRY_CACHE_MAX", "400"))
UPSTREAM_RETRIES = int(os.environ.get("UPSTREAM_RETRIES", "2"))
UPSTREAM_BACKOFF_MAX_S = float(os.environ.get("UPSTREAM_BACKOFF_MAX_S", "6"))
LOOKUP_CACHE_S = float(os.environ.get("LOOKUP_CACHE_S", "180"))
SEARCH_CACHE_MAX = int(os.environ.get("SEARCH_CACHE_MAX", "512"))   # type-ahead memo

# --- MCP compatibility tester ----------------------------------------------
# Protocol versions this explorer knows how to speak. A server answering with an
# unknown-but-present version is a warning, not a failure.
SUPPORTED_MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"]
COMPAT_CONCURRENCY = 4            # parallel JSON-RPC calls inside one test
COMPAT_TOTAL_TIMEOUT = 30.0       # hard ceiling for a whole compatibility test
COMPAT_COOLDOWN_S = 5.0           # per-URL cooldown (a test is ~5 outbound calls)

# GitHub unauthenticated search is limited to ~10 req/min. When no token is
# present we only resolve stars for repositories we already learned about from
# the registry (core API, ~60/hr) and skip open-ended search to stay honest
# about limits rather than pretending we fetched something we were blocked on.
GITHUB_SEARCH_ENABLED = bool(GITHUB_TOKEN)

USER_AGENT = "mcp-integration-explorer/1.0 (+https://github.com/local; live research tool)"

# --- Static snapshot for offline preview ----------------------------------
# The dashboard prefers the live API. When it is opened as a plain file (no
# backend), it falls back to the last real fetch stored here. This is REAL
# fetched data with timestamps, never fabricated.
SNAPSHOT_JS = STATIC_DIR / "data.snapshot.js"
