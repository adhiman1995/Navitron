#!/usr/bin/env python3
"""Build web/data/terrain.pmtiles from Terrarium-encoded elevation tiles.

Tiles are fetched for a bounding box, cached on disk so an interrupted run
resumes where it stopped, retried on failure, and packed into a single PMTiles
archive. The default source is the Tilezen Joerd elevation dataset on AWS Open
Data -- free, openly licensed, and not a commercial map service. --source also
accepts any URL template or a local file:// directory, so the whole build can
run fully offline.

Examples
--------
    python3 scripts/build_terrain.py
    python3 scripts/build_terrain.py --bounds 73.70,18.40,74.00,18.65 --maxzoom 12
    python3 scripts/build_terrain.py --source file:///data/terrarium --maxzoom 8

Terrarium PNG encoding: elevation_m = (R * 256 + G + B / 256) - 32768.
"""

from __future__ import annotations

import argparse
import math
import os
import threading
import sys
import tempfile
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Iterator

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _net import CERT_HINT, ssl_context  # noqa: E402

try:
    from pmtiles.tile import Compression, TileType, zxy_to_tileid
    from pmtiles.writer import Writer
except ImportError:  # pragma: no cover - dependency hint
    sys.exit(
        "error: the 'pmtiles' package is required.\n"
        "  pip install pmtiles       (or: python3 -m pip install -r requirements.txt)"
    )

ROOT = Path(__file__).resolve().parent.parent

# Tilezen Joerd terrarium tiles, hosted on AWS Open Data.
DEFAULT_SOURCE = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
DEFAULT_BOUNDS = "73.70,18.40,74.00,18.65"
DEFAULT_ATTRIBUTION = (
    "Elevation: Tilezen Joerd (SRTM, ETOPO1, NED and others) "
    "- https://github.com/tilezen/joerd/blob/master/docs/attribution.md"
)
USER_AGENT = "navitron-terrain-builder/1.0 (+https://github.com/adhiman1995/Navitron)"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def _umask() -> int:
    """Read the process umask without permanently changing it."""
    current = os.umask(0)
    os.umask(current)
    return current


class BuildError(RuntimeError):
    """Anything that must abort the build before an archive is written."""


# --------------------------------------------------------------------- tiles
def lon_to_x(lon: float, z: float) -> int:
    n = 1 << int(z)
    return max(0, min(n - 1, int((lon + 180.0) / 360.0 * n)))


def lat_to_y(lat: float, z: float) -> int:
    n = 1 << int(z)
    lat = max(-85.05112878, min(85.05112878, lat))
    rad = math.radians(lat)
    y = (1.0 - math.asinh(math.tan(rad)) / math.pi) / 2.0 * n
    return max(0, min(n - 1, int(y)))


def tile_range(bounds: tuple[float, float, float, float], z: int) -> tuple[int, int, int, int]:
    """(x_min, y_min, x_max, y_max) inclusive, for zoom z."""
    w, s, e, n = bounds
    return lon_to_x(w, z), lat_to_y(n, z), lon_to_x(e, z), lat_to_y(s, z)


def iter_tiles(
    bounds: tuple[float, float, float, float], minzoom: int, maxzoom: int
) -> Iterator[tuple[int, int, int]]:
    for z in range(minzoom, maxzoom + 1):
        x0, y0, x1, y1 = tile_range(bounds, z)
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                yield z, x, y


class Region:
    """One bounding box built to its own maxzoom."""

    def __init__(self, bounds: tuple[float, float, float, float], minzoom: int, maxzoom: int):
        self.bounds = bounds
        self.minzoom = minzoom
        self.maxzoom = maxzoom

    def tiles(self) -> Iterator[tuple[int, int, int]]:
        return iter_tiles(self.bounds, self.minzoom, self.maxzoom)

    def __str__(self) -> str:
        w, s, e, n = self.bounds
        return f"{w},{s},{e},{n} z{self.minzoom}-{self.maxzoom}"


def collect_tiles(regions: list[Region]) -> list[tuple[int, int, int]]:
    """Every tile any region asks for, de-duplicated, in tile-id order."""
    seen: set[tuple[int, int, int]] = set()
    for r in regions:
        seen.update(r.tiles())
    return sorted(seen, key=lambda t: zxy_to_tileid(*t))


def union_bounds(regions: list[Region]) -> tuple[float, float, float, float]:
    return (
        min(r.bounds[0] for r in regions),
        min(r.bounds[1] for r in regions),
        max(r.bounds[2] for r in regions),
        max(r.bounds[3] for r in regions),
    )


def parse_region(text: str, default_minzoom: int) -> Region:
    """'w,s,e,n:maxzoom' or 'w,s,e,n:minzoom-maxzoom'."""
    if ":" not in text:
        raise BuildError(f"--region needs 'w,s,e,n:maxzoom' - got {text!r}")
    box, _, zooms = text.rpartition(":")
    bounds = parse_bounds(box)
    if "-" in zooms:
        lo, _, hi = zooms.partition("-")
        try:
            minz, maxz = int(lo), int(hi)
        except ValueError:
            raise BuildError(f"--region zoom range must be numbers - got {zooms!r}") from None
    else:
        try:
            minz, maxz = default_minzoom, int(zooms)
        except ValueError:
            raise BuildError(f"--region maxzoom must be a number - got {zooms!r}") from None
    if minz > maxz:
        raise BuildError(f"--region minzoom above maxzoom in {text!r}")
    return Region(bounds, minz, maxz)


def count_tiles(bounds: tuple[float, float, float, float], minzoom: int, maxzoom: int) -> int:
    total = 0
    for z in range(minzoom, maxzoom + 1):
        x0, y0, x1, y1 = tile_range(bounds, z)
        total += (x1 - x0 + 1) * (y1 - y0 + 1)
    return total


# -------------------------------------------------------------------- source
class TileSource:
    """Fetches one tile, either over HTTP(S) or from a local directory."""

    def __init__(self, spec: str, timeout: float = 30.0, retries: int = 4, pause: float = 0.0):
        self.spec = spec
        self.ssl = ssl_context()
        self.timeout = timeout
        self.retries = max(1, retries)
        self.pause = pause
        self.is_local = spec.startswith("file://") or "://" not in spec

        if self.is_local:
            raw = spec[len("file://") :] if spec.startswith("file://") else spec
            # file:///abs/path keeps its leading slash; file://./rel does not.
            self.root = Path(raw).expanduser()
            self.template = None
            if "{z}" in raw:
                # A template inside a file:// spec, e.g. file:///dem/{z}/{x}/{y}.png
                self.template = raw
                self.root = None
            elif not self.root.is_dir():
                raise BuildError(f"--source directory does not exist: {self.root}")
        else:
            if not spec.startswith(("http://", "https://")):
                raise BuildError(f"--source must be http(s), file:// or a directory path: {spec}")
            for token in ("{z}", "{x}", "{y}"):
                if token not in spec:
                    raise BuildError(f"--source URL template is missing {token}: {spec}")
            self.template = spec
            self.root = None

    def describe(self) -> str:
        return f"{'local' if self.is_local else 'remote'}  {self.spec}"

    def _path(self, z: int, x: int, y: int) -> Path:
        if self.template:
            return Path(self.template.format(z=z, x=x, y=y))
        assert self.root is not None
        return self.root / str(z) / str(x) / f"{y}.png"

    def fetch(self, z: int, x: int, y: int) -> bytes | None:
        """Tile bytes, or None when the source genuinely has no such tile."""
        if self.is_local:
            p = self._path(z, x, y)
            if not p.is_file():
                return None
            return p.read_bytes()

        url = self.template.format(z=z, x=x, y=y)  # type: ignore[union-attr]
        last = ""
        for attempt in range(1, self.retries + 1):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=self.timeout, context=self.ssl) as resp:
                    data = resp.read()
                if self.pause:
                    time.sleep(self.pause)
                return data
            except urllib.error.HTTPError as exc:
                if exc.code in (403, 404):
                    return None  # outside coverage: not an error
                last = f"HTTP {exc.code}"
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                last = str(exc)
                if "CERTIFICATE_VERIFY_FAILED" in last:
                    raise BuildError(f"{last}\n  {CERT_HINT}") from None
            if attempt < self.retries:
                time.sleep(min(2 ** attempt * 0.5, 8.0))
        raise BuildError(f"giving up on {z}/{x}/{y} after {self.retries} attempts: {last} ({url})")


# --------------------------------------------------------------------- cache
class TileCache:
    def __init__(self, root: Path):
        self.root = root

    def path(self, z: int, x: int, y: int) -> Path:
        return self.root / str(z) / str(x) / f"{y}.png"

    def get(self, z: int, x: int, y: int) -> bytes | None:
        p = self.path(z, x, y)
        if p.is_file() and p.stat().st_size > 0:
            return p.read_bytes()
        return None

    def put(self, z: int, x: int, y: int, data: bytes) -> None:
        p = self.path(z, x, y)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".part")
        tmp.write_bytes(data)
        tmp.replace(p)  # atomic: a cached file is always complete

    def mark_absent(self, z: int, x: int, y: int) -> None:
        p = self.path(z, x, y).with_suffix(".absent")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.touch()

    def is_absent(self, z: int, x: int, y: int) -> bool:
        return self.path(z, x, y).with_suffix(".absent").is_file()


# ---------------------------------------------------------------------- main
def parse_bounds(text: str) -> tuple[float, float, float, float]:
    parts = [p.strip() for p in text.split(",")]
    if len(parts) != 4:
        raise BuildError(f"--bounds needs west,south,east,north - got {text!r}")
    try:
        w, s, e, n = (float(p) for p in parts)
    except ValueError:
        raise BuildError(f"--bounds values must be numbers - got {text!r}") from None
    if not (-180 <= w < e <= 180):
        raise BuildError(f"--bounds: need -180 <= west < east <= 180 (got {w}, {e})")
    if not (-90 <= s < n <= 90):
        raise BuildError(f"--bounds: need -90 <= south < north <= 90 (got {s}, {n})")
    return w, s, e, n


def human(n: int) -> str:
    for unit in ("B", "KiB", "MiB", "GiB"):
        if n < 1024 or unit == "GiB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{n} B"
        n /= 1024  # type: ignore[assignment]
    return str(n)


def build(args: argparse.Namespace) -> int:
    if args.region:
        regions = [parse_region(r, args.minzoom) for r in args.region]
    else:
        if args.minzoom > args.maxzoom:
            raise BuildError(f"--minzoom ({args.minzoom}) is above --maxzoom ({args.maxzoom})")
        regions = [Region(parse_bounds(args.bounds), args.minzoom, args.maxzoom)]

    tiles = collect_tiles(regions)
    total = len(tiles)
    bounds = union_bounds(regions)
    archive_minzoom = min(r.minzoom for r in regions)
    archive_maxzoom = max(r.maxzoom for r in regions)

    for i, r in enumerate(regions):
        print(f"{'Region' if i == 0 else '      '}    {r}")
    print(f"Tiles     {total:,}")

    if total > args.max_tiles:
        raise BuildError(
            f"this build needs {total:,} tiles, above the safety limit of {args.max_tiles:,}.\n"
            f"  Lower --maxzoom (each extra zoom is ~4x the tiles), shrink --bounds,\n"
            f"  or raise the limit deliberately with --max-tiles {total}."
        )

    source = TileSource(args.source, timeout=args.timeout, retries=args.retries, pause=args.pause)
    cache = TileCache(Path(args.cache_dir).expanduser())
    out = Path(args.output).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    print(f"Source    {source.describe()}")
    print(f"Cache     {cache.root}")
    print(f"Output    {out}\n")

    # Pass 1: make sure every tile is on disk before touching the archive, so a
    # network failure can never leave a half-written .pmtiles behind.
    #
    # Tile fetches are latency-bound, so they run on a small thread pool. A
    # local file:// source is fast enough to stay single-threaded.
    jobs = 1 if source.is_local else max(1, args.jobs)
    counts = {"fetched": 0, "cached": 0, "absent": 0, "done": 0}
    lock = threading.Lock()
    t0 = time.monotonic()

    def progress() -> None:
        i = counts["done"]
        if i == total or (i % 25 == 0 and sys.stdout.isatty()):
            rate = i / max(time.monotonic() - t0, 1e-6)
            end = "" if sys.stdout.isatty() and i != total else "\n"
            print(
                f"\r  {i:,}/{total:,} tiles  ({counts['fetched']:,} fetched, "
                f"{counts['cached']:,} cached, {counts['absent']:,} absent)  {rate:,.1f}/s",
                end=end,
                flush=True,
            )

    def handle(tile: tuple[int, int, int]) -> None:
        z, x, y = tile
        if cache.get(z, x, y) is not None:
            key = "cached"
        elif cache.is_absent(z, x, y):
            key = "absent"
        else:
            data = source.fetch(z, x, y)
            if data is None:
                cache.mark_absent(z, x, y)
                key = "absent"
            elif not data.startswith(PNG_MAGIC):
                raise BuildError(
                    f"{z}/{x}/{y}: source returned {len(data)} bytes that are not a PNG.\n"
                    f"  Terrarium tiles must be PNG; check --source."
                )
            else:
                cache.put(z, x, y, data)
                key = "fetched"
        with lock:
            counts[key] += 1
            counts["done"] += 1
            progress()

    if jobs == 1:
        for tile in tiles:
            handle(tile)
    else:
        print(f"Fetching with {jobs} parallel connections…")
        with ThreadPoolExecutor(max_workers=jobs) as pool:
            futures = {pool.submit(handle, t): t for t in tiles}
            try:
                for fut in as_completed(futures):
                    fut.result()  # re-raises the first BuildError
            except BaseException:
                # Stop promptly; already-cached tiles survive for the next run.
                for f in futures:
                    f.cancel()
                raise
    fetched, cached, absent = counts["fetched"], counts["cached"], counts["absent"]

    have = total - absent
    if have == 0:
        raise BuildError(
            "the source returned no tiles at all for this area - nothing to pack.\n"
            "  Check --source and --bounds."
        )

    # Pass 2: pack. Written to a temp file in the destination directory and
    # renamed only on success, so web/data/terrain.pmtiles is never partial.
    tmp_fd, tmp_name = tempfile.mkstemp(dir=out.parent, prefix=".terrain-", suffix=".pmtiles")
    os.close(tmp_fd)
    tmp_path = Path(tmp_name)
    written = 0
    size = 0
    try:
        with tmp_path.open("wb") as fh:
            writer = Writer(fh)
            # PMTiles wants tiles in ascending Hilbert tile-id order.
            # collect_tiles() already returns them in ascending tile-id order.
            for z, x, y in tiles:
                data = cache.get(z, x, y)
                if data is None:
                    continue
                writer.write_tile(zxy_to_tileid(z, x, y), data)
                written += 1
                size += len(data)

            w, s, e, n = bounds
            metadata = {
                "name": "navitron terrain " + "; ".join(str(r) for r in regions),
                "description": "Terrarium-encoded elevation tiles",
                "type": "baselayer",
                "format": "png",
                "encoding": "terrarium",
                "attribution": args.attribution,
                "bounds": f"{w},{s},{e},{n}",
            }
            writer.finalize(
                {
                    "tile_type": TileType.PNG,
                    "tile_compression": Compression.NONE,
                    "min_zoom": archive_minzoom,
                    "max_zoom": archive_maxzoom,
                    "min_lon_e7": int(w * 1e7),
                    "min_lat_e7": int(s * 1e7),
                    "max_lon_e7": int(e * 1e7),
                    "max_lat_e7": int(n * 1e7),
                    "center_zoom": archive_maxzoom,
                    "center_lon_e7": int((w + e) / 2 * 1e7),
                    "center_lat_e7": int((s + n) / 2 * 1e7),
                },
                metadata,
            )
        if written == 0:
            raise BuildError("no tiles were written - refusing to keep an empty archive")
        # mkstemp creates the file 0600. Left as-is, the archive is unreadable
        # to the user a web server runs as, which shows up as a 403 only after
        # deployment. Match a normal umask-created file instead.
        os.chmod(tmp_path, 0o644 & ~_umask())
        tmp_path.replace(out)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise

    print(
        f"\nWrote {out}  ({human(out.stat().st_size)}, {written:,} tiles, "
        f"{human(size)} of tile data)"
    )
    if absent:
        print(f"Note: {absent:,} tile(s) were not available from the source and were skipped.")
    print(f"Attribution required: {args.attribution}")
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="build_terrain.py",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--bounds", default=os.environ.get("BOUNDS", DEFAULT_BOUNDS),
                   help="west,south,east,north in degrees (default: %(default)s)")
    p.add_argument("--minzoom", type=int, default=int(os.environ.get("TERRAIN_MINZOOM", 0)),
                   help="lowest zoom to include (default: %(default)s)")
    p.add_argument("--maxzoom", type=int, default=int(os.environ.get("TERRAIN_MAXZOOM", 12)),
                   help="highest zoom to include (default: %(default)s)")
    p.add_argument("--region", action="append", default=None, metavar="W,S,E,N:MAXZOOM",
                   help="a bounding box with its own maxzoom, repeatable; overrides --bounds/--maxzoom. "
                        "Lets one archive cover a country coarsely and a city finely, e.g. "
                        "--region 68,6,97.5,37.5:10 --region 73.5,18.2,74.2,18.85:14")
    p.add_argument("--source", default=os.environ.get("TERRAIN_SOURCE", DEFAULT_SOURCE),
                   help="URL template with {z}/{x}/{y}, or file://DIR / a directory path")
    p.add_argument("--output", default=os.environ.get("TERRAIN_OUTPUT", str(ROOT / "web/data/terrain.pmtiles")),
                   help="output archive (default: web/data/terrain.pmtiles)")
    p.add_argument("--cache-dir", default=os.environ.get("TERRAIN_CACHE", str(ROOT / ".terrain-cache")),
                   help="on-disk tile cache, reused to resume (default: .terrain-cache)")
    p.add_argument("--max-tiles", type=int, default=60000,
                   help="refuse builds larger than this many tiles (default: %(default)s)")
    p.add_argument("--jobs", type=int, default=int(os.environ.get("TERRAIN_JOBS", 8)),
                   help="parallel HTTP connections (default: %(default)s; local sources are serial)")
    p.add_argument("--retries", type=int, default=4, help="HTTP attempts per tile (default: %(default)s)")
    p.add_argument("--timeout", type=float, default=30.0, help="HTTP timeout in seconds (default: %(default)s)")
    p.add_argument("--pause", type=float, default=0.0,
                   help="seconds to wait between HTTP requests, to be polite (default: %(default)s)")
    p.add_argument("--attribution", default=DEFAULT_ATTRIBUTION, help="attribution string stored in the archive")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        return build(args)
    except BuildError as exc:
        print(f"\nerror: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\ninterrupted - the tile cache is kept, re-run to resume.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
