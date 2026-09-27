#!/usr/bin/env python3
"""Regenerate the README's "Current live results" table from data/live_cache.json.

The table used to be hand-written and had drifted a full refresh behind the data
(it claimed 14 official / 353 servers while the cache said 12 / 340). Deriving it
from the cache means it can never disagree with what the app actually shows.

Run: python3 scripts/update_readme_stats.py     (idempotent)
"""
from __future__ import annotations

import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "data", "live_cache.json")
HISTORY = os.path.join(ROOT, "data", "history.json")
README = os.path.join(ROOT, "README.md")

START = "| Signal | Value |"
END_MARK = "\n\n---\n\n## Live data sources"


def build(cache: dict, history: list) -> str:
    st = cache["stats"]
    apps = cache["apps"]
    official = [a for a in apps if a["mcp"]["status"] == "vendor_official"]
    spec_tools = sum((a.get("tools_count") or 0) for a in apps
                     if a.get("tools_count") and not a.get("generic_gateway"))
    spec_apps = sum(1 for a in apps if a.get("tools_count") and not a.get("generic_gateway"))
    stale = sum(1 for a in apps for s in (a["mcp"].get("servers") or []) if s.get("stale"))

    rows = [
        ("Apps tracked", f"**{st['total_apps']}**"),
        ("Vendor-official MCP", f"**{len(official)}** apps"),
        ("Community MCP", f"**{st['mcp_community']}** apps"),
        ("No MCP found *in the registry*", f"**{st['mcp_none']}** apps"),
        ("Registry servers matched", f"**{st['total_mcp_servers']}**"),
        ("**App-specific live tools** (from real probes)", f"**{spec_tools}** across **{spec_apps}** apps"),
        ("Open endpoints / auth-gated (real 401/402/403)", f"**{st['open_endpoints']}** / **{st['auth_gated_endpoints']}**"),
        ("Shared aggregator gateways detected & excluded", f"**{st['generic_gateways']}**"),
        ("MCP package downloads", f"**{st['total_downloads']:,} / month**"),
        ("GitHub repos resolved / total stars",
         f"**{st['github_repos_found']}** repos \u00b7 **~{round(st['total_stars'] / 1000) * 1000:,} \u2605**"),
        ("Repos with a commit in the last 90 days", f"**{st['maintained_repos']}**"),
        ("Websites responding (up)",
         f"**{st['websites_responding']} / {st['websites_checked']}** ({st['websites_reachable']} clean 2xx/3xx)"),
        ("Average readiness score", f"**{st['avg_readiness']}**"),
    ]
    if stale:
        rows.append(("Servers carried over from the last cycle (`stale`)", f"**{stale}**"))

    out = [START, "|---|---:|"]
    out += [f"| {k} | {v} |" for k, v in rows]
    out.append("")
    pts = len(history)
    first = history[0]["ts"][:10] if history else "?"
    out.append(f"*Generated from `data/live_cache.json` by `scripts/update_readme_stats.py` \u00b7 "
               f"last real fetch `{cache['generated_at']}` \u00b7 {pts} history points since {first}.*")
    out.append("")
    named = []
    for a in official:
        ns = next((s["name"] for s in a["mcp"]["servers"] if s["classification"] == "vendor_official"), "?")
        named.append(f"{a['app']['name']} `{ns}`")
    out.append("Vendor-official apps (domain-verified in the registry): " + ", ".join(named) + ".")
    return "\n".join(out)


def main() -> int:
    cache = json.loads(io.open(CACHE, encoding="utf-8").read())
    history = json.loads(io.open(HISTORY, encoding="utf-8").read()) if os.path.exists(HISTORY) else []
    table = build(cache, history)

    readme = io.open(README, encoding="utf-8").read()
    if START not in readme or END_MARK not in readme:
        print("README markers not found; refusing to guess", file=sys.stderr)
        return 1
    start = readme.index(START)
    end = readme.index(END_MARK)
    updated = readme[:start] + table + readme[end:]
    if updated == readme:
        print("README already current (%s)" % cache["generated_at"])
        return 0
    io.open(README, "w", encoding="utf-8").write(updated)
    print("README live-results table regenerated from %s" % cache["generated_at"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
