# Status — what works, what's blocked

`unforge` turns an email + password into a logged-in Metin2 client, headless, with **no GameForge
launcher**. The chain works end-to-end.

## The login flow, step by step

| #   | Step            | What it does                                 | State    |
| --- | --------------- | -------------------------------------------- | -------- |
| 1   | `sessions`      | email + password (+ blackbox) → bearer token | ✅ works |
| 2   | `user/accounts` | list the game accounts on the login          | ✅ works |
| 3   | **`iovation`**  | attest the device ("blackbox") for play-now  | ✅ works |
| 4   | `thin/codes`    | mint the one-time game login code            | ✅ works |
| 5   | launch client   | spawn `metin2client.exe --gf`                | ✅ works |
| 6   | handoff         | serve the code on the pipe → client logs in  | ✅ works |

Verified end-to-end 2026-07-17: `unclear_xyz` went straight to character creation — no login screen.
Steps 5–6 are [handoff.md](./handoff.md).

[`authenticate()`](../src/core/authenticate.ts) runs steps 1→4 and returns a login code — verified against a
real Metin2 account (`crbgames1+gf`/`m2maccount`): minted a live code on a residential IP, over a
generic transport, no launcher, no client cert presented.

**`account create` (make a new game account headless) — works, off the login path.** Verified live
2026-07-17 (`unclear2x1` created + listed + launchable). Details/wire in
[protocol.md → Creating a game account](./protocol.md#creating-a-game-account).

**Gotcha for new accounts: verify the email before you can play.** A headless-registered GF account
can log in and create game accounts, but `thin/codes` (step 4) `403`s `"Not allowed to create code"`
until its email is confirmed — see
[protocol.md → Registering](./protocol.md#registering-a-gameforge-account). `auth register` now says
so; `CodeNotAllowedError` covers this and a genuinely outstanding code.

## The one rule that makes it work: a fresh blackbox per call

**Every privileged call must send its OWN freshly-generated blackbox, with an _advanced_ vector.**
GF's `iovation` rejects a replayed blackbox — specifically one whose rolling vector
(`vecSignatureBase64`) hasn't moved on from the previous call's — with `403 {"status":"failed"}`.
game1.js re-runs per request and drifts the vector ~1 char/sec; the real launcher mints a new
blackbox each time.

- [`authenticate()`](../src/core/authenticate.ts) draws each blackbox from a `BlackboxSequence`
  (`createBlackboxSequence`), which mints a separate one for `sessions`, `iovation`, and
  `thin/codes` and **forces** the vector to advance on every call after the first — back-to-back
  headless calls otherwise land inside the same 1-second drift step and would send an identical
  vector.
- Never reuse a blackbox across steps. `attestDevice`/`requestLoginCode` take the blackbox as input;
  the flow owns freshness. See the warnings in [`iovation.ts`](../src/core/spark/iovation.ts) and
  [`blackbox.md`](./blackbox.md).

This single detail was the entire "clientless is blocked" problem.

## How it was found (and why it took so long)

The reference [`stdLemon/nostale-auth`](https://github.com/stdLemon/nostale-auth) runs the same GF spark
flow with a **generic Go `net/http` client — no CEF, no JA3/h2 impersonation, no client certificate.**
Run locally it passed `iovation` and minted a `thin/codes` code for **both** NosTale and a Metin2
account. unforge failed `iovation` on the _identical_ Metin2 account on the same machine/IP/minute → the
difference was purely unforge's code. Controlled isolation (same token, same account, back-to-back): a
**reused** blackbox `403`d; a **fresh, vector-advanced** one `200`d. The Go lib passes because it calls
`NewBlackbox()` per request (its `UpdateVector` always advances); unforge reused one blackbox.

**The transport/cert/IP investigations were chasing a wall that never existed.** Because unforge always
reused the blackbox, `iovation` always `403`d, which read as an unbeatable server-side "genuine-CEF
grade." It wasn't. These are **dead ends, not leads** — do not re-open them:

- **Transport** (JA3, HTTP/2, exact CEF-72 fingerprint) — a generic Go client passes; not the grade.
- **Client certificate** — GF-**shared** (its SHA matches the Go lib's hardcoded constant), and it only
  feeds the `thin/codes` account-hash UA; `thin/codes` is not mutual-TLS.
- **`events2` / "hidden calls"** — telemetry only (returns `ok`, no grade).
- **IP / machine** — a clean residential IP and an ordinary desktop both pass.
- **`createGameAccount 409`** — account-verification state, not a grade.

## Materials (all solved)

| Material                | State                                                                 |
| ----------------------- | --------------------------------------------------------------------- |
| Installation id         | ✅ per-account UUID                                                   |
| Blackbox (v12, native)  | ✅ byte-verified vs game1.js; **generated fresh per call**            |
| Certificate (PEM)       | ✅ extracted; feeds the `thin/codes` account-hash UA (GF-shared cert) |
| Account hash / MAGIC UA | ✅ reproduced, matches a captured login                               |

## What's built vs not

- ✅ **Core auth** — `createSession`, `listGameAccounts`, `attestDevice`, `requestLoginCode`, and the
  full `authenticate()` flow (`src/core/`). Pure `build*Request()` split from the network call, diffed
  byte-for-byte against real captures.
- ✅ **Blackbox** — native generator + encryption, byte-verified; **fresh-per-call enforced by the flow**.
- ✅ **Account hash** (`crypto.ts`) — reproduces the launcher's `thin/codes` UA from the GF-shared cert PEM.
- ✅ **PoW captcha** — passes a live challenge headless, no browser. There was never a blob to reverse:
  the `instrumentation` is ops **GF itself sends** in the challenge, which we eval
  (`instrumentation.ts`). Verified live on a real login challenge (`{"status":"solved"}`, ~8.7s), and
  the shim reproduces real CEF's results **15/15** against a capture. `createSession` solves a login
  challenge and retries; `auth register` (`createGfAccount`) creates accounts headless through the same
  path ([pow-captcha.md](./pow-captcha.md)). (`POST /users` is rate-limited from testing —
  **don't debug the captcha there**, see the doc.)
- ✅ **Handoff** — `core/handoff/` spawns `metin2client.exe --gf` and serves the code on the
  `GameforgeClientJSONRPC` pipe; the client logs itself in ([handoff.md](./handoff.md)). The protocol
  module is pure and unit-tested; the pipe server multiplexes concurrent clients by `sessionId`.
  Needs the real launcher closed (it owns the pipe) and admin.
- ✅ **Launch** — `src/launch/` resolves the install dir and handles the client's admin requirement
  (plain spawn when elevated, else UAC) ([launch.md](./launch.md)).
- ✅ **CLI + state** — `unforge auth`/`account`/`launch`/`config` over the sealed store
  ([accounts.md](./accounts.md)); a distinct device profile is minted per GameForge account
  (`generateDeviceProfile`). The `serve` web UI drives the same store + core. The `thin/codes` cert
  resolves from `~/unforge-materials/cert.pem` → the build-baked cert, so `account code` needs no
  setup; only `launch`'s per-region game dir needs `config` ([launch.md](./launch.md)).

## What's next

The login-and-launch chain is complete, so the frontier is shape, not plumbing:

- **Multibox at scale.** Per-account device + `installationId` are already distinct; the remaining
  work is driving many concurrent clients cleanly off the one machine-wide handoff pipe
  ([handoff.md → Concurrency and multibox](./handoff.md#concurrency-and-multibox)).
- **A long-lived responder.** The client keeps asking the pipe for things _during_ play, not just at
  login, so `launch` has to stay alive for the whole session ([design.md](./design.md)). Open
  question: keep it a foreground window you leave open, or run it as a background service that owns
  the pipe for every client at once?
- **The primary face.** Is the **CLI** the driver with `serve` as a nicety, or the **web UI** the
  main face and the CLI for scripting? The command surface ([cli.md](./cli.md)) stands either way —
  this only decides where polish goes.

## Operational notes

- **Pacing** — space out logins; hammering invites the login-time PoW challenge on `sessions`
  (solved headless, but each one adds latency) ([pow-captcha.md](./pow-captcha.md), [design.md](./design.md)).
- **One identity per account** — persist the device identity + `installationId` per GF account; don't
  churn fingerprints, and don't mix a launcher login and a headless one on the same account.
- **Not every `403` is retryable.** `thin/codes` `403`s with `Not allowed to create code` when a
  previous code is still outstanding — surfaced as `CodeOutstandingError`, and **only time fixes it**
  (~18m; see [handoff.md](./handoff.md)). Retrying that one re-authenticates for nothing and feeds
  risk scoring. Other isolated `403`s have been seen to pass on a fresh retry. The library never
  retries on its own; the caller decides, and should branch on the error type rather than the status.
