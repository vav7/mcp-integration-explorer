#!/usr/bin/env python3
"""Offline, deterministic tests for src/diffing.py (historical diff + breaking
change detection). Pure functions over plain dicts - no network, no store.

Covers the required matrix: added tool, removed tool, modified schema,
renamed/removed required parameter, authentication change, protocol change,
unchanged snapshots, and reordered tools producing NO false change.

Run: python3 tests/test_diffing.py
"""
from __future__ import annotations

import copy
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src import diffing  # noqa: E402

PASS = 0
FAIL = 0


def check(label, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  ok   " + label)
    else:
        FAIL += 1
        print("  FAIL " + label + (("  | " + str(extra)) if extra else ""))


def tool(name, desc="d", props=None, required=None):
    return {"name": name, "description": desc,
            "schema": {"properties": {k: v for k, v in (props or {}).items()},
                       "required": sorted(required or [])}}


def fp(tools=None, protocol="2025-06-18", auth="none", caps=None, resources=None,
       prompts=None, servers=None, health=None):
    return {
        "protocol_version": protocol,
        "auth": auth,
        "capabilities": sorted(caps) if caps is not None else None,
        "tools": tools,
        "resources": resources,
        "prompts": prompts,
        "servers": servers if servers is not None else [],
        "packages": [],
        "repo": {"full_name": "o/r", "license": "MIT", "language": "TS", "archived": False},
        "health": health if health is not None else {"reachable": True, "status_code": 200},
    }


def snap(data, ts):
    return {"ts": ts, "data": data}


def brk(d, ctype):
    return [b for b in d["breaking_changes"] if b["change_type"] == ctype]


A = tool("create_customer", "create", {"name": "string"})
B = tool("delete_customer", "delete", {"id": "string"}, ["id"])
U = tool("update_customer", "update", {"id": "string", "note": "string"}, ["id"])

print("added tool")
d = diffing.diff_snapshots(snap(fp(tools=[A]), "t0"), snap(fp(tools=[A, B]), "t1"))
check("reported under added", any(x["kind"] == "tool" and x["name"] == "delete_customer" for x in d["added"]))
check("flagged as INFO (additive, not breaking)", brk(d, "tool_added") and brk(d, "tool_added")[0]["severity"] == "info"
      and brk(d, "tool_added")[0]["breaking"] is False)
check("summary counts it", d["summary"]["added"] == 1 and d["summary"]["changed"] is True)

print("removed tool")
d = diffing.diff_snapshots(snap(fp(tools=[A, B]), "t0"), snap(fp(tools=[A]), "t1"))
check("reported under removed", any(x["kind"] == "tool" and x["name"] == "delete_customer" for x in d["removed"]))
b = brk(d, "tool_removed")
check("HIGH + breaking + names the tool", b and b[0]["severity"] == "high" and b[0]["breaking"] is True
      and b[0]["tool"] == "delete_customer")
check("worded as potential, not certain", "Potential breaking change" in b[0]["message"])

print("modified schema")
prev = fp(tools=[tool("update_customer", "u", {"id": "string", "n": "string"}, ["id"])])
cur = fp(tools=[tool("update_customer", "u", {"id": "integer", "n": "string"}, ["id"])])
d = diffing.diff_snapshots(snap(prev, "t0"), snap(cur, "t1"))
check("type change appears under modified", any(m["field"] == "param:id:type" for m in d["modified"]))
check("type change is HIGH breaking", brk(d, "param_type_changed") and brk(d, "param_type_changed")[0]["severity"] == "high")
# optional param added = LOW, not breaking
cur2 = fp(tools=[tool("update_customer", "u", {"id": "string", "n": "string", "extra": "string"}, ["id"])])
d2 = diffing.diff_snapshots(snap(prev, "t0"), snap(cur2, "t1"))
check("new optional param is LOW and not breaking",
      brk(d2, "optional_param_added") and brk(d2, "optional_param_added")[0]["breaking"] is False)
check("optional add does NOT raise required_param_added", brk(d2, "required_param_added") == [])
cur3 = fp(tools=[tool("update_customer", "u", {"id": "string", "n": "string", "must": "string"}, ["id", "must"])])
d3 = diffing.diff_snapshots(snap(prev, "t0"), snap(cur3, "t1"))
check("required param added -> HIGH", brk(d3, "required_param_added") and brk(d3, "required_param_added")[0]["severity"] == "high")

print("renamed / removed required parameter")
prevr = fp(tools=[tool("t", "d", {"customer_id": "string"}, ["customer_id"])])
currn = fp(tools=[tool("t", "d", {"clientId": "string"}, ["clientId"])])
d = diffing.diff_snapshots(snap(prevr, "t0"), snap(currn, "t1"))
check("same-type swap detected as rename", brk(d, "required_param_renamed")
      and brk(d, "required_param_renamed")[0]["renamed_to"] == "clientId")
check("rename of a required param is HIGH", brk(d, "required_param_renamed")[0]["severity"] == "high")
currm = fp(tools=[tool("t", "d", {}, [])])
d = diffing.diff_snapshots(snap(prevr, "t0"), snap(currm, "t1"))
check("required param simply removed -> required_param_removed HIGH",
      brk(d, "required_param_removed") and brk(d, "required_param_removed")[0]["severity"] == "high")

print("authentication change")
d = diffing.diff_snapshots(snap(fp(auth="none"), "t0"), snap(fp(auth="auth_required"), "t1"))
b = brk(d, "auth_changed")
check("open -> auth is HIGH breaking", b and b[0]["severity"] == "high" and b[0]["breaking"] is True)
check("modified list carries auth from/to", any(m["kind"] == "auth" and m["from"] == "none" and m["to"] == "auth_required" for m in d["modified"]))
d = diffing.diff_snapshots(snap(fp(auth="auth_required"), "t0"), snap(fp(auth="none"), "t1"))
check("auth -> open is MEDIUM", brk(d, "auth_changed") and brk(d, "auth_changed")[0]["severity"] == "medium")

print("protocol change")
d = diffing.diff_snapshots(snap(fp(protocol="2025-03-26"), "t0"), snap(fp(protocol="2025-06-18"), "t1"))
b = brk(d, "protocol_changed")
check("protocol change is MEDIUM breaking with both versions", b and b[0]["severity"] == "medium"
      and any(m["kind"] == "protocol" for m in d["modified"]))

print("unchanged snapshots")
base = fp(tools=[A, B, U], caps=["tools", "resources"], resources=["r1"], prompts=["p1"])
d = diffing.diff_snapshots(snap(base, "t0"), snap(copy.deepcopy(base), "t1"))
check("no added/removed/modified", not d["added"] and not d["removed"] and not d["modified"])
check("not marked changed, zero breaking", d["summary"]["changed"] is False and d["summary"]["breaking"] == 0)
check("timestamps echoed", d["timestamps"] == {"from": "t0", "to": "t1"})

print("reordered tools produce no false change")
one = [A, B, U]
two = [U, A, B]
d = diffing.diff_snapshots(snap(fp(tools=one), "t0"), snap(fp(tools=two), "t1"))
check("tool-order shuffle -> unchanged", d["summary"]["changed"] is False, d["summary"])
# and via normalize_integration (property order + server order shuffled too)
def _norm(tools, servers):
    return diffing.normalize_integration({
        "mcp": {"servers": servers}, "mcp_detail": {"tools": tools, "capabilities": {"tools": {}},
                                                    "protocol_version": "2025-06-18", "auth": "none",
                                                    "resources": ["b", "a"], "prompts": []},
        "github": {"full_name": "o/r", "license": "MIT", "language": "TS", "archived": False},
        "packages": [], "liveness": {"reachable": True, "status_code": 200},
    })
srv = [{"name": "com.x/mcp", "version": "1", "classification": "vendor_official",
        "remote_urls": ["https://b", "https://a"], "packages": ["p2", "p1"]}]
n1 = _norm(one, srv)
n2 = _norm(two, srv)
check("normalize is order-insensitive (identical hash)", diffing.fingerprint_hash(n1) == diffing.fingerprint_hash(n2))
check("normalize sorts remotes/packages/resources", n1["servers"][0]["remotes"] == ["https://a", "https://b"]
      and n1["servers"][0]["packages"] == ["p1", "p2"] and n1["resources"] == ["a", "b"])

print("unknown side is not a false change")
d = diffing.diff_snapshots(snap(fp(tools=None), "t0"), snap(fp(tools=[A]), "t1"))
check("tools marked not comparable, nothing 'added'", "tools" in d["not_comparable"] and not d["added"])
check("summary says unchanged", d["summary"]["changed"] is False)

print("health + endpoint + determinism")
d = diffing.diff_snapshots(snap(fp(health={"reachable": True, "status_code": 200}), "t0"),
                           snap(fp(health={"reachable": False, "status_code": None}), "t1"))
check("reachable->unreachable is HIGH breaking", brk(d, "health_changed") and brk(d, "health_changed")[0]["severity"] == "high")
d = diffing.diff_snapshots(snap(fp(servers=[{"name": "s", "version": "1", "remotes": ["https://a"], "packages": []}]), "t0"),
                           snap(fp(servers=[{"name": "s", "version": "1", "remotes": [], "packages": []}]), "t1"))
check("endpoint removed is HIGH breaking", brk(d, "endpoint_removed") and brk(d, "endpoint_removed")[0]["severity"] == "high")
base_a = fp(tools=[A, B]); base_b = fp(tools=[A])
r1 = diffing.diff_snapshots(snap(base_a, "t0"), snap(base_b, "t1"))
r2 = diffing.diff_snapshots(snap(base_a, "t0"), snap(base_b, "t1"))
check("diff is deterministic (byte-identical repeats)", json.dumps(r1, sort_keys=True) == json.dumps(r2, sort_keys=True))
check("breaking list ordered by severity", [b["severity"] for b in r1["breaking_changes"]] ==
      sorted([b["severity"] for b in r1["breaking_changes"]], key={"high": 0, "medium": 1, "low": 2, "info": 3}.get))

print()
print("All %d checks passed." % PASS if not FAIL else "%d of %d checks FAILED." % (FAIL, PASS + FAIL))
sys.exit(1 if FAIL else 0)
