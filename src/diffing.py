"""Historical diff + breaking-change detection for MCP integrations.

Pure, deterministic functions over plain dicts so the logic is trivially
testable and reusable by the store, the API and (later) the MCP server tools.

A *fingerprint* is a normalised view of everything we track about one
integration at one point in time (see :func:`normalize_integration`). Ordering
is canonicalised everywhere (servers, tools, properties, required lists,
remotes, packages) so a harmless reorder never produces a false diff.

Probe-derived groups (protocol / auth / capabilities / tools / resources /
prompts) may be ``None`` meaning "not probed yet / unknown". A diff between an
unknown side and a known side is reported as *not comparable* rather than as a
change, so the first probe of an endpoint never looks like "everything added".

Breaking-change detection is deliberately conservative and always worded as
*potential*: we flag what is likely to break a client, never certify it.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any, Optional

# Field groups that only exist once an endpoint has actually been probed.
PROBE_GROUPS = ("protocol_version", "auth", "capabilities", "tools", "resources", "prompts")


# --------------------------------------------------------------------------
# normalisation
# --------------------------------------------------------------------------
def canonical(obj: Any) -> str:
    """Stable JSON encoding (sorted keys, no whitespace) used for hashing."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def fingerprint_hash(data: dict) -> str:
    return hashlib.sha1(canonical(data).encode("utf-8")).hexdigest()[:16]


def _norm_schema(schema: Any) -> dict:
    """Reduce an inputSchema to the parts clients actually depend on:
    property name -> type, plus the sorted required list."""
    if not isinstance(schema, dict):
        return {"properties": {}, "required": []}
    props = schema.get("properties")
    props = props if isinstance(props, dict) else {}
    out = {}
    for key in sorted(props):
        v = props[key]
        v = v if isinstance(v, dict) else {}
        if isinstance(v.get("type"), str):
            t = v["type"]
        elif isinstance(v.get("properties"), dict):
            t = "object"
        elif isinstance(v.get("items"), dict):
            t = "array"
        else:
            t = "any"
        out[key] = t
    return {"properties": out, "required": sorted({str(x) for x in (schema.get("required") or [])})}


def normalize_integration(al: dict) -> dict:
    """Build the normalised fingerprint from an AppLive dump (mode='json')."""
    mcp = al.get("mcp") or {}
    detail = al.get("mcp_detail") or {}
    gh = al.get("github") or {}
    lv = al.get("liveness") or {}

    servers = []
    for s in sorted(mcp.get("servers") or [], key=lambda x: (x.get("name") or "")):
        servers.append({
            "name": s.get("name"),
            "version": s.get("version") or None,
            "classification": s.get("classification"),
            "remotes": sorted(s.get("remote_urls") or []),
            "packages": sorted(s.get("packages") or []),
        })

    raw_tools = detail.get("tools")
    tools = None
    if isinstance(raw_tools, list):
        tools = []
        for t in sorted(raw_tools, key=lambda x: (x.get("name") or "")):
            if not isinstance(t, dict):
                continue
            tools.append({
                "name": t.get("name"),
                "description": (t.get("description") or "").strip(),
                "schema": _norm_schema(t.get("inputSchema")),
            })

    caps = detail.get("capabilities")
    capabilities = sorted(caps) if isinstance(caps, (list, dict)) and caps is not None else (
        sorted(caps.keys()) if isinstance(caps, dict) else None)
    if isinstance(detail.get("capabilities"), dict):
        capabilities = sorted(detail["capabilities"].keys())
    elif isinstance(detail.get("capabilities"), list):
        capabilities = sorted(detail["capabilities"])

    def _opt(key):
        return detail[key] if detail.get(key) is not None else None

    packages = sorted(
        [{"registry": p.get("registry"), "name": p.get("name"), "version": p.get("version"),
          "downloads": p.get("downloads_last_month")}
         for p in (al.get("packages") or []) if isinstance(p, dict)],
        key=lambda x: (x.get("registry") or "", x.get("name") or ""))

    return {
        "protocol_version": _opt("protocol_version"),
        "auth": _opt("auth"),
        "capabilities": capabilities,
        "tools": tools,
        "resources": sorted(detail["resources"]) if isinstance(detail.get("resources"), list) else None,
        "prompts": sorted(detail["prompts"]) if isinstance(detail.get("prompts"), list) else None,
        "servers": servers,
        "packages": packages,
        "repo": {
            "full_name": gh.get("full_name"),
            "license": gh.get("license"),
            "language": gh.get("language"),
            "archived": bool(gh.get("archived")),
        },
        "health": {
            "reachable": bool(lv.get("reachable")),
            "status_code": lv.get("status_code"),
        },
    }


# --------------------------------------------------------------------------
# diffing
# --------------------------------------------------------------------------
def _comparable(prev: Any, cur: Any) -> bool:
    """False when either side is unknown (None) for a probe-derived group."""
    return not (prev is None or cur is None)


def _list_diff(prev: list, cur: list, key=lambda x: x):
    pk = {key(x): x for x in prev}
    ck = {key(x): x for x in cur}
    added = [ck[k] for k in sorted(set(ck) - set(pk), key=str)]
    removed = [pk[k] for k in sorted(set(pk) - set(ck), key=str)]
    common = [k for k in sorted(set(pk) & set(ck), key=str)]
    return added, removed, common, pk, ck


def diff_snapshots(prev: dict, cur: dict) -> dict:
    """Diff two stored snapshots.

    Each argument is ``{"ts": ..., "data": <fingerprint>}`` (or a bare
    fingerprint, in which case ts is None). Returns a structured, deterministic
    report: added / removed / modified / breaking_changes / summary / timestamps.
    """
    p = prev.get("data", prev) if isinstance(prev, dict) else {}
    c = cur.get("data", cur) if isinstance(cur, dict) else {}
    pts = prev.get("ts") if isinstance(prev, dict) else None
    cts = cur.get("ts") if isinstance(cur, dict) else None

    added: list[dict] = []
    removed: list[dict] = []
    modified: list[dict] = []
    breaking: list[dict] = []
    not_comparable: list[str] = []

    def brk(change_type, severity, message, tool=None, **extra):
        breaking.append({"change_type": change_type, "severity": severity,
                         "breaking": severity in ("high", "medium"),
                         "tool": tool, "message": message, **extra})

    # ---- tools ------------------------------------------------------------
    if not _comparable(p.get("tools"), c.get("tools")):
        not_comparable.append("tools")
    else:
        pt, ct = p["tools"], c["tools"]
        t_add, t_rem, t_common, pk, ck = _list_diff(pt, ct, key=lambda t: t.get("name"))
        for t in t_add:
            added.append({"kind": "tool", "name": t["name"]})
            brk("tool_added", "info", f"New tool `{t['name']}` appeared (additive; existing clients unaffected).", tool=t["name"])
        for t in t_rem:
            removed.append({"kind": "tool", "name": t["name"]})
            brk("tool_removed", "high",
                f"Potential breaking change: tool `{t['name']}` was removed; clients calling it will fail.", tool=t["name"])
        for name in t_common:
            a, b = pk[name], ck[name]
            if a.get("description") != b.get("description"):
                modified.append({"kind": "tool", "name": name, "field": "description",
                                 "from": (a.get("description") or "")[:80], "to": (b.get("description") or "")[:80]})
                brk("tool_description_changed", "low",
                    f"Tool `{name}` description changed (cosmetic for most clients).", tool=name)
            sa, sb = a.get("schema") or {}, b.get("schema") or {}
            pa, pb = sa.get("properties") or {}, sb.get("properties") or {}
            ra, rb = sa.get("required") or [], sb.get("required") or []
            # parameter type changes
            for prop in sorted(set(pa) & set(pb)):
                if pa[prop] != pb[prop]:
                    modified.append({"kind": "tool", "name": name, "field": f"param:{prop}:type",
                                     "from": pa[prop], "to": pb[prop]})
                    brk("param_type_changed", "high",
                        f"Potential breaking change: tool `{name}` parameter `{prop}` changed type {pa[prop]} -> {pb[prop]}.",
                        tool=name, parameter=prop)
            # removed / renamed parameters
            for prop in sorted(set(pa) - set(pb)):
                was_required = prop in ra
                renamed_to = next((q for q in sorted(set(pb) - set(pa)) if pb[q] == pa[prop]), None)
                modified.append({"kind": "tool", "name": name,
                                 "field": f"param:{prop}:removed" if not renamed_to else f"param:{prop}:renamed",
                                 "from": prop, "to": renamed_to or None})
                if renamed_to:
                    brk("required_param_renamed", "high" if was_required else "medium",
                        f"Potential breaking change: tool `{name}` parameter `{prop}` appears renamed to `{renamed_to}`"
                        f"{' (was required)' if was_required else ''}.", tool=name, parameter=prop, renamed_to=renamed_to)
                elif was_required:
                    brk("required_param_removed", "high",
                        f"Potential breaking change: tool `{name}` required parameter `{prop}` was removed.",
                        tool=name, parameter=prop)
                else:
                    brk("optional_param_removed", "low",
                        f"Tool `{name}` optional parameter `{prop}` was removed.", tool=name, parameter=prop)
            # added parameters
            for prop in sorted(set(pb) - set(pa)):
                if prop in [m.get("to") for m in modified if m.get("field", "").endswith(":renamed")]:
                    continue
                is_req = prop in rb
                modified.append({"kind": "tool", "name": name, "field": f"param:{prop}:added",
                                 "from": None, "to": prop})
                if is_req:
                    brk("required_param_added", "high",
                        f"Potential breaking change: tool `{name}` gained a REQUIRED parameter `{prop}`; existing callers omit it.",
                        tool=name, parameter=prop)
                else:
                    brk("optional_param_added", "low",
                        f"Tool `{name}` gained optional parameter `{prop}` (additive).", tool=name, parameter=prop)
            # required-ness flips on surviving params
            for prop in sorted(set(pa) & set(pb)):
                if (prop in ra) != (prop in rb):
                    now_req = prop in rb
                    modified.append({"kind": "tool", "name": name, "field": f"param:{prop}:required",
                                     "from": prop in ra, "to": now_req})
                    brk("required_param_added" if now_req else "required_param_removed",
                        "high" if now_req else "medium",
                        f"Potential breaking change: tool `{name}` parameter `{prop}` became "
                        f"{'required' if now_req else 'optional'}.", tool=name, parameter=prop)

    # ---- resources / prompts ---------------------------------------------
    for group, label in (("resources", "resource"), ("prompts", "prompt")):
        if not _comparable(p.get(group), c.get(group)):
            not_comparable.append(group)
            continue
        a_add, a_rem, _, _, _ = _list_diff(p[group], c[group], key=lambda x: x)
        for x in a_add:
            added.append({"kind": label, "name": x})
            brk(f"{label}_added", "info", f"New {label} `{x}` (additive).")
        for x in a_rem:
            removed.append({"kind": label, "name": x})
            brk(f"{label}_removed", "medium",
                f"Potential breaking change: {label} `{x}` was removed.", tool=x)

    # ---- servers / endpoints / versions ----------------------------------
    s_add, s_rem, s_common, spk, sck = _list_diff(p.get("servers") or [], c.get("servers") or [],
                                                  key=lambda s: s.get("name"))
    for s in s_add:
        added.append({"kind": "server", "name": s.get("name")})
        brk("server_added", "info", f"New registry server `{s.get('name')}` (additive).")
    for s in s_rem:
        removed.append({"kind": "server", "name": s.get("name")})
        brk("server_removed", "medium",
            f"Potential breaking change: registry server `{s.get('name')}` disappeared.", tool=s.get("name"))
    for name in s_common:
        a, b = spk[name], sck[name]
        if (a.get("version") or None) != (b.get("version") or None):
            modified.append({"kind": "server", "name": name, "field": "version",
                             "from": a.get("version"), "to": b.get("version")})
            brk("server_version_changed", "low",
                f"Server `{name}` version {a.get('version')} -> {b.get('version')}.")
        ra_, rb_ = set(a.get("remotes") or []), set(b.get("remotes") or [])
        for u in sorted(ra_ - rb_):
            removed.append({"kind": "endpoint", "name": u})
            brk("endpoint_removed", "high",
                f"Potential breaking change: endpoint `{u}` was removed.", tool=u)
        for u in sorted(rb_ - ra_):
            added.append({"kind": "endpoint", "name": u})
            brk("endpoint_added", "info", f"New endpoint `{u}` (additive).")

    # ---- protocol / auth / capabilities ----------------------------------
    if not _comparable(p.get("protocol_version"), c.get("protocol_version")):
        not_comparable.append("protocol_version")
    elif p["protocol_version"] != c["protocol_version"]:
        modified.append({"kind": "protocol", "name": "protocolVersion",
                         "from": p["protocol_version"], "to": c["protocol_version"]})
        brk("protocol_changed", "medium",
            f"Potential breaking change: MCP protocol version {p['protocol_version']} -> {c['protocol_version']}.")

    if not _comparable(p.get("auth"), c.get("auth")):
        not_comparable.append("auth")
    elif p["auth"] != c["auth"]:
        pa_, pb_ = p["auth"], c["auth"]
        modified.append({"kind": "auth", "name": "auth", "from": pa_, "to": pb_})
        open_to_auth = pa_ in (None, "none", "open") and pb_ not in (None, "none", "open")
        auth_to_open = pb_ in (None, "none", "open") and pa_ not in (None, "none", "open")
        sev = "high" if open_to_auth else ("medium" if auth_to_open else "high")
        brk("auth_changed", sev,
            f"Potential breaking change: authentication changed {pa_} -> {pb_}."
            + (" Clients without credentials will start failing." if open_to_auth else ""),)

    if not _comparable(p.get("capabilities"), c.get("capabilities")):
        not_comparable.append("capabilities")
    else:
        ca, cb = set(p["capabilities"]), set(c["capabilities"])
        for cap in sorted(ca - cb):
            removed.append({"kind": "capability", "name": cap})
            brk("capability_removed", "medium",
                f"Potential breaking change: capability `{cap}` no longer advertised.")
        for cap in sorted(cb - ca):
            added.append({"kind": "capability", "name": cap})
            brk("capability_added", "info", f"Capability `{cap}` now advertised (additive).")

    # ---- repo / packages / health ----------------------------------------
    pra, prb = p.get("repo") or {}, c.get("repo") or {}
    for field in ("full_name", "license", "language", "archived"):
        if pra.get(field) != prb.get(field):
            modified.append({"kind": "repo", "name": field, "from": pra.get(field), "to": prb.get(field)})
            if field == "archived" and prb.get(field):
                brk("repo_archived", "medium", "Potential breaking change: repository was archived.")
            elif field == "full_name":
                brk("repo_moved", "medium",
                    f"Potential breaking change: repository moved {pra.get(field)} -> {prb.get(field)}.")
    pk_add, pk_rem, _, _, _ = _list_diff(p.get("packages") or [], c.get("packages") or [],
                                         key=lambda x: (x.get("registry"), x.get("name")))
    for x in pk_add:
        added.append({"kind": "package", "name": f"{x.get('registry')}:{x.get('name')}"})
    for x in pk_rem:
        removed.append({"kind": "package", "name": f"{x.get('registry')}:{x.get('name')}"})
        brk("package_removed", "medium",
            f"Potential breaking change: package {x.get('registry')}:{x.get('name')} unpublished.")

    ha, hb = p.get("health") or {}, c.get("health") or {}
    if ha.get("reachable") is not None and hb.get("reachable") is not None and ha.get("reachable") != hb.get("reachable"):
        modified.append({"kind": "health", "name": "reachable",
                         "from": ha.get("reachable"), "to": hb.get("reachable")})
        if hb.get("reachable") is False:
            brk("health_changed", "high",
                "Potential breaking change: site/endpoint went from reachable to UNREACHABLE.")
        else:
            brk("health_changed", "info", "Health recovered: unreachable -> reachable.")
    elif ha.get("status_code") != hb.get("status_code") and hb.get("status_code") is not None:
        modified.append({"kind": "health", "name": "status_code",
                         "from": ha.get("status_code"), "to": hb.get("status_code")})
        brk("health_changed", "low",
            f"HTTP status changed {ha.get('status_code')} -> {hb.get('status_code')}.")

    changed = bool(added or removed or modified)
    sev_order = {"high": 0, "medium": 1, "low": 2, "info": 3}
    breaking.sort(key=lambda b: (sev_order.get(b["severity"], 9), b["change_type"], str(b.get("tool"))))
    return {
        "added": added,
        "removed": removed,
        "modified": modified,
        "breaking_changes": breaking,
        "not_comparable": not_comparable,
        "summary": {
            "changed": changed,
            "added": len(added),
            "removed": len(removed),
            "modified": len(modified),
            "breaking": sum(1 for b in breaking if b["breaking"]),
            "notes": sum(1 for b in breaking if not b["breaking"]),
        },
        "timestamps": {"from": pts, "to": cts},
    }
