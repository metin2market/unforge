# Capturing the launcher's traffic

Public references drift as GameForge changes the flow, so the source of truth is **the real
launcher**. This is how to watch what it actually sends — the RE loop behind
[protocol.md](./protocol.md), and how to re-verify when GF changes something.

`gfclient.exe` is a Qt shell hosting an embedded **Chromium (CEF)** web app served from
`spark://www.gameforge.com`. The login UI and its API calls run in that web app, so they go through
Chromium's network stack — which a normal HTTPS proxy can see if its CA is trusted.

| Tool ([`scripts/`](../scripts))                 | Does                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `gfclear.bat`                                   | reset local GF state so the next launch does a **fresh `sessions` login** (run as admin)    |
| `capture.cmd` → `capture.ps1`                   | proxy on → `mitmdump` → proxy off; saves `captures/gf-<ts>.jsonl`                           |
| `gf-capture.py`                                 | the mitmproxy addon: each request/response, the ClientHello (JA3), and every `CONNECT` host |
| `frida/capture-ssl.ts` + `frida/ssl-capture.js` | Frida SSL tap — plaintext of the pinned native layer mitmproxy can't decrypt                |
| `decode-blackbox.ts`                            | decode a captured blackbox back to its 30 named fields                                      |
| `capture-launch.ps1`                            | ground truth for the client spawn ([launch.md](./launch.md#verifying-it))                   |

## Free first look: the console log

Before proxying anything, read the launcher's own console log at
`%LOCALAPPDATA%\Gameforge4d\GameforgeClient\browser.log`. It records the web app's `console.*`
output — enough to see the _shape_ of the flow (this is where the [captcha](./captcha.md) was found)
but **not** request bodies or headers.

## Capturing with mitmproxy

CEF respects the Windows system proxy and certificate store, so no patching is needed.

**One-time setup:** install mitmproxy (the standalone `mitmdump.exe` needs no admin or Python), then
**trust its CA** — open `http://mitm.it` while the proxy runs, or import
`%USERPROFILE%\.mitmproxy\mitmproxy-ca-cert.cer` into the CurrentUser **Trusted Root** store. This
is a deliberate security change; remove the CA when you're done.

**Each capture:** run [`scripts/capture.cmd`](../scripts/capture.cmd), which turns the Windows system
proxy on (`127.0.0.1:8080`), runs mitmdump with the addon, and turns it back off on exit (even on
Ctrl+C). Setting the proxy is the step that's easy to forget by hand — miss it and the launcher's
traffic bypasses the proxy and **nothing is captured**.

1. Start `capture.cmd` **before** the launcher (CEF reads the proxy at startup).
2. In the launcher, **log out**, then log in fresh with email + password so a full login runs — a
   cached auto-resume never hits `spark` and captures nothing. If a plain logout still resumes from
   cache, run [`gfclear.bat`](../scripts/gfclear.bat) (as admin) first.
3. Click Play so `iovation` + `thin/codes` fire, then **Ctrl+C** in the capture window.

Output: `scripts/captures/gf-<timestamp>.jsonl`, one per run. Edit the addon's `HOSTS` tuple to
capture more hosts.

> ⚠️ A capture contains the account **password** (in the `sessions` body), live tokens and
> blackboxes. `scripts/captures/` is gitignored — never commit or share one.

Running `mitmdump` directly works too, but you must set and unset the system proxy yourself:

```
mitmdump -s scripts/gf-capture.py --allow-hosts "(spark|pow-captcha)\.gameforge\.com" --set connection_strategy=lazy
```

**Both flags are essential** — see below.

## Pinned hosts

The launcher's two network layers validate certificates differently:

- **CEF (Chromium) layer** — the login web app (`spark`, `pow-captcha`). Uses the Windows
  certificate store, so trusting the mitmproxy CA is enough. This is where the interesting traffic
  lives.
- **Native Qt layer** — the telemetry hosts `events.gameforge.com` and `events2.gameforge.com`
  (mutual TLS over a private GF PKI). They validate independently of the Windows store, so MITM'ing
  fails: `events2` throws an SSL-error dialog, and intercepting `events` makes mitmproxy unable to
  verify the upstream cert, which **freezes the launcher on the splash**.

So intercept **only** the CEF hosts you need: `--allow-hosts "(spark|pow-captcha)\.gameforge\.com"`
dodges every pinned host at once (there may be more than the two telemetry ones). We don't need the
telemetry hosts anyway — `gsid` is a client-generated session id we mint locally
([protocol.md](./protocol.md#telemetry--skipped)).

Passing a host through is not enough on its own: mitmproxy's default **eager** connection strategy
opens and TLS-verifies the upstream _before_ deciding to pass it through, so a pinned host still
fails verification and hangs the splash. `--set connection_strategy=lazy` defers that connection so
passed-through hosts tunnel end-to-end untouched.

## Seeing the pinned layer (Frida SSL tap)

That native layer is confirmed **telemetry only** (no auth), so you rarely need it. If GF changes
and you must:

- **Host map (mitmproxy).** `gf-capture.py`'s `http_connect` hook logs every `CONNECT host:port` as
  `{"type":"connect",…}` — the launcher's entire host set, including pinned hosts, without
  intercepting (and freezing) them.
- **Frida SSL tap.** [`scripts/frida/`](../scripts/frida) hooks OpenSSL `SSL_write`/`SSL_read` in
  `ssleay32.dll` (the Qt TLS stack), dumping decrypted bytes so pinning is irrelevant:

  ```sh
  cd scripts/frida && bun install     # one-time; native frida binding, isolated from lib deps
  bun capture-ssl.ts --dry            # verify Frida + the launcher path (no launch)
  bun capture-ssl.ts                  # spawns gfclient.exe; log in + Play; Ctrl+C to stop
  ```

  Streams every frame to `scripts/captures/frida-<ts>.jsonl`. Run it alongside `capture.cmd` to get
  both the CEF flow and the pinned-layer plaintext from one login.

The same fallback applies if `spark` or `pow-captcha` themselves ever start showing TLS errors —
that would mean the CEF layer is pinning too.

## Reading a capture

[`scripts/decode-blackbox.ts`](../scripts/decode-blackbox.ts) is the inverse of the blackbox
generator — the fastest way to diff a real launcher blackbox against what we produce:

```sh
bun scripts/decode-blackbox.ts --capture scripts/captures/gf-<timestamp>.jsonl
```

It prints the raw `iovation` blackbox and the decrypted `thin/codes` one. Pass a `tra:…` string
directly to decode a single blackbox.

Then diff the launcher's real requests against [protocol.md](./protocol.md): is a PoW token attached
to `sessions` (new header or body field)? Which other headers differ? What is the exact `thin/codes`
User-Agent (it confirms the account hash)? Where is the blackbox sent, and what does it contain?
