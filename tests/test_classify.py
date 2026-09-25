#!/usr/bin/env python3
"""Offline tests for the classification + parsing logic (no network).

These lock in the honesty guarantees that keep the project from becoming
"fake" again: vendor-official must be domain/brand verified, shared-hosting
subdomains and GitHub user namespaces must never count as official, and the
parent-company docs-portal trap must be gated by the app's own brand.

Run:  python tests/test_classify.py     (or: pytest -q)
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.fetchers import (  # noqa: E402
    classify_server,
    name_tokens,
    namespace_to_domain,
    registered_domain,
    relevance_terms,
    vendor_domain,
    vendor_ids,
    _word_in,
)
from src.models import App, McpServer  # noqa: E402

_passed = 0


def check(cond, label):
    global _passed
    assert cond, "FAIL: " + label
    _passed += 1
    print("  ok -", label)


def cls(name, website, app_name):
    vreg, vtok = vendor_ids(website)
    return classify_server(name, vreg, vtok, name_tokens(app_name))


def test_domains():
    print("registered_domain / vendor_domain")
    check(registered_domain("open.larksuite.com") == "larksuite.com", "subdomain -> eTLD+1")
    check(registered_domain("www.stripe.com") == "stripe.com", "www stripped")
    check(registered_domain("foo.bar.co.uk") == "bar.co.uk", "known second-level TLD")
    check(vendor_domain("https://shopify.dev/docs") == "shopify.dev", "vendor domain from url")
    check(namespace_to_domain("com.stripe") == "stripe.com", "reverse namespace")
    check(namespace_to_domain("io.github.bob") is None, "github user namespace -> None")


def test_official():
    print("vendor-official detection")
    check(cls("com.stripe/mcp", "https://stripe.com", "Stripe")[0] == "vendor_official", "com.stripe -> official")
    check(cls("com.notion/mcp", "https://notion.com", "Notion")[0] == "vendor_official", "com.notion -> official")
    check(cls("com.vercel/vercel-mcp", "https://vercel.com", "Vercel")[0] == "vendor_official", "com.vercel -> official")
    check(cls("app.linear/linear", "https://linear.app", "Linear")[0] == "vendor_official", "app.linear -> official")
    check(cls("com.figma.mcp/mcp", "https://figma.com", "Figma")[0] == "vendor_official", "com.figma.mcp -> official")


def test_not_official():
    print("must NOT be vendor-official")
    check(cls("com.mcparmory/notion", "https://notion.com", "Notion")[0] == "community", "third-party domain -> community")
    check(cls("io.github.awkoy/notion-mcp-server", "https://notion.com", "Notion")[0] == "community", "github user ns -> community")
    check(cls("app.vercel.stripecheckup/x", "https://vercel.com", "Vercel")[0] == "community", "vercel.app hosting -> community")
    check(cls("app.netlify.foo/y", "https://netlify.com", "Netlify")[0] == "community", "netlify.app hosting -> community")
    check(cls("city.close/close-api", "https://close.com", "Close")[0] == "community", "close.city != close.com -> community")
    # the real Close server IS official:
    check(cls("com.close/close-mcp", "https://close.com", "Close")[0] == "vendor_official", "com.close -> official")


def test_docs_portal_gate():
    """LinkedIn Ads sits on learn.microsoft.com; com.microsoft/azure matches by
    domain, so classify flags reason='domain' and fetch_mcp's brand gate demotes
    it (azure text never mentions 'linkedin'). Assert the reason is 'domain'
    (gate-able) and that the brand token is NOT linkedin."""
    print("parent-company docs-portal gate")
    c, m, reason = cls("com.microsoft/azure", "https://learn.microsoft.com/linkedin/marketing", "LinkedIn Ads")
    check(reason == "domain", "microsoft/azure is a domain-only match (gate-able)")
    check("microsoft" not in name_tokens("LinkedIn Ads"), "'microsoft' is not a LinkedIn brand token")
    check("linkedin" in relevance_terms(App(id=0, name="LinkedIn Ads", category="x", website="https://learn.microsoft.com/linkedin/marketing")),
          "relevance requires the 'linkedin' brand")
    # Jira on developer.atlassian.com keeps official via domain + brand 'jira' in text
    c2, m2, r2 = cls("com.atlassian/atlassian-mcp-server", "https://developer.atlassian.com", "Jira")
    check(c2 == "vendor_official" and r2 == "domain", "atlassian is a domain match for Jira (kept when text mentions jira)")


def test_relevance():
    print("relevance / whole-word matching")
    check(_word_in("slack", "Slacking.biz tools") is False, "'slack' not whole-word in 'Slacking'")
    check(_word_in("notion", "better-notion server") is True, "'notion' whole-word in hyphenated text")
    check(_word_in("canva", "canvas lms") is False, "'canva' != 'canvas'")
    srv = McpServer(name="x/y", path="front-page-news", title="", description="Hacker News front page")
    # (relevance is computed inline in fetch_mcp; here we assert the word helper)
    check(_word_in("front", srv.path) is True, "'front' matches 'front-page' (documented keyword noise)")


def main():
    for fn in [test_domains, test_official, test_not_official, test_docs_portal_gate, test_relevance]:
        fn()
    print(f"\nAll {_passed} checks passed.")


if __name__ == "__main__":
    main()
