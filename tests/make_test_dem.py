#!/usr/bin/env python3
"""Generate synthetic Terrarium DEM tiles, so the terrain pipeline can be
tested with no network at all.

Writes <out>/{z}/{x}/{y}.png for every tile covering --bounds between
--minzoom and --maxzoom. Each tile is a real PNG whose pixels encode a smooth
synthetic elevation field with the Terrarium scheme
(elevation_m = R*256 + G + B/256 - 32768), so the output is valid input for
scripts/build_terrain.py --source file://<out>.

    python3 tests/make_test_dem.py --out /tmp/dem --bounds 73.8,18.45,73.9,18.55 --maxzoom 6
"""

from __future__ import annotations

import argparse
import math
import struct
import sys
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from build_terrain import iter_tiles, parse_bounds  # noqa: E402

SIZE = 32  # small tiles keep the test fast; the encoding is what matters


def png(width: int, height: int, rows: list[bytes]) -> bytes:
    """Minimal 8-bit RGB PNG encoder (no third-party imaging library)."""

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # colour type 2 = RGB
    raw = b"".join(b"\x00" + row for row in rows)  # filter type 0 per scanline
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 6))
        + chunk(b"IEND", b"")
    )


def terrarium_px(elev_m: float) -> tuple[int, int, int]:
    v = max(0.0, min(65535.99, elev_m + 32768.0))
    r = int(v) >> 8
    g = int(v) & 0xFF
    b = int(round((v - int(v)) * 256)) & 0xFF
    return r, g, b


def tile_png(z: int, x: int, y: int) -> bytes:
    rows = []
    for j in range(SIZE):
        row = bytearray()
        for i in range(SIZE):
            # A deterministic, tile-dependent but continuous-looking field.
            u = (x * SIZE + i) / (SIZE * (1 << z))
            v = (y * SIZE + j) / (SIZE * (1 << z))
            elev = 600 + 900 * math.sin(u * 12.0) * math.cos(v * 9.0) + 40 * z
            row += bytes(terrarium_px(elev))
        rows.append(bytes(row))
    return png(SIZE, SIZE, rows)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True)
    ap.add_argument("--bounds", default="73.80,18.45,73.90,18.55")
    ap.add_argument("--minzoom", type=int, default=0)
    ap.add_argument("--maxzoom", type=int, default=6)
    ap.add_argument("--skip", default="", help="z/x/y tiles to deliberately omit, comma separated")
    args = ap.parse_args(argv)

    bounds = parse_bounds(args.bounds)
    out = Path(args.out).expanduser()
    skip = {s.strip() for s in args.skip.split(",") if s.strip()}

    n = 0
    for z, x, y in iter_tiles(bounds, args.minzoom, args.maxzoom):
        if f"{z}/{x}/{y}" in skip:
            continue
        p = out / str(z) / str(x) / f"{y}.png"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(tile_png(z, x, y))
        n += 1
    print(f"wrote {n} test DEM tiles to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
