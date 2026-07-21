# mitmproxy addon: capture GameForge auth traffic to a readable JSONL file.
#
#   mitmdump -s scripts/gf-capture.py \
#     --allow-hosts "(spark|pow-captcha)\.gameforge\.com" \
#     --set connection_strategy=lazy
#
# Then log into the real GF launcher (fresh email + password) so a full login runs
# while capturing. See docs/capturing-traffic.md for the proxy + CA setup and why
# both flags are essential (the telemetry hosts are cert-pinned; passing them
# through with lazy connections avoids freezing the launcher on the splash).
#
# Output: scripts/captures/gf-<timestamp>.jsonl — one file per run, so captures
# accumulate for diffing over time. LOCAL ONLY: the sessions request body carries
# the account password and every call carries live tokens + blackboxes. The
# captures/ dir is gitignored — never commit or share a capture.

import json
import os
import time
from mitmproxy import http

# Hosts whose API calls matter for the login flow. Only spark/pow-captcha are
# intercepted (via --allow-hosts); the events* telemetry hosts are pinned and pass
# through, but stay listed so that if a future capture does see one, it's recorded.
HOSTS = (
    "spark.gameforge.com",
    "pow-captcha.gameforge.com",
    "events2.gameforge.com",
    "events.gameforge.com",
    "image-drop-challenge.gameforge.com",
)

_CAPTURE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "captures")
os.makedirs(_CAPTURE_DIR, exist_ok=True)
OUT = os.path.join(_CAPTURE_DIR, time.strftime("gf-%Y%m%d-%H%M%S.jsonl"))


def _write(entry: dict) -> None:
    with open(OUT, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")


_diag_written = False


def http_connect(flow: http.HTTPFlow) -> None:
    # Every HTTPS connection through the system proxy starts with a plaintext
    # `CONNECT host:port` — so this fires for ALL hosts, including the cert-pinned
    # ones we deliberately pass through (events2/events) and any host we've never
    # noticed. It maps the launcher's FULL host set WITHOUT intercepting (and
    # freezing) the pinned layer. A host that never shows up here is one the launcher
    # opens outside the system proxy (→ only Frida can see it). See scripts/frida/.
    _write({"type": "connect", "time": time.strftime("%H:%M:%S"),
            "host": flow.request.host, "port": flow.request.port})
    print(f"[connect] {flow.request.host}:{flow.request.port}", flush=True)


def tls_clienthello(data) -> None:
    # Record the launcher's TLS fingerprint for the auth host so we can rebuild its exact
    # JA3 offline — the test for whether GameForge pins the launcher's CEF-72 fingerprint
    # to grade the sessions token — a settled dead end (see docs/blackbox.md). mitmproxy parses the
    # ClientHello, so we grab cipher_suites + extensions (+ raw bytes if available), which
    # is enough to compute JA3 without depending on any one attribute name.
    global _diag_written
    try:
        ch = getattr(data, "client_hello", None)
        if ch is None:
            return
        sni = getattr(ch, "sni", None)
        # One-time dump of the object's real API, so a wrong attribute guess can't
        # silently lose the capture again.
        if not _diag_written:
            _diag_written = True
            _write({"type": "clienthello_diag", "sni": sni,
                    "cls": str(type(ch)), "attrs": [a for a in dir(ch) if not a.startswith("_")]})
        if sni not in HOSTS:
            return
        entry: dict = {"type": "clienthello", "time": time.strftime("%H:%M:%S"), "sni": sni}
        # raw bytes under whatever name this version uses
        for attr in ("raw_bytes", "raw", "data"):
            v = getattr(ch, attr, None)
            if isinstance(v, (bytes, bytearray)):
                entry["raw"] = bytes(v).hex()
                break
        # parsed fallbacks (enough for JA3 on their own)
        try:
            entry["cipher_suites"] = list(getattr(ch, "cipher_suites", []) or [])
        except Exception as e:
            entry["cipher_suites_err"] = repr(e)
        try:
            entry["extensions"] = [[t, (d.hex() if isinstance(d, (bytes, bytearray)) else str(d))]
                                   for (t, d) in (getattr(ch, "extensions", []) or [])]
        except Exception as e:
            entry["extensions_err"] = repr(e)
        try:
            entry["alpn"] = [a.decode("latin-1") if isinstance(a, (bytes, bytearray)) else str(a)
                             for a in (getattr(ch, "alpn_protocols", []) or [])]
        except Exception:
            pass
        _write(entry)
        print(f"[clienthello] {sni} raw={'yes' if 'raw' in entry else 'no'} "
              f"ciphers={len(entry.get('cipher_suites', []))} exts={len(entry.get('extensions', []))}",
              flush=True)
    except Exception as e:  # never break the handshake over a capture detail
        _write({"type": "clienthello_err", "err": repr(e)})
        print(f"[clienthello] failed: {e!r}", flush=True)


def response(flow: http.HTTPFlow) -> None:
    host = flow.request.pretty_host
    if host not in HOSTS:
        return
    # The client's negotiated HTTP version ("HTTP/1.1" vs "HTTP/2.0") and ALPN are
    # the point of capturing a *working* third-party client (e.g. hunt2): iovation
    # appears to gate on HTTP/2, so recording which protocol a client that passes
    # actually uses is the whole experiment. (The raw TLS/JA3 is still masked — the
    # proxy terminates it — but the HTTP version the client asked us for is visible.)
    entry = {
        "time": time.strftime("%H:%M:%S"),
        "method": flow.request.method,
        "url": flow.request.pretty_url,
        "http_version": flow.request.http_version,
        "client_alpn": bytes(flow.client_conn.alpn or b"").decode("latin-1"),
        "req_headers": dict(flow.request.headers),
        "req_body": flow.request.get_text(strict=False),
        "status": flow.response.status_code,
        "resp_headers": dict(flow.response.headers),
        "resp_body": flow.response.get_text(strict=False),
    }
    with open(OUT, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    # flush so the line shows live instead of buffering until exit.
    print(
        f"[captured] {flow.request.http_version} {flow.request.method} "
        f"{host}{flow.request.path.split('?')[0]} -> {flow.response.status_code}",
        flush=True,
    )
