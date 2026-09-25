"""MCP Compatibility Tester - a reusable, modular behavioural test service.

Given any MCP streamable-http endpoint URL, run a bounded set of independent
checks and return a CompatibilityReport. This is explicitly a *compatibility
test* from this explorer's point of view - NOT an official MCP certification.

Design notes
------------
* Reuses the existing wire primitives from :mod:`src.fetchers`
  (``mcp_headers``, ``jsonrpc_payload``, ``initialize_payload``,
  ``_parse_sse_or_json``) and the SSRF guard ``url_is_public`` - no second
  HTTP/MCP implementation lives here.
* Modular: each check is a small ``async def check_<x>(ctx) -> CompatCheck``
  registered in :data:`CHECKS`. Adding a test later = add a function + a row.
* Bounded: one initialize request, then tools/resources/prompts/error probes run
  concurrently under ``config.COMPAT_CONCURRENCY``, each with
  ``config.PROBE_TIMEOUT``; the whole run is capped by
  ``config.COMPAT_TOTAL_TIMEOUT``.
* Honest: timeouts, 401/403, 404, 429, 5xx, malformed JSON and invalid JSON-RPC
  are all reported as distinct outcomes; dependent checks are marked ``skip``
  rather than fabricating a failure.
* Never sends or echoes credentials.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Optional

import httpx

from . import config
from .fetchers import (
    _parse_sse_or_json,
    initialize_payload,
    jsonrpc_payload,
    mcp_headers,
    url_is_public,
)
from .models import CompatCheck, CompatReport
from .store import utc_now

_AUTH_CODES = (401, 403)
_OPTIONAL_LIST_METHODS = ("resources", "prompts")


# --------------------------------------------------------------------------
# transport
# --------------------------------------------------------------------------
@dataclass
class _Resp:
    status: Optional[int]
    body: Optional[dict]
    raw: str
    err: Optional[str]          # "timeout" | "connect:..." | "error:..." | None
    latency_ms: int
    headers: dict = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.status is not None and 200 <= self.status < 300

    @property
    def result(self) -> dict:
        if isinstance(self.body, dict) and isinstance(self.body.get("result"), dict):
            return self.body["result"]
        return {}

    @property
    def rpc_error(self) -> dict:
        if isinstance(self.body, dict) and isinstance(self.body.get("error"), dict):
            return self.body["error"]
        return {}


class _Session:
    """One endpoint, one MCP session id, every response recorded for the
    JSON-RPC validation check."""

    def __init__(self, client: httpx.AsyncClient, url: str, sink: list[_Resp]):
        self.client = client
        self.url = url
        self.session_id: Optional[str] = None
        self._sink = sink

    async def post(self, payload: dict, *, record: bool = True,
                   timeout: Optional[float] = None) -> _Resp:
        t0 = time.monotonic()
        try:
            r = await self.client.post(
                self.url, json=payload, headers=mcp_headers(self.session_id),
                timeout=timeout or config.PROBE_TIMEOUT)
        except httpx.TimeoutException:
            return _Resp(None, None, "", "timeout", int((time.monotonic() - t0) * 1000))
        except httpx.HTTPError as exc:
            return _Resp(None, None, "", f"connect:{type(exc).__name__}",
                         int((time.monotonic() - t0) * 1000))
        except Exception as exc:  # pragma: no cover - defensive
            return _Resp(None, None, "", f"error:{type(exc).__name__}",
                         int((time.monotonic() - t0) * 1000))
        lat = int((time.monotonic() - t0) * 1000)
        sid = r.headers.get("mcp-session-id") or r.headers.get("Mcp-Session-Id")
        if sid and not self.session_id:
            self.session_id = sid
        resp = _Resp(r.status_code, _parse_sse_or_json(r.text), r.text, None, lat, dict(r.headers))
        if record:
            self._sink.append(resp)
        return resp


class _Ctx:
    def __init__(self, client: httpx.AsyncClient, url: str):
        self.url = url
        self.responses: list[_Resp] = []
        self.session = _Session(client, url, self.responses)
        self.sem = asyncio.Semaphore(config.COMPAT_CONCURRENCY)
        self.init: Optional[_Resp] = None
        self.tools: Optional[_Resp] = None
        self.resources: Optional[_Resp] = None
        self.prompts: Optional[_Resp] = None
        self.errtest: Optional[_Resp] = None
        self.checks: list[CompatCheck] = []

    def add(self, name, status, message, latency=None, **details):
        self.checks.append(CompatCheck(name=name, status=status, message=message,
                                       latency_ms=latency, details=details or {}))

    @property
    def auth_blocked(self) -> bool:
        return self.init is not None and self.init.status in _AUTH_CODES

    @property
    def handshake_ok(self) -> bool:
        return self.init is not None and self.init.ok and bool(self.init.result)

    def capabilities(self) -> dict:
        caps = self.init.result.get("capabilities") if self.init else None
        return caps if isinstance(caps, dict) else {}


def _skip(ctx: _Ctx, name: str, reason: str):
    ctx.add(name, "skip", reason)


# --------------------------------------------------------------------------
# the checks (registry order = report order)
# --------------------------------------------------------------------------
async def check_reachable(ctx: _Ctx) -> None:
    r = ctx.init
    if r is None:
        ctx.add("Endpoint reachable", "fail", "no request was attempted")
    elif r.status is not None:
        ctx.add("Endpoint reachable", "pass",
                f"server answered HTTP {r.status}", r.latency_ms, http_status=r.status)
    elif r.err == "timeout":
        ctx.add("Endpoint reachable", "fail",
                f"no response within {config.PROBE_TIMEOUT:.0f}s", r.latency_ms)
    else:
        ctx.add("Endpoint reachable", "fail",
                f"connection failed ({r.err})", r.latency_ms, error=r.err)


async def check_tls(ctx: _Ctx) -> None:
    scheme = (ctx.url.split("://", 1)[0] or "").lower()
    r = ctx.init
    if scheme != "https":
        ctx.add("HTTPS / TLS", "warning",
                "endpoint is not HTTPS; traffic and any credentials would be unencrypted",
                r.latency_ms if r else None, scheme=scheme)
    elif r is not None and r.status is not None:
        ctx.add("HTTPS / TLS", "pass", "TLS handshake succeeded", r.latency_ms, scheme="https")
    elif r is not None and r.err and ("ssl" in r.err.lower() or "cert" in r.err.lower()):
        ctx.add("HTTPS / TLS", "fail", f"TLS/certificate error: {r.err}", r.latency_ms)
    elif r is not None and r.err:
        ctx.add("HTTPS / TLS", "warning",
                f"could not verify TLS because the connection failed ({r.err})", r.latency_ms)
    else:
        _skip(ctx, "HTTPS / TLS", "not evaluated")


async def check_handshake(ctx: _Ctx) -> None:
    r = ctx.init
    if r is None:
        ctx.add("MCP initialization", "fail", "no initialize request attempted")
    elif r.status in _AUTH_CODES:
        ctx.add("MCP initialization", "warning",
                f"server demanded credentials (HTTP {r.status}) before the handshake",
                r.latency_ms, http_status=r.status)
    elif r.status == 402:
        ctx.add("MCP initialization", "warning", "server demands payment (HTTP 402)", r.latency_ms)
    elif r.status == 404:
        ctx.add("MCP initialization", "fail", "HTTP 404: this URL is not an MCP route", r.latency_ms)
    elif r.status == 429:
        ctx.add("MCP initialization", "warning", "rate limited (HTTP 429); try again later", r.latency_ms)
    elif r.status is not None and r.status >= 500:
        ctx.add("MCP initialization", "fail", f"server error HTTP {r.status}", r.latency_ms)
    elif r.err == "timeout":
        ctx.add("MCP initialization", "fail", "initialize timed out", r.latency_ms)
    elif r.err:
        ctx.add("MCP initialization", "fail", f"initialize failed ({r.err})", r.latency_ms)
    elif not r.ok:
        ctx.add("MCP initialization", "fail", f"unexpected HTTP {r.status}", r.latency_ms)
    elif not r.result:
        ctx.add("MCP initialization", "fail",
                "HTTP 200 but the body is not a JSON-RPC result (malformed or non-MCP response)",
                r.latency_ms)
    else:
        info = r.result.get("serverInfo") or {}
        ctx.add("MCP initialization", "pass",
                f"handshake completed{(' with ' + info.get('name', '')) if isinstance(info, dict) and info.get('name') else ''}",
                r.latency_ms, server_info=info)


async def check_protocol(ctx: _Ctx) -> None:
    if not ctx.handshake_ok:
        return _skip(ctx, "Protocol version", "skipped: initialization did not complete")
    ver = ctx.init.result.get("protocolVersion")
    if not ver:
        ctx.add("Protocol version", "fail", "initialize result carries no protocolVersion",
                ctx.init.latency_ms)
    elif ver in config.SUPPORTED_MCP_PROTOCOL_VERSIONS:
        ctx.add("Protocol version", "pass", f"server speaks {ver}", ctx.init.latency_ms,
                protocol_version=ver, supported=config.SUPPORTED_MCP_PROTOCOL_VERSIONS)
    else:
        ctx.add("Protocol version", "warning",
                f"server speaks {ver}, which this tester does not recognise", ctx.init.latency_ms,
                protocol_version=ver)


async def check_capabilities(ctx: _Ctx) -> None:
    if not ctx.handshake_ok:
        return _skip(ctx, "Server capabilities", "skipped: initialization did not complete")
    caps = ctx.capabilities()
    if not caps:
        ctx.add("Server capabilities", "warning", "server advertised an empty capabilities object",
                ctx.init.latency_ms)
    else:
        ctx.add("Server capabilities", "pass",
                "advertises: " + ", ".join(sorted(caps.keys())), ctx.init.latency_ms,
                capabilities=sorted(caps.keys()))


async def check_auth(ctx: _Ctx) -> None:
    r = ctx.init
    if r is None or r.status is None:
        return _skip(ctx, "Authentication", "skipped: endpoint did not answer")
    if r.status in _AUTH_CODES:
        www = r.headers.get("www-authenticate", "")
        ctx.add("Authentication", "warning",
                f"credentials required (HTTP {r.status}); compatible but not testable anonymously",
                r.latency_ms, http_status=r.status, www_authenticate=www[:120])
    elif r.status == 402:
        ctx.add("Authentication", "warning", "payment required (HTTP 402)", r.latency_ms)
    elif r.ok:
        ctx.add("Authentication", "pass", "open endpoint: no credentials requested", r.latency_ms)
    else:
        ctx.add("Authentication", "skip", f"not determinable from HTTP {r.status}", r.latency_ms)


def _list_check(ctx: _Ctx, r: Optional[_Resp], feature: str, name: str, core: bool) -> None:
    """Shared logic for tools/list, resources/list, prompts/list."""
    if r is None:
        return _skip(ctx, name, "skipped: not attempted")
    if r.status in _AUTH_CODES:
        ctx.add(name, "warning", f"behind authentication (HTTP {r.status})", r.latency_ms)
    elif r.status == 429:
        ctx.add(name, "warning", "rate limited (HTTP 429)", r.latency_ms)
    elif r.status is not None and r.status >= 400:
        ctx.add(name, "fail" if core else "warning",
                f"HTTP {r.status} listing {feature}", r.latency_ms)
    elif r.err:
        ctx.add(name, "fail" if core else "warning", f"{feature}/list failed ({r.err})", r.latency_ms)
    elif r.rpc_error:
        code = r.rpc_error.get("code")
        if code == -32601 and not core:
            ctx.add(name, "skip", f"server reports {feature} unsupported (method not found)", r.latency_ms)
        else:
            ctx.add(name, "fail" if core else "warning",
                    f"JSON-RPC error {code}: {str(r.rpc_error.get('message'))[:80]}", r.latency_ms)
    elif isinstance(r.result.get(feature), list):
        ctx.add(name, "pass", f"{len(r.result[feature])} {feature} listed", r.latency_ms,
                count=len(r.result[feature]))
    else:
        ctx.add(name, "fail" if core else "warning",
                f"200 OK but no {feature} array in the result", r.latency_ms)


async def check_tools(ctx: _Ctx) -> None:
    _list_check(ctx, ctx.tools, "tools", "Tools discovery", core=True)


async def check_resources(ctx: _Ctx) -> None:
    _list_check(ctx, ctx.resources, "resources", "Resources listing", core=False)


async def check_prompts(ctx: _Ctx) -> None:
    _list_check(ctx, ctx.prompts, "prompts", "Prompts listing", core=False)


async def check_tool_schemas(ctx: _Ctx) -> None:
    r = ctx.tools
    if r is None or not isinstance(r.result.get("tools"), list):
        return _skip(ctx, "Tool schema validation", "skipped: no tool list available")
    tools = r.result["tools"]
    if not tools:
        ctx.add("Tool schema validation", "warning", "server exposes zero tools", r.latency_ms)
        return
    bad = []
    for t in tools:
        if not isinstance(t, dict):
            bad.append("<not an object>")
            continue
        schema = t.get("inputSchema")
        if not isinstance(t.get("name"), str) or not t["name"].strip():
            bad.append(str(t.get("name", "<unnamed>"))[:40])
        elif not isinstance(schema, dict) or schema.get("type") != "object":
            bad.append(t["name"][:40])
    if bad:
        ctx.add("Tool schema validation", "fail",
                f"{len(bad)} of {len(tools)} tools have an invalid name/inputSchema", r.latency_ms,
                invalid=bad[:8])
    else:
        ctx.add("Tool schema validation", "pass",
                f"all {len(tools)} tools carry a name and an object inputSchema", r.latency_ms,
                validated=len(tools))


async def check_jsonrpc(ctx: _Ctx) -> None:
    answered = [r for r in ctx.responses if r.status is not None and r.status < 400]
    if not answered:
        return _skip(ctx, "JSON-RPC response validation", "skipped: no parsable 2xx responses")
    bad = []
    for i, r in enumerate(answered):
        b = r.body
        if not isinstance(b, dict):
            bad.append(f"resp{i}: not a JSON object")
        elif b.get("jsonrpc") != "2.0":
            bad.append(f"resp{i}: jsonrpc != 2.0")
        elif not ("result" in b or "error" in b):
            bad.append(f"resp{i}: neither result nor error")
        elif "id" not in b:
            bad.append(f"resp{i}: missing id")
    if bad:
        ctx.add("JSON-RPC response validation", "fail",
                f"{len(bad)} of {len(answered)} responses violate JSON-RPC 2.0", None, issues=bad[:6])
    else:
        ctx.add("JSON-RPC response validation", "pass",
                f"all {len(answered)} parsed responses are well-formed JSON-RPC 2.0", None,
                validated=len(answered))


async def check_error_handling(ctx: _Ctx) -> None:
    r = ctx.errtest
    if r is None:
        return _skip(ctx, "Error-response handling", "skipped: not attempted")
    if r.status in _AUTH_CODES:
        ctx.add("Error-response handling", "skip", "behind authentication; not probed", r.latency_ms)
    elif r.status is not None and r.status >= 500:
        ctx.add("Error-response handling", "fail",
                f"an invalid method crashed the server into HTTP {r.status}", r.latency_ms)
    elif r.rpc_error and isinstance(r.rpc_error.get("code"), int):
        ctx.add("Error-response handling", "pass",
                f"invalid method rejected with JSON-RPC error {r.rpc_error.get('code')}", r.latency_ms,
                error_code=r.rpc_error.get("code"))
    elif r.ok and r.result:
        ctx.add("Error-response handling", "warning",
                "server returned a result for an unknown method instead of an error", r.latency_ms)
    elif r.ok:
        ctx.add("Error-response handling", "warning",
                "server answered an invalid method with an empty 200 body", r.latency_ms)
    else:
        ctx.add("Error-response handling", "fail",
                f"malformed error behaviour (HTTP {r.status}, {r.err or 'unparsable body'})", r.latency_ms)


#: Registry - append new checks here; the orchestrator runs them in order and
#: any check that raises is converted to a `fail` rather than killing the run.
CHECKS: list = [
    ("Endpoint reachable", check_reachable),
    ("HTTPS / TLS", check_tls),
    ("MCP initialization", check_handshake),
    ("Protocol version", check_protocol),
    ("Server capabilities", check_capabilities),
    ("Authentication", check_auth),
    ("Tools discovery", check_tools),
    ("Resources listing", check_resources),
    ("Prompts listing", check_prompts),
    ("Tool schema validation", check_tool_schemas),
    ("JSON-RPC response validation", check_jsonrpc),
    ("Error-response handling", check_error_handling),
]


# --------------------------------------------------------------------------
# orchestrator
# --------------------------------------------------------------------------
async def _fan_out(ctx: _Ctx) -> None:
    async def guarded(coro, attr):
        async with ctx.sem:
            setattr(ctx, attr, await coro)

    await asyncio.gather(
        guarded(ctx.session.post(jsonrpc_payload("tools/list", 2, {})), "tools"),
        guarded(ctx.session.post(jsonrpc_payload("resources/list", 3, {})), "resources"),
        guarded(ctx.session.post(jsonrpc_payload("prompts/list", 4, {})), "prompts"),
        guarded(ctx.session.post(jsonrpc_payload("compat/invalidMethod", 5, {})), "errtest"),
    )


def summarise(checks: list[CompatCheck]) -> dict:
    passed = sum(1 for c in checks if c.status == "pass")
    failed = sum(1 for c in checks if c.status == "fail")
    warnings = sum(1 for c in checks if c.status == "warning")
    skipped = sum(1 for c in checks if c.status == "skip")
    counted = passed + failed + warnings
    pct = round(100 * (passed + 0.5 * warnings) / counted) if counted else 0
    return {"total": len(checks), "passed": passed, "failed": failed,
            "warnings": warnings, "skipped": skipped, "compatibility_pct": pct}


async def run_compatibility_test(client: httpx.AsyncClient, url: str) -> CompatReport:
    """Run the full compatibility suite against one endpoint."""
    ctx = _Ctx(client, url)

    async def _run() -> None:
        ctx.init = await ctx.session.post(initialize_payload())
        for name, fn in CHECKS[:6]:
            try:
                await fn(ctx)
            except Exception as exc:  # a bad check must not kill the report
                ctx.add(name, "fail", f"check error: {type(exc).__name__}")
        if ctx.handshake_ok:
            # good citizen: tell the server we are initialised (not recorded)
            await ctx.session.post(jsonrpc_payload("notifications/initialized"), record=False)
            try:
                await asyncio.wait_for(_fan_out(ctx), timeout=config.PROBE_TIMEOUT * 2)
            except asyncio.TimeoutError:
                pass
        else:
            reason = ("skipped: authentication required" if ctx.auth_blocked
                      else "skipped: initialization did not complete")
            for name, _fn in CHECKS[6:10]:
                _skip(ctx, name, reason)
        for name, fn in CHECKS[6:]:
            if any(c.name == name for c in ctx.checks):
                continue                      # already emitted as a skip above
            try:
                await fn(ctx)
            except Exception as exc:
                ctx.add(name, "fail", f"check error: {type(exc).__name__}")

    error = None
    try:
        await asyncio.wait_for(_run(), timeout=config.COMPAT_TOTAL_TIMEOUT)
    except asyncio.TimeoutError:
        error = f"overall timeout after {config.COMPAT_TOTAL_TIMEOUT:.0f}s"
        for name, _fn in CHECKS:
            if not any(c.name == name for c in ctx.checks):
                _skip(ctx, name, "skipped: overall test timeout")

    stats = summarise(ctx.checks)
    return CompatReport(url=url, tested_at=utc_now(), checks=ctx.checks, error=error, **stats)


async def test_url(url: str) -> CompatReport:
    """Public entry point: guards the URL, then runs the suite on a short-lived
    client. Never attaches credentials."""
    if config.BLOCK_PRIVATE_URLS and not url_is_public(url):
        return CompatReport(url=url, tested_at=utc_now(), error="blocked: address is not public",
                            checks=[CompatCheck(name="Endpoint reachable", status="fail",
                                                message="refused: address is not public")],
                            total=1, failed=1, compatibility_pct=0)
    async with httpx.AsyncClient(follow_redirects=True) as client:
        return await run_compatibility_test(client, url)
