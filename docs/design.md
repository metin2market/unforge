# Design & architecture

How `unforge` is shaped: three layers, and the two halves — **authenticate** and
**launch** — that run through them. The wire-level detail lives in
[protocol.md](./protocol.md) (auth) and [handoff.md](./handoff.md) (client); current
progress in [status.md](./status.md); this is the structure above them.

## Three layers

Each is an entry point you can import on its own:

| Layer                             | What it is                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| **`core`** (`unforge/core`)       | What we reverse-engineered: endpoints, the account hash, the blackbox, the handoff wire protocol |
| **`storage`** (`unforge/storage`) | What persists: the sealed account store and the machine config                                   |
| **`app`** (`unforge`)             | Complete workflows over the two, plus the policy neither has                                     |

The rule that keeps the boundary honest:

> **core knows GameForge. It does not know unforge.**

So core holds no workflow, no persistence, and no default that encodes a decision of
ours. Anything true because _we_ chose it — one device per GameForge account, cached
sessions, minting a code only when the client asks for one — is `app`.
That is why [`GfSession`](../src/app/gf-session.ts) is not in core: it selects an
account, threads a device, resolves a cert and applies region policy, none of which
GameForge dictates.

Same test puts the handoff **protocol** in core (the pipe name, the `--gf` invocation, the
method set — all GameForge's design) and the handoff **server** in app (binding a
machine-wide OS resource and holding a registry is runtime state with a lifetime).

Code that knows _neither_ — reading an `unknown` from a caught throw or a parsed body — is
generic TypeScript, so it sits in `src/util` rather than widening core with plumbing. It is
internal on purpose: no `exports` entry, so it never becomes API anyone depends on.

`core` is wide on purpose. Every network step is a pair — a pure `build*Request` and the
call that sends it — because reproducing the flow yourself is a legitimate thing to want,
and the pure half is what gets asserted byte-for-byte against a captured launcher request.

### app is shaped for a long-lived host

`openApp()` binds the store, config, and policy once and returns `auth`, `accounts`, and
`launches`. It is designed against the demanding consumer — a daemon serving many clients —
because the CLI then gets that shape for free, while the reverse does not work: a
CLI-shaped API that blocks for the life of a game client can serve exactly one.

Concretely: dependencies bind at open, not per call; no operation blocks for a client's
lifetime (`launches.start` returns once the process exists, and progress is observed as
status); state is readable (`snapshot()`) and observable (`subscribe()`) in plain JSON.
The CLI and the `serve` UI are both thin clients of that one object.

## Two halves

- **Auth → login code** (cross-platform, the reusable core). The four Spark calls
  (`sessions` → `user/accounts` → `iovation` → `thin/codes`, see
  [protocol.md](./protocol.md)) turn credentials into a one-time game login code. No
  game client involved — runs anywhere Bun runs.
- **Launch** (Windows-only). Spawn `metin2client.exe --gf` from the region's game dir
  ([launch.md](./launch.md)) and hand it the code over a named pipe
  ([handoff.md](./handoff.md)); the client logs itself in, then loads and injects
  normally from there.

Split this way so the auth core stays cross-platform and dependency-light; only
`launch` touches Windows specifics (spawning the client, hosting the pipe). A
Linux/Mac user importing `unforge/core` can still generate codes.

Note the halves are asymmetric in lifetime: auth is a request/response the caller
awaits, but the handoff pipe is a **singleton, machine-wide, and shared by every
concurrent client** — so the app hosts one server for its lifetime and every launch
registers on it
([handoff.md → Concurrency and multibox](./handoff.md#concurrency-and-multibox)).

## Principles

- **Library + CLI, granular _and_ complete.** Every step is callable on its own
  (`unforge/core`) and the whole flow is one command (`unforge launch` → auth + spawn).
  Library consumers drive the same `openApp()` the CLI does.
- **Stateless core, optional persistence.** Core functions take everything as input;
  an opt-in state layer handles session reuse, the per-account device, and the cert
  ([accounts.md](./accounts.md)). **Never re-mint a session per call** — re-auth churn
  is a risk-scoring trigger, so a cached token is the cheap path, not an optimisation.
- **Stable, distinct identities.** A GameForge account owns one **device** —
  installation id + iovation identity + hardware fingerprint, as a single
  [`Device`](../src/storage/device.ts) — generated once and persisted. Never
  fresh-per-launch (churn), never shared across accounts (correlation). `auth device
regen` rolls all three at once, because they are one thing. See
  [protocol.md → Installation id](./protocol.md#installation-id) and
  [blackbox.md](./blackbox.md).
- **The blackbox freshness rule is structural.** Every privileged call needs its own
  vector-advanced blackbox; reusing one was the long-standing "clientless is blocked"
  bug. No method on [`GfSession`](../src/app/gf-session.ts) takes a blackbox, so a
  caller cannot replay one. (Core still hands out raw blackboxes — a consumer composing
  their own flow needs them — but unforge itself never touches one.)
- **Single-binary distribution.** `bun build --compile` → one binary per platform,
  no runtime install (what makes it usable from C++, Python, or anything that can
  run a program). The **auth** binary is cross-platform; the **launch** binary is
  Windows-only.
- **Bun-native first; `node:*` only where Bun has no equivalent.** The runtime is Bun
  (`Bun.file`, `Bun.write`, `Bun.spawn`, `Bun.CryptoHasher`, `Bun.serve`). A `node:*`
  import means Bun offers nothing for the job: `node:path`, `node:os`, `node:net` (the
  Windows named pipe), and the `node:fs` primitives with no Bun counterpart —
  `renameSync` for atomic replace, the exclusive-create (`wx`) lock, and `existsSync`,
  which unlike `Bun.file().exists()` also answers for **directories**. `src/` reads the
  environment through `process.env` / `process.argv`; `scripts/` use `Bun.env` /
  `Bun.argv`.

## Error handling

Every outbound call follows the same four steps, so a failure looks the same wherever it
happens and a frontend can classify it without reading prose.

1. **Dispatch through [`sendRequest`](../src/core/http.ts), never bare `fetch`.** It bounds the
   call (`REQUEST_TIMEOUT_MS`) and turns every transport failure — DNS, refused, reset, TLS,
   timeout — into a `NetworkError`. Raw `fetch` rejects with a `TypeError` whose message differs
   per runtime, which nothing downstream can branch on. `sparkFetch` wraps it for Spark requests;
   the captcha's cookie jar calls it directly.
2. **Read through [`readJson`](../src/core/http.ts), passing the endpoint's schema.** It maps
   `401` → `UnauthorizedError`, any other non-2xx → `UnexpectedResponseError` (carrying GF's
   parsed `spark` body), guards the parse so a 2xx of HTML is an unexpected _response_ rather
   than a `SyntaxError` from our parser, and validates the body against a zod schema declared
   next to the request that fetches it.
3. **Check the verdict, not just the status.** Several endpoints answer `200` with a body that
   says no — `iovation`'s `status`, `users`' `userCreated`, the captcha's `status: "solved"`. A
   2xx alone is never taken as consent.
4. **Give a recurring, actionable failure its own error class.** When GF's body is too generic
   to branch on (`CodeNotAllowedError`, `AttestationRejectedError`), the class _is_ the
   distinction. Core states only what GameForge did — no advice, no UI wording.

### Why the responses are validated

A third-party API you don't control is the one place an unchecked type assertion costs the most,
because the field that goes missing doesn't fail where it went missing. Unvalidated, each of these
reads as a bug that isn't there:

| GameForge changes                           | Symptom without a schema                                              |
| ------------------------------------------- | --------------------------------------------------------------------- |
| `iovation.status`                           | `undefined !== "ok"` → `AttestationRejectedError` — a blackbox hunt   |
| `sessions.token`                            | `Bearer undefined` → a `401` blamed on `user/accounts`, the next call |
| `codes.code`                                | `undefined` reaches the game client — a silent login screen, no error |
| a `DeviceProfile` field, off an older store | a malformed blackbox GF refuses, pointing anywhere but here           |

So the schemas exist for **diagnosis**, not defence: `ResponseShapeError` says the contract moved
and names the field, which is the one failure a retry cannot fix. `describeError` maps it to the
`response-shape` kind and says so — a UI that offered "try again" here would be lying.

They are **non-strict**. GameForge accretes fields, and unknown keys are dropped, so only a change
to a field unforge actually reads is an error. That is what keeps the signal worth acting on
instead of noise to be suppressed. It also means schemas model _what we read_, not the whole
payload — `guls` carries four fields and `user/accounts` declares the one it uses.

What a schema _does_ declare is **required**: a speculative `.optional()` only relocates the
requirement into a downstream guard, so the failure surfaces far from the contract that broke and
without a field name on it. Optionality has to be earned by a capture where the field is absent.

Note this is diagnosis at the moment of failure, not early warning: nothing here notices GF
changing until a call is made. Detection would be a scheduled canary running the flow, which is a
separate thing and not built.

**On retries — we deliberately don't.** The standard advice is to retry transient failures (408,
429, 5xx, dropped connections) with capped exponential backoff and jitter. That advice assumes
retries are safe, and here they mostly aren't: `thin/codes` is non-idempotent, and a code that gets
minted but not consumed locks the account out of another one for ~18 minutes (see
[protocol.md → Code](./protocol.md#4-code--mint-the-one-time-login-code)) — so an automatic retry
turns one failure into a guaranteed second one. Re-authentication churn is also a risk-scoring
signal in its own right. Bounded timeouts, yes; blind retries, no. If a retry policy is ever added
it has to be per-endpoint and idempotency-aware — safe on `user/accounts` (GET), never on
`thin/codes`. The one retry that does exist is the captcha re-send in
[`sendWithChallenge`](../src/core/spark/challenge.ts), which is a protocol requirement rather than
a fault-recovery policy: GF answers `409` precisely so the action gets re-sent with a solved
challenge.

When GameForge does rate-limit us it says so as `429`, and `Retry-After` is honoured per RFC 9110
(delay-seconds or HTTP-date) — carried on `RateLimitedError` and surfaced as `retryAfterMs` so a UI
can count down instead of guessing.

The human wording lives in one place, [`describeError`](../src/app/describe-error.ts), which maps
any error to a `summary`, a coarse `kind`, and GF's per-field rejections. **Both frontends render
it** — the CLI's failure reporter and `serve`'s JSON routes — so neither invents its own phrasing.
Adding a `kind` is how a UI earns an affordance (a retry timer, a focused field); reaching for
`err.message` in a frontend is the anti-pattern this exists to prevent.

## Materials

Three inputs the flow needs: the **installation id** (generated), the launcher's
**client certificate** (extracted once from a real install), and the **blackbox**
(generated natively — [blackbox.md](./blackbox.md)). Full table in
[protocol.md → Materials](./protocol.md#materials-and-inputs).

## Operational note

Pace your logins — a wait between logins, a longer wait after a rejection. Hammering
the auth endpoint invites risk scoring and temporary blocks. And note skipping the
launcher does **not** change GameForge's server-side checks: it removes the launcher
UI, not the account flags (it is not a ban bypass).
