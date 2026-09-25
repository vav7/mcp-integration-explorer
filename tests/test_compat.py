#!/usr/bin/env python3
"""Offline tests for the MCP Compatibility Tester (src/compat.py).

Each scenario is a tiny in-process ASGI stub served through httpx.ASGITransport,
so nothing touches the network and no sockets are opened. Covers:

  success · timeout · authentication failure · malformed body · invalid JSON-RPC
  · 404 · 429 · 5xx · SSRF refusal · report arithmetic · modularity of CHECKS

Run: python3 tests/test_compat.py
"""
from __future__ import annotations

import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import httpx  # noqa: E402

from src import compat, config  # noqa: E402

URL = "https://compat.test/mcp"
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


def by_name(report, name):
    for c in report.checks:
        if c.name == name:
            return c
    return None


# --------------------------------------------------------------------------
# ASGI stubs
# --------------------------------------------------------------------------
TOOLS = [
    {"name": "search", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "fetch", "inputSchema": {"type": "object", "properties": {"url": {"type": "string"}}}},
]
BAD_TOOLS = [
    {"name": "ok", "inputSchema": {"type": "object"}},
    {"inputSchema": {"type": "object"}},                      # missing name
    {"name": "noschema"},                                     # missing inputSchema
]


def _rpc(result=None, error=None, msg_id=1):
    body = {"jsonrpc": "2.0", "id": msg_id}
    if error is not None:
        body["error"] = error
    else:
        body["result"] = result
    return body


async def _read_body(receive):
    chunks = []
    while True:
        m = await receive()
        chunks.append(m.get("body", b""))
        if not m.get("more_body"):
            break
    return b"".join(chunks)


async def _send_json(send, payload, status=200, headers=None):
    body = json.dumps(payload).encode()
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json")] +
                           ([(k.encode(), v.encode()) for k, v in (headers or {}).items()])})
    await send({"type": "http.response.body", "body": body})


def make_app(mode):
    async def app(scope, receive, send):
        raw = await _read_body(receive)
        try:
            req = json.loads(raw or b"{}")
        except Exception:
            req = {}
        method = req.get("method", "")
        mid = req.get("id", 1)

        if mode == "timeout":
            await asyncio.sleep(3.0)
            return await _send_json(send, _rpc({}))

        if mode == "auth":
            return await _send_json(send, {"error": "unauthorized"}, status=401,
                                    headers={"www-authenticate": 'Bearer realm="mcp"'})
        if mode == "malformed":
            await send({"type": "http.response.start", "status": 200,
                        "headers": [(b"content-type", b"text/plain")]})
            return await send({"type": "http.response.body", "body": b"this is not json at all"})
        if mode == "invalidrpc":
            return await _send_json(send, {"hello": "world", "jsonrpc": "1.0"})
        if mode == "notfound":
            return await _send_json(send, {"detail": "no such route"}, status=404)
        if mode == "ratelimit":
            return await _send_json(send, {"detail": "slow down"}, status=429)
        if mode == "servererr":
            return await _send_json(send, {"detail": "boom"}, status=500)

        # mode == "success"
        if method == "initialize":
            return await _send_json(send, _rpc({
                "protocolVersion": "2025-06-18",
                "capabilities": {"tools": {"listChanged": True}, "resources": {}, "prompts": {}},
                "serverInfo": {"name": "stub-mcp", "version": "1.0"},
            }, msg_id=mid))
        if method == "tools/list":
            tools = BAD_TOOLS if mode == "badschema" else TOOLS
            return await _send_json(send, _rpc({"tools": tools}, msg_id=mid))
        if method == "resources/list":
            return await _send_json(send, _rpc({"resources": []}, msg_id=mid))
        if method == "prompts/list":
            return await _send_json(send, _rpc({"prompts": []}, msg_id=mid))
        return await _send_json(send, _rpc(error={"code": -32601, "message": "Method not found"}, msg_id=mid))
    return app


async def run(mode):
    transport = httpx.ASGITransport(app=make_app(mode))
    async with httpx.AsyncClient(transport=transport) as client:
        return await compat.run_compatibility_test(client, URL)


def main():
    # ------------------------------------------------------------- success
    print("success: a well-behaved MCP server")
    r = asyncio.run(run("success"))
    check("12 checks returned", len(r.checks) == 12, len(r.checks))
    check("reachable/tls/handshake/protocol/capabilities pass",
          all(by_name(r, n).status == "pass" for n in
              ["Endpoint reachable", "HTTPS / TLS", "MCP initialization", "Protocol version", "Server capabilities"]))
    check("tools/resources/prompts pass", all(by_name(r, n).status == "pass" for n in
          ["Tools discovery", "Resources listing", "Prompts listing"]))
    check("schema + jsonrpc + error-handling + auth pass", all(by_name(r, n).status == "pass" for n in
          ["Tool schema validation", "JSON-RPC response validation", "Error-response handling", "Authentication"]))
    check("100% compatible, nothing skipped", r.compatibility_pct == 100 and r.skipped == 0, (r.compatibility_pct, r.skipped))
    check("every check carries a latency where it made a request",
          by_name(r, "Endpoint reachable").latency_ms is not None)
    check("error-handling saw a proper -32601", by_name(r, "Error-response handling").details.get("error_code") == -32601)

    # ------------------------------------------------------------- bad schemas
    print("bad tool schemas")
    r = asyncio.run(run("badschema"))
    c = by_name(r, "Tool schema validation")
    check("invalid schemas reported as fail with the offenders named",
          c.status == "fail" and len(c.details.get("invalid", [])) == 2, c.details)
    check("compatibility pct drops below 100", r.compatibility_pct < 100, r.compatibility_pct)

    # ------------------------------------------------------------- timeout
    # httpx.ASGITransport awaits the app in-process and ignores client timeouts,
    # so the timeout path needs a real (loopback) socket that never answers.
    print("timeout")
    async def _timeout_run():
        async def handle(reader, writer):
            try:
                await reader.read(65536)
                await asyncio.sleep(6)
            except Exception:
                pass
            finally:
                writer.close()
        server = await asyncio.start_server(handle, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        old = config.PROBE_TIMEOUT
        config.PROBE_TIMEOUT = 0.5
        try:
            async with httpx.AsyncClient() as client:
                return await compat.run_compatibility_test(client, f"http://127.0.0.1:{port}/mcp")
        finally:
            config.PROBE_TIMEOUT = old
            server.close()
            await server.wait_closed()
    r = asyncio.run(_timeout_run())
    check("reachable fails on timeout", by_name(r, "Endpoint reachable").status == "fail",
          by_name(r, "Endpoint reachable").status)
    check("plain http is a TLS warning", by_name(r, "HTTPS / TLS").status == "warning")
    check("handshake fails on timeout", by_name(r, "MCP initialization").status == "fail")
    check("dependent checks skip rather than lie", by_name(r, "Tools discovery").status == "skip")
    check("nothing passes on a dead endpoint", r.passed == 0 and r.compatibility_pct < 30,
          (r.passed, r.compatibility_pct))

    # ------------------------------------------------------------- auth
    print("authentication required")
    r = asyncio.run(run("auth"))
    check("auth reported as warning with the scheme", by_name(r, "Authentication").status == "warning"
          and "Bearer" in by_name(r, "Authentication").details.get("www_authenticate", ""))
    check("handshake is a warning, not a pass", by_name(r, "MCP initialization").status == "warning")
    check("reachable still passes (server answered)", by_name(r, "Endpoint reachable").status == "pass")
    check("list checks skip behind auth", by_name(r, "Tools discovery").status == "skip")
    check("pct is partial, not zero", 0 < r.compatibility_pct < 100, r.compatibility_pct)

    # ------------------------------------------------------------- malformed
    print("malformed body")
    r = asyncio.run(run("malformed"))
    check("handshake fails on non-JSON body", by_name(r, "MCP initialization").status == "fail")
    check("JSON-RPC validation fails", by_name(r, "JSON-RPC response validation").status == "fail")

    # ------------------------------------------------------------- invalid rpc
    print("invalid JSON-RPC")
    r = asyncio.run(run("invalidrpc"))
    check("handshake fails (no result object)", by_name(r, "MCP initialization").status == "fail")
    check("JSON-RPC validation flags jsonrpc != 2.0", by_name(r, "JSON-RPC response validation").status == "fail")

    # ------------------------------------------------------------- http errors
    print("HTTP error classes")
    r = asyncio.run(run("notfound"))
    check("404 -> handshake fail, reachable pass", by_name(r, "MCP initialization").status == "fail"
          and by_name(r, "Endpoint reachable").status == "pass")
    r = asyncio.run(run("ratelimit"))
    check("429 -> handshake warning (rate limited)", by_name(r, "MCP initialization").status == "warning")
    r = asyncio.run(run("servererr"))
    check("5xx -> handshake fail", by_name(r, "MCP initialization").status == "fail")

    # ------------------------------------------------------------- ssrf + api
    print("guards & report shape")
    r = asyncio.run(compat.test_url("http://127.0.0.1:9/mcp"))
    check("private address refused without dialling", r.error and "not public" in r.error and r.failed == 1)
    r = asyncio.run(run("success"))
    d = r.model_dump(mode="json")
    check("report serialises with the documented fields",
          all(k in d for k in ["url", "tested_at", "checks", "total", "passed", "failed",
                               "warnings", "skipped", "compatibility_pct"])
          and all(set(c) >= {"name", "status", "message", "latency_ms", "details"} for c in d["checks"]))
    check("CHECKS registry is the extension point (12 entries)", len(compat.CHECKS) == 12)
    check("no credential fields anywhere in the report",
          "authorization" not in json.dumps(d).lower() and "cookie" not in json.dumps(d).lower())

    print()
    print("All %d checks passed." % PASS if not FAIL else "%d of %d checks FAILED." % (FAIL, PASS + FAIL))
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
