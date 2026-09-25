#!/usr/bin/env python3
"""Build a single-file, self-contained demo.html from the live dashboard.

Inlines styles.css, the real last-fetch snapshot (data.snapshot.js) and app.js
into static/index.html so the dashboard can be opened/previewed directly with no
backend. The real app still runs via `uvicorn src.app:app`; this is only a
portable snapshot view. Data is the genuine last fetch, never fabricated.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "static"


def read(p: Path) -> str:
    return p.read_text(encoding="utf-8")


def main() -> None:
    html = read(STATIC / "index.html")
    css = read(STATIC / "styles.css")
    js = read(STATIC / "app.js")
    snap_file = STATIC / "data.snapshot.js"
    snap = read(snap_file) if snap_file.exists() else "window.__SNAPSHOT__ = null;\n"

    import re as _re
    html = _re.sub(r'<link rel="stylesheet" href="/?styles\.css(\?[^"]*)?">', lambda m: f"<style>\n{css}\n</style>", html)
    html = _re.sub(r'<script src="/?data\.snapshot\.js(\?[^"]*)?"></script>', lambda m: f"<script>window.__OFFLINE_DEMO__=true;\n{snap}\n</script>", html)
    html = _re.sub(r'<script src="/?app\.js(\?[^"]*)?"></script>', lambda m: f"<script>\n{js}\n</script>", html)
    # Mark it clearly as a portable snapshot.
    html = html.replace("<title>MCP Integration Explorer", "<title>MCP Integration Explorer (snapshot)")

    out = ROOT / "demo.html"
    out.write_text(html, encoding="utf-8")
    print(f"Wrote {out} ({out.stat().st_size/1024:.0f} KB, self-contained)")


if __name__ == "__main__":
    main()
