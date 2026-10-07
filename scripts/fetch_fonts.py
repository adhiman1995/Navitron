#!/usr/bin/env python3
"""Self-host the glyph PBFs that MapLibre needs for text rendering.

Downloads the prebuilt Noto Sans glyph release from github.com/openmaptiles/fonts
and extracts only the Unicode ranges this style can actually draw -- Latin,
Indic scripts and punctuation -- into web/fonts/<Font Name>/<range>.pbf.
The full release is ~62 MB zipped and far larger unpacked; the trimmed set is a
few megabytes.

Usage:
    python3 scripts/fetch_fonts.py
    python3 scripts/fetch_fonts.py --all-ranges          # keep every range
    python3 scripts/fetch_fonts.py --zip /path/noto-sans.zip   # offline
"""

from __future__ import annotations

import argparse
import re
import shutil
import sys
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _net import CERT_HINT, ssl_context  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
RELEASE = "v2.0"
ZIP_URL = f"https://github.com/openmaptiles/fonts/releases/download/{RELEASE}/noto-sans.zip"

# Fontstacks referenced by web/style.js.
FONTS = ["Noto Sans Regular", "Noto Sans Bold", "Noto Sans Italic"]

# Glyph PBFs are 256-codepoint buckets. Keep only what the style renders:
#   0-1023      Latin-1, Latin Extended-A/B, IPA, combining diacritics, Greek
#   2304-3583   Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil,
#               Telugu, Kannada, Malayalam, Sinhala
#   7680-7935   Latin Extended Additional. Easy to think this is only
#               Vietnamese and drop it -- but it holds the dotted and
#               underdotted letters used to romanise Indian names
#               (Ladākh, Kriṣṇa, Śiva, Viṣṇu). Leaving it out makes
#               OpenMapTiles' name:latin labels request a 404 glyph range.
#   8192-8447   General punctuation, super/subscripts, currency symbols
KEEP_RANGES = [
    (0, 255), (256, 511), (512, 767), (768, 1023),
    (2304, 2559), (2560, 2815), (2816, 3071), (3072, 3327), (3328, 3583),
    (7680, 7935),
    (8192, 8447),
]
RANGE_RE = re.compile(r"(\d+)-(\d+)\.pbf$")


def download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    print(f"Downloading {url}")
    try:
        with urllib.request.urlopen(url, timeout=120, context=ssl_context()) as resp, tmp.open("wb") as out:
            total = int(resp.headers.get("Content-Length") or 0)
            done = 0
            while chunk := resp.read(1 << 16):
                out.write(chunk)
                done += len(chunk)
                if total and sys.stdout.isatty():
                    print(f"\r  {done / 1e6:6.1f} / {total / 1e6:.1f} MB", end="", flush=True)
        print()
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        tmp.unlink(missing_ok=True)
        hint = f"\n  {CERT_HINT}" if "CERTIFICATE_VERIFY_FAILED" in str(exc) else ""
        sys.exit(f"error: download failed: {exc}{hint}\n  Or pass a local copy with --zip.")
    tmp.replace(dest)


def wanted(name: str, keep_all: bool) -> bool:
    if keep_all:
        return True
    m = RANGE_RE.search(name)
    if not m:
        return False
    lo, hi = int(m.group(1)), int(m.group(2))
    return any(lo >= a and hi <= b for a, b in KEEP_RANGES)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(ROOT / "web/fonts"), help="output directory (default: web/fonts)")
    ap.add_argument("--zip", dest="zip_path", default=str(ROOT / ".font-cache/noto-sans.zip"),
                    help="local release zip; downloaded here if absent")
    ap.add_argument("--all-ranges", action="store_true", help="extract every Unicode range, not just the trimmed set")
    ap.add_argument("--fonts", nargs="+", default=FONTS, help="fontstack directory names to extract")
    ap.add_argument("--clean", action="store_true", help="remove existing glyphs for these fonts first")
    args = ap.parse_args(argv)

    zip_path = Path(args.zip_path).expanduser()
    if not zip_path.is_file():
        download(ZIP_URL, zip_path)
    else:
        print(f"Using cached {zip_path} ({zip_path.stat().st_size / 1e6:.1f} MB)")

    out_root = Path(args.out).expanduser()
    out_root.mkdir(parents=True, exist_ok=True)

    try:
        zf = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile:
        return int(bool(sys.stderr.write(
            f"error: {zip_path} is not a valid zip. Delete it and re-run.\n")) ) or 2

    with zf:
        names = zf.namelist()
        available = {n.split("/")[0] for n in names if "/" in n}
        missing = [f for f in args.fonts if f not in available]
        if missing:
            print(f"error: these fontstacks are not in the archive: {', '.join(missing)}", file=sys.stderr)
            print("Available (first 20):", ", ".join(sorted(available)[:20]), file=sys.stderr)
            return 2

        total_files = total_bytes = 0
        for font in args.fonts:
            dest = out_root / font
            if args.clean and dest.is_dir():
                shutil.rmtree(dest)
            dest.mkdir(parents=True, exist_ok=True)
            picked = [n for n in names
                      if n.startswith(font + "/") and n.endswith(".pbf") and wanted(n, args.all_ranges)]
            if not picked:
                print(f"error: no glyph ranges matched for {font}", file=sys.stderr)
                return 2
            size = 0
            for name in sorted(picked):
                data = zf.read(name)
                (dest / Path(name).name).write_bytes(data)
                size += len(data)
            total_files += len(picked)
            total_bytes += size
            print(f"  {font:<22} {len(picked):3d} ranges  {size / 1e6:5.2f} MB")

    print(f"\nWrote {total_files} glyph files ({total_bytes / 1e6:.2f} MB) to {out_root}")
    print("Fonts: Noto Sans, SIL Open Font License 1.1 -- keep the licence notice when redistributing.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
