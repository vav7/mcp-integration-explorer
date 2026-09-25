#!/usr/bin/env python3
"""One-shot live refresh with progress + incremental saving.

Phases:
  A. MCP registry + website liveness + npm/PyPI adoption  (cheap, unauthenticated)
  B. GitHub repo enrichment (stars, last commit, license)  (rate-limit aware)
  C. Live MCP endpoint probes (real tool counts / auth gating)
  D. Diff vs previous run -> changes, append history point, save cache+snapshot

Persisting data/live_cache.json + static/data.snapshot.js lets the dashboard and
the portable demo.html show the last REAL fetch even with no backend running.
"""
from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import config  # noqa: E402
from src.fetchers import fetch_github_from_repo, probe_source  # noqa: E402
from src.pipeline import _merge_github, probe_app, refresh_app, write_snapshot_js  # noqa: E402
from src.scoring import compute_readiness  # noqa: E402
from src.store import STORE  # noqa: E402


async def main() -> None:
    STORE.load_apps()
    ids = [a.id for a in STORE.apps]
    total = len(ids)
    before = {i: STORE.app_summary(STORE.live[i]) for i in ids if i in STORE.live}
    print(f"Loaded {total} apps. Starting live fetch…", flush=True)
    t0 = time.time()

    async with httpx.AsyncClient(headers={"User-Agent": config.USER_AGENT}, follow_redirects=True) as client:
        STORE.set_sources([r for r in await asyncio.gather(
            probe_source(client, "MCP Registry", config.MCP_REGISTRY_URL + "?limit=1"),
            probe_source(client, "GitHub API", config.GITHUB_API_URL + "/rate_limit"),
            probe_source(client, "npm Registry", "https://registry.npmjs.org/-/ping"),
            return_exceptions=True) if isinstance(r, dict)])

        # --- Phase A: registry + liveness + packages ----------------------
        sem = asyncio.Semaphore(config.MAX_CONCURRENCY)
        done = 0

        async def one(i: int):
            nonlocal done
            async with sem:
                await refresh_app(client, i, do_github=False, do_packages=True)
            done += 1
            if done % 20 == 0 or done == total:
                print(f"  A registry+liveness+packages {done}/{total} ({time.time()-t0:.0f}s)", flush=True)

        await asyncio.gather(*[one(i) for i in ids], return_exceptions=True)
        STORE.save_cache()

        # --- Phase B: GitHub enrichment (circuit breaker on rate limit) ---
        targets = [(i, STORE.live[i].repo_url_hint) for i in ids if STORE.live[i].repo_url_hint]
        print(f"  B github enrichment for {len(targets)} registry-published repos…", flush=True)
        resolved = rate_limited = 0
        for i, repo in targets:
            if rate_limited and not config.GITHUB_TOKEN:
                break
            g = await fetch_github_from_repo(client, repo)
            STORE.live[i].github = _merge_github(STORE.live[i].github, g)
            STORE.live[i].readiness = compute_readiness(STORE.live[i])
            if g.status == "rate_limited":
                rate_limited += 1
                print("    GitHub rate limit hit; deferring the rest.", flush=True)
                break
            if g.status == "found":
                resolved += 1
            await asyncio.sleep(0.35)
        print(f"    resolved {resolved} repos (rate_limited={bool(rate_limited)})", flush=True)

        # --- Phase C: live MCP endpoint probes ---------------------------
        probe_targets = [i for i in ids if any(s.remote_urls for s in STORE.live[i].mcp.servers)]
        print(f"  C probing {len(probe_targets)} live MCP endpoints for real tool counts…", flush=True)
        psem = asyncio.Semaphore(config.PROBE_CONCURRENCY)
        pdone = 0

        async def probe_one(i: int):
            nonlocal pdone
            async with psem:
                await probe_app(client, i, force=True)
            pdone += 1
            if pdone % 20 == 0 or pdone == len(probe_targets):
                print(f"    probed {pdone}/{len(probe_targets)} ({time.time()-t0:.0f}s)", flush=True)

        await asyncio.gather(*[probe_one(i) for i in probe_targets], return_exceptions=True)

        # --- Phase C2: flag shared aggregator gateways (honesty) ----------
        from src.pipeline import flag_generic_gateways
        n_gen, n_apps = flag_generic_gateways()
        print(f"    flagged {n_gen} generic gateway toolset(s) across {n_apps} app probes", flush=True)

    # --- Phase D: changes + history + persist ----------------------------
    after = {i: STORE.app_summary(STORE.live[i]) for i in ids if i in STORE.live}
    changes = STORE.diff_summaries(before, after)
    STORE.push_changes(changes)
    STORE.record_history()
    STORE.save_cache()
    write_snapshot_js()

    st = STORE.compute_stats()
    print("\n=== DONE ===", flush=True)
    print(f"apps={st.total_apps} refreshed={st.refreshed} in {time.time()-t0:.0f}s · changes={len(changes)}", flush=True)
    print(f"MCP: official={st.mcp_vendor_official} community={st.mcp_community} none={st.mcp_none} servers={st.total_mcp_servers}", flush=True)
    print(f"probes: open={st.open_endpoints} auth_gated={st.auth_gated_endpoints} tools={st.total_tools}", flush=True)
    print(f"sites responding={st.websites_reachable}+{st.websites_responding-st.websites_reachable}/{st.websites_checked} · repos={st.github_repos_found} stars={st.total_stars} downloads={st.total_downloads:,}/mo", flush=True)
    print(f"avg readiness={st.avg_readiness} · maintained repos={st.maintained_repos}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
