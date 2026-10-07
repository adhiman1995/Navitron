#!/usr/bin/env bash
# Copy the browser builds of MapLibre GL JS and pmtiles out of node_modules
# into web/vendor/ so the page never touches a CDN at runtime.
#
# Re-run this after `npm install` or after bumping either dependency.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/web/vendor"
MLG="$ROOT/node_modules/maplibre-gl"
PMT="$ROOT/node_modules/pmtiles"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

for d in "$MLG" "$PMT"; do
  if [ ! -d "$d" ]; then
    echo "error: $(basename "$d") is not installed. Run: npm install" >&2
    exit 1
  fi
done

mkdir -p "$VENDOR"

# MapLibre GL JS 5+/6+ is distributed as ES modules only: there is no UMD
# bundle to drop in with a classic <script> tag. maplibre-gl.mjs resolves
# maplibre-gl-worker.mjs against its own import.meta.url and spawns it as a
# module worker, so the two files have to sit side by side.
cp "$MLG/dist/maplibre-gl.mjs" \
   "$MLG/dist/maplibre-gl-worker.mjs" \
   "$MLG/dist/maplibre-gl.css" \
   "$VENDOR/"

# pmtiles' dist/esm/index.js is pre-bundled but still imports fflate by bare
# specifier, which a browser cannot resolve without an import map. Vendor
# fflate's self-contained browser ESM build next to it and rewrite the
# specifier to a relative path.
FFL="$ROOT/node_modules/fflate"
[ -d "$FFL" ] || die "fflate is not installed (it is a pmtiles dependency). Run: npm install"
cp "$FFL/esm/browser.js" "$VENDOR/fflate.mjs"
sed -e 's|from"fflate"|from"./fflate.mjs"|g' \
    -e "s|from'fflate'|from'./fflate.mjs'|g" \
    -e 's|from "fflate"|from "./fflate.mjs"|g' \
    "$PMT/dist/esm/index.js" > "$VENDOR/pmtiles.mjs"

# Nothing in web/vendor/ may import a bare specifier: the browser loads these
# files directly, with no bundler and no import map.
BARE="$(grep -oE 'from["'"'"'][a-zA-Z@][^"'"'"']*["'"'"']' "$VENDOR"/*.mjs | grep -v 'fflate.mjs' || true)"
if [ -n "$BARE" ]; then
  echo "error: unresolved bare import(s) in web/vendor — the page will fail to load:" >&2
  printf '%s\n' "$BARE" >&2
  exit 1
fi

{
  echo "# Vendored at $(date -u +%Y-%m-%dT%H:%M:%SZ) by scripts/sync-vendor.sh"
  echo "maplibre-gl $(node -p "require('$MLG/package.json').version")  (BSD-3-Clause)"
  echo "pmtiles     $(node -p "require('$PMT/package.json').version")  (BSD-3-Clause)"
  echo "fflate      $(node -p "require('$ROOT/node_modules/fflate/package.json').version")  (MIT, pmtiles dependency)"
} > "$VENDOR/VERSIONS.txt"

echo "Vendored into web/vendor/:"
ls -1 "$VENDOR"
