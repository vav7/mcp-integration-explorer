"""FastAPI application: live REST endpoints + a Server-Sent-Events activity
stream + the static dashboard.

Run:  uvicorn src.app:app --reload
"""
from __future__ import annotations

import asyncio
import contextlib
import csv
import io
import json
import time
from collections import OrderedDict
from typing import Optional

import httpx
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import compat, config
from .fetchers import registry_suggestions
from .pipeline import (discover_app, probe_app, record_snapshots, refresh_all, refresh_app,
                         refresh_ids, run_scheduler, write_snapshot_js)
from .scoring import opportunity_score
from .store import STORE


@asynccontextmanager
async def lifespan(_app: "FastAPI"):
    """Boot: load the last real fetch (instant data), then go live.

    `on_event` is deprecated in modern FastAPI; the lifespan form also makes the
    scheduler's lifecycle explicit, which matters on hosts that recycle workers.
    """
    STORE.load_apps()
    STORE.log("system", None, "", f"{config.APP_NAME} backend online. Starting first live refresh…", status="ok")
    _app.state.scheduler = asyncio.create_task(run_scheduler())
    yield
    task = getattr(_app.state, "scheduler", None)
    if task:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


app = FastAPI(title=config.APP_NAME, version="1.0.0", lifespan=lifespan)


# --- write-side guard -------------------------------------------------------
def require_key(x_api_key: Optional[str] = Header(default=None, alias="X-API-Key")) -> None:
    """Protect only the state-changing endpoints, and only when EXPLORER_API_KEY
    is set. Reads stay open; the product is a public explorer."""
    if not config.API_KEY:
        return
    if x_api_key != config.API_KEY:
        raise HTTPException(401, "valid X-API-Key header required for write operations")


@app.middleware("http")
async def no_cache_assets(request, call_next):
    """Never serve stale HTML/JS/CSS: this is a live dashboard; browsers must
    revalidate every time so a cached broken build can't linger."""
    resp = await call_next(request)
    p = request.url.path
    if p == "/" or p.endswith((".html", ".js", ".css")) or p == "/data.snapshot.js":
        resp.headers["Cache-Control"] = "no-store, max-age=0, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
    return resp


# --- data endpoints -------------------------------------------------------
@app.get("/api/snapshot")
async def get_snapshot():
    return STORE.snapshot().model_dump(mode="json")


@app.get("/api/stats")
async def get_stats():
    return STORE.compute_stats().model_dump(mode="json")


@app.get("/api/apps")
async def get_apps(category: Optional[str] = None, mcp: Optional[str] = None, q: Optional[str] = None):
    snap = STORE.snapshot()
    apps = snap.apps
    if category:
        apps = [a for a in apps if a.app.category == category]
    if mcp:
        apps = [a for a in apps if a.mcp.status == mcp]
    if q:
        ql = q.lower()
        apps = [a for a in apps if ql in a.app.name.lower() or ql in a.app.category.lower()]
    return {"generated_at": snap.generated_at, "count": len(apps),
            "apps": [a.model_dump(mode="json") for a in apps]}


@app.get("/api/apps/{app_id}")
async def get_app(app_id: int):
    al = STORE.live.get(app_id)
    if not al:
        raise HTTPException(404, "app not found")
    return al.model_dump(mode="json")


class RefreshBody(BaseModel):
    ids: Optional[list[int]] = None
    do_probe: bool = True


@app.post("/api/refresh")
async def post_refresh(body: RefreshBody | None = None, _k: None = Depends(require_key)):
    """Trigger an on-demand live refresh (runs in background; watch the stream)."""
    ids = body.ids if body else None
    do_probe = body.do_probe if body else True
    if ids:
        asyncio.create_task(_refresh_subset(ids, do_probe=do_probe))
        return JSONResponse({"started": True, "scope": "subset", "count": len(ids)})
    if STORE.refresh_running:
        return JSONResponse({"started": False, "reason": "already_running"})
    asyncio.create_task(refresh_all(do_probe=do_probe))
    return JSONResponse({"started": True, "scope": "all"})


async def _refresh_subset(ids: list[int], do_probe: bool = True) -> None:
    import httpx
    from .pipeline import probe_ids, write_snapshot_js
    STORE.log("system", None, "", f"On-demand refresh of {len(ids)} app(s)…", status="info")
    async with httpx.AsyncClient(headers={"User-Agent": config.USER_AGENT}, follow_redirects=True) as client:
        await refresh_ids(client, ids)
        if do_probe:
            await probe_ids(client, ids)
    record_snapshots(ids)
    STORE.save_cache()
    write_snapshot_js()



@app.get("/api/activity")
async def get_activity(limit: int = 50):
    return {"events": list(STORE.activity)[:limit]}


@app.get("/api/stream")
async def stream():
    """Server-Sent Events: real-time fetch activity + periodic snapshot pings."""
    queue = STORE.subscribe()

    async def event_gen():
        try:
            yield _sse({"type": "hello", "message": "stream connected", "ts": STORE.generated_at})
            # replay a little recent history so a newly-opened tab isn't empty
            for evt in list(STORE.activity)[:15][::-1]:
                yield _sse({"type": "activity", **evt})
            while True:
                try:
                    evt = await asyncio.wait_for(queue.get(), timeout=15.0)
                    if isinstance(evt, dict) and evt.get("type"):
                        yield _sse(evt)                       # e.g. {"type":"alert", ...}
                    else:
                        yield _sse({"type": "activity", **evt})
                except asyncio.TimeoutError:
                    # heartbeat keeps the connection alive through proxies
                    yield _sse({"type": "ping", "ts": STORE.generated_at,
                                "refresh_running": STORE.refresh_running})
        finally:
            STORE.unsubscribe(queue)

    return StreamingResponse(event_gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no",
                                      "Connection": "keep-alive"})


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


@app.get("/api/health")
async def health():
    return {"ok": True, "app": config.APP_NAME, "apps_loaded": len(STORE.apps),
            "refresh_running": STORE.refresh_running, "generated_at": STORE.generated_at}


# --- intelligence endpoints ----------------------------------------------
@app.get("/api/leaderboard")
async def leaderboard(limit: int = 100):
    """Apps ranked by the transparent Integration Readiness Score."""
    apps = sorted(STORE.live.values(), key=lambda a: a.readiness.score, reverse=True)[:limit]
    return {"generated_at": STORE.generated_at, "weights": config.READINESS_WEIGHTS,
            "leaderboard": [{
                "rank": i + 1, "id": a.app.id, "name": a.app.name, "category": a.app.category,
                "score": a.readiness.score, "grade": a.readiness.grade, "mcp": a.mcp.status,
                "tools": a.tools_count, "stars": a.github.stars,
                "downloads": sum((p.downloads_last_month or 0) for p in a.packages),
            } for i, a in enumerate(apps)]}


@app.get("/api/opportunities")
async def opportunities(limit: int = 25):
    """Popular, live apps that still have NO vendor-official MCP = build candidates."""
    scored = [(opportunity_score(a), a) for a in STORE.live.values()]
    scored = [(s, a) for s, a in scored if s >= 0]
    scored.sort(key=lambda x: x[0], reverse=True)
    return {"generated_at": STORE.generated_at, "opportunities": [{
        "id": a.app.id, "name": a.app.name, "category": a.app.category, "website": a.app.website,
        "demand_score": s, "mcp": a.mcp.status, "community_servers": a.mcp.matched,
        "stars": a.github.stars, "downloads": sum((p.downloads_last_month or 0) for p in a.packages),
        "readiness": a.readiness.score,
    } for s, a in scored[:limit]]}


@app.get("/api/history")
async def history():
    return {"points": [h.model_dump(mode="json") for h in STORE.history]}


@app.get("/api/changes")
async def changes(limit: int = 60):
    return {"changes": [c.model_dump(mode="json") for c in STORE.changes[:limit]]}


@app.get("/api/export")
async def export(format: str = "csv"):
    """Download the whole real dataset (agent- and human-consumable)."""
    apps = [STORE.live[a.id] for a in STORE.apps if a.id in STORE.live]
    if format == "json":
        return JSONResponse({"generated_at": STORE.generated_at, "app_name": config.APP_NAME,
                             "apps": [a.model_dump(mode="json") for a in apps]})
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", "name", "category", "website", "mcp_status", "mcp_servers",
                "official_servers", "live_tools", "auth_gated", "github_repo", "stars",
                "last_commit", "license", "language", "archived", "downloads_last_month",
                "site_status", "site_latency_ms", "readiness_score", "readiness_grade", "last_fetched"])
    for a in apps:
        off = "; ".join(s.name for s in a.mcp.servers if s.classification == "vendor_official")
        w.writerow([a.app.id, a.app.name, a.app.category, a.app.website, a.mcp.status, a.mcp.matched,
                    off, a.tools_count or "", "yes" if a.auth_gated else "no",
                    a.github.full_name or "", a.github.stars if a.github.stars is not None else "",
                    a.github.pushed_at or "", a.github.license or "", a.github.language or "",
                    "yes" if a.github.archived else ("no" if a.github.archived is not None else ""),
                    sum((p.downloads_last_month or 0) for p in a.packages),
                    (a.liveness.status_code if a.liveness else ""),
                    (a.liveness.latency_ms if a.liveness else ""),
                    a.readiness.score, a.readiness.grade, a.last_fetched or ""])
    return Response(content=buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": "attachment; filename=mcp-integration-data.csv"})


# --- universal search + discover ANY app live -----------------------------
# Bounded LRU: an unbounded dict keyed on user input is a slow memory leak on a
# long-lived public deployment.
_search_cache: "OrderedDict[str, tuple[float, list]]" = OrderedDict()


def _cache_put(key: str, value: list) -> None:
    _search_cache[key] = (time.time(), value)
    _search_cache.move_to_end(key)
    while len(_search_cache) > config.SEARCH_CACHE_MAX:
        _search_cache.popitem(last=False)


@app.get("/api/search")
async def search(q: str, limit: int = 8):
    """Type-ahead: curated matches (instant) + live MCP-registry suggestions."""
    q = (q or "").strip()
    tracked = []
    if q:
        ql = q.lower()
        for a in STORE.apps:
            if ql in a.name.lower() or ql in a.category.lower():
                al = STORE.live.get(a.id)
                tracked.append({"id": a.id, "name": a.name, "category": a.category,
                                "mcp_status": al.mcp.status if al else "pending",
                                "score": al.readiness.score if al else 0,
                                "grade": al.readiness.grade if al else "-"})
        tracked.sort(key=lambda x: (x["name"].lower().find(ql) < 0, x["name"].lower()))
        tracked = tracked[:limit]

    registry: list = []
    if len(q) >= 2:
        now = time.time()
        hit = _search_cache.get(q.lower())
        if hit and now - hit[0] < 90:
            registry = hit[1]
        else:
            try:
                async with httpx.AsyncClient(headers={"User-Agent": config.USER_AGENT}, follow_redirects=True) as client:
                    registry = await registry_suggestions(client, q, limit)
                _cache_put(q.lower(), registry)
            except Exception:
                registry = []
    return {"query": q, "tracked": tracked, "registry": registry}


_last_lookup: dict[str, float] = {}
_lookup_cache: dict[str, tuple[float, dict]] = {}


@app.get("/api/lookup")
async def lookup(name: str, website: str = ""):
    """Fetch ANY app live (not limited to the curated list) and return its real
    record. Ephemeral; use POST /api/apps to pin it to the tracked list."""
    name = (name or "").strip()
    if not name:
        raise HTTPException(400, "name is required")
    if len(name) > 80:
        raise HTTPException(400, "name too long")
    # A live lookup fans out to the registry, GitHub, npm/PyPI, the app's site
    # and an MCP handshake, so it is the most expensive request we serve.
    now = time.time()
    key = name.lower()
    # Layer 3: serve the previous result instead of rejecting the repeat. A
    # lookup costs 10-20s of upstream calls, and the answer does not change in
    # seconds - so a repeat within LOOKUP_CACHE_S is answered from cache and
    # flagged as such (never a scary 429 for the user).
    hit = _lookup_cache.get(key)
    if hit and now - hit[0] < config.LOOKUP_CACHE_S:
        out = dict(hit[1])
        out["cached"] = True
        out["cache_age_s"] = int(now - hit[0])
        out["retry_after_s"] = int(max(0, config.LOOKUP_CACHE_S - (now - hit[0])))
        return out
    last = _last_lookup.get(key, 0.0)
    if now - last < config.LOOKUP_COOLDOWN_S:
        # Only reachable when the cached result is gone but the stamp is fresh
        # (e.g. the previous run failed). Say whose limit this is, and when to
        # come back, so the client can retry on its own.
        wait = int(config.LOOKUP_COOLDOWN_S - (now - last)) + 1
        raise HTTPException(
            429,
            f"our own rate limit: this exact lookup ran {int(now - last)}s ago; retry in {wait}s",
            headers={"Retry-After": str(wait)},
        )
    if len(_last_lookup) > config.SEARCH_CACHE_MAX:
        _last_lookup.clear()
        _lookup_cache.clear()
    _last_lookup[key] = now
    STORE.bump_popular(name)
    try:
        async with httpx.AsyncClient(headers={"User-Agent": config.USER_AGENT}, follow_redirects=True) as client:
            al = await discover_app(client, name, website)
        payload = al.model_dump(mode="json")
        # Cache only a usable answer, so a throttled/failed run is retried by the
        # next click instead of being replayed from cache.
        mcp_info = payload.get("mcp") or {}
        if mcp_info.get("servers") or not mcp_info.get("error"):
            _lookup_cache[key] = (time.time(), payload)
            if len(_lookup_cache) > config.SEARCH_CACHE_MAX:
                for old_key in sorted(_lookup_cache, key=lambda k: _lookup_cache[k][0])[:
                        len(_lookup_cache) - config.SEARCH_CACHE_MAX]:
                    _lookup_cache.pop(old_key, None)
        return payload
    except Exception as exc:
        raise HTTPException(502, f"lookup failed: {type(exc).__name__}: {exc}")


# --- MCP compatibility tester ---------------------------------------------
_compat_last: dict[str, float] = {}


class CompatBody(BaseModel):
    url: str


@app.post("/api/mcp/compatibility-test")
async def mcp_compatibility_test(body: CompatBody):
    """Run the behavioural MCP compatibility suite against one endpoint.

    This is a compatibility report from this explorer's point of view, NOT an
    official MCP certification. The URL is validated and, when
    BLOCK_PRIVATE_URLS is on, refused if it resolves to a private address. No
    credentials are ever sent or echoed.
    """
    url = (body.url or "").strip()
    if not url or len(url) > 500:
        raise HTTPException(400, "a non-empty url is required")
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "url must be http(s)")
    now = time.time()
    last = _compat_last.get(url.lower(), 0.0)
    if now - last < config.COMPAT_COOLDOWN_S:
        wait = int(config.COMPAT_COOLDOWN_S - (now - last)) + 1
        raise HTTPException(
            429,
            f"our own rate limit: that endpoint was tested {int(now - last)}s ago; retry in {wait}s",
            headers={"Retry-After": str(wait)},
        )
    if len(_compat_last) > config.SEARCH_CACHE_MAX:
        _compat_last.clear()
    _compat_last[url.lower()] = now
    try:
        report = await compat.test_url(url)
    except Exception as exc:
        raise HTTPException(502, f"compatibility test failed: {type(exc).__name__}: {exc}")
    return report.model_dump(mode="json")


# --- historical diff + breaking-change detection ---------------------------
@app.get("/api/integrations/{app_id}/changes")
async def integration_changes(app_id: int):
    """Change history for one integration: the latest diff (previous stored
    snapshot -> current), the day-grouped timeline, and the snapshot index a
    client can use to request an arbitrary from/to comparison."""
    if app_id not in STORE.live:
        raise HTTPException(404, "app not found")
    al = STORE.live[app_id]
    return {
        "app_id": app_id,
        "app": al.app.name,
        "latest": STORE.diff_app(app_id, "prev", "latest"),
        "timeline": STORE.timeline(app_id),
        "snapshots": STORE.snapshot_index(app_id),
    }


@app.get("/api/integrations/{app_id}/diff")
async def integration_diff(app_id: int, from_: Optional[str] = Query(default=None, alias="from"),
                           to: Optional[str] = Query(default=None)):
    """Deterministic structured diff between two stored snapshots.

    `from` / `to` accept: an ISO timestamp (nearest snapshot at or before it),
    an integer index into the snapshot list (0 = oldest), or the words
    `prev` / `latest`. Defaults to prev -> latest.
    """
    if app_id not in STORE.live:
        raise HTTPException(404, "app not found")
    frm = from_ if from_ not in (None, "") else "prev"
    dst = to if to not in (None, "") else "latest"
    report = STORE.diff_app(app_id, frm, dst)
    if report is None:
        raise HTTPException(404, "not enough stored snapshots to compare "
                                 "(this integration has no historical fingerprints yet)")
    return report


# --- watches / alerts / popular -------------------------------------------
class WatchBody(BaseModel):
    app_id: int
    events: list[str] = ["official_mcp"]


@app.get("/api/watches")
async def get_watches():
    return {"watches": [w.model_dump(mode="json") for w in STORE.watches.values()]}


@app.post("/api/watch")
async def post_watch(body: WatchBody, _k: None = Depends(require_key)):
    if body.app_id not in STORE.live:
        raise HTTPException(404, "app not found")
    valid = {"official_mcp", "site_down", "any"}
    events = [e for e in body.events if e in valid] or ["official_mcp"]
    w = STORE.add_watch(body.app_id, events)
    return {"watching": True, "watch": w.model_dump(mode="json")}


@app.delete("/api/watch/{app_id}")
async def delete_watch(app_id: int, _k: None = Depends(require_key)):
    STORE.remove_watch(app_id)
    return {"watching": False, "app_id": app_id}


@app.get("/api/alerts")
async def get_alerts(unread: bool = False, limit: int = 60):
    items = [a for a in STORE.alerts if (a.read is False if unread else True)][:limit]
    return {"unread": STORE.unread_alerts(), "alerts": [a.model_dump(mode="json") for a in items]}


@app.post("/api/alerts/read")
async def post_alerts_read(_k: None = Depends(require_key)):
    n = STORE.mark_alerts_read()
    return {"marked_read": n, "unread": STORE.unread_alerts()}


@app.get("/api/popular")
async def get_popular(limit: int = 8):
    return {"popular": [p.model_dump(mode="json") for p in STORE.top_popular(limit)]}


class AddAppBody(BaseModel):
    name: str
    website: str = ""
    category: str = "Discovered"


@app.post("/api/apps")
async def add_app(body: AddAppBody, _k: None = Depends(require_key)):
    """Pin a discovered app to the tracked list; it is fetched live in the background."""
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(400, "name is required")
    if len(name) > 80:
        raise HTTPException(400, "name too long")
    pinned = sum(1 for a in STORE.apps if a.id > 100)
    if pinned >= config.MAX_CUSTOM_APPS and not any(a.name.lower() == name.lower() for a in STORE.apps):
        raise HTTPException(429, f"pinned-app limit reached ({config.MAX_CUSTOM_APPS})")
    app_obj = STORE.add_app(name, body.website, body.category)
    STORE.bump_popular(name)
    asyncio.create_task(_fetch_pinned(app_obj.id, name, body.website))
    return JSONResponse({"added": True, "id": app_obj.id, "app": app_obj.model_dump()})


async def _fetch_pinned(aid: int, name: str, website: str) -> None:
    STORE.log("system", None, "", f"Fetching live data for newly added “{name}”…", status="info")
    try:
        async with httpx.AsyncClient(headers={"User-Agent": config.USER_AGENT}, follow_redirects=True) as client:
            discovered = await discover_app(client, name, website)
            discovered.app = STORE.live[aid].app   # keep the assigned id/category
            STORE.live[aid] = discovered
        STORE.save_cache()
        write_snapshot_js()
        STORE.log("refresh", aid, name,
                  f"Added & fetched · MCP {discovered.mcp.status} · readiness {discovered.readiness.score}",
                  status="ok")
    except Exception as exc:
        STORE.log("system", aid, name, f"Fetch failed: {type(exc).__name__}", status="error")


# --- deep link (SPA route) ------------------------------------------------
@app.get("/app/{app_id}")
async def deep_link(app_id: int):
    """Shareable per-app URL; the dashboard reads the id and opens the modal."""
    return FileResponse(config.STATIC_DIR / "index.html")



# --- static dashboard -----------------------------------------------------
# Mounted last so the /api/* and /app/* routes above take precedence.
app.mount("/", StaticFiles(directory=str(config.STATIC_DIR), html=True), name="static")

