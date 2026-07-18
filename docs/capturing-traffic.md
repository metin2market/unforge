# Capturing the launcher's traffic

The public references drift as GameForge changes the flow, so the source of truth
is **the real launcher**. This is how to watch what it actually sends — the
reverse-engineering loop behind everything in [protocol.md](./protocol.md), and how
to re-verify the flow when GF changes it.

**The tools** (all in [`scripts/`](../scripts)):

| Script                                          | Does                                                                                                                                                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gfclear.bat`                                   | reset local GF state so the next launch does a **fresh `sessions` login** (run as admin)                                                                                                        |
| `capture.cmd` → `capture.ps1`                   | proxy on → `mitmdump` → proxy off; saves `captures/gf-<ts>.jsonl`                                                                                                                               |
| `gf-capture.py`                                 | the mitmproxy addon: records each request/response, the launcher's ClientHello (`tls_clienthello` → JA3), **and every `CONNECT` host** (`http_connect` → the full host map, incl. pinned hosts) |
| `frida/capture-ssl.ts` + `frida/ssl-capture.js` | **Frida SSL tap**: plaintext of the pinned native layer (`events2` et al.) that mitmproxy can't decrypt — see [Total-visibility capture](#total-visibility-capture-the-pinned-layer)            |
| `decode-blackbox.ts`                            | decode a captured blackbox back to its 30 named fields                                                                                                                                          |

## What the launcher is

`gfclient.exe` is a Qt shell hosting an embedded **Chromium (CEF)** web app served
from `spark://www.gameforge.com`. The login UI and its API calls run in that web
app, so the requests go through Chromium's network stack — which means a normal
HTTPS proxy can see them if its CA is trusted.

## Free first look: the console log

Before proxying anything, read the launcher's own console log:

```
%LOCALAPPDATA%\Gameforge4d\GameforgeClient\browser.log
```

It records the web app's `console.*` output — enough to _see the shape of the
flow_ (this is where the [PoW captcha](./pow-captcha.md) was found) but **not**
request bodies or headers. For those, capture the traffic.

## Capturing with mitmproxy

CEF respects the Windows system proxy and the Windows certificate store, so
mitmproxy works without patching the launcher.

**One-time setup:** install mitmproxy (the standalone Windows `mitmdump.exe` needs
no admin or Python), then **trust its CA** — open `http://mitm.it` while the proxy
runs and follow the Windows steps, or import `%USERPROFILE%\.mitmproxy\
mitmproxy-ca-cert.cer` into the CurrentUser **Trusted Root** store. This lets
mitmproxy decrypt the launcher's TLS — a deliberate security change, so remove the
CA when you're done capturing.

**Each capture:** run [`scripts/capture.cmd`](../scripts/capture.cmd). It turns the
Windows system proxy on (`127.0.0.1:8080`), runs mitmdump with the addon, and turns
the proxy back **off** on exit (even on Ctrl+C). Setting the proxy is the step
that's easy to forget when running `mitmdump` by hand — miss it and the launcher's
traffic bypasses the proxy and **nothing is captured**. Then:

1. Start `scripts/capture.cmd` (CEF reads the proxy at startup, so start it _before_
   the launcher).
2. In the launcher, **log out**, then log in fresh with email + password so a full
   login (PoW included) runs while capturing — a cached auto-resume never hits
   `spark`, so it captures nothing. If a plain logout still resumes from cache, run
   [`scripts/gfclear.bat`](../scripts/gfclear.bat) first (as admin) to wipe the
   web-auth session and force a real `sessions` login.
3. Click Play so `iovation` + `thin/codes` fire, then **Ctrl+C** in the capture
   window. It restores the proxy and prints how many requests it saved.

Output: a timestamped `scripts/captures/gf-<timestamp>.jsonl` (one per run,
gitignored — see the warning below).

Running `mitmdump` directly instead of the wrapper still works, but you must set the
system proxy yourself and unset it after:

```
mitmdump -s scripts/gf-capture.py --allow-hosts "(spark|pow-captcha)\.gameforge\.com" --set connection_strategy=lazy
```

Both flags are essential (see [Pinned hosts](#pinned-hosts)): `--allow-hosts`
intercepts only those two hosts and passes everything else through, and
`connection_strategy=lazy` stops mitmproxy from eagerly TLS-verifying the
passed-through hosts.

### The capture addon

The addon [`scripts/gf-capture.py`](../scripts/gf-capture.py) logs each
request/response for the auth hosts to a readable JSONL file, one per run under
`scripts/captures/`. Edit its `HOSTS` tuple to capture more.

> ⚠️ A capture contains the account **password** (in the `sessions` body) and live
> tokens + blackboxes. `scripts/captures/` is gitignored — never commit or share a
> capture.

### Reading a capture

[`scripts/decode-blackbox.ts`](../scripts/decode-blackbox.ts) decodes a captured
blackbox back to its 30 named fields (the inverse of `blackbox/generate.ts`) — the
fastest way to diff a real launcher blackbox against what we generate:

```
bun scripts/decode-blackbox.ts --capture scripts/captures/gf-<timestamp>.jsonl
```

It prints the raw `iovation` blackbox and the decrypted `thin/codes` one. Pass a
`tra:…` string directly to decode a single blackbox.

### Pinned hosts

The launcher's two network layers validate certificates differently:

- **CEF (Chromium) layer** — the login web app (`spark.gameforge.com`,
  `pow-captcha.gameforge.com`). Uses the **Windows certificate store**, so trusting
  the mitmproxy CA is enough to decrypt these. This is where the interesting
  traffic (login, PoW) lives.
- **Native Qt layer** — the telemetry hosts `events.gameforge.com` and
  `events2.gameforge.com` (mutual TLS over a private GF PKI). They validate certs
  independently of the Windows store, so MITM'ing them fails: `events2` throws an
  SSL-error dialog, and intercepting `events` makes mitmproxy unable to verify the
  upstream cert, which **freezes the launcher on the splash**.

So intercept **only** the CEF hosts you need and pass everything else through:
`--allow-hosts "(spark|pow-captcha)\.gameforge\.com"`. This dodges every pinned
host at once (there may be more than the two telemetry ones). We don't need the
telemetry hosts anyway — the `gsid` the code flow needs is a client-generated session
id we can mint locally, not something the telemetry call returns (see
[protocol.md](./protocol.md#telemetry-optional)).

Passing a host through is not enough on its own: mitmproxy's default **eager**
connection strategy opens and TLS-verifies the upstream _before_ deciding to pass
it through, so a pinned host still fails verification and **hangs the splash**.
`--set connection_strategy=lazy` defers that upstream connection, so passed-through
hosts tunnel end-to-end without mitmproxy touching their TLS.

### If a host we need still won't decrypt

If `spark.gameforge.com` or `pow-captcha.gameforge.com` themselves show TLS errors,
that layer is pinning too. Fall back to the **Frida SSL tap** below.

## Seeing the pinned native layer (Frida SSL tap)

mitmproxy can't decrypt the launcher's **native Qt layer** — the telemetry hosts
`events2`/`events` (mutual TLS over a private GF PKI). That layer was confirmed to be
**telemetry only** (no auth), so you rarely need it; but if GF changes and you must see it,
two tools give plaintext:

- **Host map (mitmproxy).** `gf-capture.py`'s `http_connect` hook logs every `CONNECT
host:port` as `{"type":"connect",…}` lines — the launcher's entire host set, including
  pinned hosts, without intercepting (and freezing) them.
- **Frida SSL tap.** [`scripts/frida/`](../scripts/frida) hooks OpenSSL `SSL_write`/`SSL_read`
  in `ssleay32.dll` (the Qt TLS stack), dumping decrypted bytes so pinning is irrelevant:

  ```
  cd scripts/frida && bun install     # one-time; native frida binding, isolated from lib deps
  bun capture-ssl.ts --dry            # verify Frida + the launcher path (no launch)
  bun capture-ssl.ts                  # spawns gfclient.exe; log in + Play; Ctrl+C to stop
  ```

  Streams every frame to `scripts/captures/frida-<ts>.jsonl`. Run it alongside `capture.cmd`
  to get both the CEF/spark flow and the pinned-layer plaintext in one login.

## What to look for

Diff the launcher's real requests against [protocol.md](./protocol.md):

- The `sessions` request — is a **PoW token** attached (new header or body field)?
  Which other headers differ?
- The `pow-captcha` challenge/submit calls — the challenge format and the solved
  token.
- The exact `thin/codes` `User-Agent` (confirms the account-hash) and body.
- The `blackbox` value and where it is sent.
