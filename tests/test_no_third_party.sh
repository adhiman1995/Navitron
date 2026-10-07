#!/usr/bin/env bash
# The runtime must not reach a commercial map service or a CDN. Everything the
# page loads has to come from this origin. Build scripts are allowed to talk to
# OSM/Geofabrik/GitHub/AWS-open-data at build time; the served page is not.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAIL=0

# Hosts that must appear nowhere in web/ (excluding vendored library code,
# whose own comments and docs URLs we do not control).
BANNED='(googleapis|google\.com|gstatic|maps\.google|mapbox\.com|tiles\.mapbox|arcgis|esri\.com|here\.com|tomtom|cartocdn|basemaps\.cartocdn|unpkg\.com|jsdelivr|cdnjs|cdn\.maptiler|api\.maptiler|openstreetmap\.org/\{z\})'

echo "Scanning web/ (excluding web/vendor/) for third-party hosts…"
HITS="$(grep -rInE "$BANNED" web --include='*.js' --include='*.html' --include='*.css' --include='*.json' \
        2>/dev/null | grep -v '^web/vendor/' || true)"
if [ -n "$HITS" ]; then
  echo "FAIL  third-party host referenced in served files:"
  printf '%s\n' "$HITS"
  FAIL=1
else
  echo "PASS  no third-party map service or CDN referenced in web/"
fi

# Any absolute URL the page actually LOADS is suspect. Plain <a href> links in
# the attribution are fine: a click navigates, it does not fetch a resource.
echo "Checking for absolute URLs loaded at runtime…"
LOADS="$(grep -rInE "src=\"https?://|<link[^>]+href=\"https?://|@import[^;]*https?://|fetch\(\s*[\"'\`]https?://|importScripts\(|new Worker\(\s*[\"'\`]https?://|from\s*[\"']https?://" \
         web --include='*.js' --include='*.html' --include='*.css' 2>/dev/null | grep -v '^web/vendor/' || true)"
if [ -n "$LOADS" ]; then
  echo "FAIL  the page loads something over the network:"
  printf '%s\n' "$LOADS"
  FAIL=1
else
  echo "PASS  every script, style and tile request is same-origin and relative"
fi

# The three required attributions must actually be present.
for needle in 'OpenStreetMap' 'OpenMapTiles' 'Joerd'; do
  if grep -q "$needle" web/config.js; then
    echo "PASS  attribution mentions $needle"
  else
    echo "FAIL  attribution is missing $needle"
    FAIL=1
  fi
done

exit "$FAIL"
