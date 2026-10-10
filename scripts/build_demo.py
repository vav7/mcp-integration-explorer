#!/usr/bin/env python3
"""Build the self-contained, offline `demo.html` at the repository root.

The demo is the live dashboard with every asset inlined:

  * `static/styles.css` (+ every extra local stylesheet the HTML links)
  * `static/app.js`, `motion.js`, `help.js`, `premium.js`
  * the REAL last-refresh snapshot (`static/data.snapshot.js`) as
    `window.__SNAPSHOT__`, plus `window.__OFFLINE_DEMO__ = true` so app.js
    renders instantly without ever touching the network.

Open the produced file straight from disk (double-click) and the whole
dashboard works: explorer, atlas, compare, dossier, methodology, help.

Usage:  python3 scripts/build_demo.py [--out PATH] [--quiet]
Exit 0 on success. Never fails silently: missing inputs are an error.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "static"

CSS_FILES = ["styles.css", "views.css"]
JS_FILES = ["app.js", "motion.js", "help.js", "premium.js"]


def _read(p: Path) -> str:
    if not p.is_file():
        raise SystemExit(f"build_demo: missing input {p.relative_to(ROOT)}")
    return p.read_text(encoding="utf-8")


def _safe_js(blob: str) -> str:
    """Neutralise anything that would terminate the inline <script> early."""
    return blob.replace("</script", "<\\/script").replace("<!--", "<\\!--")


def _safe_css(blob: str) -> str:
    return blob.replace("</style", "<\\/style")


def build(out: Path) -> int:
    html = _read(STATIC / "index.html")

    css = "\n\n".join(f"/* ===== {n} ===== */\n{_safe_css(_read(STATIC / n))}" for n in CSS_FILES)
    js = "\n\n".join(f"/* ===== {n} ===== */\n{_safe_js(_read(STATIC / n))}" for n in JS_FILES)

    snap_js = STATIC / "data.snapshot.js"
    if snap_js.is_file():
        snapshot = _safe_js(snap_js.read_text(encoding="utf-8"))
    else:  # fall back to the committed live cache so a demo can always build
        import json
        cache = ROOT / "data" / "live_cache.json"
        payload = json.loads(cache.read_text(encoding="utf-8")) if cache.is_file() else {}
        snapshot = "window.__SNAPSHOT__ = " + _safe_js(json.dumps(payload, ensure_ascii=False)) + ";"

    # ---- swap the external local assets for inline blocks ------------------
    # stylesheets: drop every local <link rel="stylesheet"> (keep remote fonts)
    html, n_css = re.subn(
        r'<link rel="stylesheet" href="/[^"]+">\n?',
        "",
        html,
    )
    # scripts: drop the four local app scripts (keep nothing else - there is none)
    html, n_js = re.subn(r'<script src="/[^"]+"></script>\n?', "", html)
    if n_css == 0 or n_js == 0:
        raise SystemExit(f"build_demo: could not find local asset tags in index.html "
                         f"(css={n_css}, js={n_js}) - markup changed?")

    head_block = f'<style>\n{css}\n</style>\n</head>'
    if "</head>" not in html:
        raise SystemExit("build_demo: index.html has no </head>")
    html = html.replace("</head>", head_block, 1)

    body_block = (
        "<script>\nwindow.__OFFLINE_DEMO__ = true;\n"
        + snapshot
        + "\n</script>\n<script>\n"
        + js
        + "\n</script>\n</body>"
    )
    if "</body>" not in html:
        raise SystemExit("build_demo: index.html has no </body>")
    html = html.replace("</body>", body_block, 1)

    # offline builds must never try the remote favicon proxy etc. - harmless,
    # but mark the document so future code can detect demo mode.
    html = html.replace('<meta name="build"', '<meta name="demo" content="offline-snapshot">\n<meta name="build"', 1)

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    return len(html.encode("utf-8"))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default=str(ROOT / "demo.html"))
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args()
    size = build(Path(a.out))
    if not a.quiet:
        print(f"demo.html written: {size / 1e6:.2f} MB (self-contained, offline)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
