# The GameForge login protocol

How the GameForge launcher authenticates a **Spark** account and turns it into a
one-time game login code — the flow `unforge` reproduces. GameForge accounts are
shared across GF titles, so most of this is game-agnostic; only the final code is
Metin2-specific.

The endpoints live on `spark.gameforge.com`. Every request carries a
`TNT-Installation-Id` header (see [Installation id](#installation-id)).

> This page describes how the flow _works_. For what currently works vs. what's
> blocked, see [status.md](./status.md).

## The flow

Four calls, in order: authenticate → list accounts → attest device → mint code.
This mirrors a captured launcher "play now".

**How it hangs together:**

- The **bearer token** from step 1 is the thread — every later call carries it
  (`Authorization: Bearer`). It's the only credential you keep.
- Step 3 `iovation` returns just `{"status":"ok"}` — a _receipt_, not a credential.
- Step 4's **login code** is the end product — a different thing from the blackbox.
- **Every privileged call sends its OWN fresh blackbox with an advanced vector.** Reusing
  one blackbox across steps gets `iovation` rejected (`403`) — it's the single easiest way
  to break the flow. See [blackbox.md](./blackbox.md).

### 1. Session — credentials to bearer token

```
POST https://spark.gameforge.com/api/v2/authProviders/credentials/sessions
```

Headers: `TNT-Installation-Id`, `gf-installation-id`, `Origin:
spark://www.gameforge.com`, a browser `User-Agent`, `Content-Type:
application/json`. Body:

```json
{ "email": "…", "password": "…", "locale": "en-GB", "blackbox": "…" }
```

- **`locale` must match `^[a-z]{2}-[A-Z]{2}$`** — hyphen, not underscore. `en_GB`
  returns `400 INPUT_VALIDATION_FAILURE`; `en-GB` is accepted. (The older v1
  `auth/sessions` endpoint used `en_GB`; v2 is stricter.)
- **`blackbox`** — the iovation device fingerprint (see [Materials](#materials-and-inputs)),
  ~1750 chars, prefixed `tra:`. It is **required**: an empty string gets the whole
  request rejected as `409 CREDENTIALS_INVALID`, even with a correct password.
  Confirmed by replaying a captured launcher request through this code — the same
  call that fails empty returns `201` with a real blackbox. **Note:** each call sends its
  _own_ freshly-generated blackbox. `sessions` only checks it's present and well-formed, but
  `iovation` rejects a _replayed_ one (a vector that hasn't advanced), so never reuse the
  sessions blackbox on a later call ([blackbox.md](./blackbox.md)).

Success is `201` with `{ "token": "…" }` — the bearer token for the next calls.
Failures:

- `409` + `gf-challenge-id` header, body `errorTypes: ["CHALLENGE_REQUIRED"]` — a
  captcha is required. See [pow-captcha.md](./pow-captcha.md).
- `409` body `errorTypes: ["CREDENTIALS_INVALID"]` — bad password, a missing/invalid
  `blackbox`, or an account with no credentials provider (e.g. Google-SSO only).
- `403` — also treated as a credentials rejection.

### 2. Accounts — pick the game account

```
GET https://spark.gameforge.com/api/v1/user/accounts
```

Headers: `Authorization: Bearer <token>`, `TNT-Installation-Id`, browser UA. The
response is a JSON **object keyed by account id**; each value carries `gameId`,
`displayName`, `usernames`, and `guls.game` (the game name). Pick the account
whose game is Metin2.

### 3. Attest device

```
POST https://spark.gameforge.com/api/v1/auth/iovation
```

Headers: `Authorization: Bearer <token>`, `Origin`, `TNT-Installation-Id`, browser
UA. Body `{ "accountId": "…", "blackbox": "tra:…", "type": "play_now" }` — a **fresh**
`tra:…` blackbox, **not** the one sent to `sessions`. Returns `{ "status": "ok" }`. The
launcher sends this just before minting a code.

> **The one rule:** the blackbox here must be freshly generated with an _advanced_ vector.
> A replayed (byte-identical, or same-vector) blackbox is rejected `403 {"status":"failed"}`
> — GF treats it as a static/replayed device. game1.js re-runs per request; so do we
> ([blackbox.md](./blackbox.md)).

### 4. Code — mint the one-time login code

```
POST https://spark.gameforge.com/api/v1/auth/thin/codes
```

Headers: `Authorization: Bearer <token>`, `TNT-Installation-Id`, and the
**account-hash `User-Agent`** (see below) — note **no `Origin`** here. Body:

```json
{
  "blackbox": "<encrypted blackbox>",
  "gameId": "<gameId>.<region>",
  "gsid": "<sessionId>-<random 4 digits>",
  "platformGameAccountId": "<account id>"
}
```

- **`blackbox`** here is a **different, encrypted** blackbox from the `tra:…` one —
  base64-ish, ~2600 chars, bound to `gsid` + account. It's the raw `tra:…` blackbox
  XOR-encrypted against `sha512(gsid-accountId)` — generated natively, see
  [blackbox.md](./blackbox.md).
- **`gameId`** is the game id plus a region suffix, e.g. `fab180a3-….pt-PT`.
- **`gsid`** is a client session id (UUID) joined to a random 4-digit number.

Success is `{ "code": "…" }` — the one-time login code handed to `metin2client.exe`.

## Registering a GameForge account

Registration creates the top-level GF login (email + password) — the multibox lever
_above_ game accounts. Unlike login, it **always** triggers the PoW captcha.

```
POST https://spark.gameforge.com/api/v2/users
```

Same headers as `sessions` (both installation-id headers, `Origin`, browser UA). Body —
**email-first** key order (GF ignores order; we mirror the launcher):

```json
{ "email": "…", "password": "…", "locale": "pt-PT", "blackbox": "tra:…" }
```

The first attempt returns `409` + a `gf-challenge-id`; solve the PoW
([pow-captcha.md](./pow-captcha.md)) and **retry the same request** carrying header
`gf-challenge-id: {id}`. Success is `201` `{ "userCreated": true, "userId": "…" }`.
[`createUser`](../src/core/spark/create-user.ts) runs the `409 → solve → retry` loop headless
(the `instrumentation` is ops GF itself sends, not a blob to reverse — see
[pow-captcha.md](./pow-captcha.md)).

**A new login can authenticate immediately but can't _play_ until its email is verified.**
`sessions` returns a token with no verification, and you can list/create game accounts — but
**step 4 (`thin/codes`) refuses with `403 "Not allowed to create code"` until the email is
confirmed** (GameForge's confirmation link). Verified live: the same account went `403 → 201`
the minute after clicking the link. This gate is per-GF-account activation, not per game
account, and it does not lapse on its own.

## Logout

```
DELETE https://spark.gameforge.com/api/v1/auth/sessions
```

`Authorization: Bearer <token>`, `Origin`, `TNT-Installation-Id`, browser UA; no body.
Returns `202`, invalidating the session server-side — the clean way to end a run rather
than dropping the token ([`logout`](../src/core/spark/sessions.ts)).

## Creating a game account

A GF login starts with **no** game accounts (`/user/accounts` returns `{}`); the
launcher creates one on first play. Reproducing this lets one GF login mint game
accounts programmatically — the multibox lever.

```
POST https://spark.gameforge.com/api/v2/users/me/accounts
```

Same headers as `sessions` (Bearer token, `Origin`, both installation-id headers,
browser UA). Body:

```json
{
  "displayName": "…",
  "gameId": "fab180a3-cd65-4b7e-bd0e-2ef77fd0c258",
  "gameEnvironmentId": "5401ee5b-1316-41ae-a628-73377b8676ba",
  "gfLang": "pt",
  "accountGroup": "pt",
  "blackbox": "tra:…"
}
```

The `gameId` + `gameEnvironmentId` are Metin2's (pt) constants; the `blackbox` is
the `tra:…` one. Returns `201` with `{ accountId, displayName, gameId, guls }` —
`guls.user` is the numeric account id, `guls.server` the server. After this,
`/user/accounts` lists the new account and the [code flow](#4-code--mint-the-one-time-login-code)
can log into it.

Creation itself does **not** mint or hold a login code (the real launcher's `thin/codes` succeeds
immediately on a just-created account). But the account still can't get a code until its GF login is
**email-verified** — see [Registering a GameForge account](#registering-a-gameforge-account) above.

## The account hash ("MAGIC")

`thin/codes` is authorised by a hash embedded in the `User-Agent`:

```
User-Agent: Chrome/C<version> (<accountHash>)
```

`accountHash` is a deterministic SHA cascade over four inputs — the launcher's
embedded **certificate** (PEM bytes), the **client version**, the
**installation id**, and the **account id** — branched on the installation id's
**first decimal digit**:

- **Even** first digit: `accountId[:2]` + first 8 hex chars of
  `sha256( sha256(cert) + sha1("C"+version) + sha256(installId) + sha1(accountId) )`
- **Odd** first digit: `accountId[:2]` + last 8 hex chars of
  `sha256( sha1(cert) + sha256("C"+version) + sha1(installId) + sha256(accountId) )`

(The odd branch swaps sha1/sha256 and takes the right 8 chars.) All hash outputs
are lowercase hex strings that are concatenated as text before the outer hash.
Implemented in [`src/core/crypto.ts`](../src/core/crypto.ts).

**Verified against captured launcher UAs** (e.g. `Chrome/C2.8.5.1959 (58d43ebf89)`):
with the right cert our hash reproduces every captured `thin/codes` UA hash exactly. The
captures so far all use an **odd**-first-digit installation id, so only that branch has
ground-truth coverage; the even branch is exercised only synthetically.

## Materials and inputs

| Input               | What                           | Where it comes from                                                                           |
| ------------------- | ------------------------------ | --------------------------------------------------------------------------------------------- |
| **Installation id** | UUID, per account              | Generated + persisted by us (never per-launch)                                                |
| **Client version**  | e.g. `2.8.5.1959`              | `gfclient.exe` FileVersion                                                                    |
| **Certificate**     | GF-shared client cert (public) | Extracted once (Frida `importPkcs12`); only the **PEM** is used, for the `thin/codes` UA hash |
| **blackbox**        | iovation device fingerprint    | Reimplemented natively (recipe from `game1.js`) — [blackbox.md](./blackbox.md)                |

### Installation id

A UUID GameForge stores in the registry (`HKLM\SOFTWARE\WOW6432Node\Gameforge4d\
MainApp\InstallationId`). We generate our own instead — it must be **stable per
account** and **distinct across accounts** (both fresh-per-launch churn and a
shared id are fingerprinting red flags). It must contain a digit, since the
account hash branches on its first digit.

### Certificate

The `thin/codes` account hash needs the launcher's embedded **public certificate** — the PEM
only (the private key/`.p12` was just for the telemetry call we skip). The cert is **GF-shared
across titles**: its SHA-256 (`99025da7…`) matches the constant `stdLemon/nostale-auth` hardcodes
for NosTale. It's loaded at runtime via `QSslCertificate::importPkcs12` (no file on disk to copy),
so we **extract** it with a **Frida** hook on that call — as GflessClient's `CertExtractor` does;
`gfclient.exe` is 32-bit, so that recipe applies directly. `accountHash` normalises the PEM to LF
endings + a trailing newline (or the hash won't line up) and reproduces a captured launcher's UA
hash **exactly**. `morsisko/NosTale-Auth`'s older bundled cert gives the wrong hash — don't use it.
The PEM is bundled at `src/core/gameforge-cert.pem`.

## Telemetry (optional)

The launcher also POSTs a `game_started` event to `events2.gameforge.com` over
**mutual TLS** (using the `.p12`), which yields the session id it later reuses in
`gsid`. We can generate `gsid` locally instead, so this call is optional for
obtaining a code.

## What this does not do

Reproducing the login does **not** bypass any account-level block — the same auth
APIs are called, so a flagged account still fails. See the repo README.
