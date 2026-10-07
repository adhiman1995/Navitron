"""Shared HTTPS helper for the build scripts.

Some Python installs (notably the python.org macOS builds) ship without the
system root certificates wired into the default SSL context, which makes every
https download fail with CERTIFICATE_VERIFY_FAILED. If certifi is importable we
use its CA bundle; otherwise we fall back to the stock context and let the real
error surface with a usable hint.
"""

from __future__ import annotations

import ssl

CERT_HINT = (
    "TLS certificate verification failed. Either install certifi\n"
    "  (python3 -m pip install certifi)\n"
    "or, on a python.org macOS build, run:\n"
    '  "/Applications/Python 3.x/Install Certificates.command"'
)


def ssl_context() -> ssl.SSLContext:
    try:
        import certifi
    except ImportError:
        return ssl.create_default_context()
    return ssl.create_default_context(cafile=certifi.where())
