# MCP Integration Explorer — verification & change report

Workspace copy: `mcp-integration-explorer/` · packaged: `mcp-integration-explorer-v15.zip`
All claims below were re-derived from **live sources on 2026-09-24**, not from the README.

---

## 1. Is the data realistic?  Yes — with four measured caveats.

I re-fetched every signal family independently and compared against the shipped cache:

| Signal family | Independent re-fetch | Verdict |
|---|---|---|
| MCP registry namespaces | `com.stripe/mcp`, `com.notion/mcp`, `app.linear/linear`, `com.vercel/vercel-mcp`, `com.supabase/mcp`, `com.cloudflare.mcp/mcp`, `com.atlassian/…`, `com.monday/…`, `com.airtable/mcp`, `com.apify/…`, `com.seranking/mcp`, `ai.fathom.api/mcp`, `com.close/…`, `com.transcriptapi/…` all present and correctly domain-verified | **Accurate** |
| Live MCP probes | `mcp.stripe.com`→401, `mcp.notion.com/mcp`→401, `mcp.linear.app/mcp`→401, `docs.mcp.cloudflare.com/mcp`→200 with `search_cloudflare_documentation` + `migrate_pages_to_workers_guide` | **Accurate** (auth-gated / open / tool names all match) |
| GitHub stars | `cloudflare/mcp-server-cloudflare` 4,280 (cache 4,277) · `supabase/mcp` 2,920 (2,919) · `atlassian/…` 1,064 (1,061) · `apify/…` 8,314 (8,188) · `stripe/ai` 1,831 (1,829) | **Accurate** (deltas = a few hours of real star drift) |
| npm downloads | `@supabase/mcp-server-supabase` 406,869 · `mongodb-mcp-server` 338,225 · `firecrawl-mcp` 126,701 · `@brightdata/mcp` 36,086 — **byte-identical** to the cache | **Accurate** |
| Site liveness | stripe/notion/slack/salesforce/docs.github all HTTP 200 with latencies in the same band as the cache | **Accurate** |

### Caveats (all now documented in the README and, where fixable, fixed)

1. **"No MCP found" = "not in the official registry", not "doesn't exist".**
   Verified: GitHub ships `github/github-mcp-server` (★33,176) and Netlify ships
   `netlify/netlify-mcp`; **neither is published in the registry**, so both read as
   community/none here. Figma *is* in the registry (`com.figma.mcp/mcp`) but isn't in
   the curated 100. → README limitation added; UI wording clarified.

2. **The registry's `search` does not match multi-word queries at all** (a space = zero
   hits, even for a published server). Verified: `se ranking`→0 vs `seranking`→
   `com.seranking/mcp`; `youtube transcript`→0 vs `youtubetranscript`→2; `bright data`→0
   vs `brightdata`→2. This is why SE Ranking & YouTube Transcript kept *flipping*
   between "official" and "none" between refreshes. **Fixed:** every multi-word brand is
   now queried both ways plus each distinctive token; `REGISTRY_LIMIT` 20→50. After a
   real refresh both apps returned to vendor-official and matched servers went
   340→526, live tools 178→402.

3. **Star/download attribution follows the repo the registry publishes**, which for a
   hosted official server can be a community repo (Vercel→`pulsemcp/mcp-servers` ★80,
   Linear→`adelaidasofia/linear-mcp` ★1). Documented as a limitation; not silently
   "corrected", because the registry is the honest source of truth.

4. **Aggregate counts wobble refresh-to-refresh** (368→338→362→340 servers) because
   registry search shifts. **Fixed for verified servers** with an anti-flap rule: a
   domain-verified official server survives one blank cycle, is flagged `stale`
   (UI shows a "carried over" chip + provenance note), and only drops after two.

---

## 2. Will it deploy easily?  Yes — with honest caveats, now mitigated.

**What already works:** `python:3.11-slim` Dockerfile, 4 runtime deps, no build step, no
Node; `render.yaml` + `fly.toml`; `run.sh`; GitHub Actions re-fetches every 6h and commits
`data/` + `demo.html`; instant cold boot from the shipped snapshot. `demo.html` is a
fully self-contained offline build (verified rendering with zero JS errors).

**Caveats found and mitigated:**

| Issue | Fix |
|---|---|
| Scheduler writes `data/` every 15 min → crashes/loses state on ephemeral FS (Render/Fly free) | `NO_AUTO_REFRESH=1` serves the committed snapshot read-only; the Actions cron owns the data |
| Unauthenticated GitHub quota is **per egress IP** → N dynos each burn it | Documented; pair with `NO_AUTO_REFRESH` or a volume |
| `POST /api/refresh`, `POST /api/apps`, `POST/DELETE /api/watch` were open → anyone can trigger expensive refreshes / grow the list | `EXPLORER_API_KEY` gates all write endpoints (reads stay open) |
| `/api/lookup?website=` + registry remotes are visitor-influenced URLs → SSRF primitive on self-host | `BLOCK_PRIVATE_URLS=1` (default) refuses loopback/private/link-local/reserved before dialing; verified 9 blocked + 3 public cases |
| Unbounded type-ahead dict = slow leak | Bounded LRU (`SEARCH_CACHE_MAX=512`) |
| Expensive lookup spammable | `LOOKUP_COOLDOWN_S` per name (default 30s; a 2s default provably never fired because a lookup takes ~10-20s) |
| Pinned apps unbounded | `MAX_CUSTOM_APPS=200` |
| Deprecated `@app.on_event` startup hooks | Migrated to FastAPI `lifespan` (verified: 0 deprecation warnings on boot) |
| Not horizontally scalable (in-memory store) | Documented honestly; one web instance or move `data/` to a DB |

---

## 3. UI — everything you asked for, verified in real Chromium (63 checks + screenshots)

| Your ask | What I did | Verified |
|---|---|---|
| Two search boxes doing the same thing | Nav search is now a compact **icon action**; the hero keeps the only search box | 1 visible box |
| No home button | **Home** button in nav (+ logo, drawer, footer) closes any window and returns to top | ✓ |
| Landscape analytics should open like Pricing | It (plus Trends, Signals, Methodology) now opens as a **full-screen view** from toolbar/drawer/footer/cards; `#intelligence`/`#methodology`/`#pricing` deep links; Intelligence has Landscape/Trends/Signals tabs | ✓ |
| "Don't stop the animation after once done" | Reveals opt in via `data-replay` and re-arm when fully off-screen, so scrolling up and back down replays; `prefers-reduced-motion` still disables it | ✓ both directions |
| Compare deck lag + scrolling + empty reserved slot | Picker list built **once**, filtered by toggling nodes, favicons memoised; grid owns full width (1 col → 50/50 → 3 → 4) with only a slim `+` rail; cells stagger in | 100 rows, no rebuild-on-type; no ghost slot |
| Numbers should juggle to live values | Dossier downloads/stars/forks/issues/commit-age/latency/registry-count are all `data-num` roll-and-flash elements | ✓ |
| "Page it" / awkward gap / arrangement | Explorer + leaderboard + opportunities render **25 rows/page** with truthful `Showing 26-50 of 100`, numbered pages, Show all / Back to pages; table lost its inner 74vh scrollbar; rail is now one tabbed panel (What changed / Activity) | page height 9,774px → ~5,300px |
| App data should open fluid & feel live | Staggered hero/breakdown/stat entrances, spring modal, `data-num` roll-ups, live re-fetch progress pulse | ✓ |
| Search an app outside the 100 with logos | Palette shows registry + "Anywhere" suggestions **with real brand logos**; fetching shows a staged progress card (registry → handshake → repo/packages → liveness → score) with a live seconds counter | logos resolve |
| Colours | Untouched — every new rule reuses the existing tokens | ✓ |

**Two pre-existing bugs the browser caught and I fixed:**
- **Deep links rendered a blank page.** Asset URLs were relative, so `/app/81` requested
  `/app/app.js`, hit `/app/{id}`, got a 422 and showed no CSS/JS. Assets are now
  root-absolute (and `build_demo.py` still inlines them).
- **Pager was cumulative.** Page 2 re-rendered rows 1-50 while claiming "Showing 26-50",
  and "Show all" deleted the only way back. Now a real window with an always-present
  exit from show-all.

---

## 4. Test matrix (all passing)

| Suite | Checks | Covers |
|---|---|---|
| `tests/test_classify.py` | 25 | official/community/gateway classification (unchanged) |
| `tests/test_registry_recall.py` | 44 | registry recall, relevance precision, anti-flap, SSRF, cooldown |
| `tests/render_smoke.js` | — | init+render, all views, no runtime errors |
| `tests/compare_flow.js` | — | compare updates in place, no reserved slot |
| `tests/v15_views.js` | 49 | views/tabs/rail/palette/dossier/paging against an HTML-aware DOM shim |
| `tests/browser_check.py` | 63 | real Chromium: nav, views, paging, replay, compare, palette, dossier, deep links, theme, **0 console errors** + 13 screenshots in `docs/screenshots/` |

Data in `data/` is a genuine live fetch from **2026-09-24T17:12:25Z** (100 apps, 14
vendor-official, 366 servers, 221 app-specific tools, ~999k downloads/mo, avg readiness
48.0), with 24 history points since 2026-09-21.

---

## 5. Rate limits & 429s (v35)

A lookup costs 10-20s of upstream calls (registry search terms, GitHub, npm/PyPI,
site probe, MCP handshake), so on shared/free-tier IPs the registry, GitHub and
npm all return 429s regularly. The old UI collapsed every failure into "HTTP 429 -
the registry may be rate-limiting", which was wrong twice over: the 429 a user
actually saw was almost always **this explorer's own** `/api/lookup` cooldown, and
a throttled upstream was being implied as a verdict on the app. v35 fixes both
ends.

**Backend, three layers** (`src/fetchers.py`, `src/app.py`, `src/config.py`):

| Layer | What it does | Knobs |
|---|---|---|
| response cache | identical registry URLs (lookup terms + type-ahead) are served from memory; a throttled response is never cached | `REGISTRY_CACHE_S` 300, `REGISTRY_CACHE_MAX` 400 |
| bounded retries | 429/5xx retried with exponential backoff + jitter that honours `Retry-After`; 404s fail fast; transport errors keep their real reason | `UPSTREAM_RETRIES` 2, `UPSTREAM_BACKOFF_MAX_S` 6 |
| lookup result cache | a *successful* lookup is replayed from memory (labelled) instead of re-fanning-out or being rejected | `LOOKUP_CACHE_S` 180 |

Honesty rules kept: our own 429 returns `Retry-After` and a detail starting with
"our own rate limit"; a failed lookup is never cached, so the next click really
retries; a throttled registry search surfaces as `registry HTTP 429` in
Provenance (never "no MCP found"); a throttled probe is `http_status: 429` +
"rate limited by the endpoint", rendered as "endpoint rate-limited this probe".

**Frontend** (`static/app.js`, styles layer v35): the failure surface is now the
same `.lk-*` card the progress walker uses - app logo, kicker, countdown in the
`.lk-timer` slot, primary/ghost actions. Our-own 429 renders "Slow down, not
broken" with a live countdown taken from `Retry-After` and a retry button that
unlocks at zero; an upstream throttle renders "Rate limited upstream", names the
registry / GitHub / npm and points at `GITHUB_TOKEN`; 502/504/timeout get their
own honest copy. Cached results say so: toast "served from cache (Ns old)" plus a
Provenance line with the age and when a fresh run is available.

**Proof**: `tests/test_rate_limits.py` (36 offline checks: backoff arithmetic,
retry/cache semantics, 429-with-Retry-After API contract, failed-lookup-not-cached)
and `tests/lookup_429_check.py` (23 real-Chromium checks incl. countdown ticking,
timer teardown on close, cached-repeat provenance; screenshots
`docs/screenshots/v35-lookup-429-{ours,upstream}.png`, `v35-lookup-cached.png`).
Full matrix after this round: classify 25 · recall 44 · compat 30 · diffing 30 ·
rate-limits 36 · v15_views 54 · browser_check 81 · mobile 16 · lookup_429 23.

---

## 6. Views behave like windows (v36)

**Reported defect**: a full-screen view opened from the top nav or the drawer
looked right, but opened "from any other place" (a deep-dive card, a footer
link, a metrics tile, a hash on load) it showed two scrollbar thumbs and let
the dashboard slide underneath. Root cause, three layers deep:

1. v32 pinned `html{overflow-x:hidden}` (and body carries one too). Once the
   root's overflow is not `visible`, `body{overflow:hidden}` **stops
   propagating to the viewport**, so the old scroll-lock did nothing: the
   WINDOW stayed scrollable behind the fixed sheet and kept its offset - the
   second thumb in the report. Nav/drawer openings only looked fine because
   they usually happen at scrollY 0.
2. The same `overflow-x:hidden` on html/body made each a scroll box, which
   silently detached every root-level `position:sticky` - the nav scrolled
   away site-wide, and an open view's 66px chrome band showed the page behind.
3. There was no obvious close affordance besides "Back to dashboard".

**Fix** (`static/app.js` `lockWindowScroll/unlockWindowScroll`, styles layer
v36): a reason-keyed lock set pins the ROOT element only (never the body: a
body scroll box would detach sticky) while any view or modal is open; the
reader's offset is remembered and restored instantly (never animated) on
close, so views and modals can overlap safely. `overflow-x:clip` (with
`hidden` as the parse-fallback) restores stickiness while keeping mobile
clipping. While locked, `body.scroll-locked` pins the nav fixed and
compensates its exact flow slot, so the chrome band and the page geometry
stay pixel-identical. `html{scrollbar-gutter:stable}` keeps the lock from
shifting layout on classic-scrollbar platforms. Each of the four views now
opens with a premium red Windows-style `.pv-x` close button (crisp HD cross,
dark glass at rest, Fluent red on hover) wired to the existing
`data-closeview` delegation; Esc and "Back to dashboard" are unchanged.

**Proof**: `tests/browser_check.py` +12 checks (nav pinned while scrolling;
root locked and offset held when a view opens mid-page; neither wheel nor
keys scroll behind it; only the view scrolls; the chrome band is the nav;
four close buttons, pinned top-right; hover turns Windows red; the button
closes; close restores the exact offset; modals lock and unlock the same
way) and `tests/v15_views.js` +3 (root lock/unlock, body lock mark, pv-x
markup). Screenshot `docs/screenshots/v36-view-lock-redx.png`.
Full matrix after this round: classify 25 · recall 44 · compat 30 · diffing 30 ·
rate-limits 36 · v15_views 57 · browser_check 93 · mobile 16 · lookup_429 23.
