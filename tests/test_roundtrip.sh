#!/usr/bin/env bash
# End-to-end, no network: generate synthetic Terrarium tiles, pack them with
# scripts/build_terrain.py, serve them with scripts/serve.py, then read the
# archive back with the browser pmtiles library and compare every tile.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${1:-8108}"
TMP="$(mktemp -d)"
BOUNDS="73.80,18.45,73.90,18.55"

cleanup() { [ -n "${SRV_PID:-}" ] && kill "$SRV_PID" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

mkdir -p "$TMP/srv"
python3 "$ROOT/tests/make_test_dem.py" --out "$TMP/dem" --bounds "$BOUNDS" --maxzoom 7 >/dev/null || exit 1
python3 "$ROOT/scripts/build_terrain.py" --source "file://$TMP/dem" --bounds "$BOUNDS" \
        --maxzoom 7 --output "$TMP/srv/terrain.pmtiles" --cache-dir "$TMP/cache" >/dev/null || exit 1

python3 "$ROOT/scripts/serve.py" --root "$TMP/srv" --port "$PORT" --quiet >"$TMP/serve.log" 2>&1 &
SRV_PID=$!
disown "$SRV_PID" 2>/dev/null || true   # keep the shell quiet when we kill it
for _ in $(seq 40); do curl -s -o /dev/null "http://127.0.0.1:$PORT/terrain.pmtiles" && break; sleep 0.1; done

node "$ROOT/tests/verify_archive.mjs" "http://127.0.0.1:$PORT" terrain.pmtiles "$TMP/dem"
