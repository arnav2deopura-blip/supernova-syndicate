#!/usr/bin/env bash
# Frontend preview; add --backend for the local API. PYTHON can select an interpreter.
set -euo pipefail
cd "$(dirname "$0")/.."
FRONTEND_PORT="${FRONTEND_PORT:-5500}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
WITH_BACKEND=0
[[ "${1:-}" == "--backend" ]] && WITH_BACKEND=1
PY="${PYTHON:-}"
if [[ -z "$PY" ]]; then
  for candidate in python3.14 python3.13 python3.12 python3 python; do
    if command -v "$candidate" >/dev/null && "$candidate" -c "import sys;sys.exit(sys.version_info < (3,12) if $WITH_BACKEND else sys.version_info < (3,8))"; then
      PY="$(command -v "$candidate")";break
    fi
  done
fi
[[ -n "$PY" ]] || { echo 'Install Python 3.12+ for the backend (or set PYTHON=/path/to/python).';exit 1; }
"$PY" -c "import sys;sys.exit(sys.version_info < (3,12) if $WITH_BACKEND else sys.version_info < (3,8))" || { echo 'The selected Python is too old.';exit 1; }
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
pids=()
cleanup() { if [[ ${#pids[@]} -gt 0 ]];then for p in "${pids[@]}";do kill "$p" 2>/dev/null || true;done;fi; }
trap cleanup EXIT INT TERM
ready() {
  "$PY" - "$1" <<'PY'
import sys,time,urllib.request
for _ in range(120):
 try:
  with urllib.request.urlopen(sys.argv[1],timeout=2) as r:
   if r.status == 200:sys.exit(0)
 except (OSError,ValueError):pass
 time.sleep(.5)
raise SystemExit('Server did not become ready: '+sys.argv[1])
PY
}
if [[ $WITH_BACKEND == 1 ]];then
  if [[ ! -x .venv/bin/python ]];then "$PY" -m venv .venv;fi
  .venv/bin/python -c 'import sys;sys.exit(sys.version_info < (3,12))' || { echo 'Recreate .venv with Python 3.12+.';exit 1; }
  # pip is idempotent and repairs an incomplete existing environment as well.
  .venv/bin/python -m pip install -q -r backend/requirements.txt
  .venv/bin/python -m pip check
  uvicorn_args=(backend.server:app --host 127.0.0.1 --port "$BACKEND_PORT")
  [[ ! -f .env ]] || uvicorn_args+=(--env-file .env)
  if port_busy "$BACKEND_PORT";then echo "Backend port $BACKEND_PORT is busy. Stop it or choose another BACKEND_PORT to run the current code.";exit 1;fi
  if ! port_busy "$BACKEND_PORT";then
    ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-http://localhost:$FRONTEND_PORT,http://127.0.0.1:$FRONTEND_PORT}" \
      .venv/bin/python -m uvicorn "${uvicorn_args[@]}" &
    pids+=($!)
  fi
  ready "http://127.0.0.1:$BACKEND_PORT/api/health"
fi
if port_busy "$FRONTEND_PORT";then echo "Port $FRONTEND_PORT is busy. Set FRONTEND_PORT to a free port.";exit 1;fi
"$PY" -m http.server "$FRONTEND_PORT" --bind 127.0.0.1 --directory frontend >/dev/null &
pids+=($!)
ready "http://127.0.0.1:$FRONTEND_PORT/"
if [[ $WITH_BACKEND == 1 ]];then
  url="http://localhost:$FRONTEND_PORT/?api=http://localhost:$BACKEND_PORT"
  echo "Backend ready: http://localhost:$BACKEND_PORT/docs"
else
  url="http://localhost:$FRONTEND_PORT/?api=default"
fi
echo "Frontend ready: $url"
echo 'Ctrl+C stops the processes started here.'
wait
