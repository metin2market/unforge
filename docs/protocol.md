# The GameForge login protocol

How the launcher authenticates a **Spark** account and turns it into a one-time game login code —
the flow `unforge` reproduces. GameForge accounts are shared across GF titles, so most of this is
game-agnostic; only the final code is Metin2-specific.

Everything is on `spark.gameforge.com`, and every request carries a `TNT-Installation-Id` header.

## The flow

Four calls, in order, mirroring a captured launcher "play now":

```
sessions ──▶ user/accounts ──▶ iovation ──▶ thin/codes
 token        game accounts     device       login code
                                attested      minted
```

- The **bearer token** from step 1 is the thread — every later call carries it. It is the only
  credential you keep.
- Step 3 returns `{"status":"ok"}` — a _receipt_, not a credential.
- **Every privileged call sends its OWN fresh blackbox with an advanced vector.** Reusing one
  across steps gets `iovation` rejected — the single easiest way to break the flow
  ([blackbox.md](./blackbox.md)).

### 1. Session — credentials to bearer token

```
POST /api/v2/authProviders/credentials/sessions
{ "email": "…", "password": "…", "locale": "en-GB", "blackbox": "tra:…" }
```

Headers: `TNT-Installation-Id`, `gf-installation-id`, `Origin: spark://www.gameforge.com`, a
browser `User-Agent`, `Content-Type: application/json`.

- **`locale` must match `^[a-z]{2}-[A-Z]{2}$`** — hyphen, not underscore. `en_GB` returns
  `400 INPUT_VALIDATION_FAILURE`. (The older v1 `auth/sessions` accepted `en_GB`; v2 is stricter.)
- **`blackbox` is required.** An empty string gets the request rejected as
  `409 CREDENTIALS_INVALID` even with a correct password. `sessions` only checks that it is present
  and well-formed — but never reuse this one on a later call.

Success is `201 { "token": "…" }`. Failures:

| Response                                        | Meaning                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| `409` + `gf-challenge-id`, `CHALLENGE_REQUIRED` | solve the captcha and retry — [captcha.md](./captcha.md)                |
| `409 CREDENTIALS_INVALID`                       | bad password, bad/missing blackbox, or a credentials-less account (SSO) |
| `403`                                           | also treated as a credentials rejection                                 |

### 2. Accounts — list the game accounts

```
GET /api/v1/user/accounts
```

Headers: `Authorization: Bearer <token>`, `TNT-Installation-Id`, browser UA. The response is a
JSON **object keyed by account id**; each value carries `gameId`, `displayName`, `usernames`,
`accountGroup` ([regions.md](./regions.md)), the `deleted`/`preDeleted` stamps, and `guls`.
`guls.user` is the **numeric** account id — a different field from the UUID `id`, and the one the
game client asks for during the handoff ([launch.md](./launch.md)).

### 3. Attest the device

```
POST /api/v1/auth/iovation
{ "accountId": "…", "blackbox": "tra:…", "type": "play_now" }
```

Headers: `Authorization`, `Origin`, `TNT-Installation-Id`, browser UA. Returns `{"status":"ok"}`.
This call **is** the launcher's Play button.

> **The one rule:** the blackbox here must be freshly generated with an _advanced_ vector. A
> replayed one (byte-identical, or same-vector) is rejected `403 {"status":"failed"}` — GF treats
> it as a static device. `game1.js` re-runs per request; so do we.

A fresh vector is **necessary but not sufficient**: some correctly-advanced attestations are still
refused. In a traced sample, three `403 {"status":"failed"}` calls showed the same ~0.32 character
vector divergence as the calls that passed, and one game account both passed and failed 37 seconds
apart on the same installation. Per-account, per-installation and rate-limit explanations all break
on the data. So a `403` here is **not** proof of a client bug: it is "GF declined this device right
now", surfaced as [`AttestationRejectedError`](../src/core/errors.ts), and retryable.

### 4. Code — mint the one-time login code

```
POST /api/v1/auth/thin/codes
{
  "blackbox": "<encrypted blackbox>",
  "gameId": "<gameId>.<region>",
  "gsid": "<sessionId>-<random 4 digits>",
  "platformGameAccountId": "<account id>"
}
```

Headers: `Authorization`, `TNT-Installation-Id`, and the **account-hash `User-Agent`** (below) —
note **no `Origin`**. The `blackbox` here is the **encrypted** form, bound to `gsid` + account
([blackbox.md](./blackbox.md)); `gsid` is a client session id (UUID) joined to a random 4-digit
number. Success is `{ "code": "…" }` — the one-time code handed to the game client.

**`403 {"error":{"message":"Not allowed to create code"}}`** is GF's one generic refusal; the body
never names the cause. Four produce it, in rough order of likelihood:

1. **A code is outstanding.** An unconsumed code holds its account for ~18 minutes, longer on a
   fresh device. Only time clears it.
2. **The region is wrong** — a `<gameId>.<region>` the account doesn't live in. Reachable only by a
   caller passing its own region; `mintCode` checks and raises without calling GF
   ([regions.md](./regions.md)).
3. **The login is in cooldown** — the "red bar" ([red-bar.md](./red-bar.md)), or an account GF has
   deleted or scheduled for deletion. The cooldown is **per GameForge login, not per game account**:
   every account under it is refused, including one created seconds ago, while other logins mint
   normally in the same minute. It clears once attempts stop — measured at ~37 and ~82 minutes.
   **Nothing readable detects it**: `user/me` `validated`, the deletion flags, and
   `user/game/<gameId>/environment/<envId>` → `permissions: ["play","install"]` all stay clean.
4. **The account isn't email-verified** — new GF logins only, and waiting won't fix it (below).

[`CodeNotAllowedError`](../src/core/errors.ts) carries the two causes readable from the account
itself (region mismatch, deletion stamp); nothing in the response distinguishes the rest. To
isolate: a sibling account on the same login rules out the login, token and device in one call; an
account on a _different_ login separates cause 3 from a wider outage. Budget **one attempt each** —
a mint is not a free probe, and attempts may prolong a block.

### Logout

```
DELETE /api/v1/auth/sessions
```

`Authorization`, `Origin`, `TNT-Installation-Id`, browser UA; no body. Returns `202`, invalidating
the session server-side — the clean way to end a run rather than dropping the token
([`sessions.ts`](../src/core/spark/sessions.ts)).

## Registering a GameForge account

The top-level login (email + password) — the multibox lever _above_ game accounts. Unlike login,
it **always** triggers the captcha.

```
POST /api/v2/users
{ "email": "…", "password": "…", "locale": "pt-PT", "blackbox": "tra:…" }
```

Same headers as `sessions`; email-first key order mirrors the launcher (GF ignores order). The
first attempt returns `409` + a `gf-challenge-id`; solve it ([captcha.md](./captcha.md)) and retry
the same request carrying header `gf-challenge-id: {id}`. Success is
`201 { "userCreated": true, "userId": "…" }`.
[`createGfAccount`](../src/core/spark/create-gf-account.ts) runs that loop headless.

> **A new login can authenticate immediately but cannot _play_ until its email is verified.**
> `sessions` returns a token, and you can list and create game accounts — but `thin/codes` refuses
> with `403 "Not allowed to create code"` until the confirmation link is clicked. Verified live:
> the same account went `403 → 201` the minute after. Per-GF-account, and it does not lapse.

## Creating a game account

A GF login starts with **no** game accounts (`/user/accounts` returns `{}`); the launcher creates
one on first play. Reproducing this is what lets one login mint game accounts programmatically.

```
POST /api/v2/users/me/accounts
{
  "displayName": "…",
  "gameId": "fab180a3-cd65-4b7e-bd0e-2ef77fd0c258",
  "gameEnvironmentId": "5401ee5b-1316-41ae-a628-73377b8676ba",
  "gfLang": "pt",
  "accountGroup": "pt",
  "blackbox": "tra:…"
}
```

Same headers as `sessions`, plus the bearer token. Returns
`201 { accountId, displayName, gameId, guls }`. The `accountGroup`/`gfLang` pair fixes the
account's region **permanently** ([regions.md](./regions.md)). Creation does not mint or hold a
login code, but the new account still can't get one until its GF login is email-verified.

## The account hash ("MAGIC")

`thin/codes` is authorised by a hash embedded in the User-Agent:

```
User-Agent: Chrome/C<version> (<accountHash>)
```

`accountHash` is a deterministic SHA cascade over four inputs — the launcher's embedded
**certificate** (PEM bytes), the **client version**, the **installation id**, and the **account
id** — branched on the installation id's **first decimal digit**:

- **Even:** `accountId[:2]` + first 8 hex chars of
  `sha256( sha256(cert) + sha1("C"+version) + sha256(installId) + sha1(accountId) )`
- **Odd:** `accountId[:2]` + **last** 8 hex chars of
  `sha256( sha1(cert) + sha256("C"+version) + sha1(installId) + sha256(accountId) )`

(The odd branch swaps sha1/sha256 and takes the right 8 chars.) All hash outputs are lowercase hex,
concatenated as text before the outer hash. Implemented in [`crypto.ts`](../src/core/crypto.ts) and
verified against captured launcher UAs (e.g. `Chrome/C2.8.5.1959 (58d43ebf89)`). Every capture so
far uses an **odd**-first-digit installation id, so only that branch has ground-truth coverage.

## Materials

| Input               | What                        | Where it comes from                                   |
| ------------------- | --------------------------- | ----------------------------------------------------- |
| **Installation id** | UUID, per GF account        | generated + persisted by us, never per-launch         |
| **Client version**  | e.g. `2.8.5.1959`           | `gfclient.exe` FileVersion                            |
| **Certificate**     | GF-shared client cert       | extracted once; only the PEM is used, for the UA hash |
| **blackbox**        | iovation device fingerprint | generated natively — [blackbox.md](./blackbox.md)     |

**Installation id.** GameForge stores one per machine in the registry
(`HKLM\SOFTWARE\WOW6432Node\Gameforge4d\MainApp\InstallationId`). We generate our own instead: it
must be **stable per account** and **distinct across accounts** (both fresh-per-launch churn and a
shared id are fingerprinting red flags), and it must contain a digit, since the account hash
branches on the first one.

**Certificate.** The PEM only — it feeds nothing but the `thin/codes` UA hash; `thin/codes` is not
mutual-TLS. The cert is **GF-shared across titles** (its SHA-256 `99025da7…` matches the constant
`stdLemon/nostale-auth` hardcodes for NosTale) and the launcher loads it at runtime via
`QSslCertificate::importPkcs12`, so there is no file on disk to copy — it is extracted with a
**Frida** hook on that call, as GflessClient's `CertExtractor` does (`gfclient.exe` is 32-bit, so
the recipe applies directly). `accountHash` normalises the PEM to LF endings plus a trailing
newline, or the hash won't line up. `morsisko/NosTale-Auth`'s older bundled cert gives the wrong
hash — don't use it. The working PEM is bundled at
[`src/core/gameforge-cert.pem`](../src/core/gameforge-cert.pem), overridable by a PEM at
`~/unforge-materials/cert.pem` if GameForge ever rotates it.

## Telemetry — skipped

The launcher also POSTs a `game_started` event to `events2.gameforge.com` over **mutual TLS**,
which yields the session id it later reuses as `gsid`. We generate `gsid` locally, so the call is
optional and unforge never makes it. It is telemetry only: no auth, no device grade.

## What this does not do

Reproducing the login does **not** bypass any account-level block — the same APIs are called, so a
flagged account fails here too. See [red-bar.md](./red-bar.md).
