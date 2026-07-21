# Architecture

Three layers, two halves, one rule that keeps the boundary honest.

## Three layers

Each is an importable entry point:

| Layer                             | Holds                                                                                | Source         |
| --------------------------------- | ------------------------------------------------------------------------------------ | -------------- |
| **`core`** (`unforge/core`)       | What we reverse-engineered: endpoints, the account hash, the blackbox, the pipe wire | `src/core/`    |
| **`storage`** (`unforge/storage`) | What persists: the sealed account store and the machine config                       | `src/storage/` |
| **`app`** (`unforge`)             | Complete workflows over both, plus the policy neither has                            | `src/app/`     |

> **core knows GameForge. It does not know unforge.**

So core holds no workflow, no persistence, and no default that encodes a decision of ours.
Anything true because _we_ chose it — one device per GameForge account, cached sessions, minting
a code only when the client asks — is `app`. That is why [`GfSession`](../src/app/gf-session.ts)
is not in core: it selects an account, threads a device, resolves a cert, applies region policy.

The same test splits the handoff: the **protocol** is core (pipe name, `--gf` invocation, method
set — all GameForge's design), the **server** is app (binding a machine-wide OS resource and
holding a registry is runtime state with a lifetime).

Code that knows neither — reading an `unknown` off a caught throw — is generic TypeScript and
lives in `src/util`, internal on purpose (no `exports` entry, so it never becomes API).

`core` is wide on purpose: every network step is a pair, a pure `build*Request` and the call that
sends it. Reproducing the flow yourself is a legitimate thing to want, and the pure half is what
gets asserted byte-for-byte against a captured launcher request.

## Two halves

- **Auth → login code** (cross-platform). Four Spark calls turn credentials into a one-time game
  login code, no game client involved — [protocol.md](./protocol.md).
- **Launch** (Windows-only). Spawn `metin2client.exe --gf` and hand it the code over a named pipe;
  the client logs itself in — [launch.md](./launch.md).

Split this way so the auth core stays cross-platform and dependency-light. The halves are
asymmetric in lifetime: auth is a request/response the caller awaits, but the handoff pipe is a
**singleton, machine-wide, shared by every concurrent client** — so the app hosts one server for
its own lifetime and every launch registers on it.

## `app` is shaped for a long-lived host

`openApp()` binds the store, config, and policy once and returns `auth`, `accounts`, and
`launches`. It is designed against the demanding consumer — a host serving many clients — because
the CLI then gets that shape for free, while the reverse does not work: a CLI-shaped API that
blocks for the life of a game client can serve exactly one.

Concretely: dependencies bind at open, not per call; no operation blocks for a client's lifetime
(`launches.start` returns once the process exists, progress is observed as status); state is
readable (`snapshot()`) and observable (`subscribe()`) in plain JSON. The CLI
([`src/cli/`](../src/cli/index.ts)) and the `serve` web UI ([`src/serve/`](../src/serve/index.ts))
are thin clients of that one object, so command logic lives in one place.

`serve` draws no window of its own and runs no daemon: it opens the UI as an app window which
holds a heartbeat WebSocket, and the server exits when the last one drops. A second launch finds
the port taken and reopens the window at the running instance.

| Piece                                                          | Where                                               |
| -------------------------------------------------------------- | --------------------------------------------------- |
| `openApp()` — the workflows (`auth` / `accounts` / `launches`) | `src/app/app.ts`                                    |
| `GfSession` — an authenticated login; owns blackbox freshness  | `src/app/gf-session.ts`                             |
| ref resolution — handle / email / name / id prefix (pure)      | `src/app/refs.ts`                                   |
| a group as a person reads it (`regionLabel`)                   | `src/app/region-text.ts`                            |
| the handoff pipe server · launch tracking                      | `src/app/handoff-server.ts` · `src/app/launches.ts` |
| cert PEM — bundled, local file overrides                       | `src/app/cert.ts`                                   |
| the shapes the web UI receives (region pre-rendered)           | `src/serve/wire.ts`                                 |
| `spawnClient()` — the Windows client spawn                     | `src/launch/`                                       |

## Principles

- **Library + CLI, granular _and_ complete.** Every step is callable on its own (`unforge/core`)
  and the whole flow is one command (`unforge launch`).
- **Stateless core, optional persistence.** Core takes everything as input; an opt-in state layer
  handles session reuse, the per-account device, and the cert ([storage.md](./storage.md)).
  **Never re-mint a session per call** — re-auth churn is a risk-scoring trigger.
- **Identity rules are structural, not conventions.** A GameForge account owns one persisted
  `Device`, and no `GfSession` method accepts a blackbox — so a caller cannot churn an identity or
  replay a blackbox even by mistake ([blackbox.md](./blackbox.md)).
- **Single-binary distribution.** `bun build --compile` → one executable, no runtime install, so
  it's callable from C++, Python, or anything that runs a program.
- **Bun-native first.** A `node:*` import means Bun offers nothing for the job: `node:path`,
  `node:os`, `node:net` (the Windows named pipe), and the `node:fs` primitives with no counterpart
  — `renameSync`, the exclusive-create (`wx`) lock, and `existsSync`, which unlike
  `Bun.file().exists()` also answers for directories. `src/` reads `process.env`/`process.argv`;
  `scripts/` use `Bun.env`/`Bun.argv`.
- **Pace the logins.** A wait between logins, a longer wait after a rejection. Hammering the auth
  endpoint invites risk scoring and temporary blocks ([red-bar.md](./red-bar.md)).

## Error handling

Every outbound call follows the same four steps, so a failure looks the same wherever it happens
and a frontend can classify it without reading prose.

1. **Dispatch through [`sendRequest`](../src/core/http.ts), never bare `fetch`.** It bounds the
   call and turns every transport failure — DNS, refused, reset, TLS, timeout — into a
   `NetworkError`. Raw `fetch` rejects with a `TypeError` whose message differs per runtime, which
   nothing downstream can branch on.
2. **Read through [`readJson`](../src/core/http.ts) with the endpoint's zod schema.** `401` →
   `UnauthorizedError`, other non-2xx → `UnexpectedResponseError` carrying GF's parsed body, and a
   guarded parse so a 2xx of HTML is an unexpected _response_ rather than a `SyntaxError`.
3. **Check the verdict, not just the status.** Several endpoints answer `200` with a body that
   says no — `iovation`'s `status`, `users`' `userCreated`, the captcha's `status: "solved"`.
4. **Give a recurring, actionable failure its own error class** (`CodeNotAllowedError`,
   `AttestationRejectedError`) when GF's body is too generic to branch on. Core states only what
   GameForge did — no advice, no UI wording.

**Schemas exist for diagnosis, not defence.** A third-party API is where an unchecked type
assertion costs most, because the field that goes missing doesn't fail where it went missing:

| GameForge changes                           | Symptom without a schema                                              |
| ------------------------------------------- | --------------------------------------------------------------------- |
| `iovation.status`                           | `undefined !== "ok"` → `AttestationRejectedError` — a blackbox hunt   |
| `sessions.token`                            | `Bearer undefined` → a `401` blamed on `user/accounts`, the next call |
| `codes.code`                                | `undefined` reaches the game client — a silent login screen, no error |
| a `DeviceProfile` field, off an older store | a malformed blackbox GF refuses, pointing anywhere but here           |

`ResponseShapeError` says the contract moved and names the field — the one failure a retry cannot
fix, so `describeError` maps it to the `response-shape` kind and a UI never offers "try again".
Schemas are **non-strict** (GF accretes fields; unknown keys drop) and model only what we read,
but what they declare is **required**: a speculative `.optional()` relocates the requirement into
a downstream guard, so the failure surfaces far from the contract that broke. Optionality has to
be earned by a capture where the field is absent.

**No retries, deliberately.** `thin/codes` is non-idempotent and a minted-but-unconsumed code locks
the account out of another for ~18 minutes ([protocol.md](./protocol.md#4-code--mint-the-one-time-login-code)),
so an automatic retry turns one failure into a guaranteed second. Re-auth churn is a risk signal
in its own right. Bounded timeouts yes, blind retries no; any future policy must be per-endpoint
and idempotency-aware. The one retry that exists is the captcha re-send in
[`sendWithChallenge`](../src/core/spark/challenge.ts), which is a protocol requirement — GF answers
`409` precisely so the action gets re-sent solved. Real rate limiting arrives as `429`;
`Retry-After` is honoured per RFC 9110 and surfaced as `retryAfterMs` so a UI can count down.

Human wording lives only in [`describeError`](../src/app/describe-error.ts), which maps any error
to a `summary`, a coarse `kind`, and GF's per-field rejections. Both frontends render it, so
neither invents its own phrasing; reaching for `err.message` in a frontend is the anti-pattern
this prevents.

## Logging

Structured logging on [LogTape](https://logtape.org). The library only _emits_
(`getLogger(["unforge", …])`); each entry point calls `configureLogging()` once at startup. If
nothing configures LogTape the calls are no-ops, so `core` imposes no I/O on embedders.

Levels: `trace` (every HTTP call), `debug` (per-step progress), `info` (milestones), `warn`
(handled-but-unexpected), `error` (the operation failed).

Two sinks are always on:

- **console** on stderr, so stdout stays clean (`account code` prints only the code). `info`+ by
  default; `--verbose` drops it to `debug`+ — never `trace`.
- **file**, a rotating trail capturing **everything** (`trace`+, bodies included) regardless of the
  console threshold. `%LOCALAPPDATA%\unforge\logs\unforge.log`, overridable with `$UNFORGE_LOG_FILE`;
  20 MB × 10 files, written unbuffered so a one-shot CLI run still leaves a complete trail.

**The request trace is always on** — one `→` before dispatch (so a hung call still leaves a mark)
and one `←` with status and duration, inline with the steps that made it. No flag, because the
failures worth diagnosing are one-shot: a spent challenge or a cooldown can't be reproduced.

`trace-scrub.ts` masks credentials before they are logged: `password` → a constant (nothing is
diagnosable from one), `token`/`code`/`Authorization` → a truncated SHA-256, which keeps "same
token as last call?" answerable and is safe only because those are high-entropy. Blackbox,
installation ids, cookies and email stay raw — that _is_ the diagnosis, and it is why bodies are
logged as strings (`redactByField` walks fields and would strip exactly those). The log therefore
stays device-identifying: local, gitignored, never pasted in public. Every sink also wraps
`@logtape/redaction`; pass secrets as named fields, never interpolated into a message.

There is no telemetry sink in the tool — unforge opens only the GameForge calls the flow needs. An
embedder that wants its own sinks configures LogTape itself; unforge only emits.
