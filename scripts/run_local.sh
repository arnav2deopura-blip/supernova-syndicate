#!/usr/bin/env bash
# Run the site on this machine.
#   scripts/run_local.sh            frontend only, using the deployed backend (nothing to install but Python)
#   scripts/run_local.sh --backend  also start the backend here (port 8000) and point the page at it
# Stop with Ctrl+C. Ports: FRONTEND_PORT (default 5500), BACKEND_PORT (default 8000).
set -euo pipefail
cd "$(dirname "$0")/.."

FRONTEND_PORT="${FRONTEND_PORT:-5500}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
WITH_BACKEND=0
[[ "${1:-}" == "--backend" ]] && WITH_BACKEND=1

PY="$(command -v python3 || command -v python)"
[[ -n "$PY" ]] || { echo "Python 3 is needed: https://www.python.org/downloads/"; exit 1; }

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

if [[ $WITH_BACKEND == 1 ]]; then
  if [[ ! -x .venv/bin/python ]]; then
    echo "Creating .venv and installing the backend (first time only, a few minutes)…"
    "$PY" -m venv .venv
    .venv/bin/pip install -q --upgrade pip
    .venv/bin/pip install -q -r backend/requirements.txt
  fi
  if port_busy "$BACKEND_PORT"; then
    echo "Port $BACKEND_PORT is busy: is a backend already running? Using it."
  else
    ALLOWED_ORIGINS="http://localhost:$FRONTEND_PORT,http://127.0.0.1:$FRONTEND_PORT" \
      .venv/bin/uvicorn backend.server:app --port "$BACKEND_PORT" &
    pids+=($!)
  fi
fi

if port_busy "$FRONTEND_PORT"; then
  echo "Port $FRONTEND_PORT is busy. Run with FRONTEND_PORT=5600 $0 $*"; exit 1
fi
"$PY" -m http.server "$FRONTEND_PORT" --bind 127.0.0.1 --directory frontend >/dev/null 2>&1 &
pids+=($!)

if [[ $WITH_BACKEND == 1 ]]; then
  api="local"; [[ "$BACKEND_PORT" != 8000 ]] && api="http://localhost:$BACKEND_PORT"
  url="http://localhost:$FRONTEND_PORT/?api=$api"
  echo; echo "Backend:  http://localhost:$BACKEND_PORT/docs"
else
  url="http://localhost:$FRONTEND_PORT/?api=default"
  echo; echo "Backend:  the deployed one (Azure)"
fi
echo "Open:     $url"
echo "Ctrl+C stops everything."
wait
