"""In-memory + on-disk state for live app data, aggregate stats, time-series
history, change detection, and a rolling activity feed that powers the
real-time dashboard stream.
"""
from __future__ import annotations

import asyncio
import json
from collections import deque
from datetime import datetime, timezone
from typing import Optional

from . import config
from .models import (
    Alert, App, AppLive, Change, HistoryPoint, PopularItem, Snapshot, SourceHealth, Stats, Watch,
)
from . import diffing
from .scoring import compute_readiness
import uuid


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _days_since(iso: str | None) -> Optional[float]:
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - dt).total_seconds() / 86400.0
    except Exception:
        return None


class Store:
    def __init__(self) -> None:
        self.apps: list[App] = []
        self.live: dict[int, AppLive] = {}
        self.sources: list[SourceHealth] = []
        self.activity: deque[dict] = deque(maxlen=200)
        self.history: list[HistoryPoint] = []
        self.changes: list[Change] = []
        self.alerts: list[Alert] = []
        self.watches: dict[int, Watch] = {}
        self.popular: dict[str, PopularItem] = {}
        self.app_snapshots: dict[int, list[dict]] = {}
        self._subs: list[asyncio.Queue] = []
        self.refresh_running = False
        self.generated_at = utc_now()
        self.note = (
            "All fields are fetched live from real sources: the official MCP registry, "
            "the GitHub API, npm/PyPI, direct HTTP site checks, and live probes of each "
            "server's MCP endpoint. 'Vendor official' means the server's reverse-domain "
            "namespace resolves to the app's own website domain."
        )

    # --- loading ----------------------------------------------------------
    def load_apps(self) -> None:
        self.load_app_snapshots()
        data = json.loads(config.APPS_FILE.read_text(encoding="utf-8"))
        self.apps = [App(**a) for a in data["apps"]]
        # merge any user-pinned discovered apps
        if config.CUSTOM_APPS_FILE.exists():
            try:
                for a in json.loads(config.CUSTOM_APPS_FILE.read_text(encoding="utf-8")):
                    if not any(x.id == a["id"] for x in self.apps):
                        self.apps.append(App(**a))
            except Exception:
                pass
        for a in self.apps:
            if a.id not in self.live:
                self.live[a.id] = AppLive(app=a)
        self.load_cache()
        self.load_history()
        self.load_changes()
        self.load_watches()
        self.load_alerts()
        self.load_popular()

    def _persist_custom(self) -> None:
        curated = {a["id"] for a in json.loads(config.APPS_FILE.read_text(encoding="utf-8"))["apps"]}
        custom = [a.model_dump() for a in self.apps if a.id not in curated]
        config.CUSTOM_APPS_FILE.write_text(json.dumps(custom, ensure_ascii=False, indent=2), encoding="utf-8")

    def add_app(self, name: str, website: str = "", category: str = "Discovered") -> App:
        """Pin a discovered app to the tracked list (persisted separately)."""
        name = name.strip()
        existing = next((a for a in self.apps if a.name.lower() == name.lower()), None)
        if existing:
            return existing
        next_id = max((a.id for a in self.apps), default=0) + 1
        app = App(id=next_id, name=name, category=category or "Discovered",
                  website=(website or "").strip())
        self.apps.append(app)
        self.live[app.id] = AppLive(app=app)
        self._persist_custom()
        return app

    def load_cache(self) -> None:
        if not config.CACHE_FILE.exists():
            return
        try:
            raw = json.loads(config.CACHE_FILE.read_text(encoding="utf-8"))
        except Exception:
            return
        # apps.json is the source of truth for frame metadata (name/category/
        # website); the cache only supplies the *fetched* fields.
        fresh = {a.id: a for a in self.apps}
        for item in raw.get("apps", []):
            try:
                al = AppLive.model_validate(item)
            except Exception:
                continue
            if al.app.id in fresh:
                al.app = fresh[al.app.id]
            # recompute readiness so formula changes apply to cached data
            al.readiness = compute_readiness(al)
            self.live[al.app.id] = al
        for s in raw.get("sources", []):
            try:
                self.sources.append(SourceHealth.model_validate(s))
            except Exception:
                continue
        self.generated_at = raw.get("generated_at", self.generated_at)

    def save_cache(self) -> None:
        payload = self.snapshot().model_dump(mode="json")
        config.CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        config.CACHE_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    # --- history / changes ------------------------------------------------
    def load_history(self) -> None:
        if config.HISTORY_FILE.exists():
            try:
                self.history = [HistoryPoint.model_validate(x) for x in
                                json.loads(config.HISTORY_FILE.read_text(encoding="utf-8"))]
            except Exception:
                self.history = []

    def load_changes(self) -> None:
        if config.CHANGES_FILE.exists():
            try:
                self.changes = [Change.model_validate(x) for x in
                                json.loads(config.CHANGES_FILE.read_text(encoding="utf-8"))]
            except Exception:
                self.changes = []

    def record_history(self) -> None:
        st = self.compute_stats()
        point = HistoryPoint(
            ts=utc_now(), official=st.mcp_vendor_official, community=st.mcp_community,
            none=st.mcp_none, servers=st.total_mcp_servers, tools=st.total_tools,
            downloads=st.total_downloads, stars=st.total_stars, responding=st.websites_responding,
            reachable=st.websites_reachable, avg_readiness=round(st.avg_readiness, 1),
        )
        # avoid duplicate points within the same minute
        if self.history and self.history[-1].ts == point.ts:
            self.history[-1] = point
        else:
            self.history.append(point)
        self.history = self.history[-config.HISTORY_MAX_POINTS:]
        config.HISTORY_FILE.write_text(
            json.dumps([h.model_dump(mode="json") for h in self.history], ensure_ascii=False, indent=2),
            encoding="utf-8")

    def push_changes(self, changes: list[Change]) -> None:
        if not changes:
            return
        self.changes = (changes + self.changes)[:config.CHANGES_MAX]
        config.CHANGES_FILE.write_text(
            json.dumps([c.model_dump(mode="json") for c in self.changes], ensure_ascii=False, indent=2),
            encoding="utf-8")
        for c in changes[:8]:
            self.log("change", c.app_id, c.app, c.message, status="info")

    @staticmethod
    def app_summary(al: AppLive) -> dict:
        return {
            "status": al.mcp.status,
            "servers": al.mcp.matched,
            "stars": al.github.stars or 0,
            "tools": al.tools_count or 0,
            "downloads": sum((p.downloads_last_month or 0) for p in al.packages),
            "up": bool(al.liveness and al.liveness.reachable),
        }

    def diff_summaries(self, before: dict[int, dict], after: dict[int, dict]) -> list[Change]:
        ts = utc_now()
        out: list[Change] = []
        names = {a.id: a.name for a in self.apps}
        for aid, a in after.items():
            b = before.get(aid)
            if not b:
                continue
            nm = names.get(aid, f"#{aid}")
            if b["status"] != a["status"]:
                out.append(Change(ts=ts, app_id=aid, app=nm, kind="status",
                                  message=f"MCP status {b['status']} → {a['status']}"))
            if a["servers"] != b["servers"]:
                d = a["servers"] - b["servers"]
                out.append(Change(ts=ts, app_id=aid, app=nm, kind="servers",
                                  message=f"registry servers {b['servers']} → {a['servers']} ({d:+d})"))
            if a["stars"] != b["stars"] and abs(a["stars"] - b["stars"]) >= 5:
                out.append(Change(ts=ts, app_id=aid, app=nm, kind="stars",
                                  message=f"repo ★ {b['stars']:,} → {a['stars']:,} ({a['stars']-b['stars']:+,})"))
            if a["tools"] != b["tools"]:
                out.append(Change(ts=ts, app_id=aid, app=nm, kind="tools",
                                  message=f"live tools {b['tools']} → {a['tools']}"))
            if b["up"] != a["up"]:
                out.append(Change(ts=ts, app_id=aid, app=nm, kind="site",
                                  message=f"site {'came up' if a['up'] else 'went down'}"))
        return out

    # --- watches / alerts / popular --------------------------------------
    def load_watches(self) -> None:
        if config.WATCHES_FILE.exists():
            try:
                for w in json.loads(config.WATCHES_FILE.read_text(encoding="utf-8")):
                    wt = Watch.model_validate(w)
                    self.watches[wt.app_id] = wt
            except Exception:
                self.watches = {}

    def load_alerts(self) -> None:
        if config.ALERTS_FILE.exists():
            try:
                self.alerts = [Alert.model_validate(x) for x in json.loads(config.ALERTS_FILE.read_text(encoding="utf-8"))]
            except Exception:
                self.alerts = []

    def load_popular(self) -> None:
        if config.POPULAR_FILE.exists():
            try:
                self.popular = {k: PopularItem.model_validate(v) for k, v in
                                json.loads(config.POPULAR_FILE.read_text(encoding="utf-8")).items()}
            except Exception:
                self.popular = {}

    def _save_watches(self) -> None:
        config.WATCHES_FILE.write_text(json.dumps([w.model_dump(mode="json") for w in self.watches.values()],
                                                  ensure_ascii=False, indent=2), encoding="utf-8")

    def _save_alerts(self) -> None:
        config.ALERTS_FILE.write_text(json.dumps([a.model_dump(mode="json") for a in self.alerts],
                                                 ensure_ascii=False, indent=2), encoding="utf-8")

    def _save_popular(self) -> None:
        config.POPULAR_FILE.write_text(json.dumps({k: v.model_dump(mode="json") for k, v in self.popular.items()},
                                                  ensure_ascii=False, indent=2), encoding="utf-8")

    def add_watch(self, app_id: int, events: list[str]) -> Watch:
        name = self.live[app_id].app.name if app_id in self.live else f"#{app_id}"
        w = Watch(app_id=app_id, name=name, events=events or ["official_mcp"], created=utc_now())
        self.watches[app_id] = w
        self._save_watches()
        self.log("system", app_id, name, f"Watching for: {', '.join(w.events)}", status="info")
        return w

    def remove_watch(self, app_id: int) -> None:
        if app_id in self.watches:
            del self.watches[app_id]
            self._save_watches()

    # --- per-integration historical snapshots (diff / breaking changes) -----
    def load_app_snapshots(self) -> None:
        if not config.APP_SNAPSHOTS_FILE.exists():
            return
        try:
            raw = json.loads(config.APP_SNAPSHOTS_FILE.read_text(encoding="utf-8"))
            self.app_snapshots = {int(k): v for k, v in raw.items() if isinstance(v, list)}
        except Exception:
            self.app_snapshots = {}

    def _save_app_snapshots(self) -> None:
        config.APP_SNAPSHOTS_FILE.parent.mkdir(parents=True, exist_ok=True)
        config.APP_SNAPSHOTS_FILE.write_text(
            json.dumps({str(k): v for k, v in self.app_snapshots.items()}, ensure_ascii=False),
            encoding="utf-8")

    def record_app_snapshot(self, app_id: int, fingerprint: dict, ts: Optional[str] = None) -> bool:
        """Append one normalised fingerprint for an integration.

        Unchanged refreshes store a lightweight pointer (hash only) so the
        timeline can show "no changes" days without duplicating payloads.
        Returns True when this snapshot differs from the previous one.
        """
        entries = self.app_snapshots.setdefault(int(app_id), [])
        h = diffing.fingerprint_hash(fingerprint)
        last = entries[-1] if entries else None
        changed = last is None or last.get("hash") != h
        entries.append({"ts": ts or utc_now(), "hash": h, "changed": changed,
                        "data": fingerprint if changed else None})
        if len(entries) > config.APP_SNAPSHOTS_MAX:
            entries[:] = entries[-config.APP_SNAPSHOTS_MAX:]
            self._ensure_resolvable(entries)
        self.app_snapshots[int(app_id)] = entries
        self._save_app_snapshots()
        return changed

    @staticmethod
    def _ensure_resolvable(entries: list[dict]) -> None:
        """After trimming, the oldest kept entry must carry a payload, or an
        'unchanged' pointer could lose the fingerprint it refers to."""
        if entries and entries[0].get("data") is None:
            for e in entries[1:]:
                if e.get("data") is not None and e.get("hash") == entries[0].get("hash"):
                    entries[0]["data"] = e["data"]
                    break

    def snapshot_index(self, app_id: int) -> list[dict]:
        return [{"ts": e["ts"], "hash": e.get("hash"), "changed": bool(e.get("changed")),
                 "has_data": e.get("data") is not None}
                for e in self.app_snapshots.get(int(app_id), [])]

    def resolve_snapshot(self, app_id: int, ref) -> Optional[dict]:
        """Resolve 'latest' | 'prev' | an int index | an ISO timestamp to a
        concrete {ts, data} pair (walking back to the nearest payload)."""
        entries = self.app_snapshots.get(int(app_id), [])
        if not entries:
            return None
        target = None
        if ref in (None, "", "latest", -1):
            target = entries[-1]
        elif ref == "prev" or ref == -2:
            target = entries[-2] if len(entries) > 1 else None
        elif isinstance(ref, int) or (isinstance(ref, str) and ref.lstrip("-").isdigit()):
            i = int(ref)
            target = entries[i] if -len(entries) <= i < len(entries) else None
        else:
            cand = [e for e in entries if e["ts"] <= str(ref)]
            target = cand[-1] if cand else entries[0]
        if target is None:
            return None
        if target.get("data") is not None:
            return {"ts": target["ts"], "hash": target.get("hash"), "data": target["data"]}
        for e in reversed(entries[:entries.index(target) + 1]):
            if e.get("data") is not None and e.get("hash") == target.get("hash"):
                return {"ts": target["ts"], "hash": target.get("hash"), "data": e["data"]}
        for e in entries:
            if e.get("data") is not None and e.get("hash") == target.get("hash"):
                return {"ts": target["ts"], "hash": target.get("hash"), "data": e["data"]}
        return None

    def diff_app(self, app_id: int, from_ref="prev", to_ref="latest") -> Optional[dict]:
        a = self.resolve_snapshot(app_id, from_ref)
        b = self.resolve_snapshot(app_id, to_ref)
        if not a or not b or not a.get("data") or not b.get("data"):
            return None
        report = diffing.diff_snapshots(a, b)
        al = self.live.get(int(app_id))
        report["app_id"] = int(app_id)
        report["app"] = al.app.name if al else f"#{app_id}"
        return report

    def timeline(self, app_id: int, limit: int = 30) -> list[dict]:
        """Day-grouped change history, computed deterministically from the
        stored fingerprints (consecutive distinct payloads are diffed)."""
        entries = [e for e in self.app_snapshots.get(int(app_id), []) if e.get("data") is not None]
        days: dict[str, dict] = {}
        pairs = 0
        for prev, cur in zip(entries, entries[1:]):
            if pairs >= limit:
                break
            pairs += 1
            d = diffing.diff_snapshots(prev, cur)
            day = (cur["ts"] or "")[:10]
            slot = days.setdefault(day, {"day": day, "changes": 0, "breaking": 0, "ts": cur["ts"]})
            slot["changes"] += d["summary"]["added"] + d["summary"]["removed"] + d["summary"]["modified"]
            slot["breaking"] += d["summary"]["breaking"]
        # days with a snapshot but no diff still deserve a "no changes" row
        for e in entries:
            days.setdefault((e["ts"] or "")[:10], {"day": (e["ts"] or "")[:10], "changes": 0,
                                                  "breaking": 0, "ts": e["ts"]})
        return [days[k] for k in sorted(days, reverse=True)][:limit]

    def record_alert(self, app_id, app, event, message) -> Alert:
        a = Alert(id=uuid.uuid4().hex[:12], ts=utc_now(), app_id=app_id, app=app, event=event, message=message)
        self.alerts = ([a] + self.alerts)[:config.ALERTS_MAX]
        self._save_alerts()
        # broadcast live to any open dashboards + optional webhook
        payload = a.model_dump(mode="json")
        for q in list(self._subs):
            try:
                q.put_nowait({"type": "alert", "alert": payload})
            except Exception:
                pass
        if config.ALERT_WEBHOOK_URL:
            self._fire_webhook(payload)
        return a

    def _fire_webhook(self, alert: dict) -> None:
        try:
            import urllib.request
            body = json.dumps({"text": f"[{alert['app']}] {alert['message']}", "alert": alert}).encode()
            req = urllib.request.Request(config.ALERT_WEBHOOK_URL, data=body,
                                         headers={"Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=8)
        except Exception:
            pass

    def mark_alerts_read(self) -> int:
        n = sum(1 for a in self.alerts if not a.read)
        for a in self.alerts:
            a.read = True
        self._save_alerts()
        return n

    def unread_alerts(self) -> int:
        return sum(1 for a in self.alerts if not a.read)

    def bump_popular(self, name: str) -> None:
        key = name.strip().lower()
        if not key:
            return
        item = self.popular.get(key) or PopularItem(name=name.strip())
        item.count += 1
        item.last = utc_now()
        self.popular[key] = item
        self._save_popular()

    def top_popular(self, limit: int = 6) -> list[PopularItem]:
        return sorted(self.popular.values(), key=lambda p: p.count, reverse=True)[:limit]

    def generate_alerts(self, changes: list[Change]) -> list[Alert]:
        """Turn watched-app changes into alerts."""
        fired: list[Alert] = []
        for c in changes:
            w = self.watches.get(c.app_id)
            if not w:
                continue
            ev = set(w.events)
            msg = c.message
            hit = None
            if "official_mcp" in ev and c.kind == "status" and "vendor_official" in msg:
                hit = ("official_mcp", f"{c.app} now has a vendor-official MCP 🎉")
            elif "site_down" in ev and c.kind == "site" and "went down" in msg:
                hit = ("site_down", f"{c.app} website went down")
            elif "any" in ev:
                hit = ("any", f"{c.app}: {msg}")
            if hit:
                fired.append(self.record_alert(c.app_id, c.app, hit[0], hit[1]))
        return fired

    # --- activity + pub/sub ----------------------------------------------
    def log(self, kind: str, app_id: Optional[int], app_name: str, message: str, status: str = "info") -> None:
        evt = {"ts": utc_now(), "kind": kind, "app_id": app_id, "app": app_name,
               "message": message, "status": status}
        self.activity.appendleft(evt)
        for q in list(self._subs):
            try:
                q.put_nowait(evt)
            except Exception:
                pass

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=500)
        self._subs.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        if q in self._subs:
            self._subs.remove(q)

    def set_sources(self, sources: list[dict]) -> None:
        self.sources = [SourceHealth(**s) for s in sources]

    # --- aggregation ------------------------------------------------------
    def compute_stats(self) -> Stats:
        st = Stats(total_apps=len(self.apps))
        by_cat: dict[str, dict] = {}
        latencies: list[int] = []
        readiness_sum = 0.0
        for al in self.live.values():
            m = al.mcp.status
            if m == "vendor_official":
                st.mcp_vendor_official += 1
            elif m == "community":
                st.mcp_community += 1
            elif m == "none":
                st.mcp_none += 1
            elif m == "unknown":
                st.mcp_unknown += 1
            else:
                st.mcp_pending += 1
            st.total_mcp_servers += len(al.mcp.servers)
            if al.last_fetched:
                st.refreshed += 1
            if al.liveness:
                st.websites_checked += 1
                if al.liveness.reachable:
                    st.websites_reachable += 1
                if al.liveness.responded:
                    st.websites_responding += 1
                if al.liveness.latency_ms is not None:
                    latencies.append(al.liveness.latency_ms)
            if al.github.status == "found":
                st.github_repos_found += 1
                st.total_stars += al.github.stars or 0
                d = _days_since(al.github.pushed_at)
                if d is not None and d <= 90 and not al.github.archived:
                    st.maintained_repos += 1

            # downloads / tools / probes
            dl = sum((p.downloads_last_month or 0) for p in al.packages)
            st.total_downloads += dl
            if al.tools_count:
                st.open_endpoints += 1
                if al.generic_gateway:
                    st.generic_gateways += 1
                else:
                    st.total_tools += al.tools_count
            best_probe = next((s.probe for s in al.mcp.servers if s.probe), None)
            if best_probe:
                st.probed_endpoints += 1
                if best_probe.result in ("auth_required", "payment_required", "forbidden"):
                    st.auth_gated_endpoints += 1
            readiness_sum += al.readiness.score

            cat = al.app.category
            c = by_cat.setdefault(cat, {"apps": 0, "vendor_official": 0, "community": 0,
                                        "none": 0, "unknown": 0, "pending": 0,
                                        "reachable": 0, "servers": 0, "stars": 0,
                                        "downloads": 0, "tools": 0, "readiness_sum": 0})
            c["apps"] += 1
            if m in c:
                c[m] += 1
            c["servers"] += len(al.mcp.servers)
            c["downloads"] += dl
            c["tools"] += (al.tools_count or 0) if not al.generic_gateway else 0
            c["readiness_sum"] += al.readiness.score
            if al.liveness and al.liveness.reachable:
                c["reachable"] += 1
            if al.github.status == "found" and al.github.stars:
                c["stars"] += al.github.stars

        st.avg_readiness = round(readiness_sum / len(self.live), 1) if self.live else 0.0
        for cat, c in by_cat.items():
            c["avg_readiness"] = round(c["readiness_sum"] / c["apps"], 1) if c["apps"] else 0
            c.pop("readiness_sum", None)
        st.by_category = {k: by_cat[k] for k in sorted(by_cat)}
        if latencies:
            latencies.sort()
            st.median_latency_ms = latencies[len(latencies) // 2]
        return st

    def snapshot(self) -> Snapshot:
        self.generated_at = utc_now()
        apps = [self.live[a.id] for a in self.apps if a.id in self.live]
        return Snapshot(
            generated_at=self.generated_at,
            app_name=config.APP_NAME,
            tagline=config.APP_TAGLINE,
            stats=self.compute_stats(),
            sources=self.sources,
            apps=apps,
            changes=self.changes[:60],
            history=self.history[-120:],
            alerts=self.alerts[:60],
            watches=list(self.watches.values()),
            popular=self.top_popular(8),
            refresh_running=self.refresh_running,
            note=self.note,
        )


STORE = Store()
