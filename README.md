# MCP Integration Explorer

> Live, source-traceable integration readiness for 100 apps — real data only, nothing fabricated.

A real, running web app that answers one question with **live data**: for a curated
list of 100 SaaS/dev apps, **does an MCP (Model Context Protocol) server exist, is
it vendor-official or community, how many real tools does its endpoint expose, how
adopted is it (downloads/stars), how maintained is it, and is its site up?**

Every field is fetched from a real public source and links back to it. If a source
returns nothing → **"none"**; if a fetch fails → **"unknown"**. Nothing is guessed.

---

## What it does (feature tour)

**Universal search — fetch ANY app live**
- Press **⌘K / Ctrl-K or `/`** for a command palette. Curated matches appear
  instantly; as you type it also queries the **live MCP registry** for apps beyond
  the 100, and offers **“Fetch ‘<name>’”** for *any* app — which runs the full live
  pipeline (registry → probe → repo → downloads → readiness) on the spot.
- **Pin** a discovered app to keep tracking it (persisted in `data/custom_apps.json`).

**Deep real data per app**
- **MCP registry** — the actual servers for each app, with namespace, repo, live
  remote endpoints, version, and packages.
- **Live endpoint probes** — we handshake each server's real MCP endpoint
  (`initialize` → `tools/list`) and count the **actual tools** it exposes, or record
  that it's **auth-gated** (401/402/403). This is the *real* version of the old
  fabricated "credential access" field.
- **Adoption** — npm/PyPI **monthly download counts** + last publish per package.
- **Maintenance** — GitHub stars, forks, open issues, **last-commit recency**,
  license, language, archived flag.
- **Liveness** — real HTTP status, latency, and whether the site responded.

**Intelligence layer (computed from real data — zero hallucination)**
- **Integration Readiness Score** (0–100) with a fully transparent weighted formula
  and a per-component breakdown shown for every app.
- **Readiness leaderboard** across all 100 apps.
- **Opportunities view** — apps with real demand (stars/downloads/community servers)
  but **no vendor-official MCP** = build candidates.
- **Category insights** and a **readiness grade distribution**.

**True live tracking**
- **Trend charts** — the real time-series (`history.json`) graphed as an interactive
  area chart with a metric switcher (official MCPs, community, live tools,
  downloads, stars, avg readiness, sites online). Every point is a genuine refresh
  snapshot; the GitHub Actions cron adds one every 6h.
- **"What changed" feed** — diffs between refreshes (new server appeared, ★ +N, site
  went down, tool count changed).
- **Real-time SSE activity stream** while a refresh runs.
- **Watch & alerts** — subscribe to an app; when it ships an official MCP or goes
  down, an alert fires to the in-app bell, streams over SSE, and can hit a webhook.
- **GitHub Actions cron** re-fetches and commits fresh data every 6h — the dataset
  (and the trend chart) stays current for free, even with no server running.

**Interface**
- **Light/dark theme toggle** (respects system preference, persists choice, no flash).
- **⌘K command palette** with recent + popular + live-registry suggestions.
- **Compare up to 4 apps** side-by-side (best value per row starred).

**Interface v15 - one short page, and instruments get their own room**
- **Home** - a real home entry point in the nav (plus the logo, the drawer and the
  footer): closes any open window and returns you to the top.
- **One search surface.** The nav search used to be a second, identical search box
  beside the hero's. It is now a compact icon action; the hero keeps the only box.
- **Deep-dive windows.** Anything you cannot reach by scrolling the home page opens
  as a full-screen window, exactly like Pricing - from the toolbar, the drawer, the
  footer or the **Go deeper** cards: **Intelligence** (the landscape analytics) and
  **Methodology**. Hash deep links work: `#intelligence`, `#methodology`, `#pricing`.
  The Intelligence window divides the landscape into five separate full-width parts -
  where points come from, who ships the server, repository freshness, the adoption
  map, and endpoint/latency truth - instead of one cramped card grid.
- **Trends and Signals stay on the home page.** Trends is the closing section; the
  signal wire is a compact, capped (6) two-column card grid with filter chips - no
  endless scroll. The top nav therefore lists only the three off-page views
  (Intelligence / Methodology / Pricing); everything else is one scroll away.
- **Scroll motion replays.** Reveals opt in with `data-replay`: once a panel is fully
  above the viewport it re-arms, so scrolling up and back down animates again instead
  of showing a dead page. `prefers-reduced-motion` still disables all of it.
- **Explorer rail is tabbed.** *What changed* and *Activity* are one panel with two
  tabs, a live count, a new-activity dot and a jump to the home signal wire, so the
  rail no longer stacks two 340px feeds beside the table.
- **Explorer + rail are two aligned blocks with a premium scroller.** The app list and
  the "What changed / Activity" rail share one exact height; each scrolls inside
  itself on a thin gradient-thumb scroller with edge fades and contained overscroll,
  so all 100 rows are reachable without a 6,000px page and without the dead space the
  old mismatched columns left. (An intermediate paging experiment was reverted in
  favour of this - the scroll read better and stayed compact.)
- **Shareable deep links actually render.** `/app/41`, `#methodology`, `#intelligence`.
  Asset URLs used to be relative, so on `/app/41` the browser requested `/app/app.js`,
  hit the `/app/{id}` route, got a 422 and showed a blank page. Assets are now
  root-absolute.
- **The drawer is de-cluttered.** Three groups only - Views (Home + the three
  windows), Compare (selection + compare), Actions (search, refresh, export, theme,
  alerts). The redundant "Navigate" and "Explorer view" lists are gone; both are one
  scroll or one toolbar toggle away.
- **Compare deck has no reserved empty space.** The grid owns the full width: one app
  is one column, two are 50/50, three and four follow. The only extra track is a slim
  `+` rail inside the grid; the old 96px ghost slot is gone. Cells stagger in as a
  column is added, and the picker list is built once and filtered by toggling nodes
  (with memoised favicons), which is what removed the typing lag.
- **Every number juggles.** The dossier's downloads, stars, forks, open issues, commit
  age, latency and registry-server count are all `data-num` elements: they roll from
  the old figure to the new one and flash when live data changes them.
- **Fetching an app outside the 100 is legible.** The blind spinner is now a staged
  progress card (registry → endpoint handshake → repo & packages → liveness →
  score) with a running seconds counter, and palette suggestions carry the real brand
  logo - including registry hits beyond the tracked list.

**Interface v20 - compact Intelligence, living Methodology**
- The hero search no longer carries the little command-key chip; the nav icon owns the shortcut hint.
- **Intelligence is three tabs of two instruments each**, so the window is three compact
  spreads instead of one long stack: *Score & supply* (composition + provenance),
  *Code & endpoints* (repository freshness + endpoint/tool truth), *Adoption & latency*
  (the adoption map + a dedicated site-latency instrument). Probe truth was split into
  "endpoints & live tools" and "site latency" to make six instruments pair cleanly.
- **Methodology is interactive and live.** A summary strip shows the current average
  readiness on an animated gauge beside live counts; the seven stages sit on a spine
  that draws as you scroll; each stage is a card that lifts on hover and **expands on
  click to reveal the live figure that stage produced from the current snapshot**
  (e.g. "995k package downloads per month") plus a link to the real source. Motion is
  transform/opacity/grid-rows only, and `prefers-reduced-motion` disables it.

**Interface v23 - the two last polish fixes**
- The live-lookup progress card finally has its styles: the step icons were rendering
  at natural SVG size (a room-filling glyph that read as a glitch). Now a 44px logo
  chip, a seconds timer, five compact step rows with a spinner, and a real progress bar.
- Numbers behave like a **stock ticker** once you have seen them: the from-zero juggle
  remains for the first sight, but live/auto refreshes roll the digits from the previous
  figure to the new one with a green-up / red-down tick, and bars **slide** to their new
  width instead of snapping. A value memo keyed by `data-nk` (or element id) survives the
  DOM rebuild that each refresh performs.

**Interface v26 - the last of the "unstyled icon" bugs and a complete ticker**
- The alerts dropdown rows had no layout CSS at all (the row icon rendered as a
  room-filling glyph, same class of bug as the lookup card). Now a proper compact
  row: 26px icon chip tinted by event type, name + relative time + message.
- Looked-up apps get a real logo: the registry's per-server `websiteUrl` is now
  kept, and the favicon domain falls back app website -> brand-matching server
  site -> registered domain (so "nvidia" resolves to the nvidia.com mark).
- The ticker audit now covers every `[data-num]` on the page: on a live change all
  of them update, and none re-rolls from zero while you watch. An open dossier
  syncs in place on auto-refresh instead of freezing until reopened, and the
  provenance donut slides its segments rather than re-spinning.

**Interface v28 - premium AMOLED-blue + live wires in Intelligence**
- The three list sections sit on a deep blue-black surface with an ambient glow,
  near-black bar tracks and blue-glowing fills; the per-row/coloured washes drop to
  about a third of their former alpha so nothing reads light on an AMOLED panel.
- The scroller's bottom edge is a 34px fade with inner padding - a row is never
  sliced by a hard border - and the sticky header is opaque so rows cannot show
  through it.
- Opened boxes (dossier and every modal) use a darker premium blue panel with a
  blue rim-glow and no backdrop-filter blur (also cheaper to scroll); the page
  backdrop deepens to match the compare window.
- Each of the three Intelligence sections carries a **live line graph** ("live wire")
  drawn from the real refresh history - official vs community, tools vs responding
  sites, downloads vs stars - redrawn when a new snapshot lands, with the latest
  values as ticking numbers.

**Interface v29 - live, not just lively**
- The 5s health poll now compares `generated_at` and reloads the snapshot whenever
  the server's data is newer, so signals, "what changed" and every number pick up a
  refresh within seconds on any deployment - no waiting for an SSE event.
- Fixed the invisible analytics bars: a second bar-pass in the same render read the
  transient draw-in width ("0%") as the target and animated every bar down to zero.
  Bar targets are now latched in `data-bar` on first sight.
- Footer: **Made with ❤ by vav7**.

**Interface v30 - Help, gold credit, premium plates**
- A **Help** window (book-marked, first in the nav, `#help`, also in the drawer): eighteen
  plain-word answers in four groups - start here, reading the data, using the tools,
  honesty & limits - as a smooth accordion, so a first-time visitor never has to guess
  what "official", "readiness", "auth gated" or the Changes tab mean.
- Footer credit: **Made with ❤ (a real red beating heart) by vav7 · vaibhav**, the name
  in an animated gold-foil shine.
- The two "Go deeper" cards are premium plates: index numerals, gradient hairline,
  glass medallion, meta line, an inline motif and a hover shine sweep.

**Interface v32 - wide help, mobile pass, rounded list plate**
- The Help window uses the home page's own width (1240px): four groups as two
  balanced columns under a sticky contents bar with jump chips - no narrow
  centred stack.
- Mobile (390/360px): nothing overflows horizontally on any surface. The nav
  collapses to its essentials (theme/export move to the drawer, wordmark drops
  at 360px), and the data table scrolls inside its plate instead of stretching
  the page. `tests/mobile_check.py` asserts it at two viewports.
- The app list is a rounded plate on all four sides (16px radius + hairline
  border), with bottom padding so the last row is never sliced and no fade
  hiding the bottom edge; momentum scrolling and a stable scrollbar gutter keep
  the scroll smooth.

**Interface v33/v34 - a professional, editorial footer**
- Four trimmed columns (Windows / On this page / Data & tools / Live sources) in the
  site's borderless editorial style - generous spacing, mono uppercase headings,
  13px links, no panels or boxes. Every destination appears exactly once: the old
  footer repeated Methodology, Pricing and Home across columns and the bottom bar.
- The credit sits centred in the bottom bar on ONE line - red beating heart and
  gold-foil "vav7" - between the copyright and the last-snapshot stamp, all three
  aligned on a single hairline-ruled row.

**Interface v36 - full-screen views behave like windows**
- Opening Intelligence / Help / Methodology / Pricing from ANYWHERE (dive cards,
  footer links, metrics tiles, drawer, hash) no longer leaves the WINDOW
  scrollable behind the opaque sheet: the root element is pinned while a view or
  modal is open, so exactly one scrollbar remains (the view's own), and closing
  returns the reader to their exact scroll offset. The lock is reason-keyed, so
  views and modals may overlap without fighting over the page.
- While the window is locked the chrome band is held by hand (the nav is pinned
  and its flow slot compensated), so an open view never shows the scrolled page
  through its top band.
- v32's `overflow-x:hidden` on html/body had silently killed every root-level
  `position:sticky` (the nav scrolled away site-wide); both now use
  `overflow-x:clip`, which clips without becoming a scroll container, so the nav
  sticks again with the same horizontal clipping on mobile.
- Every view carries a premium Windows-style close button: a crisp HD cross, dark
  glass at rest, Fluent red on hover, pinned top-right under the nav. Esc and
  "Back to dashboard" work exactly as before.

**Consumable + MCP-native**
- **CSV / JSON export** (client-side, works offline) — the dataset is consumable by
  a human *and* an agent.
- **Deep links** — `/app/41` opens that app's evidence, shareable.
- **The explorer is itself an MCP server** — agents can query it directly
  (`python -m src.mcp_server`).
- **Dockerfile + Render/Fly configs + `llms.txt`** for free deployment.

**Search, compare & alerts**
- **Recent & popular** — the ⌘K palette remembers your recent apps and ranks the
  most-fetched ones (server-side counter), so discovery gets faster over time.
- **Compare** — select up to 4 apps (row `+` button or modal) for a side-by-side
  matrix (readiness, tools, downloads, stars, last commit, license, site) with the
  best value per row starred.
- **Watch & alerts** — watch any app for *"ships an official MCP"*, *"site goes
  down"*, or *any change*. When a background refresh detects it, an alert fires to
  the in-app notification center (bell), streams live over SSE, and can POST to a
  webhook (`ALERT_WEBHOOK_URL` — Slack/Discord/Zapier). Persisted in `data/`.

---

## Current live results (last real fetch)

| Signal | Value |
|---|---:|
| Apps tracked | **100** |
| Vendor-official MCP | **14** apps |
| Community MCP | **62** apps |
| No MCP found *in the registry* | **24** apps |
| Registry servers matched | **390** |
| **App-specific live tools** (from real probes) | **404** across **15** apps |
| Open endpoints / auth-gated (real 401/402/403) | **25** / **26** |
| Shared aggregator gateways detected & excluded | **10** |
| MCP package downloads | **708,048 / month** |
| GitHub repos resolved / total stars | **69** repos · **~24,000 ★** |
| Repos with a commit in the last 90 days | **48** |
| Websites responding (up) | **100 / 100** (93 clean 2xx/3xx) |
| Average readiness score | **47.3** |
| Servers carried over from the last cycle (`stale`) | **4** |

*Generated from `data/live_cache.json` by `scripts/update_readme_stats.py` · last real fetch `2026-09-25T10:29:25Z` · 26 history points since 2026-09-21.*

Vendor-official apps (domain-verified in the registry): Close `com.close/close-mcp`, SE Ranking `com.seranking/mcp`, Apify `com.apify/apify-mcp-server`, Vercel `com.vercel/vercel-mcp`, Cloudflare `com.cloudflare.mcp/mcp`, Supabase `com.supabase/mcp`, Notion `com.notion/mcp`, Airtable `com.airtable/mcp`, Linear `app.linear/linear`, Jira `com.atlassian/atlassian-mcp-server`, Monday.com `com.monday/monday.com`, Stripe `com.stripe/mcp`, Fathom `ai.fathom.api/mcp`, YouTube Transcript `com.transcriptapi/youtube-transcript-and-youtube-search`.

---

## Live data sources (all free, no key required)

| Source | What we fetch |
|---|---|
| **Official MCP Registry** | servers, namespace, repo, live remotes, version, packages |
| **Live MCP endpoints** | real tool lists via JSON-RPC handshake, or auth-gating status |
| **GitHub REST API** | stars, forks, issues, last commit, license, language, archived |
| **npm + PyPI (+ pypistats)** | monthly downloads, latest version, last publish |
| **Direct HTTP** | site status code, latency, reachability |

Set `GITHUB_TOKEN` to raise GitHub limits (and enable open-ended repo search).

> **Measured behaviour of the registry search (this decides recall).** The registry's
> `search` parameter does not match multi-word queries at all: a query containing a
> space returns **zero** results even when the server is published. Verified live on
> 2026-09-24:
>
> | query | results | query | results |
> |---|---|---|---|
> | `se ranking` | 0 | `seranking` | `com.seranking/mcp` |
> | `youtube transcript` | 0 | `youtubetranscript` | 2 servers |
> | `bright data` | 0 | `brightdata` | `io.github.brightdata/brightdata-mcp` |
> | `help scout` | 0 | `helpscout` | 0 (genuinely absent) |
>
> So every multi-word brand is queried **both** ways, plus each distinctive token on
> its own, and `REGISTRY_LIMIT` is 50 rather than 20 so a brand cannot be pushed off
> page one. `tests/test_registry_recall.py` locks this in.

---

## Methodology (transparent, and tested)

- **Vendor-official** — the server's reverse-domain namespace resolves to the app's
  own registered domain (`com.stripe/mcp` → stripe.com), or its brand token matches
  the app name on a mainstream corporate domain. Namespaces on shared hosts
  (`*.vercel.app`, `*.netlify.app`, `*.github.io`, …) and GitHub-user namespaces
  (`io.github.*`) are **never** official. A brand-relevance gate prevents an app
  listed on a parent's docs portal (LinkedIn Ads on `learn.microsoft.com`) from
  being matched to `com.microsoft/azure`.
- **Community** — any other registry server whose name/title/description genuinely
  mentions the app (whole-word match, so `Th3Slack3r` ≠ Slack).
- **Live tools** — counted only from a real `tools/list` response. If the **same**
  toolset is served to ≥4 different apps, it's a **shared aggregator gateway** and is
  flagged + excluded from app-specific tool counts (so a generic 41-tool gateway is
  never credited to each app it wraps).
- **Readiness score** — weighted sum of official-MCP, live tools, downloads, stars,
  commit recency, and site uptime (weights in `src/config.py`, sum to 1.0). The exact
  per-component breakdown is shown for each app.
- **Anti-flap** — a *successful* registry search that returns nothing at all, for an
  app whose vendor-official server was domain-verified in an earlier cycle, is much
  more likely to be a search miss than a delisting. The server is kept for one extra
  cycle, flagged `stale`, stamped with when it was last seen, and the reason is
  written into its provenance line. Two blank cycles in a row are then accepted as a
  real "none". The UI renders the flag as a **carried over** chip, so nothing is
  hidden and a verified server never flickers off between refreshes.
- **Category words are not brand evidence** — when a brand already has a distinctive
  token of its own, a bare category word does not qualify a server as being about that
  app. Without this, "YouTube Transcript" matched any server that merely mentioned the
  word *transcript* (e.g. a Slack transcript helper). The full phrase and the squashed
  handle still match, so genuine coverage is unchanged.

`tests/test_classify.py` locks the classification rules in with 25 offline checks;
`tests/test_registry_recall.py` adds 44 more covering registry recall, relevance
precision, the anti-flap merge, the SSRF guard and the lookup cooldown.

---

## Run it

```bash
pip install -r requirements.txt

./run.sh                       # live server → http://localhost:8000
# or: uvicorn src.app:app --reload
```

On boot it loads the last real fetch (instant data), then runs a full live refresh
and keeps auto-refreshing every 15 min, streaming each event to the dashboard.

**Other commands**
```bash
python scripts/refresh_once.py   # one-shot live fetch → cache + snapshot + history/changes
python scripts/build_demo.py     # build self-contained demo.html (offline view)
python tests/test_classify.py    # 25 honesty checks
python tests/test_rate_limits.py  # 36 rate-limit / 429 checks (offline)
python -m src.mcp_server         # run the explorer AS an MCP server (stdio)
```

**Deploy (free)** - full guide in [`DEPLOY.md`](DEPLOY.md)
```bash
# Render (recommended, one click): push repo -> New + -> Blueprint -> Deploy
docker build -t mcp-explorer . && docker run -p 8000:8000 mcp-explorer   # any Docker host
fly launch --copy-config && fly deploy                                   # Fly.io
```

**Auto-updating data (free):** the GitHub Actions workflow
(`.github/workflows/refresh.yml`) re-fetches every 6h and commits fresh
`data/`+`demo.html`, so the repo and any static host stay current.

### Configuration

| Env var | Default | What it does |
|---|---|---|
| `GITHUB_TOKEN` | unset | Raises GitHub from ~60 req/h per IP and enables open-ended repo search |
| `EXPLORER_API_KEY` | unset | When set, the **write** endpoints (`POST /api/refresh`, `POST /api/apps`, `POST`/`DELETE /api/watch`, `POST /api/alerts/read`) require an `X-API-Key` header. Reads stay open |
| `BLOCK_PRIVATE_URLS` | `1` | Refuses to fetch or probe anything resolving to loopback / private / link-local / reserved space. The pipeline dials URLs a visitor can influence (`/api/lookup?website=`, pinned apps, registry-published endpoints), so on a self-hosted box this is what stops it becoming an SSRF primitive into your own network |
| `NO_AUTO_REFRESH` | `0` | Serve the committed snapshot read-only: no scheduler, no `data/` writes. **Use this on ephemeral-filesystem hosts** and whenever several instances share one egress IP, since the unauthenticated GitHub quota is per IP |
| `NO_STARTUP_REFRESH` | `0` | Skip the boot refresh (implies `NO_AUTO_REFRESH`) |
| `REFRESH_INTERVAL_FULL` | `900` | Background refresh cadence in seconds |
| `MAX_CUSTOM_APPS` | `200` | Cap on user-pinned apps |
| `LOOKUP_COOLDOWN_S` | `30.0` | Per-name cooldown on the expensive live lookup. It must exceed the lookup's own ~10-20s runtime (the stamp is taken at request start), or it never fires |
| `LOOKUP_CACHE_S` | `180.0` | How long a *successful* `/api/lookup` result is served from memory. A repeat inside this window gets the cached record - labelled "Served from cache (Ns old)" in the dossier's Provenance block - instead of another 10-20s upstream fan-out, and instead of a 429 |
| `REGISTRY_CACHE_S` | `300.0` | TTL of the per-URL registry response cache: identical registry queries (lookup search terms, type-ahead) inside the window cost zero upstream requests |
| `REGISTRY_CACHE_MAX` | `400` | Bound on that cache (oldest entries evicted) |
| `UPSTREAM_RETRIES` | `2` | Extra attempts on registry 429/5xx, exponential backoff + jitter, honouring an upstream `Retry-After` |
| `UPSTREAM_BACKOFF_MAX_S` | `6.0` | Ceiling for a single backoff sleep |
| `SEARCH_CACHE_MAX` | `512` | Bound on the type-ahead memo (an LRU, not an unbounded dict) |
| `ALERT_WEBHOOK_URL` | unset | POST each fired alert here (Slack / Discord / Zapier) |

### Rate limits, and what a 429 means here

A lookup fans out to the registry, GitHub, npm/PyPI, the app's own site and a
live MCP handshake, so on shared or free-tier egress IPs throttling is a fact of
life, not an error state. Three layers absorb it, and the UI always says *whose*
limit was hit:

1. **Don't re-ask.** Successful registry responses are cached per URL for
   `REGISTRY_CACHE_S`; a successful lookup result is served from memory for
   `LOOKUP_CACHE_S`, labelled in the UI so a cached answer is never mistaken for
   a fresh one.
2. **Retry politely.** Registry 429/5xx are retried up to `UPSTREAM_RETRIES`
   times with exponential backoff + jitter that honours an upstream
   `Retry-After`. A throttled response is never cached, so the next call really
   retries. An MCP endpoint answering 429 gets one bounded retry inside the
   probe and the capability fetch.
3. **Name the limiter.** `/api/lookup` returns 429 only from *this explorer's
   own* cooldown, and then it sends `Retry-After` plus a detail string starting
   with "our own rate limit". The UI renders that as "Slow down, not broken"
   with a live countdown and a retry button; a genuinely upstream throttle
   renders as "Rate limited upstream", names registry / GitHub / npm and points
   at the `GITHUB_TOKEN` lever. A throttled registry search shows up in
   Provenance as `registry HTTP 429` - never as "no MCP found" - and a throttled
   endpoint probe says "endpoint rate-limited this probe (HTTP 429)".

`tests/test_rate_limits.py` (36 offline checks) and `tests/lookup_429_check.py`
(23 real-Chromium checks) lock all of this in.

> **Where do I deploy it?** See **[`DEPLOY.md`](DEPLOY.md)**. The short version:
> push the repo to GitHub, then Render → **New + → Blueprint** → pick it → Deploy
> (`render.yaml` does the rest). Fly.io and any Docker/VPS host are covered too.
> Serverless/static platforms (Vercel, Netlify, Pages) cannot run the live app -
> no background scheduler, no writable disk, no SSE.

### Deployment notes (the honest ones)

- **Single process, in-memory store persisted to `data/`.** Fine on one container;
  not horizontally scalable as-is. Run one web instance, or move `data/` to
  SQLite/Postgres before scaling out.
- **Ephemeral filesystems lose watches, alerts, pinned apps and history** on restart.
  Mount a volume (Fly), or run `NO_AUTO_REFRESH=1` and let the GitHub Actions cron own
  the dataset while the app serves it read-only.
- **SSE needs a proxy that does not buffer.** The response already sets
  `X-Accel-Buffering: no`; a CDN in front will still buffer `/api/stream` unless you
  exempt it.
- **Cold boot is instant**: `data/` ships the last real fetch, and the scheduler goes
  live in the background.
- **Docker**: `python:3.11-slim`, four runtime dependencies, no build step, no Node.
- **Frontend caching is deliberately off** for `.html/.js/.css` (`no-store`) so a bad
  build can never linger behind a cache; asset URLs also carry `?v=` for busting.

---

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/snapshot` | Full dataset + stats + sources + changes + history |
| `GET` | `/api/stats` | Aggregate stats |
| `GET` | `/api/apps?category=&mcp=&q=` | Filtered apps |
| `GET` | `/api/apps/{id}` | One app with all evidence |
| `GET` | `/api/search?q=` | Type-ahead: curated matches + **live registry suggestions** |
| `GET` | `/api/lookup?name=&website=` | **Fetch ANY app live** (not limited to the 100) |
| `POST` | `/api/apps` | **Pin** a discovered app `{name, website?}` to track it |
| `GET` | `/api/leaderboard` | Readiness ranking + weights |
| `GET` | `/api/opportunities` | Demand-but-no-official-MCP apps |
| `GET` | `/api/history` | Time-series points |
| `GET` | `/api/changes` | Recent diffs between refreshes |
| `POST` | `/api/watch` · `DELETE /api/watch/{id}` | Watch an app for alerts `{app_id, events}` |
| `GET` | `/api/alerts` · `POST /api/alerts/read` | Alert inbox · mark read |
| `GET` | `/api/popular` | Most-fetched apps |
| `GET` | `/api/export?format=csv\|json` | Dataset download |
| `GET` | `/api/activity` · `/api/stream` | Event log · **SSE** live stream |
| `POST` | `/api/refresh` | Live refresh (`{"ids":[…],"do_probe":true}`) |
| `POST` | `/api/mcp/compatibility-test` | **MCP Compatibility Report** for any endpoint (`{"url":"…"}`) |
| `GET` | `/api/integrations/{id}/changes` | Latest diff + day-grouped timeline + snapshot index for one integration |
| `GET` | `/api/integrations/{id}/diff?from=&to=` | Deterministic structured diff between two stored snapshots |
| `GET` | `/api/health` · `/app/{id}` · `/llms.txt` | Health · deep link · agent doc |

**As an MCP server** (`python -m src.mcp_server`), tools: `overview`, `list_apps`,
`search_apps`, `get_app`, `top_by_readiness`, `apps_missing_official_mcp`.

---

## Project layout

```
src/
  config.py       sources, timeouts, readiness weights, paths
  models.py       Pydantic models for all real data
  fetchers.py     MCP registry, GitHub, npm/PyPI, live MCP probe, liveness
                  + the transparent official/community/gateway classifier
                  + fetch_mcp_detail (capability snapshot for diffing)
  compat.py       MCP Compatibility Tester (12 checks, modular CHECKS registry)
  diffing.py      historical diff + breaking-change detection (pure, deterministic)
  scoring.py      Integration Readiness Score + opportunity score
  store.py        cache, stats, time-series history, change detection, pub/sub
  pipeline.py     refresh orchestration, probes, gateway detection, scheduler
  app.py          FastAPI: REST + SSE + export + deep links + static dashboard
  mcp_server.py   the explorer exposed AS an MCP server (dependency-free stdio)
static/           index.html · app.js · styles.css · llms.txt · data.snapshot.js
scripts/          refresh_once.py · build_demo.py · update_readme_stats.py
docs/screenshots  verification captures (dark + light themes)
tests/            test_classify.py (25) · test_registry_recall.py (44)
                  · test_compat.py (30) · test_diffing.py (30)
                  · test_rate_limits.py (36) · render_smoke.js · compare_flow.js
                  · v15_views.js (57)
                  · browser_check.py (93 real-Chromium checks) · mobile_check.py (16 checks at 390/360px)
                  · lookup_429_check.py (23 real-Chromium 429/cached-lookup checks)
data/             apps.json · live_cache.json · history.json · changes.json
.github/workflows/refresh.yml   free 6-hourly auto-refresh + commit
Dockerfile · render.yaml · fly.toml · demo.html · run.sh
```

---

## MCP Compatibility Tester

A reusable async service (`src/compat.py`) that behaviourally tests **any** MCP
streamable-http endpoint and returns a Compatibility Report. It is explicitly a
*compatibility test from this explorer's point of view*, **not an official MCP
certification**.

Twelve checks, each returning `{name, status: pass|fail|warning|skip, message,
latency_ms, details}`:

1. Endpoint reachable · 2. HTTPS/TLS · 3. MCP initialization handshake ·
4. Protocol version · 5. Server capabilities · 6. `tools/list` · 7. `resources/list` ·
8. `prompts/list` · 9. Tool schema validation · 10. JSON-RPC response validation ·
11. Error-response handling (invalid method must yield a JSON-RPC error) ·
12. Authentication requirement.

Scoring: `compatibility_pct = round(100 * (passed + 0.5*warnings) / counted)` where
`counted = passed + failed + warnings`; `skip` (optional feature not advertised,
auth-gated, or unreachable-dependency) is excluded rather than counted against the
server.

It reuses the existing wire primitives (`mcp_headers`, `jsonrpc_payload`,
`initialize_payload`, `_parse_sse_or_json`) and the SSRF guard, runs the
tools/resources/prompts/error probes concurrently under
`COMPAT_CONCURRENCY`, applies `PROBE_TIMEOUT` per request and
`COMPAT_TOTAL_TIMEOUT` overall, and never sends or echoes credentials. New checks
are added by appending to the `CHECKS` registry.

```bash
curl -s -X POST http://localhost:8000/api/mcp/compatibility-test \
     -H 'Content-Type: application/json' \
     -d '{"url":"https://docs.mcp.cloudflare.com/mcp"}' | jq '.compatibility_pct, .checks[].name'
# 100
# "Endpoint reachable" ... "Error-response handling"
```

In the dashboard, open any application dossier and press **test compatibility** on a
server card: the report renders inline (percentage ring, per-check pass/warn/fail/skip
with latency, and a **Run again** button).

## Historical diff + breaking-change detection

Every refresh stores a **normalised fingerprint** per integration
(`data/app_snapshots.json`, capped at `APP_SNAPSHOTS_MAX` per app; unchanged
refreshes store only a hash pointer so "no change" days still appear on the
timeline). `src/diffing.py` is pure and deterministic: ordering is canonicalised
(servers, tools, properties, required lists, remotes, packages) so a harmless
reorder never produces a false diff, and probe-derived groups that were never
probed on one side are reported as `not_comparable` instead of "everything
added/removed".

Tracked: protocol version · server name/version · endpoints · auth method ·
capabilities · tools (names, descriptions, input schemas) · resources · prompts ·
repository/package metadata · health/availability.

Breaking changes are **potential**, never certified, and carry a severity:
`tool_removed`, `required_param_removed`, `required_param_renamed`,
`required_param_added`, `param_type_changed`, `endpoint_removed` = HIGH;
`auth_changed`, `protocol_changed`, `capability_removed`, `server_removed`,
`package_removed`, `repo_archived/moved` = MEDIUM; description/optional-param/
status-code = LOW; additive events (`tool_added`, `endpoint_added`,
`capability_added`) = INFO and `breaking: false`.

```bash
curl -s 'http://localhost:8000/api/integrations/64/diff?from=0&to=1' | jq '{summary, breaking_changes}'
# {"summary":{"changed":true,"added":1,"removed":2,"modified":5,"breaking":6,...},
#  "breaking_changes":[{"change_type":"tool_removed","severity":"high","breaking":true,
#                       "tool":"delete_customer","message":"Potential breaking change: ..."}]}
```

`from` / `to` accept an ISO timestamp (nearest snapshot at or before it), an
integer index (0 = oldest), or `prev` / `latest`. In the dashboard, open any
dossier and switch to the **Changes** tab: summary counts, severity-coloured
potential-breaking cards, Added / Removed / Modified lists, both snapshot
timestamps, a day-grouped **history timeline**, and two selectors to compare any
two stored snapshots.

## Honesty notes & limitations

- **"No MCP found" means "none in the official MCP registry"** — a registry coverage
  gap, not proof that no server exists. Verified on 2026-09-24: GitHub ships
  `github/github-mcp-server` (★33,176) and Netlify ships `netlify/netlify-mcp`, and
  **neither is published in the registry**, so both read as community / none here.
  Figma *is* in the registry (`com.figma.mcp/mcp`) but is not in the curated 100. If
  you act on this data, read "none" as "not discoverable in the registry".
- **Registry search is keyword-based.** "Vendor-official" is domain-verified and
  strong; "community" means a registry server genuinely mentions the app, which for
  a few common-word brands (*Front*, *Grain*) may include a tangential hit — the
  detail view lists the exact servers so you can judge.
- **Stars/downloads belong to the repo the registry publishes**, which for a hosted
  official server is sometimes a community repo. Verified examples: Vercel's
  `com.vercel/vercel-mcp` resolves to `pulsemcp/mcp-servers` (★80), Linear's
  `app.linear/linear` to `adelaidasofia/linear-mcp` (★1), Stripe's `com.stripe/mcp`
  to `stripe/ai` (★1,831) rather than `stripe/agent-toolkit` (both are Stripe's and
  both currently report the same star count). The popularity and maintenance
  components of the score inherit that, so read them as "of the published server
  repo".
- **Any new `/{thing}/{id}` route is an asset-loading hazard.** The deep-link 422 above
  happened because a route matched asset filenames. Keep asset URLs root-absolute and
  keep such routes last in the routing table.
- **Refresh-to-refresh movement is partly measurement noise.** Between two real
  refreshes on 2026-09-24 the totals moved 368→338→362→340 servers and
  14→12 vendor-official apps, because registry search results shift. The anti-flap
  rule stops a *verified official* server from flickering, but aggregate counts still
  wobble by a few percent. Read the trend chart as direction, not as precision.
- **Live tools** are counted from real handshakes. Auth-gated endpoints can't be
  counted without credentials, so they're reported as gated (not zero-capability).
  Shared aggregator gateways are detected and excluded from app-specific counts.
- **GitHub stars** are for the MCP-server repo published in the registry (the
  vendor's own for official servers, else the top community repo) — not necessarily
  the app's main product repo. Hosted/remote-only official servers (e.g. Notion's
  `mcp.notion.com`) publish no repo/package, so their stars/downloads may be sparse;
  we report only what the registry exposes.
- **Unauthenticated GitHub** is ~60 req/hour; when hit, stars defer to a later
  refresh and existing values are never overwritten by an error. Add `GITHUB_TOKEN`.
- **Site liveness** checks the exact URL in `apps.json`; a 403/404 usually means the
  listed docs path moved or blocks bots — the real status code is shown either way.
