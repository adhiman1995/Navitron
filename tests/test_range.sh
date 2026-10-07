#!/usr/bin/env bash
# Exercises scripts/serve.py with curl: full GET, byte range, open-ended range,
# suffix range, unsatisfiable range, and the MIME types this stack needs.
# Starts its own server on a spare port and shuts it down again.
#
#   ./tests/test_range.sh [port]
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${1:-8107}"
BASE="http://127.0.0.1:$PORT"
TMP="$(mktemp -d)"
PASS=0; FAIL=0

cleanup() {
  [ -n "${SRV_PID:-}" ] && kill "$SRV_PID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

ok()   { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL  %s\n      expected: %s\n      actual:   %s\n' "$1" "$2" "$3"; }
want() { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }

# A deterministic 1000-byte file plus one of each MIME type we care about.
mkdir -p "$TMP/root"
python3 -c "
import sys
sys.stdout.buffer.write(bytes(i % 256 for i in range(1000)))
" > "$TMP/root/blob.bin"
printf 'export const x = 1;\n' > "$TMP/root/mod.mjs"
head -c 300 "$TMP/root/blob.bin" > "$TMP/root/fake.pmtiles"
printf '<!doctype html><title>t</title>\n' > "$TMP/root/index.html"

python3 "$ROOT/scripts/serve.py" --root "$TMP/root" --port "$PORT" --quiet >"$TMP/serve.log" 2>&1 &
SRV_PID=$!
disown "$SRV_PID" 2>/dev/null || true   # keep the shell quiet when we kill it
for _ in $(seq 40); do
  curl -s -o /dev/null "$BASE/index.html" && break
  sleep 0.1
done
if ! curl -s -o /dev/null "$BASE/index.html"; then
  echo "FAIL  server did not start; log:"; cat "$TMP/serve.log"; exit 1
fi

code()  { curl -s -o /dev/null -w '%{http_code}' "$@"; }
hdr()   { curl -sI "$@" | tr -d '\r' | awk -F': ' -v k="$1" 'tolower($1)==tolower(k){print $2}'; }

# ---- 200: a plain GET ------------------------------------------------------
want "200 on a full GET"            "200"  "$(code "$BASE/blob.bin")"
want "Content-Length is the whole file" "1000" \
     "$(curl -s -o /dev/null -w '%{size_download}' "$BASE/blob.bin")"
want "Accept-Ranges advertised"     "bytes" \
     "$(curl -sI "$BASE/blob.bin" | tr -d '\r' | awk -F': ' 'tolower($1)=="accept-ranges"{print $2}')"

# ---- 206: a closed byte range ---------------------------------------------
want "206 on bytes=0-15"            "206"  "$(code -H 'Range: bytes=0-15' "$BASE/blob.bin")"
want "closed range returns 16 bytes" "16" \
     "$(curl -s -H 'Range: bytes=0-15' -o /dev/null -w '%{size_download}' "$BASE/blob.bin")"
want "Content-Range for bytes=0-15" "bytes 0-15/1000" \
     "$(curl -s -D - -H 'Range: bytes=0-15' -o /dev/null "$BASE/blob.bin" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-range"{print $2}')"
want "range bytes match the file"   "$(python3 -c "
import sys; sys.stdout.write(''.join('%02x'%(i%256) for i in range(100,116)))")" \
     "$(curl -s -H 'Range: bytes=100-115' "$BASE/blob.bin" | xxd -p | tr -d '\n')"

# ---- 206: an open-ended range --------------------------------------------
want "206 on bytes=990-"            "206"  "$(code -H 'Range: bytes=990-' "$BASE/blob.bin")"
want "open-ended range runs to EOF" "10" \
     "$(curl -s -H 'Range: bytes=990-' -o /dev/null -w '%{size_download}' "$BASE/blob.bin")"

# ---- 206: a suffix range (what PMTiles uses for the header) --------------
want "206 on bytes=-127"            "206"  "$(code -H 'Range: bytes=-127' "$BASE/blob.bin")"
want "suffix range returns 127 bytes" "127" \
     "$(curl -s -H 'Range: bytes=-127' -o /dev/null -w '%{size_download}' "$BASE/blob.bin")"
want "Content-Range for bytes=-127" "bytes 873-999/1000" \
     "$(curl -s -D - -H 'Range: bytes=-127' -o /dev/null "$BASE/blob.bin" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-range"{print $2}')"
want "suffix larger than the file clamps" "1000" \
     "$(curl -s -H 'Range: bytes=-5000' -o /dev/null -w '%{size_download}' "$BASE/blob.bin")"

# ---- 416: unsatisfiable --------------------------------------------------
want "416 when start is past EOF"   "416"  "$(code -H 'Range: bytes=1000-1100' "$BASE/blob.bin")"
want "416 carries Content-Range */size" "bytes */1000" \
     "$(curl -s -D - -H 'Range: bytes=5000-6000' -o /dev/null "$BASE/blob.bin" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-range"{print $2}')"
want "416 when end precedes start"  "416"  "$(code -H 'Range: bytes=500-100' "$BASE/blob.bin")"

# ---- MIME types ----------------------------------------------------------
want "'.mjs' is served as JavaScript" "text/javascript" \
     "$(curl -sI "$BASE/mod.mjs" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-type"{print $2}')"
want "'.pmtiles' has its own type"  "application/vnd.pmtiles" \
     "$(curl -sI "$BASE/fake.pmtiles" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-type"{print $2}')"
want "'.pmtiles' is not cached"     "no-cache" \
     "$(curl -sI "$BASE/fake.pmtiles" | tr -d '\r' | awk -F': ' 'tolower($1)=="cache-control"{print $2}')"

# ---- misc ----------------------------------------------------------------
want "404 for a missing file"       "404"  "$(code "$BASE/nope.bin")"
want "a malformed Range falls back to 200" "200" \
     "$(code -H 'Range: lines=1-2' "$BASE/blob.bin")"
want "OPTIONS is answered"          "204"  "$(code -X OPTIONS "$BASE/blob.bin")"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
