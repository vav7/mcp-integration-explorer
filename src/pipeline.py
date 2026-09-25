"""Refresh orchestration + background scheduler.

A full refresh does, per app:
  1. MCP registry lookup (real servers)              — fetch_mcp
  2. Website liveness (real HTTP)                    — check_liveness
  3. GitHub repo enrichment (stars, last commit, …)  — fetch_github_from_repo
  4. npm/PyPI adoption (real monthly downloads)      — fetch_package_stats
  5. Live MCP endpoint probe (real tool count/auth)  — probe_mcp  [own cadence]
  6. Integration Readiness Score (computed)          — compute_readiness

After each cycle it records a history point and emits a "what changed" diff.
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

import httpx

from . import config, diffing
from .fetchers import (
    fetch_mcp_detail,
    check_liveness,
    fetch_github_from_repo,
    fetch_mcp,
    fetch_package_stats,
    probe_mcp,
    probe_source,
    search_github,
)
from .models import AppLive, Change
from .scoring import compute_readiness
from .store import STORE

_sem = asyncio.Semaphore(config.MAX_CONCURRENCY)
_probe_sem = asyncio.Semaphore(config.PROBE_CONCURRENCY)


def _parse_ts(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except Exception:
        return None


def _stale(ts: str | None, max_age_seconds: int) -> bool:
    dt = _parse_ts(ts)
    if dt is None:
        return True
    return (datetime.now(timezone.utc) - dt).total_seconds() > max_age_seconds


def _merge_github(old, new):
    """Never lose resolved star data to a transient rate-limit/error."""
    if old is not None and getattr(old, "status", None) == "found" and \
       getattr(new, "status", None) in {"rate_limited", "error", "skipped", "pending"}:
        return old
    return new


#: how many consecutive empty registry cycles before a previously verified
#: vendor-official server is allowed to drop off an app.
EMPTY_CYCLES_BEFORE_DROP = 2


def _merge_mcp(old, new):
    """Never let one bad or blank registry cycle rewrite verified history.

    Two honest rules:
      * 'unknown' means we could not reach the source, which is not evidence
        that the app has no MCP server -> keep what we already knew.
      * a *successful* search that returned nothing at all, for an app whose
        vendor-official server was domain-verified in an earlier cycle, is far
        more likely to be a registry search miss than a delisting (the
        registry's search is keyword-based and has been observed to return zero
        hits for a published server). We keep the server, mark it `stale`, and
        only accept "none" after EMPTY_CYCLES_BEFORE_DROP blank cycles in a row.
        The UI shows the stale flag, so nothing is hidden.
    """
    if getattr(new, "status", None) == "unknown" and old is not None and \
       getattr(old, "status", None) in {"vendor_official", "community", "none"}:
        return old
    if old is None:
        return new
    old_verified = [s for s in getattr(old, "servers", []) if s.classification == "vendor_official"]
    if not old_verified or getattr(new, "servers", None):
        new.empty_cycles = 0
        return new
    strikes = getattr(old, "empty_cycles", 0) + 1
    if strikes < EMPTY_CYCLES_BEFORE_DROP:
        kept = old.model_copy(deep=True)
        kept.empty_cycles = strikes
        kept.queries = new.queries or kept.queries
        kept.fetched_at = new.fetched_at or kept.fetched_at
        for s in kept.servers:
            s.stale = True
            s.last_seen = old.fetched_at or s.last_seen
        kept.error = (f"registry search returned nothing this cycle (queries: "
                      f"{', '.join(new.queries) or 'n/a'}); keeping the domain-verified "
                      f"server from {old.fetched_at or 'the last cycle that saw it'} "
                      f"[{strikes}/{EMPTY_CYCLES_BEFORE_DROP} blank cycles]")
        return kept
    new.empty_cycles = 0
    return new


def _collect_packages(servers, cap: int) -> list[str]:
    """Unique 'registry:identifier' package strings across an app's servers."""
    out: list[str] = []
    for s in servers:
        for p in s.packages:
            if p not in out:
                out.append(p)
    return out[:cap]


def _best_remote_server(al: AppLive):
    """Pick the server whose live endpoint is most worth probing (official first)."""
    with_remote = [s for s in al.mcp.servers if s.remote_urls]
    if not with_remote:
        return None
    official = [s for s in with_remote if s.classification == "vendor_official"]
    return (official or with_remote)[0]


async def refresh_app(client: httpx.AsyncClient, app_id: int, *, force_github: bool = False,
                      do_github: bool = True, do_packages: bool = True) -> AppLive | None:
    al = STORE.live.get(app_id)
    if al is None:
        return None
    app = al.app
    async with _sem:
        # Preserve previously-run live probes across the re-fetch (fetch_mcp
        # rebuilds server objects), so we only re-probe when stale.
        old_probes = {s.name: s.probe for s in al.mcp.servers if s.probe}
        al.mcp = _merge_mcp(al.mcp, await fetch_mcp(client, app))
        for s in al.mcp.servers:
            if s.name in old_probes:
                s.probe = old_probes[s.name]
        al.liveness = await check_liveness(client, app)

        official = [s for s in al.mcp.servers if s.classification == "vendor_official" and s.repository_url]
        anyrepo = [s for s in al.mcp.servers if s.repository_url]
        repo_url = (official[0].repository_url if official else
                    anyrepo[0].repository_url if anyrepo else None)
        al.repo_url_hint = repo_url

        gh = al.github
        need_gh = force_github or repo_url is None or _stale(gh.fetched_at, config.REFRESH_INTERVAL_GITHUB)
        if do_github and repo_url and need_gh:
            al.github = _merge_github(gh, await fetch_github_from_repo(client, repo_url))
        elif do_github and repo_url is None and config.GITHUB_SEARCH_ENABLED and need_gh:
            al.github = _merge_github(gh, await search_github(client, app))

        pkgs = _collect_packages(al.mcp.servers, config.MAX_PACKAGES_PER_APP)
        last_pkg_fetch = al.packages[0].fetched_at if al.packages else None
        if do_packages and pkgs and (not al.packages or _stale(last_pkg_fetch, config.PACKAGES_INTERVAL)):
            al.packages = await fetch_package_stats(client, pkgs)

        # carry over any existing probe onto the (possibly re-fetched) server list
        al.tools_count, al.auth_gated, al.generic_gateway = _summarize_probe(al)
        al.readiness = compute_readiness(al)
        al.last_fetched = al.mcp.fetched_at

    kind = al.mcp.status
    msg = f"MCP {al.mcp.status} ({al.mcp.matched} server{'s' if al.mcp.matched != 1 else ''})"
    if al.tools_count:
        msg += f" · {al.tools_count} live tools"
    elif al.auth_gated:
        msg += " · endpoint auth-gated"
    if al.liveness:
        msg += f" · site {'up' if al.liveness.reachable else (str(al.liveness.status_code) if al.liveness.responded else 'down')}"
    if al.github.status == "found" and al.github.stars is not None:
        msg += f" · ★{al.github.stars:,}"
    dl = sum((p.downloads_last_month or 0) for p in al.packages)
    if dl:
        msg += f" · {dl:,} dl/mo"
    msg += f" · readiness {al.readiness.score}"
    STORE.log("refresh", app.id, app.name, msg, status=kind)
    return al


def _summarize_probe(al: AppLive) -> tuple[int | None, bool, bool]:
    """Return (tools_count, auth_gated, generic_gateway) for an app.

    Prefers a genuine app-specific open endpoint over a shared aggregator
    gateway, so a generic toolset is never credited as app-specific capability.
    """
    specific = [s.probe for s in al.mcp.servers
                if s.probe and s.probe.result == "open" and s.probe.tools_count and not s.probe.generic_gateway]
    generic = [s.probe for s in al.mcp.servers
               if s.probe and s.probe.result == "open" and s.probe.tools_count and s.probe.generic_gateway]
    tools, is_generic = None, False
    if specific:
        tools = max(p.tools_count for p in specific)
    elif generic:
        tools = max(p.tools_count for p in generic)
        is_generic = True
    gated = any(s.probe and s.probe.result in ("auth_required", "payment_required", "forbidden")
                for s in al.mcp.servers)
    return tools, gated, is_generic


def flag_generic_gateways(min_shared: int = 4) -> tuple[int, int]:
    """Data-driven detection of aggregator/gateway MCP endpoints.

    If the SAME tool-name signature is served to >= min_shared different apps,
    it is a generic gateway (e.g. an 'ask_<gateway>' meta-toolset), not an
    app-specific capability. Marks those probes so scoring/UI stay honest.
    """
    from collections import defaultdict
    sig_apps: dict[tuple, set] = defaultdict(set)
    for al in STORE.live.values():
        for s in al.mcp.servers:
            if s.probe and s.probe.result == "open" and s.probe.tool_names:
                sig_apps[tuple(sorted(s.probe.tool_names))].add(al.app.id)
    generic_sigs = {sig for sig, ids in sig_apps.items() if len(ids) >= min_shared}
    for al in STORE.live.values():
        for s in al.mcp.servers:
            if s.probe and s.probe.result == "open" and s.probe.tool_names:
                s.probe.generic_gateway = tuple(sorted(s.probe.tool_names)) in generic_sigs
        al.tools_count, al.auth_gated, al.generic_gateway = _summarize_probe(al)
        al.readiness = compute_readiness(al)
    return len(generic_sigs), sum(len(ids) for sig, ids in sig_apps.items() if sig in generic_sigs)



async def probe_app(client: httpx.AsyncClient, app_id: int, *, force: bool = False) -> None:
    """Live-probe the best MCP endpoint for one app (real tools / auth gating)."""
    al = STORE.live.get(app_id)
    if al is None:
        return
    server = _best_remote_server(al)
    if server is None:
        al.tools_count, al.auth_gated, al.generic_gateway = None, False, False
        return
    existing = server.probe
    if existing and not force and not _stale(existing.probed_at, config.PROBE_INTERVAL):
        al.tools_count, al.auth_gated, al.generic_gateway = _summarize_probe(al)
        al.readiness = compute_readiness(al)
        return
    async with _probe_sem:
        probe = await probe_mcp(client, server.remote_urls[0])
    server.probe = probe
    # Capability snapshot for the historical diff. Only overwrite what we
    # actually learned: an open endpoint tells us everything, a gated one tells
    # us its auth state, a dead one tells us nothing (keep prior knowledge).
    if probe.result == "open":
        detail = await fetch_mcp_detail(client, server.remote_urls[0])
        if detail:
            al.mcp_detail = detail
    elif probe.result in ("auth_required", "payment_required", "forbidden"):
        al.mcp_detail = {"auth": probe.result, "protocol_version": probe.protocol_version,
                         "capabilities": None, "tools": None, "resources": None, "prompts": None}
    al.tools_count, al.auth_gated, al.generic_gateway = _summarize_probe(al)
    al.readiness = compute_readiness(al)
    if probe.result == "open":
        STORE.log("probe", al.app.id, al.app.name,
                  f"live endpoint open — {probe.tools_count} tools ({server.name})", status="ok")
    elif probe.result in ("auth_required", "payment_required", "forbidden"):
        STORE.log("probe", al.app.id, al.app.name,
                  f"endpoint gated ({probe.result.replace('_', ' ')}) — {server.name}", status="warn")


async def refresh_ids(client: httpx.AsyncClient, ids: list[int], *, force_github: bool = False,
                      do_github: bool = True, do_packages: bool = True) -> None:
    tasks = [refresh_app(client, i, force_github=force_github, do_github=do_github, do_packages=do_packages)
             for i in ids]
    for chunk in _chunked(tasks, 12):
        await asyncio.gather(*chunk, return_exceptions=True)


async def probe_ids(client: httpx.AsyncClient, ids: list[int], *, force: bool = False) -> None:
    tasks = [probe_app(client, i, force=force) for i in ids]
    for chunk in _chunked(tasks, 10):
        await asyncio.gather(*chunk, return_exceptions=True)


def _chunked(seq: list, n: int):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


async def probe_sources(client: httpx.AsyncClient) -> None:
    results = await asyncio.gather(
        probe_source(client, "MCP Registry", config.MCP_REGISTRY_URL + "?limit=1"),
        probe_source(client, "GitHub API", config.GITHUB_API_URL + "/rate_limit"),
        probe_source(client, "npm Registry", "https://registry.npmjs.org/-/ping"),
        return_exceptions=True,
    )
    STORE.set_sources([r for r in results if isinstance(r, dict)])


def record_snapshots(ids) -> None:
    """Persist one normalised fingerprint per integration after a refresh so a
    later refresh can be diffed against it (src/diffing.py + the store archive)."""
    for i in ids:
        al = STORE.live.get(i)
        if al is None:
            continue
        try:
            STORE.record_app_snapshot(i, diffing.normalize_integration(al.model_dump(mode="json")))
        except Exception as exc:  # a diff failure must never break a refresh
            STORE.log("system", i, al.app.name, f"snapshot record failed: {type(exc).__name__}", status="warn")


async def refresh_all(*, force_github: bool = False, do_probe: bool = True) -> None:
    if STORE.refresh_running:
        STORE.log("system", None, "", "Refresh already running; ignoring request.", status="warn")
        return
    STORE.refresh_running = True
    ids = [a.id for a in STORE.apps]
    before = {i: STORE.app_summary(STORE.live[i]) for i in ids if i in STORE.live}
    STORE.log("system", None, "", f"Starting live refresh of {len(ids)} apps…", status="info")
    started = datetime.now(timezone.utc)
    try:
        async with httpx.AsyncClient(headers={"User-Agent": config.USER_AGENT}, follow_redirects=True) as client:
            await probe_sources(client)
            await refresh_ids(client, ids, force_github=force_github)
            if do_probe:
                STORE.log("system", None, "", "Probing live MCP endpoints for real tool counts…", status="info")
                await probe_ids(client, ids)
                n_gen, n_apps = flag_generic_gateways()
                if n_gen:
                    STORE.log("system", None, "",
                              f"Flagged {n_gen} shared aggregator gateway toolset(s) across {n_apps} app probes as non-app-specific.",
                              status="warn")
    except Exception as exc:
        STORE.log("system", None, "", f"Refresh error: {type(exc).__name__}: {exc}", status="error")
    finally:
        STORE.refresh_running = False
        after = {i: STORE.app_summary(STORE.live[i]) for i in ids if i in STORE.live}
        changes = STORE.diff_summaries(before, after)
        STORE.push_changes(changes)
        fired = STORE.generate_alerts(changes)
        if fired:
            STORE.log("system", None, "", f"🔔 {len(fired)} alert(s) fired for watched apps.", status="warn")
        STORE.record_history()
        record_snapshots(ids)
        STORE.save_cache()
        write_snapshot_js()
        elapsed = (datetime.now(timezone.utc) - started).total_seconds()
        STORE.log("system", None, "",
                  f"Refresh complete in {elapsed:.0f}s · {len(changes)} change(s) detected · cache saved.",
                  status="ok")


async def run_scheduler() -> None:
    """Background loop: initial refresh (with probes), then periodic refreshes.

    With NO_AUTO_REFRESH the loop never starts: the instance serves the last
    real fetch read-only (the GitHub Actions cron keeps data/ current), which is
    what you want on an ephemeral-filesystem host or a shared egress IP.
    """
    if config.NO_AUTO_REFRESH:
        STORE.log("system", None, "",
                  "Auto-refresh disabled (NO_AUTO_REFRESH): serving the last real fetch, read-only.",
                  status="info")
        return
    await asyncio.sleep(config.STARTUP_REFRESH_DELAY)
    if not config.NO_STARTUP_REFRESH:
        await refresh_all()
    while True:
        await asyncio.sleep(config.REFRESH_INTERVAL_FULL)
        await refresh_all()


# --- static snapshot for offline preview ----------------------------------
def write_snapshot_js() -> None:
    snap = STORE.snapshot().model_dump(mode="json")
    config.SNAPSHOT_JS.parent.mkdir(parents=True, exist_ok=True)
    config.SNAPSHOT_JS.write_text("window.__SNAPSHOT__ = " + json.dumps(snap, ensure_ascii=False) + ";\n",
                                  encoding="utf-8")


async def one_shot() -> None:
    STORE.load_apps()
    await refresh_all(force_github=True)


# --- discover ANY app live (not limited to the curated list) --------------
def _derive_website(servers) -> str:
    """Derive the app's own website ONLY from a vendor-official server's
    namespace (com.stripe -> stripe.com). We never guess from community servers,
    since their namespace is the provider's domain, not the app's."""
    from .fetchers import namespace_to_domain
    for s in servers:
        if s.classification == "vendor_official":
            dom = namespace_to_domain(s.namespace)
            if dom:
                return "https://" + dom
    return ""


def _gateway_hint(probe) -> bool:
    """Flag obvious shared aggregators for ad-hoc discoveries (the corpus-wide
    detection runs during full refreshes; this is a light single-app hint)."""
    if not probe or probe.result != "open" or not probe.tool_names:
        return False
    host = (probe.url or "").lower()
    known_hosts = ("gateway.pipeworx.io", "api.mcp.ai", "mcp.ai/", "waystation.ai", "server.smithery.ai")
    if any(h in host for h in known_hosts):
        return True
    names = set(t.lower() for t in probe.tool_names)
    return any(n.startswith("ask_") or n in {"discover_tools", "deep_research", "resolve_entity"} for n in names)


async def discover_app(client: httpx.AsyncClient, name: str, website: str = "") -> AppLive:
    """Fetch a brand-new app live and return its real record (not persisted)."""
    from .fetchers import fetch_package_stats, namespace_to_domain  # noqa: F401
    from .models import App
    tmp = App(id=-1, name=name.strip(), category="Discovered", website=(website or "").strip())
    al = AppLive(app=tmp)
    al.mcp = await fetch_mcp(client, tmp)

    # derive a website for liveness if the caller didn't give one
    site = tmp.website or _derive_website(al.mcp.servers)
    if site:
        al.app.website = site
        al.liveness = await check_liveness(client, al.app)

    official = [s for s in al.mcp.servers if s.classification == "vendor_official" and s.repository_url]
    anyrepo = [s for s in al.mcp.servers if s.repository_url]
    repo_url = official[0].repository_url if official else (anyrepo[0].repository_url if anyrepo else None)
    al.repo_url_hint = repo_url
    if repo_url:
        al.github = _merge_github(al.github, await fetch_github_from_repo(client, repo_url))

    pkgs = _collect_packages(al.mcp.servers, config.MAX_PACKAGES_PER_APP)
    if pkgs:
        al.packages = await fetch_package_stats(client, pkgs)

    server = _best_remote_server(al)
    if server is not None:
        server.probe = await probe_mcp(client, server.remote_urls[0])
        if _gateway_hint(server.probe):
            server.probe.generic_gateway = True
    al.tools_count, al.auth_gated, al.generic_gateway = _summarize_probe(al)
    al.readiness = compute_readiness(al)
    al.last_fetched = al.mcp.fetched_at
    return al


if __name__ == "__main__":
    asyncio.run(one_shot())
