#!/usr/bin/env python3
"""Static file server for web/ with HTTP Range support.

PMTiles reads single files with ranged GETs, which Python's stock
SimpleHTTPRequestHandler does not implement -- so the map will not load behind
it. This handler adds single-range and suffix-range support, a correct 416 for
unsatisfiable ranges, and the MIME types this stack needs (.mjs, .pmtiles,
.pbf).

Usage:
    python3 scripts/serve.py                 # http://127.0.0.1:8080
    python3 scripts/serve.py --port 9000 --bind 0.0.0.0
"""

from __future__ import annotations

import argparse
import os
import re
import socket
import sys
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB_ROOT = ROOT / "web"

RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")

EXTRA_TYPES = {
    ".mjs": "text/javascript",
    ".js": "text/javascript",
    ".json": "application/json",
    ".pmtiles": "application/vnd.pmtiles",
    ".pbf": "application/x-protobuf",
    ".geojson": "application/geo+json",
    ".webmanifest": "application/manifest+json",
    ".wasm": "application/wasm",
}


class RangeHandler(SimpleHTTPRequestHandler):
    server_version = "navitron/1.0"
    protocol_version = "HTTP/1.1"  # required for keep-alive + 206 responses

    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, **EXTRA_TYPES}

    def end_headers(self) -> None:
        self.send_header("Accept-Ranges", "bytes")
        # Everything is served from one origin, but a permissive CORS header
        # makes it painless to embed the tiles elsewhere during development.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Range")
        self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Range")
        path = self.path.split("?", 1)[0]
        if path.endswith(".pmtiles"):
            # Archives are rebuilt in place; never let a browser pin an old one.
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_OPTIONS(self) -> None:  # noqa: N802 - http.server naming
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Allow", "GET, HEAD, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def send_head(self):  # type: ignore[override]
        """Serve a full body, or a 206/416 when a Range header is present."""
        if "Range" not in self.headers:
            return super().send_head()

        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()

        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return None

        try:
            size = os.fstat(f.fileno()).st_size
            parsed = self._parse_range(self.headers["Range"], size)
            if parsed is None:
                # Malformed or multi-range: fall back to the whole entity.
                f.close()
                return super().send_head()
            if parsed == "unsatisfiable":
                f.close()
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return None

            start, end = parsed
            length = end - start + 1
            f.seek(start)
            self.send_response(HTTPStatus.PARTIAL_CONTENT)
            self.send_header("Content-Type", self.guess_type(path))
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Content-Length", str(length))
            self.send_header("Last-Modified", self.date_time_string(int(os.fstat(f.fileno()).st_mtime)))
            self.end_headers()
            return _Slice(f, length)
        except Exception:
            f.close()
            raise

    @staticmethod
    def _parse_range(header: str, size: int):
        """-> (start, end) inclusive | "unsatisfiable" | None (not handled)."""
        m = RANGE_RE.match(header.strip())
        if not m:
            return None
        first, last = m.group(1), m.group(2)
        if first == "" and last == "":
            return None
        if first == "":
            # Suffix range: the last N bytes. PMTiles uses this for the header.
            n = int(last)
            if n == 0:
                return "unsatisfiable"
            n = min(n, size)
            return size - n, size - 1
        start = int(first)
        if start >= size:
            return "unsatisfiable"
        end = size - 1 if last == "" else min(int(last), size - 1)
        if end < start:
            return "unsatisfiable"
        return start, end

    def copyfile(self, source, outputfile):  # type: ignore[override]
        if isinstance(source, _Slice):
            source.copy_to(outputfile)
            return
        super().copyfile(source, outputfile)

    def log_message(self, fmt: str, *args) -> None:
        if not getattr(self.server, "quiet", False):
            super().log_message(fmt, *args)


class _Slice:
    """A byte window over an open file, consumed by copyfile()/close()."""

    def __init__(self, fileobj, length: int):
        self.fileobj = fileobj
        self.remaining = length

    def copy_to(self, out, chunk: int = 64 * 1024) -> None:
        while self.remaining > 0:
            buf = self.fileobj.read(min(chunk, self.remaining))
            if not buf:
                break
            out.write(buf)
            self.remaining -= len(buf)

    def close(self) -> None:
        self.fileobj.close()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8080)))
    ap.add_argument("--bind", default=os.environ.get("BIND", "127.0.0.1"))
    ap.add_argument("--root", default=str(WEB_ROOT), help="directory to serve (default: web/)")
    ap.add_argument("--quiet", action="store_true", help="do not log each request")
    args = ap.parse_args(argv)

    root = Path(args.root).expanduser().resolve()
    if not root.is_dir():
        print(f"error: not a directory: {root}", file=sys.stderr)
        return 2
    if not (root / "index.html").is_file():
        print(f"warning: {root}/index.html is missing", file=sys.stderr)

    handler = partial(RangeHandler, directory=str(root))
    ThreadingHTTPServer.allow_reuse_address = True
    try:
        httpd = ThreadingHTTPServer((args.bind, args.port), handler)
    except OSError as exc:
        print(f"error: cannot bind {args.bind}:{args.port} - {exc}", file=sys.stderr)
        return 2
    httpd.quiet = args.quiet  # type: ignore[attr-defined]

    host = args.bind if args.bind not in ("0.0.0.0", "::") else socket.gethostname()
    print(f"Serving {root}")
    print(f"  http://{host}:{args.port}/   (Range requests supported)")
    print("Ctrl-C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
