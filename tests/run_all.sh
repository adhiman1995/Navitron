#!/usr/bin/env bash
# Everything that can be checked without a browser or a Planetiler run:
#   syntax, style-spec validation, no-third-party-host audit, the terrain
#   pipeline offline, HTTP Range behaviour, and a PMTiles round-trip read back
#   through the real browser library.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
FAILED=()
step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
run()  { if "${@:2}"; then printf 'OK    %s\n' "$1"; else FAILED+=("$1"); printf 'FAIL  %s\n' "$1"; fi; }

step "JavaScript syntax"
for f in web/*.js scripts/*.mjs tests/*.mjs; do
  run "node --check $f" node --check "$f"
done

step "Python syntax"
run "py_compile scripts/ tests/" python3 -m py_compile \
  scripts/build_terrain.py scripts/serve.py scripts/fetch_fonts.py scripts/_net.py tests/make_test_dem.py

step "Shell syntax"
for f in scripts/*.sh tests/*.sh; do
  run "bash -n $f" bash -n "$f"
done

step "Style specification"
run "validate-style" node scripts/validate-style.mjs

step "No third-party map services referenced"
run "host audit" bash tests/test_no_third_party.sh

step "Terrain coverage of the built archive"
run "terrain coverage" node tests/check_terrain_coverage.mjs

step "Terrain pipeline (offline)"
run "test_terrain" bash tests/test_terrain.sh

step "HTTP Range support"
run "test_range" bash tests/test_range.sh

step "PMTiles round-trip through the browser library"
run "test_roundtrip" bash tests/test_roundtrip.sh

step "Browser smoke test (optional)"
# Needs Playwright and real data in web/data. Skipped otherwise, because the
# suite must stay runnable on a clean checkout with nothing built yet.
if [ ! -s web/data/map.pmtiles ]; then
  printf 'SKIP  web/data/map.pmtiles has not been built yet\n'
elif ! node -e "require(process.env.PLAYWRIGHT_MODULE||'playwright')" >/dev/null 2>&1; then
  printf 'SKIP  Playwright is not installed (npm i -D playwright && npx playwright install chromium)\n'
else
  SMOKE_PORT="${SMOKE_PORT:-8109}"
  python3 scripts/serve.py --port "$SMOKE_PORT" --quiet >/dev/null 2>&1 &
  SMOKE_SRV=$!
  disown "$SMOKE_SRV" 2>/dev/null || true
  for _ in $(seq 40); do curl -s -o /dev/null "http://127.0.0.1:$SMOKE_PORT/index.html" && break; sleep 0.1; done
  run "smoke_browser" node tests/smoke_browser.mjs "http://127.0.0.1:$SMOKE_PORT" tests/screenshots
  kill "$SMOKE_SRV" 2>/dev/null
fi

printf '\n'
if [ "${#FAILED[@]}" -eq 0 ]; then
  printf '\033[32mall suites passed\033[0m\n'
  exit 0
fi
printf '\033[31m%d suite(s) failed:\033[0m\n' "${#FAILED[@]}"
printf '  - %s\n' "${FAILED[@]}"
exit 1
