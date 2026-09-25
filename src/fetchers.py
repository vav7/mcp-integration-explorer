"""Real data fetchers.

These functions hit *live* public APIs and return exactly what those APIs say.
Nothing is guessed or invented:

  * MCP data      -> the official Model Context Protocol registry
                     (https://registry.modelcontextprotocol.io)
  * GitHub stars  -> the GitHub REST API, resolved from the repository URL the
                     registry itself publishes (or open search when a token is
                     supplied)
  * Liveness      -> a real HTTP request to the app's website

"Vendor official" is decided by a transparent, explainable rule: the MCP
server's reverse-domain namespace must resolve to the same registered domain as
the app's own website (e.g. `com.stripe/mcp` -> stripe.com). Everything else is
labelled community. The rule is recorded on each server so the UI can show why.
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import random
import re
import socket
import time
from datetime import datetime, timezone
from typing import Any, Optional
from urllib.parse import quote_plus, urlparse

import httpx

from . import config
from .config import MAX_SEARCH_TERMS
from .models import (
    App,
    GithubResult,
    LivenessResult,
    McpProbe,
    McpResult,
    McpServer,
    PackageStat,
)

# Common second-level public suffixes so registered-domain detection is sane.
_KNOWN_SECOND_LEVEL = {
    "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au",
    "co.jp", "ne.jp", "or.jp", "com.br", "co.in", "com.cn", "co.nz",
    "co.za", "com.mx", "com.sg", "com.hk", "co.kr", "com.tw", "com.ar",
    "com.co", "com.pe", "com.ph", "com.my", "com.tr", "com.ua", "co.id",
    "com.vn", "com.ec", "com.eg", "com.ng", "com.pk", "com.sa",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def registered_domain(host: str) -> str:
    """Naive eTLD+1 for a hostname: 'open.larksuite.com' -> 'larksuite.com'."""
    host = (host or "").lower().strip().strip(".")
    if host.startswith("www."):
        host = host[4:]
    labels = [l for l in host.split(".") if l]
    if len(labels) < 2:
        return host
    last_two = ".".join(labels[-2:])
    if last_two in _KNOWN_SECOND_LEVEL and len(labels) >= 3:
        return ".".join(labels[-3:])
    return last_two


def vendor_domain(website: str) -> str:
    try:
        host = urlparse(website).netloc or urlparse("http://" + website).netloc
    except Exception:
        host = website
    return registered_domain(host)


def sld(website: str) -> str:
    """Second-level label, e.g. 'https://open.larksuite.com' -> 'larksuite'."""
    dom = vendor_domain(website)
    return dom.split(".")[0] if dom else ""


def vendor_ids(website: str) -> tuple[str, str]:
    """Return (registered_domain, sld_token) for an app's own website."""
    reg = vendor_domain(website)
    tok = reg.split(".")[0] if reg else ""
    return reg, tok


# Generic trailing/qualifier words that are not distinctive brand tokens.
_GENERIC_TOKENS = {
    "ads", "ad", "cloud", "business", "api", "apis", "cli", "app", "apps",
    "commerce", "marketing", "selling", "partner", "platform", "developer",
    "developers", "docs", "doc", "suite", "hub", "pro", "the", "for", "of",
    "and", "video", "videos", "data", "connect", "works", "work", "team",
    "teams", "project", "projects", "manager", "management", "online", "ai",
}


# Common category words. These ARE real words a server might mention, but on
# their own they are not evidence that the server is about a particular app:
# "transcript" is what YouTube Transcript does, not who it is. They are only
# demoted when the brand already has a distinctive token of its own, so a brand
# whose whole name is a category word keeps full recall.
_CATEGORY_WORDS = {
    "transcript", "transcripts", "search", "mail", "email", "chat", "note", "notes",
    "file", "files", "doc", "docs", "task", "tasks", "sheet", "sheets", "form", "forms",
    "site", "sites", "shop", "store", "report", "reports", "board", "desk", "inbox",
    "message", "messages", "meeting", "meetings", "call", "calls", "page", "pages",
    "post", "posts", "helper", "tool", "tools", "server", "servers", "ranking",
    "rank", "analytics", "assistant", "agent", "agents", "bot", "bots", "scraper",
    "crawler", "video", "audio", "image", "images", "text", "writer", "reader",
}


def name_tokens(app_name: str) -> set[str]:
    """Distinctive brand tokens from an app's display name (aliases included).

    'LinkedIn Ads' -> {'linkedin'}; 'Lark (Larksuite)' -> {'lark','larksuite'}.
    Used for brand-token official matching, which is safer than trusting the
    website domain (some apps list a parent company's docs portal).
    """
    raw = app_name
    aliases = re.findall(r"\(([^)]+)\)", raw)
    cleaned = re.sub(r"\([^)]+\)", " ", raw)
    pieces = re.split(r"[^A-Za-z0-9]+", cleaned.lower())
    for a in aliases:
        pieces.extend(re.split(r"[^A-Za-z0-9]+", a.lower()))
    return {p for p in pieces if len(p) >= 3 and p not in _GENERIC_TOKENS}



def namespace_to_domain(namespace: str) -> Optional[str]:
    """Reverse a reverse-domain namespace to a candidate domain.

    'com.stripe'          -> 'stripe.com'
    'io.github.awkoy'     -> None (GitHub user/Pages namespace, not a vendor)
    'app.vercel.foo'      -> 'foo.vercel.app'
    """
    ns = (namespace or "").lower().strip(".")
    if not ns or ns.startswith("io.github."):
        return None
    labels = [l for l in ns.split(".") if l]
    if len(labels) < 2:
        return None
    return ".".join(reversed(labels))


def build_search_terms(app: App) -> list[str]:
    """Small, de-duplicated set of registry SEARCH terms for an app.

    These are used only to query the registry (recall). Precision is enforced
    separately by `relevance_terms`, so it is safe to include the website's own
    brand token here even when the site is a parent company's docs portal
    (e.g. 'atlassian' for Jira at developer.atlassian.com).

    IMPORTANT (measured against the live registry): its `search` parameter does
    NOT do multi-word matching - a query containing a space returns ZERO hits
    even when the brand is published. Verified examples:

        search="se ranking"        -> 0 results     search="seranking"      -> com.seranking/mcp
        search="youtube transcript"-> 0 results     search="youtubetranscript"-> 2 servers
        search="bright data"       -> 0 results     search="brightdata"     -> brightdata-mcp
        search="help scout"        -> 0 results     search="helpscout"      -> 0 (genuinely absent)

    So every multi-word brand ALSO gets a squashed single-token variant,
    otherwise those apps silently flip between "official" and "no MCP found"
    from one refresh to the next.
    """
    raw = app.name
    # Pull aliases out of parentheses: "Lark (Larksuite)" -> ["Lark", "Larksuite"]
    aliases = re.findall(r"\(([^)]+)\)", raw)
    base = re.sub(r"\([^)]+\)", " ", raw)
    base = re.sub(r"[^\w\s.+/-]", " ", base).strip()
    terms: list[str] = []

    def add(t: str) -> None:
        t = t.strip().lower()
        if t and t not in terms:
            terms.append(t)

    def add_squashed(t: str) -> None:
        """Single-token form: the registry only matches spaceless queries."""
        sq = re.sub(r"[^a-z0-9]", "", (t or "").lower())
        if len(sq) >= 3 and " " in (t or "").lower():
            add(sq)

    add(base)
    add_squashed(base)
    for a in aliases:
        add(a)
        add_squashed(a)
    # Every distinctive brand token on its own ("zoho cliq" -> "cliq").
    for tok in sorted(name_tokens(raw)):
        add(tok)
    # First token (drops trailing words like Business/Cloud/Ads/CLI)
    first = base.split()[0] if base.split() else ""
    add(first)
    # The website's own second-level label often names the true vendor
    add(sld(app.website))
    return terms[:MAX_SEARCH_TERMS]


def relevance_terms(app: App) -> set[str]:
    """Terms a server must actually mention to count as being about this app.

    Brand-focused: the app's name tokens plus its full display name and any
    parenthetical aliases. Deliberately EXCLUDES the website's domain token when
    that token is not part of the app's own name, so an app listed on a parent
    company's docs portal (LinkedIn Ads on learn.microsoft.com) is not polluted
    by unrelated 'microsoft' servers.
    """
    raw = app.name
    aliases = re.findall(r"\(([^)]+)\)", raw)
    base = re.sub(r"\([^)]+\)", " ", raw)
    base = re.sub(r"[^\w\s.+/-]", " ", base).strip().lower()
    rel = set(name_tokens(raw))
    if base:
        rel.add(base)
    for a in aliases:
        a = a.strip().lower()
        if a:
            rel.add(a)
    # Registries publish squashed brand handles ("com.seranking/mcp" for
    # "SE Ranking", "youtubetranscript" for "YouTube Transcript"), so the
    # spaceless form of a multi-word brand is a legitimate mention too. The
    # whole-word anchors in _word_in keep it from matching inside longer words.
    for t in list(rel):
        sq = re.sub(r"[^a-z0-9]", "", t)
        if " " in t and len(sq) >= 4:
            rel.add(sq)
    # Precision: when the brand already has a distinctive token of its own, a
    # bare category word is not evidence. Without this, "YouTube Transcript"
    # matches any server that happens to mention the word "transcript" (e.g. a
    # Slack transcript helper). The full phrase and the squashed handle still
    # match, so nothing genuinely about the app is lost.
    base_tokens = [t for t in re.split(r"[^a-z0-9]+", base) if len(t) >= 3]
    distinctive = [t for t in base_tokens if t not in _GENERIC_TOKENS and t not in _CATEGORY_WORDS]
    if distinctive:
        rel = {t for t in rel if t in distinctive or t not in _CATEGORY_WORDS}
    # The website SLD only counts if it is genuinely part of the brand name.
    s = sld(app.website)
    if s and s in name_tokens(raw):
        rel.add(s)
    return {t for t in rel if t}



# Mainstream TLDs; used so brand-token matching only fires for real corporate
# domains (com.shopify -> shopify.com) and not oddities (city.close -> close.city).
_COMMON_TLDS = {
    "com", "io", "ai", "app", "dev", "org", "net", "co", "sh", "xyz",
    "tech", "cloud", "so", "me", "gg", "tv", "cc", "hq", "run",
}

# Shared hosting platforms. A subdomain here (foo.vercel.app) is a third-party
# deployment, NOT the platform vendor's own product, so it can never count as
# vendor-official for the app even when the brand token coincides.
_HOSTING_DOMAINS = {
    "vercel.app", "netlify.app", "github.io", "pages.dev", "workers.dev",
    "render.com", "onrender.com", "herokuapp.com", "web.app", "firebaseapp.com",
    "fly.dev", "railway.app", "higgsfield.app", "glitch.me", "replit.app",
    "replit.dev", "ngrok.app", "ngrok.io", "azurewebsites.net", "elasticbeanstalk.com",
    "bubbleapps.io", "gitbook.io", "readme.io", "mintlify.app", "deno.dev",
}


def classify_server(name: str, vreg: str, vtok: str, name_tokens: set[str]) -> tuple[str, bool, Optional[str]]:
    """Return (classification, namespace_matches_vendor, match_reason).

    match_reason is 'token' (namespace brand token is one of the app's name
    tokens), 'domain' (namespace registered domain equals the app website's
    registered domain), or None (community).

    Vendor-official requires the server's reverse-domain namespace to resolve to
    the app's own registered domain (com.stripe -> stripe.com), or to be a
    mainstream corporate domain whose brand token is one of the app's NAME
    tokens (com.shopify for "Shopify" listed at shopify.dev). Namespaces on
    shared hosting platforms (foo.vercel.app) and GitHub user namespaces
    (io.github.*) are always community.
    """
    namespace = name.split("/", 1)[0] if "/" in name else name
    cand = namespace_to_domain(namespace)
    if not cand:
        return "community", False, None
    cand_reg = registered_domain(cand)
    if cand_reg in _HOSTING_DOMAINS:
        return "community", False, None
    cand_tok = cand_reg.split(".")[0] if cand_reg else ""
    ns_labels = [l for l in namespace.lower().split(".") if l]
    ns_tld = ns_labels[0] if ns_labels else ""
    # Brand-token match is the strongest signal (the app's own name).
    if len(cand_tok) >= 3 and cand_tok in name_tokens and ns_tld in _COMMON_TLDS:
        return "vendor_official", True, "token"
    if vreg and cand_reg == vreg:
        return "vendor_official", True, "domain"
    return "community", False, None


def _word_in(term: str, text: str) -> bool:
    return re.search(r"\b" + re.escape(term.lower()) + r"\b", text.lower()) is not None





def _parse_server(entry: dict) -> Optional[McpServer]:
    """Parse one registry entry into an McpServer (classification applied later,
    once we have aggregated text across all versions of the same server)."""
    srv = entry.get("server") or {}
    name = srv.get("name")
    if not name:
        return None
    meta = (entry.get("_meta") or {}).get("io.modelcontextprotocol.registry/official") or {}
    repo = srv.get("repository") or {}
    remotes = [r.get("url") for r in (srv.get("remotes") or []) if isinstance(r, dict) and r.get("url")]
    packages = []
    for p in srv.get("packages") or []:
        if isinstance(p, dict):
            ident = p.get("identifier") or p.get("name")
            rtype = (p.get("registryType") or "").lower()
            if ident:
                packages.append(f"{rtype}:{ident}" if rtype else str(ident))
    namespace, _, path = name.partition("/")
    return McpServer(
        name=name,
        namespace=namespace,
        path=path,
        title=srv.get("title") or "",
        description=(srv.get("description") or "")[:400],
        version=srv.get("version") or "",
        repository_url=repo.get("url"),
        website_url=srv.get("websiteUrl") or None,
        remote_urls=remotes,
        packages=packages,
        is_latest=bool(meta.get("isLatest", True)),
        published_at=meta.get("publishedAt"),
    )


# --- rate-limit plumbing -----------------------------------------------------
# The official registry (and occasionally GitHub/npm) answer 429 when an IP
# sends too many requests. Shared/free-tier hosts do this constantly, so every
# registry read goes through _registry_get: cached, retried with backoff that
# honours Retry-After, and never caching a throttled response.
_REGISTRY_CACHE: dict[str, tuple[float, int, Any]] = {}
_RETRYABLE_STATUS = (429, 500, 502, 503, 504)


def retry_delay(retry_after: Optional[str], attempt: int) -> float:
    """Prefer an upstream Retry-After hint; else exponential backoff + jitter."""
    if retry_after:
        try:
            return min(max(float(str(retry_after).strip()), 0.0),
                       config.UPSTREAM_BACKOFF_MAX_S * 3)
        except (TypeError, ValueError):
            pass
    return min(0.6 * (2 ** attempt) + random.uniform(0.0, 0.4),
               config.UPSTREAM_BACKOFF_MAX_S)


async def registry_get(client: httpx.AsyncClient, url: str,
                       timeout: float = None) -> tuple[Optional[int], Any]:
    """GET registry JSON with cache + bounded retries on 429/5xx.

    Returns (status_code|None, parsed_body_or_error_string)."""
    timeout = config.HTTP_TIMEOUT if timeout is None else timeout
    hit = _REGISTRY_CACHE.get(url)
    if hit and time.time() - hit[0] < config.REGISTRY_CACHE_S:
        return hit[1], hit[2]
    status: Optional[int] = None
    data: Any = None
    for attempt in range(max(0, config.UPSTREAM_RETRIES) + 1):
        try:
            resp = await client.get(url, timeout=timeout)
            status = resp.status_code
            if status == 200:
                data = resp.json()
                break
            data = None
            if status not in _RETRYABLE_STATUS:
                break
            delay = retry_delay(resp.headers.get("retry-after"), attempt)
        except Exception as exc:
            status, data = None, f"{type(exc).__name__}: {exc}"
            delay = retry_delay(None, attempt)
        if attempt < config.UPSTREAM_RETRIES:
            await asyncio.sleep(delay)
    if status == 200 and isinstance(data, dict):
        _REGISTRY_CACHE[url] = (time.time(), status, data)
        if len(_REGISTRY_CACHE) > config.REGISTRY_CACHE_MAX:
            for key in sorted(_REGISTRY_CACHE, key=lambda k: _REGISTRY_CACHE[k][0])[:
                    len(_REGISTRY_CACHE) - config.REGISTRY_CACHE_MAX]:
                _REGISTRY_CACHE.pop(key, None)
    return status, data


async def fetch_mcp(client: httpx.AsyncClient, app: App) -> McpResult:
    """Query the official MCP registry for servers genuinely about this app.

    Methodology (fully transparent, no fabricated claims):
      * Search the registry with the app's brand terms.
      * Group results by server id and aggregate text across all versions.
      * Keep a server only if a brand term appears as a whole word in its
        path/title/description (drops coincidences like a user named
        'Th3Slack3r', or 'com.microsoft/azure' for 'LinkedIn Ads').
      * Classify vendor-official via the namespace's reverse domain, with a
        brand-token safety gate for domain-only matches on shared docs hosts.
    """
    vreg, vtok = vendor_ids(app.website)
    ntokens = name_tokens(app.name)
    terms = build_search_terms(app)
    rel_terms = relevance_terms(app)

    latest: dict[str, McpServer] = {}          # server id -> display object (latest version)
    combined_text: dict[str, str] = {}         # server id -> text across all versions
    queries_used: list[str] = []
    source_url = None
    last_error = None
    any_success = False

    async def _fetch(term):
        url = f"{config.MCP_REGISTRY_URL}?search={quote_plus(term)}&limit={config.REGISTRY_LIMIT}"
        status, data = await registry_get(client, url)
        return term, url, status, data

    for term, url, status, data in await asyncio.gather(*[_fetch(t) for t in terms]):
        queries_used.append(term)
        source_url = source_url or url
        if status != 200 or data is None:
            # keep the honest reason: "registry HTTP 429" tells the UI the
            # upstream throttled us, which is not the same as "no MCP found".
            last_error = f"registry HTTP {status}" if status else str(data)
            continue
        any_success = True
        for entry in data.get("servers", []):
            parsed = _parse_server(entry)
            if not parsed:
                continue
            combined_text[parsed.name] = (
                combined_text.get(parsed.name, "") + f" {parsed.path} {parsed.title} {parsed.description}"
            )
            prev = latest.get(parsed.name)
            if prev is None or (parsed.is_latest and not prev.is_latest):
                latest[parsed.name] = parsed

    kept: list[McpServer] = []
    for sid, srv in latest.items():
        text = combined_text.get(sid, "")
        # Relevance: the app's own brand must appear as a whole word in this
        # server's aggregated text (across all versions).
        if not any(_word_in(t, text) for t in rel_terms):
            continue
        classification, matches, reason = classify_server(srv.name, vreg, vtok, ntokens)
        # Safety gate: a domain-only official match (e.g. an app whose website is
        # a parent company's docs portal) must also mention the app's own brand.
        if classification == "vendor_official" and reason == "domain":
            if not any(_word_in(nt, text) for nt in ntokens):
                classification, matches = "community", False
        srv.classification = classification
        srv.namespace_matches_vendor = matches
        kept.append(srv)

    servers = sorted(kept, key=lambda s: (s.classification != "vendor_official", s.name))
    if servers:
        status = "vendor_official" if any(s.classification == "vendor_official" for s in servers) else "community"
    elif not any_success:
        status = "unknown"   # every query failed -> we cannot claim "none"
    else:
        status = "none"

    return McpResult(
        status=status,
        servers=servers,
        matched=len(servers),
        queries=queries_used,
        source_url=source_url,
        fetched_at=utc_now(),
        error=last_error if status == "unknown" else None,
    )




def _github_owner_repo(repo_url: str) -> Optional[tuple[str, str]]:
    try:
        p = urlparse(repo_url)
        parts = [x for x in p.path.split("/") if x]
        if p.netloc.endswith("github.com") and len(parts) >= 2:
            return parts[0], parts[1]
    except Exception:
        pass
    return None


async def fetch_github_from_repo(client: httpx.AsyncClient, repo_url: str) -> GithubResult:
    """Resolve real stars/metadata for a repo URL via the GitHub core API."""
    parsed = _github_owner_repo(repo_url)
    if not parsed:
        return GithubResult(status="skipped", via="none", error="not a github repo url", fetched_at=utc_now())
    owner, repo = parsed
    api_url = f"{config.GITHUB_API_URL}/repos/{owner}/{repo}"
    headers = {"Accept": "application/vnd.github+json", "User-Agent": config.USER_AGENT}
    if config.GITHUB_TOKEN:
        headers["Authorization"] = f"Bearer {config.GITHUB_TOKEN}"
    try:
        resp = await client.get(api_url, headers=headers, timeout=config.HTTP_TIMEOUT)
        if resp.status_code in (403, 429):
            return GithubResult(status="rate_limited", via="registry_repository",
                                source_url=repo_url, fetched_at=utc_now(),
                                error="GitHub rate limit")
        if resp.status_code == 404:
            return GithubResult(status="none", via="registry_repository",
                                html_url=repo_url, source_url=api_url, fetched_at=utc_now())
        if resp.status_code != 200:
            return GithubResult(status="error", via="registry_repository", source_url=repo_url,
                                fetched_at=utc_now(), error=f"HTTP {resp.status_code}")
        d = resp.json()
        return GithubResult(
            status="found",
            full_name=d.get("full_name"),
            html_url=d.get("html_url") or repo_url,
            stars=d.get("stargazers_count"),
            forks=d.get("forks_count"),
            open_issues=d.get("open_issues_count"),
            license=(d.get("license") or {}).get("spdx_id"),
            language=d.get("language"),
            archived=d.get("archived"),
            pushed_at=d.get("pushed_at"),
            description=(d.get("description") or "")[:240] or None,
            via="registry_repository",
            source_url=api_url,
            fetched_at=utc_now(),
        )
    except Exception as exc:
        return GithubResult(status="error", via="registry_repository", source_url=repo_url,
                            fetched_at=utc_now(), error=f"{type(exc).__name__}: {exc}")


async def search_github(client: httpx.AsyncClient, app: App) -> GithubResult:
    """Open-ended GitHub search (only used when a token is configured)."""
    if not config.GITHUB_SEARCH_ENABLED:
        return GithubResult(status="skipped", via="none", fetched_at=utc_now(),
                            error="search disabled without GITHUB_TOKEN")
    q = f"{app.name.split('(')[0].strip()} mcp"
    api_url = f"{config.GITHUB_API_URL}/search/repositories?q={quote_plus(q)}&per_page=1&sort=stars"
    headers = {"Accept": "application/vnd.github+json", "User-Agent": config.USER_AGENT,
               "Authorization": f"Bearer {config.GITHUB_TOKEN}"}
    try:
        resp = await client.get(api_url, headers=headers, timeout=config.HTTP_TIMEOUT)
        if resp.status_code in (403, 429):
            return GithubResult(status="rate_limited", via="search", source_url=api_url, fetched_at=utc_now())
        if resp.status_code != 200:
            return GithubResult(status="error", via="search", source_url=api_url,
                                fetched_at=utc_now(), error=f"HTTP {resp.status_code}")
        items = resp.json().get("items", [])
        if not items:
            return GithubResult(status="none", via="search", source_url=api_url, fetched_at=utc_now())
        d = items[0]
        return GithubResult(status="found", full_name=d.get("full_name"), html_url=d.get("html_url"),
                            stars=d.get("stargazers_count"), description=(d.get("description") or "")[:240] or None,
                            via="search", source_url=api_url, fetched_at=utc_now())
    except Exception as exc:
        return GithubResult(status="error", via="search", source_url=api_url,
                            fetched_at=utc_now(), error=f"{type(exc).__name__}: {exc}")


def url_is_public(url: str) -> bool:
    """Refuse to point the pipeline at private/internal addresses.

    The explorer fetches URLs that a visitor can influence (``/api/lookup?website=``,
    a pinned app's website, or a remote endpoint published in the registry). On a
    self-hosted deployment that would otherwise be a server-side request forgery
    primitive into the operator's own network, so anything that resolves to a
    loopback / private / link-local / reserved address is rejected before a
    single packet is sent. Public hosts are unaffected.
    """
    try:
        host = (urlparse(url).hostname or "").strip().rstrip(".")
    except Exception:
        return False
    if not host:
        return False
    host = host.removeprefix("[").removesuffix("]")
    try:
        addrs = socket.getaddrinfo(host, None)
    except Exception:
        return False          # unresolvable -> we will not dial it either
    for family, _type, _proto, _canon, sockaddr in addrs:
        raw = sockaddr[0]
        try:
            ip = ipaddress.ip_address(raw.split("%")[0])
        except ValueError:
            return False
        if (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved
                or ip.is_multicast or ip.is_unspecified):
            return False
    return True


async def check_liveness(client: httpx.AsyncClient, app: App) -> LivenessResult:
    """Issue a real HTTP request to the app's website and measure it."""
    url = app.website
    if not url.startswith("http"):
        url = "https://" + url
    if config.BLOCK_PRIVATE_URLS and not url_is_public(url):
        return LivenessResult(url=app.website, status_code=None, latency_ms=None,
                              reachable=False, responded=False, fetched_at=utc_now(),
                              error="blocked: address is not public")
    start = time.monotonic()
    headers = {"User-Agent": "Mozilla/5.0 (compatible; mcp-integration-explorer/1.0)"}
    try:
        resp = await client.get(url, headers=headers, timeout=config.LIVENESS_TIMEOUT, follow_redirects=True)
        latency = int((time.monotonic() - start) * 1000)
        return LivenessResult(
            url=app.website,
            status_code=resp.status_code,
            latency_ms=latency,
            reachable=200 <= resp.status_code < 400,
            responded=True,               # the server answered (even 4xx/5xx) -> it's up
            final_url=str(resp.url),
            fetched_at=utc_now(),
        )
    except Exception as exc:
        latency = int((time.monotonic() - start) * 1000)
        return LivenessResult(url=app.website, status_code=None, latency_ms=latency,
                              reachable=False, responded=False, fetched_at=utc_now(),
                              error=f"{type(exc).__name__}: {str(exc)[:120]}")


async def probe_source(client: httpx.AsyncClient, name: str, url: str) -> dict:
    """Health-check one of our upstream sources for the status bar."""
    start = time.monotonic()
    try:
        resp = await client.get(url, timeout=config.HTTP_TIMEOUT,
                                headers={"User-Agent": config.USER_AGENT, "Accept": "application/json"})
        latency = int((time.monotonic() - start) * 1000)
        return {"name": name, "reachable": resp.status_code < 500, "latency_ms": latency,
                "last_check": utc_now(), "detail": f"HTTP {resp.status_code}"}
    except Exception as exc:
        return {"name": name, "reachable": False, "latency_ms": int((time.monotonic() - start) * 1000),
                "last_check": utc_now(), "detail": f"{type(exc).__name__}"}


# --- package adoption stats (npm / PyPI, free, no key) --------------------
# Shared MCP streamable-http primitives. probe_mcp AND the compatibility tester
# both use these so there is exactly one definition of the wire format.
MCP_HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
}


def mcp_headers(session_id: str | None = None) -> dict:
    h = dict(MCP_HEADERS)
    h["User-Agent"] = config.USER_AGENT
    if session_id:
        h["Mcp-Session-Id"] = session_id
    return h


def jsonrpc_payload(method: str, msg_id: int | None = None, params: dict | None = None) -> dict:
    p = {"jsonrpc": "2.0", "method": method}
    if msg_id is not None:
        p["id"] = msg_id
    if params is not None:
        p["params"] = params
    return p


def initialize_payload() -> dict:
    return jsonrpc_payload("initialize", 1, {
        "protocolVersion": config.SUPPORTED_MCP_PROTOCOL_VERSIONS[0],
        "capabilities": {},
        "clientInfo": {"name": "mcp-integration-explorer", "version": "1.0"},
    })


def _parse_sse_or_json(text: str):
    """MCP streamable-http may answer with plain JSON or an SSE frame."""
    text = (text or "").strip()
    if text.startswith("{"):
        try:
            return json.loads(text)
        except Exception:
            return None
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            try:
                return json.loads(line[5:].strip())
            except Exception:
                continue
    return None


async def fetch_package_stats(client: httpx.AsyncClient, packages: list[str]) -> list[PackageStat]:
    """Resolve real adoption stats for 'registry:identifier' package strings."""
    out: list[PackageStat] = []
    seen: set[str] = set()
    for raw in packages:
        if raw in seen:
            continue
        seen.add(raw)
        if ":" in raw:
            reg, name = raw.split(":", 1)
        else:
            reg, name = "npm", raw
        reg = reg.lower()
        stat = PackageStat(registry=reg, name=name, fetched_at=utc_now())
        try:
            if reg == "npm":
                stat.url = f"https://www.npmjs.com/package/{name}"
                dl = await client.get(f"https://api.npmjs.org/downloads/point/last-month/{name}",
                                      timeout=config.HTTP_TIMEOUT)
                if dl.status_code == 200:
                    stat.downloads_last_month = dl.json().get("downloads")
                # abbreviated packument (small/fast) -> latest version
                meta = await client.get(f"https://registry.npmjs.org/{name}",
                                        headers={"Accept": "application/vnd.npm.install-v1+json"},
                                        timeout=config.HTTP_TIMEOUT)
                if meta.status_code == 200:
                    stat.version = (meta.json().get("dist-tags") or {}).get("latest")
            elif reg == "pypi":
                stat.url = f"https://pypi.org/project/{name}"
                meta = await client.get(f"https://pypi.org/pypi/{name}/json", timeout=config.HTTP_TIMEOUT)
                if meta.status_code == 200:
                    md = meta.json()
                    stat.version = (md.get("info") or {}).get("version")
                    rel = (md.get("releases") or {}).get(stat.version) or []
                    if rel:
                        stat.last_published = rel[0].get("upload_time_iso_8601") or rel[0].get("upload_time")
                try:
                    dl = await client.get(f"https://pypistats.org/api/packages/{name}/recent",
                                          timeout=config.HTTP_TIMEOUT)
                    if dl.status_code == 200:
                        stat.downloads_last_month = (dl.json().get("data") or {}).get("last_month")
                except Exception:
                    pass
            else:
                continue
        except Exception as exc:
            stat.error = f"{type(exc).__name__}"
        out.append(stat)
    return out


# --- live MCP endpoint probe (real tools / auth gating) -------------------
async def probe_mcp(client: httpx.AsyncClient, url: str) -> McpProbe:
    """Connect to a real MCP endpoint and list its tools.

    Honest outcomes: 'open' (returned a tool list), 'auth_required'/'forbidden'/
    'payment_required' (server demanded credentials), 'timeout'/'error'
    (could not complete the handshake). We never invent a tool count.
    """
    if config.BLOCK_PRIVATE_URLS and not url_is_public(url):
        return McpProbe(url=url, result="error", http_status=None, tools_count=None,
                        tool_names=[], generic_gateway=False, protocol_version=None,
                        latency_ms=None, probed_at=utc_now(), error="blocked: address is not public")
    started = time.monotonic()
    headers = mcp_headers()
    init = initialize_payload()

    def latency() -> int:
        return int((time.monotonic() - started) * 1000)

    r = None
    for attempt in range(2):
        try:
            r = await client.post(url, json=init, headers=headers, timeout=config.PROBE_TIMEOUT)
        except httpx.TimeoutException:
            return McpProbe(url=url, result="timeout", latency_ms=latency(), probed_at=utc_now())
        except Exception as exc:
            return McpProbe(url=url, result="error", latency_ms=latency(), probed_at=utc_now(),
                            error=f"{type(exc).__name__}: {str(exc)[:100]}")
        if r.status_code == 429 and attempt == 0:
            await asyncio.sleep(retry_delay(r.headers.get("retry-after"), 0))
            continue
        break
    if r is not None and r.status_code == 429:
        # Honest: the endpoint throttled us. That is NOT "no MCP here".
        return McpProbe(url=url, result="error", http_status=429, latency_ms=latency(),
                        probed_at=utc_now(), error="rate limited by the endpoint (HTTP 429)")

    code = r.status_code
    if code in (401,):
        return McpProbe(url=url, result="auth_required", http_status=code, latency_ms=latency(), probed_at=utc_now())
    if code in (402,):
        return McpProbe(url=url, result="payment_required", http_status=code, latency_ms=latency(), probed_at=utc_now())
    if code in (403,):
        return McpProbe(url=url, result="forbidden", http_status=code, latency_ms=latency(), probed_at=utc_now())
    if code >= 400:
        return McpProbe(url=url, result="error", http_status=code, latency_ms=latency(), probed_at=utc_now())

    sid = r.headers.get("mcp-session-id") or r.headers.get("Mcp-Session-Id")
    body = _parse_sse_or_json(r.text)
    proto = None
    if isinstance(body, dict):
        proto = (body.get("result") or {}).get("protocolVersion")

    # Best-effort: send the initialized notification, then list tools.
    post_headers = dict(headers)
    if sid:
        post_headers["Mcp-Session-Id"] = sid
    try:
        await client.post(url, json=jsonrpc_payload("notifications/initialized"),
                          headers=post_headers, timeout=config.PROBE_TIMEOUT)
    except Exception:
        pass
    try:
        r2 = await client.post(url, json=jsonrpc_payload("tools/list", 2, {}),
                               headers=post_headers, timeout=config.PROBE_TIMEOUT)
        data = _parse_sse_or_json(r2.text)
        tools = ((data or {}).get("result") or {}).get("tools") if isinstance(data, dict) else None
        if isinstance(tools, list):
            names = [t.get("name") for t in tools if isinstance(t, dict) and t.get("name")]
            return McpProbe(url=url, result="open", http_status=r2.status_code, tools_count=len(tools),
                            tool_names=names[:15], protocol_version=proto, latency_ms=latency(), probed_at=utc_now())
        return McpProbe(url=url, result="error", http_status=r2.status_code, protocol_version=proto,
                        latency_ms=latency(), probed_at=utc_now(), error="no tools in response")
    except httpx.TimeoutException:
        return McpProbe(url=url, result="timeout", protocol_version=proto, latency_ms=latency(), probed_at=utc_now())
    except Exception as exc:
        return McpProbe(url=url, result="error", protocol_version=proto, latency_ms=latency(),
                        probed_at=utc_now(), error=f"{type(exc).__name__}: {str(exc)[:100]}")


async def fetch_mcp_detail(client: httpx.AsyncClient, url: str) -> Optional[dict]:
    """Capture a normalisable capability snapshot of one live MCP endpoint.

    Reuses the shared wire primitives (mcp_headers / jsonrpc_payload /
    initialize_payload / _parse_sse_or_json). Returns None when the endpoint is
    unreachable or gated, so callers keep whatever they already knew instead of
    recording a false "everything disappeared". Feeds src/diffing.py.
    """
    headers = mcp_headers()
    r = None
    for attempt in range(2):
        try:
            r = await client.post(url, json=initialize_payload(), headers=headers,
                                  timeout=config.PROBE_TIMEOUT)
        except Exception:
            return None
        if r.status_code == 429 and attempt == 0:
            await asyncio.sleep(retry_delay(r.headers.get("retry-after"), 0))
            continue
        break
    if r is None or r.status_code >= 400:
        return None
    sid = r.headers.get("mcp-session-id") or r.headers.get("Mcp-Session-Id")
    if sid:
        headers = mcp_headers(sid)
    init = _parse_sse_or_json(r.text) or {}
    result = init.get("result") if isinstance(init, dict) else None
    if not isinstance(result, dict):
        return None

    async def listing(method: str, key: str, msg_id: int):
        try:
            rr = await client.post(url, json=jsonrpc_payload(method, msg_id, {}),
                                   headers=headers, timeout=config.PROBE_TIMEOUT)
        except Exception:
            return None
        if rr.status_code >= 400:
            return None
        body = _parse_sse_or_json(rr.text) or {}
        res = body.get("result") if isinstance(body, dict) else None
        val = (res or {}).get(key) if isinstance(res, dict) else None
        return val if isinstance(val, list) else None

    tools_raw = await listing("tools/list", "tools", 21)
    resources_raw = await listing("resources/list", "resources", 22)
    prompts_raw = await listing("prompts/list", "prompts", 23)

    tools = []
    for t in (tools_raw or []):
        if isinstance(t, dict):
            tools.append({"name": t.get("name"), "description": t.get("description") or "",
                          "inputSchema": t.get("inputSchema") or {}})
    caps = result.get("capabilities")
    return {
        "protocol_version": result.get("protocolVersion"),
        "server_info": result.get("serverInfo") or {},
        "capabilities": sorted(caps.keys()) if isinstance(caps, dict) else (sorted(caps) if isinstance(caps, list) else []),
        "auth": "none",
        "tools": tools,
        "resources": [x.get("name") or x.get("uri") for x in resources_raw if isinstance(x, dict)] if resources_raw is not None else None,
        "prompts": [x.get("name") for x in prompts_raw if isinstance(x, dict)] if prompts_raw is not None else None,
        "fetched_at": utc_now(),
    }


# --- live type-ahead suggestions from the registry ------------------------
async def registry_suggestions(client: httpx.AsyncClient, q: str, limit: int = 8) -> list[dict]:
    """Search the live MCP registry and derive distinct app-like suggestions.

    Returns human-readable labels (the brand token of each server's namespace,
    e.g. 'com.notion/mcp' -> 'notion') so type-ahead can offer apps beyond the
    curated list. Purely real registry data; no invented entries.
    """
    q = (q or "").strip()
    if len(q) < 2:
        return []
    # The registry's search does not match multi-word queries at all (a space
    # means zero hits), so a spaced type-ahead is retried as a single token.
    squashed = re.sub(r"[^a-z0-9]", "", q.lower())
    queries = [q] + ([squashed] if " " in q and len(squashed) >= 3 else [])
    entries: list[dict] = []
    for term in queries:
        url = f"{config.MCP_REGISTRY_URL}?search={quote_plus(term)}&limit=25"
        status, data = await registry_get(client, url, timeout=config.SUGGEST_TIMEOUT)
        if status == 200 and isinstance(data, dict):
            entries.extend(data.get("servers", []))
    data = {"servers": entries}
    out: list[dict] = []
    seen: set[str] = set()
    for entry in data.get("servers", []):
        srv = entry.get("server") or {}
        name = srv.get("name") or ""
        if not name:
            continue
        ns, _, path = name.partition("/")
        dom = namespace_to_domain(ns)
        if dom:
            label = registered_domain(dom).split(".")[0]
            vendor_like = True
        else:
            label = (srv.get("title") or path or ns).strip()
            vendor_like = False
        label = re.sub(r"[-_]+", " ", label).strip()
        key = label.lower()
        if not label or len(label) < 2 or key in seen:
            continue
        seen.add(key)
        repo = (srv.get("repository") or {}).get("url")
        # A domain the type-ahead can render a real logo for. Only ever taken
        # from data the registry itself publishes (its websiteUrl, or the
        # vendor domain implied by an official reverse-domain namespace) - we
        # never guess one, so an unknown app simply shows its initials.
        website = srv.get("websiteUrl") or ""
        try:
            site_dom = (urlparse(website).hostname or "").lower().removeprefix("www.") if website else ""
        except Exception:
            site_dom = ""
        out.append({
            "label": label.title() if label.islower() else label,
            "slug": label,
            "server": name,
            "vendor_like": vendor_like,
            "description": (srv.get("description") or "")[:90],
            "repository_url": repo,
            "website_url": website,
            "domain": site_dom or (registered_domain(dom) if (dom and vendor_like) else ""),
        })
        if len(out) >= limit:
            break
    return out
