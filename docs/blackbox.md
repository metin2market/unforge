# The blackbox (iovation)

The blackbox **is** the device fingerprint — same thing, not two. The "fingerprint" is the raw
device facts (timezone, screen, GPU, hashes…); the "blackbox" is those facts **sealed into one
`tra:…` string** (iovation's own name for that packed form — every implementation uses it).
GameForge's `game1.js` collects and seals it in the browser; we rebuild it natively, so we can mint
fresh ones on demand.

It carries every meaningful GF call — `sessions`, `auth/iovation`, account creation, `thin/codes` —
and it is how GameForge ties a login to a device and detects automation / multi-accounting.

It was expected to be the hardest part of going launcher-less. It isn't: the generator is a
JavaScript file GF serves, and all it does is collect device fields and run a **simple, known
encoding** over them. Implemented in [`src/core/blackbox/`](../src/core/blackbox), pure and
browser-free, verified byte-for-byte against captured launcher blackboxes.

## Two forms

| Form          | Looks like           | Used by                                          |
| ------------- | -------------------- | ------------------------------------------------ |
| **Raw**       | `tra:…`, ~1750 chars | `sessions`, `auth/iovation`, `users/me/accounts` |
| **Encrypted** | base64, ~2600 chars  | `thin/codes`                                     |

Both derive from the same fingerprint; the encrypted one is the raw one bound to the request's
`gsid` + `accountId`.

## The raw recipe

`game1.js` gathers ~30 device fields (timezone, OS, browser, memory, screen, WebGL / canvas /
audio / font hashes, user-agent, timestamps…) then encodes them:

1. Field values in a **fixed-order array** (30 entries) → `JSON.stringify`.
2. **`encodeURIComponent`** the JSON — the exact primitive game1 uses (it leaves `( ) ! * ' ~`
   literal and encodes space as `%20`; the Go ports emulate it with a QueryEscape + replace dance).
3. **Cumulative-sum the bytes** (mod 256): `out[0] = enc[0]`, `out[i] = out[i-1] + enc[i]` — each
   output byte folds in the previous _output_.
4. **base64url** (no padding), then prefix `"tra:"`.

That is the whole generator, ~40 lines — [`generate.ts`](../src/core/blackbox/generate.ts). The
field set/order and the encoding were read out of the current `game1.js` (deobfuscated) and
cross-checked against the MIT Go ports `stdLemon/nostale-auth` and `alaingilbert/ogame`, which
generate valid blackboxes browser-free the same way.

### Three positional fields are not free-form

Read out of real launcher blackboxes ([capturing-traffic.md](./capturing-traffic.md)) and pinned by
a capture test:

- **`extraPayload` (28) is context-dependent.** `sessions` and `iovation` send **`null`**; only
  `thin/codes` populates it with `{ features:[randomInt], installation, session }`, where `session`
  is the `gsid` **without** its `-NNNN` suffix.
- **`automationFlags` (29) is `73728`** (`0x12000`) — game1's environment bitmask from its
  automation probes (`webdriver`, `_phantom`, `Headless`…), constant for the launcher's CEF build.
  (`0` — "no flags" — is _less_ plausible than a real environment.)
- **`serverDateIso` (27) has second precision** (`…:55.000Z`): game1 reads it from the HTTP `Date`
  response header, which has no milliseconds. `generatedAtIso` (21, a local clock) keeps its
  milliseconds.

## The device must be coherent, not real

The fields **don't have to be real** — they must be _plausible_ and **stable per account** (a fixed
virtual device), with only the timestamps refreshed per call.

"Plausible" is stronger than it sounds, and it constrains _how_ fields are generated: on real
hardware they are not independent. So [`device.ts`](../src/core/blackbox/device.ts) builds a whole
machine rather than picking each field separately, reads the clock and languages off the host (a
real browser reports the machine it runs on, not the game region — which keeps them consistent with
the IP for free), and respects the limits the browser itself imposes (`navigator.deviceMemory` is
spec-clamped to ≤ 8, so a "32 GB" device is not implausible but impossible).

There is **no shared default profile**: one device is minted per GameForge account and kept
forever, since a fingerprint that changes between logins is itself a flag and one shared across
accounts correlates them. [`identity.ts`](../src/core/blackbox/identity.ts) holds the other half —
the persisted per-account `clientId` and the drifting `x-vec` signature that game1 keeps in
localStorage. What this does not solve: [red-bar.md](./red-bar.md).

## One fresh blackbox per privileged call — never reuse

`iovation` rejects a **replayed** blackbox — specifically one whose rolling vector
(`vecSignatureBase64`, field 25) hasn't advanced since the previous call — with
`403 {"status":"failed"}`. game1.js re-runs per request and drifts the vector ~1 char/sec; the
launcher mints a new blackbox each time.

So a [`GfSession`](../src/app/gf-session.ts) draws from a `BlackboxSequence` that mints **three**
raw blackboxes per login — one each for `sessions`, `iovation`, `thin/codes` — threading the same
device identity through and **forcing the vector to advance** (`forceVectorDrift`) after the first,
because back-to-back headless calls otherwise land in the same 1-second drift step and would send
an identical vector. No `GfSession` method accepts a blackbox, so a caller cannot replay one.

This single detail was the entire "clientless is blocked" problem. It is necessary but **not
sufficient** — `iovation` still refuses some correctly-advanced attestations, unexplained
([protocol.md](./protocol.md#3-attest-the-device)).

### Dead ends, not leads

A reused blackbox `403`s `iovation` every time, which reads as an unbeatable server-side
"genuine-CEF grade" and sends you hunting for one. There is no such grade, and these are settled —
don't re-open them:

| Suspect                                 | Why it isn't one                                                      |
| --------------------------------------- | --------------------------------------------------------------------- |
| **Transport** (JA3, HTTP/2, CEF-72 TLS) | a generic Go `net/http` client passes                                 |
| **Client certificate**                  | GF-shared, and it only feeds the `thin/codes` UA hash; not mutual TLS |
| **`events2` / "hidden calls"**          | telemetry only — returns `ok`, carries no grade                       |
| **IP / machine**                        | a clean residential IP and an ordinary desktop both pass              |
| **`createGameAccount` 409**             | account-verification state, not a device grade                        |

The controlled test that settles it: same token, same account, back-to-back — a **reused** blackbox
`403`s, a **fresh, vector-advanced** one `200`s.

## The encrypted form

For `thin/codes`, the raw `tra:…` is XOR-encrypted then base64'd:

```
base64( XOR( rawBytes, key ) )
key = sha512hex(gsid + "-" + accountId)                  // the 128-char hex, as ASCII bytes
out[i] = raw[i] ^ key[i % 128] ^ key[127 - (i % 128)]    // folded from both ends
```

[`encrypt.ts`](../src/core/blackbox/encrypt.ts) — re-encrypting a decrypted real `thin/codes`
blackbox reproduces the captured ciphertext byte-for-byte, and it matches `stdLemon/nostale-auth`'s
`blackboxEncryption.go`.

## GF's `game1.js` is not vendored

The generator is proprietary GameForge code, read only as an RE reference to derive the field list
and encoding, never run in production. Pull it live from `https://gameforge.com/tra/game1.js`
(~62 KB, shared GF-wide — the same script for OGame / NosTale / Metin2). If GF rotates the
obfuscation and the field set shifts, re-derive with `ogame-ninja/ogame_fingerprint`'s
`deobfuscator.go` and update the native port.

**Capturing traffic is not a substitute.** A capture hands you **one finished blackbox**, not a way
to make more: the value is computed client-side and is valid for a few minutes. Great for a one-shot
replay to validate auth code, useless for anything unattended. Generating natively is what makes
headless multibox and re-login viable.
