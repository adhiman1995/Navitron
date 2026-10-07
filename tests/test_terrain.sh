#!/usr/bin/env bash
# Offline tests for scripts/build_terrain.py: a successful file:// build,
# resume-from-cache, the tile-count safety limit, bad input, and the promise
# that a failed run never leaves a partial archive behind.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
PASS=0; FAIL=0
BOUNDS="73.80,18.45,73.90,18.55"

trap 'rm -rf "$TMP"' EXIT
ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n      %s\n' "$1" "${2:-}"; }

build() { python3 "$ROOT/scripts/build_terrain.py" "$@" 2>&1; }

python3 "$ROOT/tests/make_test_dem.py" --out "$TMP/dem" --bounds "$BOUNDS" --maxzoom 7 >/dev/null

# ---- 1. a clean offline build ---------------------------------------------
OUT="$TMP/a.pmtiles"
if build --source "file://$TMP/dem" --bounds "$BOUNDS" --maxzoom 7 \
         --output "$OUT" --cache-dir "$TMP/cache" >"$TMP/log1"; then
  [ -s "$OUT" ] && ok "offline build from file:// writes an archive" \
                || bad "offline build from file:// writes an archive" "output missing"
else
  bad "offline build from file:// writes an archive" "$(tail -3 "$TMP/log1")"
fi
grep -q "8 fetched" "$TMP/log1" && ok "first run fetches every tile" \
  || bad "first run fetches every tile" "$(grep tiles "$TMP/log1" | tail -1)"

# ---- 2. the cache makes a second run resume -------------------------------
build --source "file://$TMP/dem" --bounds "$BOUNDS" --maxzoom 7 \
      --output "$TMP/b.pmtiles" --cache-dir "$TMP/cache" >"$TMP/log2"
grep -q "8 cached" "$TMP/log2" && ok "second run is served entirely from cache" \
  || bad "second run is served entirely from cache" "$(grep tiles "$TMP/log2" | tail -1)"
cmp -s "$OUT" "$TMP/b.pmtiles" && ok "two runs produce identical archives" \
  || bad "two runs produce identical archives" "byte difference"

# ---- 3. missing tiles are tolerated, not fatal ----------------------------
python3 "$ROOT/tests/make_test_dem.py" --out "$TMP/holey" --bounds "$BOUNDS" \
        --maxzoom 7 --skip 7/90/57 >/dev/null
if build --source "file://$TMP/holey" --bounds "$BOUNDS" --maxzoom 7 \
         --output "$TMP/c.pmtiles" --cache-dir "$TMP/cache3" >"$TMP/log3"; then
  grep -q "1 tile(s) were not available" "$TMP/log3" \
    && ok "an absent tile is reported and skipped" \
    || bad "an absent tile is reported and skipped" "$(tail -3 "$TMP/log3")"
else
  bad "an absent tile is reported and skipped" "build failed: $(tail -3 "$TMP/log3")"
fi

# ---- 4. the tile-count safety limit --------------------------------------
LOG="$(build --source "file://$TMP/dem" --bounds "$BOUNDS" --maxzoom 7 \
             --output "$TMP/d.pmtiles" --cache-dir "$TMP/cache4" --max-tiles 3)"
if [ ! -e "$TMP/d.pmtiles" ] && printf '%s' "$LOG" | grep -q "safety limit"; then
  ok "the tile-count limit aborts before writing anything"
else
  bad "the tile-count limit aborts before writing anything" "$LOG"
fi
printf '%s' "$LOG" | grep -q -- "--max-tiles 8" \
  && ok "the limit error names the exact override to use" \
  || bad "the limit error names the exact override to use" "$LOG"

# ---- 5. bad input is rejected with a clear message ------------------------
for args in "--bounds 1,2,3" "--bounds 74,18.4,73.7,18.6" "--bounds a,b,c,d"; do
  # shellcheck disable=SC2086
  LOG="$(build --source "file://$TMP/dem" $args --output "$TMP/e.pmtiles" --cache-dir "$TMP/c5")"
  if [ ! -e "$TMP/e.pmtiles" ] && printf '%s' "$LOG" | grep -qi "error:.*bounds"; then
    ok "rejects $args"
  else
    bad "rejects $args" "$LOG"
  fi
done

LOG="$(build --source "file://$TMP/does-not-exist" --bounds "$BOUNDS" --maxzoom 2 \
             --output "$TMP/f.pmtiles" --cache-dir "$TMP/c6")"
if [ ! -e "$TMP/f.pmtiles" ] && printf '%s' "$LOG" | grep -q "does not exist"; then
  ok "a missing --source directory is a clear error, with no archive written"
else
  bad "a missing --source directory is a clear error, with no archive written" "$LOG"
fi

LOG="$(build --source "ftp://example.invalid/{z}/{x}/{y}.png" --bounds "$BOUNDS" --maxzoom 1 \
             --output "$TMP/g.pmtiles" --cache-dir "$TMP/c7")"
printf '%s' "$LOG" | grep -q "must be http" \
  && ok "an unsupported --source scheme is rejected" \
  || bad "an unsupported --source scheme is rejected" "$LOG"

LOG="$(build --source "https://example.invalid/tiles.png" --bounds "$BOUNDS" --maxzoom 1 \
             --output "$TMP/h.pmtiles" --cache-dir "$TMP/c8")"
printf '%s' "$LOG" | grep -q "missing {z}" \
  && ok "a URL template without {z}/{x}/{y} is rejected" \
  || bad "a URL template without {z}/{x}/{y} is rejected" "$LOG"

# ---- 6. a non-PNG source aborts without writing an archive ---------------
mkdir -p "$TMP/junk/0/0" && printf 'not a png at all' > "$TMP/junk/0/0/0.png"
LOG="$(build --source "file://$TMP/junk" --bounds "$BOUNDS" --maxzoom 0 \
             --output "$TMP/i.pmtiles" --cache-dir "$TMP/c9")"
if [ ! -e "$TMP/i.pmtiles" ] && printf '%s' "$LOG" | grep -q "not a PNG"; then
  ok "non-PNG source data aborts the build, leaving no archive"
else
  bad "non-PNG source data aborts the build, leaving no archive" "$LOG"
fi

# ---- 7. an empty source is an error, not an empty archive ----------------
mkdir -p "$TMP/empty"
LOG="$(build --source "file://$TMP/empty" --bounds "$BOUNDS" --maxzoom 3 \
             --output "$TMP/j.pmtiles" --cache-dir "$TMP/c10")"
if [ ! -e "$TMP/j.pmtiles" ] && printf '%s' "$LOG" | grep -q "no tiles"; then
  ok "an empty source never produces an empty archive"
else
  bad "an empty source never produces an empty archive" "$LOG"
fi

# ---- 8. --region: several boxes at different zooms in one archive --------
python3 "$ROOT/tests/make_test_dem.py" --out "$TMP/multi" --bounds "73.0,18.0,75.0,19.0" --maxzoom 9 >/dev/null
LOG="$(build --source "file://$TMP/multi" --region "73.0,18.0,75.0,19.0:7" \
             --region "73.80,18.45,73.90,18.55:9" \
             --output "$TMP/multi.pmtiles" --cache-dir "$TMP/cmulti")"
if [ -s "$TMP/multi.pmtiles" ]; then
  ok "--region builds one archive from several boxes"
else
  bad "--region builds one archive from several boxes" "$LOG"
fi
# The coarse box must not pull in the fine box's zooms, so the total has to be
# below a single z9 build of the whole area.
WIDE="$(printf '%s' "$LOG" | awk '/^Tiles/ {print $2}' | tr -d ,)"
FULL="$(python3 -c "
import sys; sys.path.insert(0,'$ROOT/scripts')
from build_terrain import count_tiles, parse_bounds
print(count_tiles(parse_bounds('73.0,18.0,75.0,19.0'), 0, 9))")"
if [ -n "$WIDE" ] && [ "$WIDE" -lt "$FULL" ]; then
  ok "--region keeps the fine zooms inside the small box ($WIDE tiles vs $FULL for a flat z9 build)"
else
  bad "--region keeps the fine zooms inside the small box" "region=$WIDE flat=$FULL"
fi
# And the archive header must advertise the deepest zoom present.
HDRMAX="$(python3 -c "
from pmtiles.reader import Reader, MmapSource
with open('$TMP/multi.pmtiles','rb') as f:
    print(Reader(MmapSource(f)).header()['max_zoom'])" 2>/dev/null)"
[ "$HDRMAX" = "9" ] && ok "--region archive header reports maxzoom 9" \
  || bad "--region archive header reports maxzoom 9" "got '$HDRMAX'"

LOG="$(build --source "file://$TMP/multi" --region "73.0,18.0,75.0,19.0" \
             --output "$TMP/bad.pmtiles" --cache-dir "$TMP/cbad")"
if [ ! -e "$TMP/bad.pmtiles" ] && printf '%s' "$LOG" | grep -q "region needs"; then
  ok "--region without a zoom is rejected"
else
  bad "--region without a zoom is rejected" "$LOG"
fi

# ---- 9. the coverage check must actually catch a holey archive ----------
# A country-coarse + city-fine archive is exactly the shape that renders flat
# terrain outside the city, so the check has to fail on it.
build --source "file://$TMP/multi" --region "73.0,18.0,75.0,19.0:7" \
      --region "73.80,18.45,73.90,18.55:9" \
      --output "$TMP/holey.pmtiles" --cache-dir "$TMP/cmulti" >/dev/null
if TERRAIN_ARCHIVE="$TMP/holey.pmtiles" TERRAIN_BOUNDS="73.0,18.0,75.0,19.0" TERRAIN_MAXZOOM=9 \
     node "$ROOT/tests/check_terrain_coverage.mjs" 4 >"$TMP/cov1" 2>&1; then
  bad "coverage check fails on a mixed-zoom archive" "it passed, so the check is useless: $(tail -2 "$TMP/cov1")"
else
  grep -q "render FLAT terrain" "$TMP/cov1" \
    && ok "coverage check fails on a mixed-zoom archive, and says why" \
    || bad "coverage check fails on a mixed-zoom archive, and says why" "$(tail -3 "$TMP/cov1")"
fi
# ...and must pass on the uniform one.
if TERRAIN_ARCHIVE="$TMP/a.pmtiles" TERRAIN_BOUNDS="$BOUNDS" TERRAIN_MAXZOOM=7 \
     node "$ROOT/tests/check_terrain_coverage.mjs" 4 >"$TMP/cov2" 2>&1; then
  ok "coverage check passes on a uniform archive"
else
  bad "coverage check passes on a uniform archive" "$(tail -3 "$TMP/cov2")"
fi

# ---- 10. no stray temp files are left in the output directory ------------
STRAY="$(find "$TMP" -maxdepth 1 -name '.terrain-*' | wc -l | tr -d ' ')"
[ "$STRAY" = "0" ] && ok "no partial .pmtiles temp files are left behind" \
  || bad "no partial .pmtiles temp files are left behind" "$STRAY found"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
