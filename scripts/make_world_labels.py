#!/usr/bin/env python3
"""Generate global place labels for the low-zoom world context.

The world context archive (scripts/build-map.sh with global BOUNDS) carries
coastlines, water, landcover and boundaries from Natural Earth -- but its
`place` layer comes from OpenStreetMap, so it is empty unless you process the
full 95 GB planet. Natural Earth has its own country and city labels, so we
take them from there instead and emit a small GeoJSON the style can load
directly.

Input is the natural_earth_vector.sqlite.zip that Planetiler already downloads
into WORK_DIR/sources, so this costs no extra network.

    python3 scripts/make_world_labels.py
    python3 scripts/make_world_labels.py --zip ~/ne.zip --out web/data/world-labels.geojson

Natural Earth is public domain.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ZIP_CANDIDATES = [
    ROOT / ".planetiler/sources/natural_earth_vector.sqlite.zip",
    Path("/tmp/planetiler/sources/natural_earth_vector.sqlite.zip"),
]


def find_zip(explicit: str | None) -> Path:
    if explicit:
        p = Path(explicit).expanduser()
        if not p.is_file():
            sys.exit(f"error: no such file: {p}")
        return p
    for p in DEFAULT_ZIP_CANDIDATES:
        if p.is_file():
            return p
    sys.exit(
        "error: could not find natural_earth_vector.sqlite.zip.\n"
        "  It is downloaded by scripts/build-map.sh into WORK_DIR/sources.\n"
        "  Run the vector build first, or pass --zip /path/to/natural_earth_vector.sqlite.zip"
    )


def extract_sqlite(zip_path: Path, dest_dir: Path) -> Path:
    with zipfile.ZipFile(zip_path) as zf:
        names = [n for n in zf.namelist() if n.endswith(".sqlite")]
        if not names:
            sys.exit(f"error: no .sqlite inside {zip_path}")
        print(f"Extracting {names[0]} (~810 MB, removed again afterwards)…")
        zf.extract(names[0], dest_dir)
    return dest_dir / names[0]


def countries(cur) -> list[dict]:
    rows = cur.execute(
        """SELECT name, name_en, label_x, label_y, labelrank, iso_a2
           FROM ne_110m_admin_0_countries
           WHERE label_x IS NOT NULL AND label_y IS NOT NULL"""
    ).fetchall()
    out = []
    for name, name_en, x, y, labelrank, iso in rows:
        out.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(x, 4), round(y, 4)]},
            "properties": {
                "kind": "country",
                "name": name_en or name,
                "rank": int(labelrank) if labelrank is not None else 5,
                "iso": iso,
            },
        })
    return out


def cities(cur, limit_rank: int) -> list[dict]:
    rows = cur.execute(
        """SELECT name, name_en, longitude, latitude, scalerank, pop_max, adm0name
           FROM ne_10m_populated_places
           WHERE longitude IS NOT NULL AND latitude IS NOT NULL
             AND scalerank <= ?
           ORDER BY scalerank ASC""",
        (limit_rank,),
    ).fetchall()
    out = []
    for name, name_en, lon, lat, scalerank, pop, country in rows:
        out.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(lon, 4), round(lat, 4)]},
            "properties": {
                "kind": "city",
                "name": name_en or name,
                # scalerank 0 = global metropolis, 10 = minor town. The style
                # reveals higher ranks as you zoom in.
                "rank": int(scalerank) if scalerank is not None else 10,
                "pop": int(pop) if pop else 0,
                "country": country,
            },
        })
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--zip", dest="zip_path", default=None, help="natural_earth_vector.sqlite.zip")
    ap.add_argument("--sqlite", default=None, help="an already-extracted .sqlite, skips unzipping")
    ap.add_argument("--out", default=str(ROOT / "web/data/world-labels.geojson"))
    ap.add_argument("--max-city-rank", type=int, default=7,
                    help="keep cities with scalerank <= this (0 = biggest only, 10 = all). Default: %(default)s")
    args = ap.parse_args(argv)

    tmp: tempfile.TemporaryDirectory | None = None
    if args.sqlite:
        db_path = Path(args.sqlite).expanduser()
        if not db_path.is_file():
            sys.exit(f"error: no such file: {db_path}")
    else:
        tmp = tempfile.TemporaryDirectory(prefix="ne-")
        db_path = extract_sqlite(find_zip(args.zip_path), Path(tmp.name))

    try:
        db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        cur = db.cursor()
        feats = countries(cur) + cities(cur, args.max_city_rank)
        db.close()
    finally:
        if tmp is not None:
            tmp.cleanup()  # the 810 MB extract never outlives this run

    out = Path(args.out).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "type": "FeatureCollection",
        "attribution": "Natural Earth (public domain)",
        "features": feats,
    }
    # Compact: this ships to every visitor.
    out.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False))

    n_country = sum(1 for f in feats if f["properties"]["kind"] == "country")
    n_city = len(feats) - n_country
    print(f"Wrote {out}  ({out.stat().st_size / 1e6:.2f} MB)")
    print(f"  {n_country} countries, {n_city} cities (scalerank <= {args.max_city_rank})")
    print("  Natural Earth is public domain; no attribution required, but credited in config.js.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
