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
| `tests/browser_check.py` | 63 | real Chromium: nav, views, paging, replay, compare, palette, dossier, deep links, theme, **0 console errors** + 13 screenshots written to `docs/screenshots/` |

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
`docs/screenshots/v35-lookup-429-{ours,upstream}.png`, `v35-lookup-cached.png`; those three are
regenerated on each run and are git-ignored, since only the curated gallery is committed).
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

---

## 7. Repo hygiene audit (pre-push)

Audited every file in the tree before publishing to GitHub. Findings and what was
done, with measured numbers:

| Item | Before | Verdict | After |
|---|---|---|---|
| Working tree (excl. `.git`) | 23 MB / 119 files | bloated | **12 MB / 56 tracked files** (16 MB on disk after a full test run: the suites rewrite 13 ignored screenshots, +3.6 MB) |
| `.pytest_cache/`, `src/__pycache__/`, `tests/__pycache__/` | 20 files, 480 KB | **junk** (git-ignored caches, zero runtime value) | deleted |
| `tests/_inspect.js` | 12 lines | **junk** (scratch debugger, referenced nowhere) | deleted |
| `docs/screenshots/` | 48 PNGs, 15 MB, only 1 referenced | **bloat** (test output accumulating per round) | **8 curated captures, 3.2 MB**, rest git-ignored |
| `tests/` (13 files, 152 KB) | — | **not junk**: the evidence behind every claim in this file, `README.md` and `.github/workflows/refresh.yml` | kept in full |
| `data/live_cache.json` (2.4 MB), `demo.html` (2.2 MB), `static/data.snapshot.js` (1.7 MB), `data/app_snapshots.json` (948 KB) | — | heavy but **intentional**: they hold the last real fetch so a first clone and the portable demo render with genuine data and no network | kept, documented in `.gitignore` |
| `.git` | 53 MB over 12 commits (8 near-identical 2.2 MB `demo.html` blobs) | history weight, not content | **flattened to a single initial commit**; the round-by-round story lives in `README.md` and in sections 1-6 above |

Verification screenshots are now declared test **output** in `.gitignore`
(`docs/screenshots/*` with eight explicit `!` exceptions), so re-running
`browser_check.py` / `mobile_check.py` / `lookup_429_check.py` regenerates them
locally without dirtying the repo or re-bloating history.

**Proof after the cleanup**: the full matrix was re-run against the slimmed tree
and is green: classify 25 · recall 44 · compat 30 · diffing 30 · rate-limits 36 ·
v15_views 57 · render_smoke PASS · compare_flow PASS · browser_check 93 ·
mobile 16 · lookup_429 23. Nothing was deleted that any test, route, deploy file
or doc references.


---

## 8. Mobile report card + the stuck-view glitch (v37)

Six issues from the field, root cause and fix for each:

| # | Reported issue | Root cause | Fix |
|---|---|---|---|
| 1 | Explorer / Leaderboard / Opportunities sometimes do not switch, on desktop and mobile ("should switch instantly") | each list caches a data signature and skips its re-render when nothing changed; the skip also fired when ANOTHER list had overwritten the shared content region in between, so the old list stayed on screen | a `contentView` marker records which list is actually painted; only that list may skip its redraw, so every tab click repaints |
| 2 | App list on phones: labels visible, every value pushed off-card; the plate overflowed | the phone card layout kept the table's 680px min-width, so each label/value row stretched 680px wide and the value sat past the right edge | min-width dropped; cards rebuilt as a header row plus a two-column grid of labelled metric rows (readiness full width so its bar breathes); the list scrolls vertically inside its own rounded plate |
| 3 | Leaderboard rows and opportunity cards too airy on phones | fixed four-column row grid could not fit 390px | compact grid: rank, identity and score on one line with the bar spanning below; tighter opportunity cards |
| 4 | Compare matrix cut off on phones, left labels unreachable | centred overflow: the grid is wider than its scroller and was centred, so the overflow on the left could not be scrolled to | grid left-aligned inside its own swipe region; the metric column pins (sticky) while app columns swipe; a right-edge fade advertises the swipe |
| 5 | Footer one endless column on phones | single-column stack under 520px | two-up columns like the desktop footer, brand block spanning both |
| 6 | Coverage & readiness bar charts look dated next to the rest of the site | rows stacked a label line over a 4px track | redrawn as instrument rows inside bordered panels: mono label, 7px gradient track, bold count, exactly the style of the reference panels |

**Proof after the round**: classify 25 · recall 44 · compat 30 · diffing 30 ·
rate-limits 36 · v15_views 57 · render_smoke PASS · compare_flow PASS ·
browser_check 95 (two new checks: tab-switch sequence + instrument panels) ·
mobile 24 (eight new checks per viewport: card values on screen, plate scroll,
footer two-up, panel rows, compare swipe with pinned column) · lookup_429 23.
Two new captures joined the curated gallery: `v37-insight-panels.png`,
`v37-mobile-explorer.png`.

## 9. v38: compare deck polish, full labels, tests-free upload package

Mobile compare deck, from user reports and reproduced at 390x844: cells sat
invisible for up to ~280ms because of the staggered pop-in (now zero delay on
phones), the pinned corner only covered its text band so head cards slid
through above it (now full-height), the right-edge fade dimmed the last real
column into looking cut (removed; slimmer phone columns make the next app
peek at rest instead), and long values could bleed between 86px columns
(columns slimmed to minmax(80px,1fr) with a stronger pinned-edge shadow).
Lookup client budget raised 45s to 90s: on rate-limited IPs a cold probe
legitimately takes ~64s of server-side backoff retries and the page used to
abort mid-probe and show a failure card. Instrument bar rows now show every
label in full: wrap on desktop, stacked label over a full-width track on
phones (the old 30% track ellipsised "AI, Research and Media-native" and
"80-100 · ready now").

Repo hygiene for re-upload: refresh.yml no longer calls the deleted test
suite; README rewritten as a clean public-facing document (the generated
live-results table and its updater anchors are preserved); curated gallery
swapped to `v38-insight-panels.png` and `v38-mobile-compare.png`.

Suites after v38: pytest 10 · registry recall 44 · compat 30 · diffing 30 ·
v15_views 57 · render_smoke PASS · compare_flow PASS · browser_check 95 ·
mobile 26 (two new per viewport: stacked full labels, no invisible cells plus
peek cue) · lookup_429 23 (live-lookup wait budget documented as backoff
headroom, not a regression allowance).

The upload zip excludes `tests/` and this file: the user's GitHub copy runs
without them and the workflow no longer references them. They remain in the
working copy as the regression harness.
## 10. v39: the phone compare window scrolls, and stops lagging

Report: on phones the comparison window still cut off below the fold after
v38, and swiping inside it felt laggy.

Root causes found in the harness (390x844 and 360x740, real Chromium):
1. Cut-off: `#modal.cmpwin` is a fixed shell (`max-height:94vh`,
   `overflow:hidden`, flex column). On phones `.cmp3` (the add-apps picker
   plus the grid column) stood at full natural height with NO vertical
   scroller anywhere in the chain (`.cmp3-view` is `overflow:visible` on
   phones since v37), so everything below the fold was clipped by the
   shell and simply unreachable. The grid itself was fine; the window had
   nowhere to scroll.
2. A dead blank band inside the grid: the desktop equal-height rule
   `.cmp-flex{min-height:100%}` stretched the grid part to the stretched
   grid track once the column became a scroller (measured: flex 553px vs
   453px of real rows).
3. Lag: phone URL bars fire `resize` on every collapse/expand while
   scrolling; the debounced handler rebuilt the ENTIRE compare grid on
   each event (innerHTML churn + every counter re-animating). Plus per
   cell entrance animations on ~45 cells, a `grid-template-columns .3s`
   tween on every row (full layout per frame while toggling), and a wide
   blur shadow on the ten pinned labels repainting during swipes.

Fixes (CSS v39 layer appended at EOF of `static/styles.css`; two guarded
edits in `static/app.js` applied by a throwaway `scripts/patch_v39.py`):
- `<=920px`: `.modal.cmpwin .cmp3` becomes the real vertical scroller
  (`min-height:0; overflow-y:auto; overscroll-behavior:contain`), the
  view loses its own nested max-height, and `.cmp-flex{min-height:0}`
  kills the dead band. The shell is sized `min(94vh,94dvh)` so an open
  URL bar never hides the bottom of the sheet either. Scrolling lifts the
  add-apps panel away and the whole table down to the foot note reads at
  once; the horizontal swipe with the pinned metric column is unchanged.
- `<=760px`: cells render instantly (`animation:none`), the column tween
  is off, the pinned-label edge shadow is lighter, the window rises in
  .36s instead of .5s.
- JS: `cmpGridNarrow` remembers the layout mode the open grid was built
  for; the resize handler rebuilds the grid only when that mode actually
  flips, and the trend chart redraws only when the viewport WIDTH changes
  (height-only URL-bar events no longer touch main thread mid-scroll).

Verification (real Chromium, both phone viewports, plus full regression):
mobile_check 32 (was 26; three new per viewport: window scrolls and the
last row + foot are reachable at max scroll, cells carry no entrance
animation and rows no column tween, a height-only viewport resize keeps
the very same grid node alive) · browser_check 95 · pytest 10 · registry
recall 44 · compat 30 · diffing 30 · v15_views 57 · render_smoke PASS ·
compare_flow PASS · lookup_429 23. Curated gallery shot swapped to
`v39-mobile-compare.png` (picker lifted, full table in one screen).

### v39b addendum: phones open already reading the table

Even with the scroller in place, the window opened at the very top
(picker first, table below the fold), which still read as "cut off" at a
glance. `openCompare` now sets the scroller to the picker's height on
phones when a selection is already on the board, so the window opens on
the head cards and the full metric table, with the picker's tail as the
cue that one scroll up brings the add-apps list back. The foot note on
phones adds "Scroll the window up for the app picker." Empty selection
still opens on the picker, where building the comparison starts.

mobile_check 34 (one new per viewport: open state shows the head cards
with the picker above the fold) · browser_check 95 · v15_views 57 ·
render_smoke PASS · compare_flow PASS · pytest 10. Demo and upload zip
rebuilt with v39b inside and cold-boot proven.

### v39c addendum: deploy proof and the last phone gap

The live Render site was probed while this round ran: its served HTML
contained no `cmpwin` at all and neither asset hash matched any build
since the compare rework, i.e. the deployment predates v37/v38/v39
entirely. Every "still cut" report was made against that fossil build.
To make this provable forever, `static/index.html` now carries
`<meta name="build" content="v39c">` and `init()` logs
`MCP Integration Explorer build v39c` to the console: view-source or
console on any deployment and you know exactly what it serves.

Last phone gap closed: adding the FIRST app from an empty compare window
left the fresh table below the fold while the reader faced the picker;
the scroller now glides to the table the moment the grid appears
(instant under prefers-reduced-motion). The compare head also gives its
desktop padding back on phones (~30px more room for rows).

Suites: mobile_check 36 (one new per viewport: first add glides to the
table, head cards in view) · browser_check 95 · pytest 10 · registry 44 ·
compat 30 · diffing 30 · v15_views 57 · render_smoke PASS ·
compare_flow PASS. Demo and upload zip rebuilt with v39c inside.

### v39c addendum 2: cache-busting the fossil build forever

The served asset tags still carried `?v=18`, a query string unchanged for
months: any proxy or browser cache that ever stored that URL keeps
replaying the fossil copy no matter what the origin now says (the
no-store middleware only helps caches that obey the CURRENT response).
All three tags (styles, snapshot, app) now carry `?v=39c`, so the first
request after a deploy is a URL no cache has ever seen. The phone glide
also falls back to a plain scrollTop assignment where
scrollTo(options) is unavailable. Suites re-run green: mobile 36,
browser 95, compare_flow PASS, render_smoke PASS, pytest 10.

### v39d addendum: landscape phones are mobile too

A landscape phone is wider than 760px, so every portrait-only perf rule
missed it: the staggered cell pop (up to ~280ms of invisible cells) and
the column-width tween still ran there. The perf rules now key on
`@media(hover:none)` as well, i.e. any touch device in any orientation
gets instant cells and no tweens; desktop pointers keep the motion.
mobile_check grew a 844x390 probe (cells fully opaque the instant the
grid attaches; window scrolls to its foot; page never sideways): 38
checks pass. browser_check 95 unchanged (hover:hover keeps the motion).
Demo and upload zip rebuilt with v39d inside.

## 11. v40: the compare dock, rebuilt for phones

The last remaining phone bug, straight from a real device shot: add four
apps from the home screen and the dock blew up. The old dock was a single
flex row (label, chips, Clear, Compare) with `max-width:calc(100vw - 32px)`:
the chips wrapped into a four-storey tower, the row ran out of width, and
the Compare button got squeezed until its own label clipped ("Com..."),
half outside the box. The dock also ate a third of the screen.

The v40 CSS layer (EOF of styles.css, keyed on
`@media(max-width:760px), (hover:none) and (max-width:920px)` so landscape
phones get it too) turns the dock into a three-row grid:

- row 1: the label, now live-counted by renderCompareBar ("Compare 4/4"),
  with Clear parked top-right;
- row 2: the chips on ONE row, `flex-wrap:nowrap` + `overflow-x:auto` with
  hidden scrollbars and touch scrolling, so four long names stay a compact
  swipeable strip instead of a tower;
- row 3: the Compare button at `width:100%`, its own grid row, so it can
  never be clipped or pushed out again.

The dock is `width:calc(100vw - 20px)`, sits on
`bottom:calc(10px + env(safe-area-inset-bottom,0px))` for gesture-bar
phones, and its parked slide now uses `translateY(calc(100% + 28px))` so a
taller dock still hides completely offscreen. Desktop (hover:hover, wide)
keeps the original one-row dock untouched.

New regression checks in tests/mobile_check.py (38 -> 41): at 390x844 and
360x740, after clearing the board and adding four apps straight from the
home list, the Compare and Clear boxes must sit wholly inside the dock
box, all chips must share one row, the dock height must stay <= 160px and
the label must read "n/4"; the 844x390 landscape probe repeats the
button-whole and one-row assertions. Curated shot: v40-dock-4apps.png
(whitelisted in .gitignore, swapped into the README gallery).

Suites: mobile_check 41 · browser_check 95 · pytest 10 · registry 44 ·
compat 30 · diffing 30 · v15_views 57 · render_smoke PASS ·
compare_flow PASS · lookup_429 23. Build marker and asset tags bumped to
v40 / ?v=40; demo.html and the upload zip (47 entries, now carrying the
v40 dock shot) rebuilt and cold-boot verified: meta v40, three ?v=40 tags,
v40 LAYER and the counted label present in both the served static files
and the standalone demo.
