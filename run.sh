#!/usr/bin/env bash
# Convenience launcher for the MCP Integration Explorer.
#   ./run.sh            -> start the live server on :8000
#   PORT=9000 ./run.sh  -> custom port
#   ./run.sh once       -> one-shot refresh (no server), then build demo.html
set -euo pipefail
cd "$(dirname "$0")"

if [ "${1:-}" = "once" ]; then
  python3 scripts/refresh_once.py
  python3 scripts/build_demo.py
  exit 0
fi

PORT="${PORT:-8000}"
if [ ! -d ".venv" ] && command -v python3 >/dev/null 2>&1; then
  python3 -c "import fastapi, uvicorn, httpx" 2>/dev/null || {
    echo "Installing dependencies…"; python3 -m pip install -r requirements.txt;
  }
fi
echo "MCP Integration Explorer -> http://localhost:${PORT}"
exec python3 -m uvicorn src.app:app --host 0.0.0.0 --port "${PORT}" --reload
