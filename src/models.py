"""Pydantic models describing the *real* data we fetch and serve.

Each model carries its own `fetched_at` timestamp and, where relevant, the
`source_url` it came from, so every number on the dashboard is traceable to a
live API response rather than an invented claim.
"""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field, model_validator

McpStatus = Literal["vendor_official", "community", "none", "unknown", "pending"]
ProbeResult = Literal[
    "open", "auth_required", "payment_required", "forbidden",
    "error", "timeout", "no_remote", "pending",
]


class App(BaseModel):
    """A curated app from the input list (the frame we report on)."""

    id: int
    name: str
    category: str
    website: str


class McpProbe(BaseModel):
    """Result of live-connecting to a server's real MCP endpoint."""

    url: str
    result: ProbeResult = "pending"
    http_status: Optional[int] = None
    tools_count: Optional[int] = None
    tool_names: list[str] = Field(default_factory=list)   # sample of real tool names
    generic_gateway: bool = False     # toolset is shared across many apps (e.g. an aggregator)
    protocol_version: Optional[str] = None
    latency_ms: Optional[int] = None
    probed_at: Optional[str] = None
    error: Optional[str] = None


class PackageStat(BaseModel):
    """Real adoption stats for an MCP server's published package."""

    registry: str = ""                    # 'npm' | 'pypi'
    name: str = ""
    version: Optional[str] = None
    downloads_last_month: Optional[int] = None
    last_published: Optional[str] = None
    url: Optional[str] = None
    fetched_at: Optional[str] = None
    error: Optional[str] = None


class McpServer(BaseModel):
    """A single MCP server exactly as returned by the official registry."""

    name: str                                   # reverse-domain id, e.g. com.stripe/mcp
    namespace: str = ""                         # part before '/', e.g. com.stripe
    path: str = ""                              # part after '/', e.g. mcp
    title: str = ""
    description: str = ""
    version: str = ""
    repository_url: Optional[str] = None        # real GitHub/source repo, if published
    website_url: Optional[str] = None           # registry-published site, used for logos
    remote_urls: list[str] = Field(default_factory=list)   # live streamable-http endpoints
    packages: list[str] = Field(default_factory=list)      # npm/pypi package names
    is_latest: bool = True
    published_at: Optional[str] = None
    namespace_matches_vendor: bool = False      # honest signal behind "vendor_official"
    classification: McpStatus = "community"
    probe: Optional[McpProbe] = None            # live tools/auth probe of its endpoint
    stale: bool = False                         # kept from the last cycle that saw it
    last_seen: Optional[str] = None             # when the registry last returned it


class McpResult(BaseModel):
    status: McpStatus = "pending"
    servers: list[McpServer] = Field(default_factory=list)
    matched: int = 0
    queries: list[str] = Field(default_factory=list)       # the search terms actually used
    source_url: Optional[str] = None                       # registry search URL (provenance)
    fetched_at: Optional[str] = None
    error: Optional[str] = None
    # Consecutive refreshes where the registry search came back completely empty
    # for this app. Used by _merge_mcp so a domain-verified vendor-official
    # server is not silently dropped by one blank cycle (see the README's
    # honesty notes): it takes two blank cycles in a row to accept "none".
    empty_cycles: int = 0


class CompatCheck(BaseModel):
    """One compatibility check against a live MCP endpoint."""

    name: str
    status: Literal["pass", "fail", "warning", "skip"]
    message: str = ""
    latency_ms: Optional[int] = None
    details: dict = Field(default_factory=dict)


class CompatReport(BaseModel):
    """A compatibility report. Deliberately NOT a certification: it is a
    best-effort behavioural test from this explorer's point of view."""

    url: str
    tested_at: str
    checks: list[CompatCheck] = Field(default_factory=list)
    total: int = 0
    passed: int = 0
    failed: int = 0
    warnings: int = 0
    skipped: int = 0
    compatibility_pct: int = 0
    error: Optional[str] = None


class GithubResult(BaseModel):
    status: Literal["found", "none", "rate_limited", "error", "pending", "skipped"] = "pending"
    full_name: Optional[str] = None           # owner/repo
    html_url: Optional[str] = None
    stars: Optional[int] = None
    forks: Optional[int] = None
    open_issues: Optional[int] = None
    license: Optional[str] = None
    language: Optional[str] = None
    archived: Optional[bool] = None
    pushed_at: Optional[str] = None           # last commit timestamp (maintenance signal)
    description: Optional[str] = None
    via: Literal["registry_repository", "search", "none"] = "none"
    source_url: Optional[str] = None
    fetched_at: Optional[str] = None
    error: Optional[str] = None


class LivenessResult(BaseModel):
    url: str
    status_code: Optional[int] = None
    latency_ms: Optional[int] = None
    reachable: bool = False          # got a 2xx/3xx response
    responded: bool = False          # got ANY HTTP response (site is up, even if 4xx/5xx)
    final_url: Optional[str] = None
    fetched_at: Optional[str] = None
    error: Optional[str] = None

    @model_validator(mode="after")
    def _infer_responded(self):
        # Any HTTP status code means the server answered -> it responded.
        if self.status_code is not None:
            self.responded = True
        return self


class Readiness(BaseModel):
    """Transparent Integration Readiness Score computed only from real signals."""

    score: int = 0                    # 0..100
    grade: str = "—"                  # A/B/C/D/E
    components: dict[str, dict] = Field(default_factory=dict)


class AppLive(BaseModel):
    """Everything we currently know (from real fetches) about one app."""

    app: App
    mcp: McpResult = Field(default_factory=McpResult)
    github: GithubResult = Field(default_factory=GithubResult)
    liveness: Optional[LivenessResult] = None
    packages: list[PackageStat] = Field(default_factory=list)
    readiness: Readiness = Field(default_factory=Readiness)
    repo_url_hint: Optional[str] = None          # best repository URL from the registry
    mcp_detail: Optional[dict] = None            # capability snapshot for historical diffing
    tools_count: Optional[int] = None            # real tools on the best probed endpoint
    auth_gated: bool = False                      # best endpoint required auth/payment
    generic_gateway: bool = False                 # best open endpoint is a shared aggregator
    last_fetched: Optional[str] = None


class SourceHealth(BaseModel):
    name: str
    reachable: bool = False
    latency_ms: Optional[int] = None
    last_check: Optional[str] = None
    detail: Optional[str] = None


class Stats(BaseModel):
    total_apps: int = 0
    refreshed: int = 0
    mcp_vendor_official: int = 0
    mcp_community: int = 0
    mcp_none: int = 0
    mcp_unknown: int = 0
    mcp_pending: int = 0
    total_mcp_servers: int = 0
    websites_reachable: int = 0        # returned 2xx/3xx
    websites_responding: int = 0       # returned ANY HTTP response (up, even 4xx/5xx)
    websites_checked: int = 0
    github_repos_found: int = 0
    total_stars: int = 0
    median_latency_ms: Optional[int] = None
    # --- new aggregate intelligence ---
    total_downloads: int = 0           # npm+pypi monthly downloads across MCP packages
    total_tools: int = 0               # real app-specific tools across probed open endpoints
    open_endpoints: int = 0            # probed endpoints that returned tools
    generic_gateways: int = 0          # probed endpoints that are shared aggregators
    auth_gated_endpoints: int = 0      # probed endpoints requiring auth/payment
    probed_endpoints: int = 0
    avg_readiness: float = 0.0
    maintained_repos: int = 0          # repos with a commit in the last 90 days
    by_category: dict[str, dict] = Field(default_factory=dict)


class HistoryPoint(BaseModel):
    ts: str
    official: int = 0
    community: int = 0
    none: int = 0
    servers: int = 0
    tools: int = 0
    downloads: int = 0
    stars: int = 0
    responding: int = 0
    reachable: int = 0
    avg_readiness: float = 0.0


class Change(BaseModel):
    ts: str
    app_id: Optional[int] = None
    app: str = ""
    kind: str = ""          # status | tools | stars | site | downloads | new_server
    message: str = ""


class Watch(BaseModel):
    app_id: int
    name: str = ""
    events: list[str] = Field(default_factory=list)   # official_mcp | site_down | any
    created: str = ""


class Alert(BaseModel):
    id: str
    ts: str
    app_id: Optional[int] = None
    app: str = ""
    event: str = ""
    message: str = ""
    read: bool = False


class PopularItem(BaseModel):
    name: str
    count: int = 0
    last: str = ""


class Snapshot(BaseModel):
    """Top-level payload the dashboard consumes."""

    generated_at: str
    app_name: str
    tagline: str
    stats: Stats
    sources: list[SourceHealth] = Field(default_factory=list)
    apps: list[AppLive]
    changes: list[Change] = Field(default_factory=list)
    history: list[HistoryPoint] = Field(default_factory=list)
    alerts: list[Alert] = Field(default_factory=list)
    watches: list[Watch] = Field(default_factory=list)
    popular: list[PopularItem] = Field(default_factory=list)
    refresh_running: bool = False
    note: str = ""
