"""Integration Readiness Score — computed ONLY from real fetched signals.

Every component is explainable and shown in the UI; there is no black box and
nothing is invented. If a signal is missing (not fetched / unavailable), it
scores low and says so, rather than guessing.
"""
from __future__ import annotations

import math
from datetime import datetime, timezone

from . import config
from .models import AppLive, Readiness

W = config.READINESS_WEIGHTS


def _days_since(iso: str | None) -> float | None:
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - dt).total_seconds() / 86400.0
    except Exception:
        return None


def _log_score(value: float | None, ceiling_log: float) -> float:
    if not value or value <= 0:
        return 0.0
    return min(math.log10(value + 1) / ceiling_log, 1.0)


def compute_readiness(al: AppLive) -> Readiness:
    mcp_status = al.mcp.status
    gh = al.github
    lv = al.liveness

    # 1) Official MCP presence
    off_map = {"vendor_official": 1.0, "community": 0.5, "none": 0.0, "unknown": 0.2, "pending": 0.1}
    c_official = off_map.get(mcp_status, 0.1)

    # 2) Capability: real tools on a live endpoint
    if al.tools_count is not None and al.tools_count > 0 and not al.generic_gateway:
        c_cap = min(al.tools_count / 12.0, 1.0)
        cap_detail = f"{al.tools_count} live app-specific tools"
    elif al.tools_count is not None and al.generic_gateway:
        c_cap = 0.35
        cap_detail = f"shared aggregator gateway ({al.tools_count} generic tools)"
    elif al.auth_gated:
        c_cap = 0.5
        cap_detail = "endpoint exists but auth-gated"
    elif any(s.remote_urls for s in al.mcp.servers):
        c_cap = 0.3
        cap_detail = "remote endpoint present (not probed/open)"
    else:
        c_cap = 0.0
        cap_detail = "no live endpoint"

    # 3) Adoption: npm/PyPI monthly downloads
    downloads = sum((p.downloads_last_month or 0) for p in al.packages)
    c_adopt = _log_score(downloads, config.DOWNLOADS_CEILING_LOG)
    adopt_detail = f"{downloads:,}/mo downloads" if downloads else "no package download data"

    # 4) Popularity: GitHub stars of the MCP repo
    stars = gh.stars or 0
    c_pop = _log_score(stars, config.STARS_CEILING_LOG)
    pop_detail = f"★{stars:,}" if gh.status == "found" else "no repo stars"

    # 5) Maintenance: recency of last commit, archived penalty
    days = _days_since(gh.pushed_at)
    if days is None:
        c_maint, maint_detail = 0.3, "commit recency unknown"
    elif days < 30:
        c_maint, maint_detail = 1.0, f"committed {int(days)}d ago"
    elif days < 90:
        c_maint, maint_detail = 0.8, f"committed {int(days)}d ago"
    elif days < 180:
        c_maint, maint_detail = 0.6, f"committed {int(days)}d ago"
    elif days < 365:
        c_maint, maint_detail = 0.35, f"committed {int(days)}d ago"
    else:
        c_maint, maint_detail = 0.15, f"committed {int(days)}d ago"
    if gh.archived:
        c_maint *= 0.3
        maint_detail += " (archived)"

    # 6) Availability: website reachable
    if lv is None:
        c_avail, avail_detail = 0.1, "site not checked"
    elif lv.reachable:
        c_avail, avail_detail = 1.0, f"site up (HTTP {lv.status_code})"
    elif lv.responded:
        c_avail, avail_detail = 0.5, f"site responded HTTP {lv.status_code}"
    else:
        c_avail, avail_detail = 0.1, "site unreachable"

    comps = {
        "official_mcp": {"weight": W["official_mcp"], "score": round(c_official, 3),
                         "detail": f"MCP: {mcp_status.replace('_', ' ')}"},
        "capability": {"weight": W["capability"], "score": round(c_cap, 3), "detail": cap_detail},
        "adoption": {"weight": W["adoption"], "score": round(c_adopt, 3), "detail": adopt_detail},
        "popularity": {"weight": W["popularity"], "score": round(c_pop, 3), "detail": pop_detail},
        "maintenance": {"weight": W["maintenance"], "score": round(c_maint, 3), "detail": maint_detail},
        "availability": {"weight": W["availability"], "score": round(c_avail, 3), "detail": avail_detail},
    }
    total = sum(c["weight"] * c["score"] for c in comps.values())
    score = int(round(total * 100))
    grade = "A" if score >= 80 else "B" if score >= 60 else "C" if score >= 40 else "D" if score >= 20 else "E"
    return Readiness(score=score, grade=grade, components=comps)


def opportunity_score(al: AppLive) -> float:
    """Demand signal for apps WITHOUT a vendor-official MCP: how worth-building
    is an official integration? Higher = more demand, still no official server."""
    if al.mcp.status == "vendor_official":
        return -1.0  # not an opportunity; already has official support
    downloads = sum((p.downloads_last_month or 0) for p in al.packages)
    stars = al.github.stars or 0
    demand = (
        _log_score(stars, config.STARS_CEILING_LOG) * 40
        + _log_score(downloads, config.DOWNLOADS_CEILING_LOG) * 40
        + min(len(al.mcp.servers), 10) * 2          # community activity
        + (10 if (al.liveness and al.liveness.reachable) else 0)
    )
    return round(demand, 2)
