# Deploying the MCP Integration Explorer (live)

The app is a single long-running Python (FastAPI) process that serves the
dashboard, refreshes the data in the background, and streams live activity over
SSE. It needs a host that runs a **persistent process** - i.e. Render, Fly.io,
or any Docker/VPS host. (Serverless/static platforms such as Vercel or Netlify
cannot run it: no background scheduler, no writable disk, no long-lived SSE.)

Everything required is already in the repo: `render.yaml`, `fly.toml`,
`Dockerfile`, and a `data/` folder with the last real fetch so cold boots are
instant.

---

## Render - the one-click path (recommended)

1. Push this folder to a GitHub repository (New repository → *uploading an
   existing file* → drag the contents in → commit).
2. Sign in at [render.com](https://render.com) with that GitHub account.
3. **New + → Blueprint → select the repository.** Render reads `render.yaml`
   and pre-fills: Python 3.11, `pip install -r requirements.txt`,
   `uvicorn … --port $PORT`, health check `/api/health`, free plan, auto-deploy
   on push.
4. (Optional) In *Env* add `GITHUB_TOKEN` for higher GitHub rate limits, and
   `EXPLORER_API_KEY` if the site will be public and you want the write
   endpoints protected. Neither is required.
5. **Deploy.** ~2 minutes later you have `https://mcp-integration-explorer.onrender.com`.

What you get, identical to localhost:
- instant boot from the committed `data/`, then the scheduler re-fetches the
  registry / GitHub / npm / probes **every 15 minutes** in the background;
- the dashboard updates itself over the SSE stream (activity feed, tickers);
- ⌘K live lookup of *any* app, the Refresh button, watch/alerts (+ optional
  webhook), and the MCP compatibility tester.

Verify: `https://YOUR-APP.onrender.com/api/health` → `{"ok": true, …,
"apps_loaded": 100}`.

Free-tier realities (both normal, neither fatal):
- the instance **sleeps after ~15 min of no traffic** and takes ~30 s to wake on
  the next visit;
- the **disk is ephemeral**, so watches/alerts/pinned apps reset on a restart.
  The dataset itself is fine: it reloads from the repo on boot and keeps
  refreshing in memory. If you want those to survive, use Fly.io with a volume
  (below) or a VPS.

## Fly.io - persistent volume, still free-ish

```bash
fly launch --copy-config      # reads fly.toml + Dockerfile
fly volumes create mcp_data --region iad
# add to fly.toml:  [mounts] source="mcp_data" destination="/app/data"
fly deploy
```

The volume makes watches/alerts/history/pinned apps survive restarts.
512 MB shared-cpu is plenty; `auto_stop_machines` keeps idle cost at zero.

## Any Docker host / VPS

```bash
docker build -t mcp-explorer .
docker run -d -p 8000:8000 --restart unless-stopped \
  -e GITHUB_TOKEN=... -v mcpdata:/app/data --name mcp-explorer mcp-explorer
```

Image is `python:3.11-slim`, four runtime deps, no build step, no Node. Put
Caddy or nginx in front for TLS, and proxy `/api/stream` **unbuffered** (the
response already sends `X-Accel-Buffering: no`).

---

## Environment variables (all optional)

| Var | Default | Use it when |
|---|---|---|
| `GITHUB_TOKEN` | unset | raising GitHub from ~60 req/h per IP; enables open-ended repo search |
| `EXPLORER_API_KEY` | unset | gating write endpoints (`POST /api/refresh`, `/api/apps`, `/api/watch`, `/api/alerts/read`) behind `X-API-Key` on a public site |
| `NO_AUTO_REFRESH` | `0` | you want a read-only mirror (also use this if several instances share one egress IP, since GitHub quota is per IP) |
| `BLOCK_PRIVATE_URLS` | `1` | keep at `1` on anything public |
| `REFRESH_INTERVAL_FULL` | `900` | tuning the background refresh cadence |
| `MAX_CUSTOM_APPS` / `LOOKUP_COOLDOWN_S` / `SEARCH_CACHE_MAX` | 200 / 30 / 512 | abuse caps on a public deployment |
| `LOOKUP_CACHE_S` / `REGISTRY_CACHE_S` / `UPSTREAM_RETRIES` | 180 / 300 / 2 | tuning the 429 layers: how long a successful lookup/registry answer is reused, and how many backoff retries a throttled registry call gets. Free-tier IPs get throttled constantly; the defaults already turn most of it into cache hits |
| `ALERT_WEBHOOK_URL` | unset | posting fired alerts to Slack/Discord/Zapier |

## If you see 429s

Expected, and handled. The registry, GitHub and npm all throttle shared IPs
(Render's free instance egresses through a pool). This app answers with three
layers - response caches, bounded backoff retries that honour `Retry-After`,
and a lookup result cache - and the UI always says whose limit was hit
("Slow down, not broken" = this app's own cooldown; "Rate limited upstream" =
the registry/GitHub/npm). Set `GITHUB_TOKEN` to lift the GitHub ceiling; a
persistent *registry* throttle usually means several instances share one IP,
in which case run `NO_AUTO_REFRESH=1` on all but one.

## Post-deploy smoke test

```bash
curl -s https://YOUR-HOST/api/health          # {"ok":true,...,"apps_loaded":100}
curl -s https://YOUR-HOST/api/stats | head -c 200
curl -s -X POST https://YOUR-HOST/api/mcp/compatibility-test \
     -H 'Content-Type: application/json' \
     -d '{"url":"https://docs.mcp.cloudflare.com/mcp"}' | head -c 200
```

Then open `/` in a browser: the Live pill is green, the table is populated,
⌘K suggests from the live registry, and the activity feed moves on refresh.

## Not a hosting path, but useful to know

`demo.html` in the repo root is a **self-contained offline snapshot** of the
dashboard (real data, no backend). Open it directly from disk for demos, or
attach it to an issue/PR - it is not a substitute for the live service.
