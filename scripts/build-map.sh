#!/usr/bin/env bash
# Build web/data/map.pmtiles from OpenStreetMap with Planetiler's OpenMapTiles
# profile. Downloads the Planetiler jar on first run; nothing proprietary is
# contacted — only GitHub (the jar) and OSM/Natural Earth mirrors (the data).
#
# Environment variables (all optional):
#   AREA        Geofabrik area to download, e.g. india, monaco, europe/monaco
#               (ignored when OSM_PATH is set).           default: india
#   BOUNDS      west,south,east,north in degrees; clips the output.
#                                        default: 73.70,18.40,74.00,18.65 (Pune)
#   OSM_PATH    Use this local .osm.pbf instead of downloading.
#   HEAP        JVM max heap.                                      default: 6g
#   NODEMAP     Node location map: sortedtable (best for country-sized
#               extracts) | sparsearray (best for the planet) | array.
#                                                        default: sortedtable
#   COMPRESS_TEMP  true trades CPU for much less scratch disk. default: false
#   MIN_FREE_GB Abort unless this much disk is free. Default is estimated from
#               the OSM input size; set to 0 to skip the check.
#   MAXZOOM     Highest vector zoom to generate.                   default: 14
#   MINZOOM     Lowest vector zoom.                                 default: 0
#   OUTPUT      Output archive.               default: web/data/map.pmtiles
#   PLANETILER_VERSION  Release tag to fetch.             default: latest
#   EXTRA_ARGS  Appended verbatim to the Planetiler command line.
#
# Usage:  ./scripts/build-map.sh
#         AREA=monaco BOUNDS=7.40,43.72,7.44,43.75 ./scripts/build-map.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

AREA="${AREA:-india}"
BOUNDS="${BOUNDS:-73.70,18.40,74.00,18.65}"
HEAP="${HEAP:-6g}"
NODEMAP="${NODEMAP:-sortedtable}"
COMPRESS_TEMP="${COMPRESS_TEMP:-false}"
MAXZOOM="${MAXZOOM:-14}"
MINZOOM="${MINZOOM:-0}"
OUTPUT="${OUTPUT:-$ROOT/web/data/map.pmtiles}"
PLANETILER_VERSION="${PLANETILER_VERSION:-latest}"
JAR_DIR="${JAR_DIR:-$ROOT/vendor-jars}"
JAR="$JAR_DIR/planetiler.jar"
WORK_DIR="${WORK_DIR:-$ROOT/.planetiler}"
EXTRA_ARGS="${EXTRA_ARGS:-}"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- java check
JAVA_BIN="${JAVA:-java}"
if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java" ]; then
  JAVA_BIN="$JAVA_HOME/bin/java"
fi
command -v "$JAVA_BIN" >/dev/null 2>&1 || die "java not found. Planetiler needs a JDK 21 or newer.
  macOS:  brew install openjdk@21
  Debian: sudo apt install openjdk-21-jdk
  Or set JAVA=/path/to/jdk-21/bin/java"

JAVA_RAW="$("$JAVA_BIN" -version 2>&1 | head -1)"
# "openjdk version \"21.0.3\" ..." / "java version \"1.8.0_392\""
JAVA_VER="$(printf '%s' "$JAVA_RAW" | sed -n 's/.*version "\([0-9][0-9.]*\).*/\1/p')"
JAVA_MAJOR="${JAVA_VER%%.*}"
[ "$JAVA_MAJOR" = "1" ] && JAVA_MAJOR="$(printf '%s' "$JAVA_VER" | cut -d. -f2)"
[ -n "$JAVA_MAJOR" ] || die "could not parse a Java version from: $JAVA_RAW"
if [ "$JAVA_MAJOR" -lt 21 ]; then
  die "Java $JAVA_MAJOR found ($JAVA_BIN), but Planetiler requires 21 or newer.
  $JAVA_RAW
  macOS:  brew install openjdk@21 && export JAVA=\"\$(brew --prefix openjdk@21)/bin/java\"
  Debian: sudo apt install openjdk-21-jdk"
fi
echo "Java $JAVA_MAJOR  ($JAVA_BIN)"

# ------------------------------------------------------------- bounds check
printf '%s' "$BOUNDS" | grep -Eq '^-?[0-9.]+,-?[0-9.]+,-?[0-9.]+,-?[0-9.]+$' \
  || die "BOUNDS must be west,south,east,north — got: $BOUNDS"
IFS=, read -r W S E N <<<"$BOUNDS"
awk -v w="$W" -v s="$S" -v e="$E" -v n="$N" 'BEGIN{
  if (w >= e) { print "error: west must be < east"       > "/dev/stderr"; exit 1 }
  if (s >= n) { print "error: south must be < north"     > "/dev/stderr"; exit 1 }
  if (w < -180 || e > 180 || s < -90 || n > 90) {
    print "error: bounds outside the valid lon/lat range" > "/dev/stderr"; exit 1 }
}'

# ------------------------------------------------------------ fetch the jar
mkdir -p "$JAR_DIR" "$WORK_DIR" "$(dirname "$OUTPUT")"
if [ ! -s "$JAR" ]; then
  if [ "$PLANETILER_VERSION" = "latest" ]; then
    JAR_URL="https://github.com/onthegomap/planetiler/releases/latest/download/planetiler.jar"
  else
    JAR_URL="https://github.com/onthegomap/planetiler/releases/download/${PLANETILER_VERSION}/planetiler.jar"
  fi
  echo "Downloading Planetiler ($PLANETILER_VERSION) from GitHub releases…"
  echo "  $JAR_URL"
  curl -fL --retry 3 --retry-delay 2 --progress-bar -o "$JAR.part" "$JAR_URL" \
    || die "download failed: $JAR_URL"
  # A jar is a zip; anything else (an HTML error page) is a failed download.
  head -c 2 "$JAR.part" | grep -q 'PK' || { rm -f "$JAR.part"; die "downloaded file is not a jar"; }
  mv "$JAR.part" "$JAR"
fi
echo "Planetiler jar: $JAR ($(du -h "$JAR" | cut -f1))"

# ----------------------------------------------------------------- the build
# Planetiler parses --output as a URI, so a space anywhere in the path (very
# easy to hit on macOS: "~/My Projects/…") makes it fail with
# "Illegal character in path". Run from a staging directory and pass a bare
# filename, which keeps the URI clean whatever the path above it looks like.
#
# Staging also means Planetiler never runs inside web/data. A build that fails
# or is interrupted leaves the previous archive untouched, instead of having
# already deleted it with --force, and nothing else in web/data is ever in
# reach of the tool's own cleanup.
OUT_DIR="$(cd "$(dirname "$OUTPUT")" && pwd)"
OUT_NAME="$(basename "$OUTPUT")"
case "$OUT_NAME" in
  *[![:alnum:]._-]*) die "the output filename must not contain spaces or special characters: $OUT_NAME" ;;
esac
OUTPUT="$OUT_DIR/$OUT_NAME"
STAGE_DIR="$WORK_DIR/staging"
mkdir -p "$STAGE_DIR"
case "$STAGE_DIR" in
  *[[:space:]]*) die "WORK_DIR must not contain spaces (Planetiler parses paths as URIs): $WORK_DIR" ;;
esac

ARGS=(
  --force
  --bounds="$BOUNDS"
  --minzoom="$MINZOOM"
  --maxzoom="$MAXZOOM"
  --output="$OUT_NAME"
  --tmpdir="$WORK_DIR/tmp"
  --download-dir="$WORK_DIR/sources"
  --nodemap-type="$NODEMAP"
  --storage=mmap
)
[ "$COMPRESS_TEMP" = "true" ] && ARGS+=(--compress-temp)

if [ -n "${OSM_PATH:-}" ]; then
  [ -s "$OSM_PATH" ] || die "OSM_PATH does not exist or is empty: $OSM_PATH"
  # Resolve before the cd below, so a relative OSM_PATH keeps working.
  OSM_PATH="$(cd "$(dirname "$OSM_PATH")" && pwd)/$(basename "$OSM_PATH")"
  # --download still fetches the small auxiliary sources (water polygons,
  # Natural Earth, lake centerlines); the OSM extract comes from disk.
  ARGS+=(--osm-path="$OSM_PATH" --download)
  echo "OSM input: $OSM_PATH (local)"
else
  ARGS+=(--download --area="$AREA")
  echo "OSM input: Geofabrik area '$AREA' (downloaded, cached in $WORK_DIR/sources)"
fi

# ------------------------------------------------------------ disk preflight
# Planetiler writes a lot of scratch data and then a large archive. Running out
# of disk halfway through wastes the whole build, so estimate first. Rule of
# thumb at maxzoom 14: roughly 10x the size of the .osm.pbf input, for temp
# plus output combined. Lower zooms need far less.
free_gb() { df -g "$1" 2>/dev/null | awk 'NR==2 {print $4}'; }

if [ -n "${OSM_PATH:-}" ]; then
  OSM_FILE="$OSM_PATH"
else
  OSM_FILE="$WORK_DIR/sources/$(basename "$AREA").osm.pbf"
fi
OSM_BYTES=0
[ -f "$OSM_FILE" ] && OSM_BYTES="$(wc -c <"$OSM_FILE" | tr -d ' ')"

if [ -z "${MIN_FREE_GB:-}" ]; then
  # Two different things consume disk, and they scale differently:
  #
  #   scratch  Planetiler reads every node in the .osm.pbf into a location map
  #            before it applies --bounds, so this tracks the INPUT size and is
  #            paid in full even for a small clip. ~3x the pbf.
  #   output   the archive itself, which tracks the AREA you asked for and the
  #            maxzoom. Each zoom below 14 roughly halves it.
  #
  # That distinction matters: a city clip out of a 1.6 GB country extract needs
  # the scratch but almost no output space.
  MIN_FREE_GB="$(awk -v b="$OSM_BYTES" -v mz="$MAXZOOM" -v w="$W" -v s="$S" -v e="$E" -v n="$N" 'BEGIN {
    gb = b / 1073741824;
    scratch = gb * 3;

    zoomf = 1;
    for (z = mz; z < 14; z++) zoomf /= 2;

    area = (e - w) * (n - s);
    frac = area / 100;            # ~100 deg^2 is a large state
    if (frac > 1) frac = 1;

    need = scratch + gb * 5 * zoomf * frac;
    if (need < 2) need = 2;
    printf "%.0f", need + 0.5;
  }')"
fi

if [ "$MIN_FREE_GB" != "0" ]; then
  FREE_OUT="$(free_gb "$OUT_DIR")"
  FREE_TMP="$(free_gb "$WORK_DIR")"
  FREE="${FREE_OUT:-0}"
  [ -n "$FREE_TMP" ] && [ "$FREE_TMP" -lt "$FREE" ] && FREE="$FREE_TMP"
  echo "Disk:    ${FREE} GB free, ~${MIN_FREE_GB} GB estimated for this build"
  if [ "$FREE" -lt "$MIN_FREE_GB" ]; then
    die "not enough free disk: ${FREE} GB available, ~${MIN_FREE_GB} GB needed
  for a maxzoom-$MAXZOOM build from $(basename "$OSM_FILE").
  Options:
    - free space, or point OUTPUT= and WORK_DIR= at a larger volume
    - lower MAXZOOM (each zoom below 14 roughly halves the output)
    - COMPRESS_TEMP=true  (less scratch disk, more CPU)
    - EXTRA_ARGS='--free-osm-after-read'  (reclaims the input mid-build)
    - MIN_FREE_GB=0 to skip this check and risk filling the disk"
  fi
fi

echo "Bounds:  $BOUNDS"
echo "Zooms:   $MINZOOM-$MAXZOOM     Heap: $HEAP     Nodemap: $NODEMAP"
echo "Output:  $OUTPUT"
echo

# shellcheck disable=SC2086
set +e
( cd "$STAGE_DIR" && set -x && "$JAVA_BIN" -Xmx"$HEAP" -XX:MaxHeapFreeRatio=40 \
    -jar "$JAR" ${ARGS[@]+"${ARGS[@]}"} $EXTRA_ARGS )
STATUS=$?
set -e

[ "$STATUS" -eq 0 ] || die "Planetiler exited with status $STATUS — the previous
  $OUTPUT (if any) has been left untouched. See the log above."
[ -s "$STAGE_DIR/$OUT_NAME" ] || die "Planetiler finished but produced no archive in $STAGE_DIR"

# Only now replace the live archive.
mv -f "$STAGE_DIR/$OUT_NAME" "$OUTPUT"
[ -s "$OUTPUT" ] || die "could not move the finished archive into $OUTPUT"
echo
echo "Done: $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
echo "Next: python3 scripts/build_terrain.py --bounds \"$BOUNDS\" && python3 scripts/serve.py"
