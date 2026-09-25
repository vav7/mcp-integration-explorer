#!/usr/bin/env python3
"""The explorer is itself an MCP server.

A dependency-free stdio MCP server (newline-delimited JSON-RPC 2.0) that lets
any MCP-capable agent query the REAL fetched dataset — the same data the
dashboard shows. It reads data/live_cache.json (written by the live pipeline),
so it works standalone with no backend running.

Run:   python -m src.mcp_server
Wire into an MCP client, e.g. Claude Desktop / any agent:
   { "mcpServers": { "mcp-integration-explorer":
       { "command": "python", "args": ["-m", "src.mcp_server"],
         "cwd": "/path/to/mcp-integration-explorer" } } }

Tools: overview, list_apps, search_apps, get_app, top_by_readiness,
       apps_missing_official_mcp.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "live_cache.json"

PROTOCOL_VERSION = "2024-11-05"
SERVER_INFO = {"name": "mcp-integration-explorer", "version": "1.0.0"}


def _load():
    if not CACHE.exists():
        return {"apps": [], "stats": {}, "generated_at": None}
    try:
        return json.loads(CACHE.read_text(encoding="utf-8"))
    except Exception:
        return {"apps": [], "stats": {}, "generated_at": None}


def _dl(a):
    return sum((p.get("downloads_last_month") or 0) for p in (a.get("packages") or []))


def _brief(a):
    r = a.get("readiness") or {}
    return {
        "id": a["app"]["id"], "name": a["app"]["name"], "category": a["app"]["category"],
        "website": a["app"]["website"], "mcp_status": (a.get("mcp") or {}).get("status"),
        "mcp_servers": (a.get("mcp") or {}).get("matched", 0),
        "official_servers": [s["name"] for s in (a.get("mcp") or {}).get("servers", [])
                             if s.get("classification") == "vendor_official"],
        "live_tools": a.get("tools_count"), "generic_gateway": a.get("generic_gateway", False),
        "auth_gated": a.get("auth_gated", False), "downloads_last_month": _dl(a),
        "github_repo": (a.get("github") or {}).get("full_name"),
        "stars": (a.get("github") or {}).get("stars"),
        "last_commit": (a.get("github") or {}).get("pushed_at"),
        "site_status": (a.get("liveness") or {}).get("status_code"),
        "readiness_score": r.get("score"), "readiness_grade": r.get("grade"),
    }


# --- tool implementations -------------------------------------------------
def t_overview(_args):
    d = _load()
    st = d.get("stats", {})
    return {
        "generated_at": d.get("generated_at"),
        "apps_tracked": st.get("total_apps"),
        "vendor_official_mcp": st.get("mcp_vendor_official"),
        "community_mcp": st.get("mcp_community"),
        "no_mcp": st.get("mcp_none"),
        "registry_servers_matched": st.get("total_mcp_servers"),
        "app_specific_live_tools": st.get("total_tools"),
        "open_endpoints": st.get("open_endpoints"),
        "auth_gated_endpoints": st.get("auth_gated_endpoints"),
        "generic_gateways": st.get("generic_gateways"),
        "mcp_package_downloads_per_month": st.get("total_downloads"),
        "sites_responding": st.get("websites_responding"),
        "avg_readiness": st.get("avg_readiness"),
        "note": "All values fetched live from the official MCP registry, GitHub, npm/PyPI, live endpoint probes, and direct site checks.",
    }


def t_list_apps(args):
    d = _load()
    apps = [_brief(a) for a in d.get("apps", [])]
    cat = args.get("category")
    status = args.get("mcp_status")
    if cat:
        apps = [a for a in apps if a["category"].lower() == cat.lower()]
    if status:
        apps = [a for a in apps if a["mcp_status"] == status]
    limit = int(args.get("limit", 100))
    return {"count": len(apps), "apps": apps[:limit]}


def t_search_apps(args):
    q = (args.get("query") or "").lower()
    d = _load()
    out = [_brief(a) for a in d.get("apps", [])
           if q in a["app"]["name"].lower() or q in a["app"]["category"].lower()]
    return {"count": len(out), "apps": out}


def t_get_app(args):
    key = str(args.get("name_or_id", "")).strip()
    d = _load()
    for a in d.get("apps", []):
        if key.isdigit() and a["app"]["id"] == int(key):
            return a
        if a["app"]["name"].lower() == key.lower():
            return a
    # fuzzy
    for a in d.get("apps", []):
        if key.lower() in a["app"]["name"].lower():
            return a
    return {"error": f"app not found: {key}"}


def t_top_by_readiness(args):
    d = _load()
    limit = int(args.get("limit", 20))
    apps = sorted((_brief(a) for a in d.get("apps", [])),
                  key=lambda x: (x["readiness_score"] or 0), reverse=True)
    return {"top": apps[:limit]}


def t_apps_missing_official_mcp(args):
    d = _load()
    limit = int(args.get("limit", 20))
    import math
    def demand(a):
        stars = a.get("stars") or 0
        dl = a.get("downloads_last_month") or 0
        lg = lambda v, c: min(math.log10(v + 1) / c, 1) if v > 0 else 0
        return lg(stars, 4) * 40 + lg(dl, 5) * 40 + min(a.get("mcp_servers") or 0, 10) * 2
    apps = [_brief(a) for a in d.get("apps", []) if (a.get("mcp") or {}).get("status") != "vendor_official"]
    apps.sort(key=demand, reverse=True)
    for a in apps:
        a["demand_score"] = round(demand(a), 1)
    return {"count": len(apps), "opportunities": apps[:limit]}


TOOLS = [
    {"name": "overview", "description": "Aggregate live statistics across all tracked apps (official/community MCP counts, live tools, downloads, readiness).",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "list_apps", "description": "List tracked apps with their real MCP status, live tool count, downloads, stars and readiness score.",
     "inputSchema": {"type": "object", "properties": {
         "category": {"type": "string", "description": "filter by exact category"},
         "mcp_status": {"type": "string", "enum": ["vendor_official", "community", "none", "unknown"]},
         "limit": {"type": "integer"}}}},
    {"name": "search_apps", "description": "Search apps by name or category substring.",
     "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
    {"name": "get_app", "description": "Full real record for one app: every MCP server (with repo/remote/probe), packages, GitHub repo, liveness, readiness breakdown, provenance.",
     "inputSchema": {"type": "object", "properties": {"name_or_id": {"type": "string"}}, "required": ["name_or_id"]}},
    {"name": "top_by_readiness", "description": "Apps ranked by the transparent Integration Readiness Score.",
     "inputSchema": {"type": "object", "properties": {"limit": {"type": "integer"}}}},
    {"name": "apps_missing_official_mcp", "description": "Opportunities: apps with real demand (stars/downloads/community servers) but NO vendor-official MCP.",
     "inputSchema": {"type": "object", "properties": {"limit": {"type": "integer"}}}},
]

DISPATCH = {
    "overview": t_overview, "list_apps": t_list_apps, "search_apps": t_search_apps,
    "get_app": t_get_app, "top_by_readiness": t_top_by_readiness,
    "apps_missing_official_mcp": t_apps_missing_official_mcp,
}


def _send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        method = msg.get("method")
        mid = msg.get("id")
        params = msg.get("params") or {}
        if method == "initialize":
            _send({"jsonrpc": "2.0", "id": mid, "result": {
                "protocolVersion": params.get("protocolVersion", PROTOCOL_VERSION),
                "capabilities": {"tools": {}}, "serverInfo": SERVER_INFO}})
        elif method and method.startswith("notifications/"):
            continue
        elif method == "tools/list":
            _send({"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}})
        elif method == "tools/call":
            name = params.get("name")
            fn = DISPATCH.get(name)
            if not fn:
                _send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": f"unknown tool: {name}"}})
                continue
            try:
                result = fn(params.get("arguments") or {})
                _send({"jsonrpc": "2.0", "id": mid, "result": {
                    "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False, indent=2)}],
                    "isError": False}})
            except Exception as exc:
                _send({"jsonrpc": "2.0", "id": mid, "result": {
                    "content": [{"type": "text", "text": f"error: {type(exc).__name__}: {exc}"}], "isError": True}})
        elif method == "ping":
            _send({"jsonrpc": "2.0", "id": mid, "result": {}})
        elif mid is not None:
            _send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"method not found: {method}"}})


if __name__ == "__main__":
    main()
