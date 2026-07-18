# The blackbox (iovation)

**In one line:** the blackbox _is_ the device fingerprint — same thing, not two. The
"fingerprint" is the raw device facts (timezone, screen, GPU, hashes…); the "blackbox" is
those facts **sealed into one `tra:…` string** (iovation's name for that packed form).
GameForge's `game1.js` collects + seals it in the browser; we rebuild it natively (no
browser) so we can make fresh ones on demand. **Status: done and verified byte-for-byte**,
and it is **not** the current blocker: reusing the launcher's exact warm blackbox/clientId
with a token _we_ mint still `403`s, so the wall is our **token**, not the blackbox (see
[status.md](./status.md)). Our fields match the launcher's; the encoder is proven correct.

Every meaningful GF call — `sessions`, `auth/iovation`, account creation,
`thin/codes` — carries a **blackbox**: iovation's (TransUnion's)
device-attestation fingerprint. **"Blackbox" is iovation's own name for it (`bb`)**,
not ours — every implementation uses it (`stdLemon`'s Go type is literally
`Blackbox`, GflessClient has `blackbox.cpp`). It's how GameForge ties a login to a
device and detects automation / multi-accounting.

It was expected to be the hardest part of going launcher-less. **It isn't.** The
generator is a JavaScript file GF serves (`game1.js`), and all it does is collect
device fields and run a **simple, known encoding** over them. We reimplement that
encoding natively in TypeScript — no browser, no shipping GF's script. Two
maintained MIT libraries (`stdLemon/nostale-auth`, `alaingilbert/ogame`) generate
valid blackboxes exactly this way, browser-free — independent confirmation the
recipe below is complete.

## Two forms

| Form          | Looks like           | Used by                                          |
| ------------- | -------------------- | ------------------------------------------------ |
| **Raw**       | `tra:…`, ~1750 chars | `sessions`, `auth/iovation`, `users/me/accounts` |
| **Encrypted** | base64, ~2600 chars  | `thin/codes`                                     |

Both derive from the same fingerprint; the encrypted one is the raw one bound to
the request's `gsid` + `accountId`.

## Raw blackbox — the recipe

`game1.js` gathers ~30 device fields (timezone, OS, browser, memory, screen,
WebGL / canvas / audio / font hashes, user-agent, timestamps…) then encodes them:

1. Put the field values in a **fixed-order array** (30 entries) → `JSON.stringify`.
2. **`encodeURIComponent`** the JSON (this is the exact primitive game1 uses — it
   already leaves `( ) ! * ' ~` literal and encodes space as `%20`; the Go ports
   emulate it with a QueryEscape + replace dance).
3. **Cumulative-sum the bytes** (mod 256): `out[0] = enc[0]`,
   `out[i] = out[i-1] + enc[i]` (each output byte folds in the previous output).
4. **base64url** (no padding), then prefix `"tra:"`.

That's the whole generator — ~40 lines. The field set/order and this encoding were
read directly out of the current `game1.js` (deobfuscated), and cross-check against
the MIT Go ports `stdLemon/nostale-auth` (`pkg/blackbox/blackbox.go`) and
`alaingilbert/ogame` (`pkg/device/device.go`).

The device fields **don't have to be real** — they must be _plausible_ and **stable
per account** (a fixed virtual device), with only the timestamps refreshed per
call. That yields a fresh, valid blackbox on demand _and_ a consistent per-account
fingerprint (a red-bar-avoidance win — churny fingerprints are a trigger). This is
exactly what the Go libs do: `alaingilbert` persists a device under
`~/.ogame/devices/<name>` and refreshes timestamps via an injectable `NowFunc`.

**Implemented** in `src/core/blackbox/` — pure, browser-free:

- [`generate.ts`](../src/core/blackbox/generate.ts) — `generateBlackbox()` and the
  `encodeBlackboxBody()` transform, verified byte-for-byte against real captured
  launcher blackboxes.
- [`device.ts`](../src/core/blackbox/device.ts) — the `DeviceProfile` (a stable
  virtual device) with a sensible Windows/Chrome default.
- [`identity.ts`](../src/core/blackbox/identity.ts) — the persisted per-account
  `clientId` + drifting `x-vec` signature (game1 keeps these in localStorage);
  `createDeviceIdentity()` / `driftVector()`.

### Field specifics verified against captured launcher blackboxes

Three positional fields are not free-form — they were read out of real launcher
blackboxes ([capturing-traffic.md](./capturing-traffic.md)) and are pinned against a
real capture:

- **`extraPayload` (field 28) is context-dependent.** `sessions` and `iovation`
  send **`null`**; only `thin/codes` populates it with
  `{ features:[randomInt], installation, session }`, where `session` is the `gsid`
  **without** its `-NNNN` suffix. So `generateBlackbox` takes `extraPayload` only
  for the code blackbox and defaults to `null`.
- **`automationFlags` (field 29) is `73728`** (`0x12000`) — game1's environment
  bitmask from its automation probes (`webdriver`, `_phantom`, `Headless`…),
  constant for the launcher's CEF build. (`0` — "no flags" — is _less_ plausible
  than a real environment.)
- **`serverDateIso` (field 27) has second precision** (`…:55.000Z`): game1 reads it
  from the HTTP `Date` response header, which has no milliseconds. `generatedAtIso`
  (field 21, a local clock) keeps its milliseconds.

**One fresh blackbox per privileged call — never reuse.** `iovation` rejects a
**replayed** blackbox — specifically one whose rolling vector (`vecSignatureBase64`,
field 25) hasn't advanced since the previous call — with `403 {"status":"failed"}`.
game1.js re-runs per request and drifts the vector ~1 char/sec; the launcher mints a
new blackbox each time. Reusing one blackbox for `sessions`+`iovation` was the
long-standing "iovation is walled" bug.

So a [`GfSession`](../src/app/gf-session.ts) mints **three** raw blackboxes per
login — one each for `sessions`, `iovation`, `thin/codes` — threading the same device
identity through, and **forcing the vector to advance** (`forceVectorDrift`) on the calls
after `sessions`, because back-to-back headless calls otherwise land in the same 1-second
drift step and would send an identical vector. The first two send `null`-`extraPayload`;
`thin/codes` populates it and is sent encrypted. No browser, no `game1.js` at runtime.

## Encrypted blackbox — done

For `thin/codes`, the raw `tra:…` is XOR-encrypted then base64'd:

```
base64( XOR( rawBytes, key ) )
key = sha512hex(gsid + "-" + accountId)          // the 128-char hex, as ASCII bytes
out[i] = raw[i] ^ key[i % 128] ^ key[127 - (i % 128)]   // folded from both ends
```

Implemented in [`src/core/blackbox/encrypt.ts`](../src/core/blackbox/encrypt.ts)
(`encryptBlackbox` / `decryptBlackbox`). Re-encrypting a decrypted real `thin/codes`
blackbox reproduces the captured ciphertext byte-for-byte, and it matches
`stdLemon/nostale-auth`'s `blackboxEncryption.go`.

## GF's `game1.js` — proprietary, not vendored

The generator is proprietary GameForge code, so it isn't vendored here. It's read
only as an RE reference — to (re)derive the field list + encoding, never run in
production. Pull it from the live URL below when you need it. If GF rotates
the obfuscation and the field set shifts, re-derive with
`ogame-ninja/ogame_fingerprint`'s `deobfuscator.go` (auto-deobfuscates the live
script) and update the native port.

> Live URL (for reference / re-capture): `https://gameforge.com/tra/game1.js`
> (~62 KB, `application/javascript`, shared GF-wide — same script for OGame /
> NosTale / Metin2).

## Why capturing traffic doesn't substitute for this

A mitmproxy capture ([capturing-traffic.md](./capturing-traffic.md)) hands us **one
finished blackbox**, not a way to make more: the value is computed client-side and
is only valid for a few minutes. Great for a one-shot replay to validate the auth
code (which is how we first proved the flow), useless for anything unattended.
Generating natively is what makes headless multibox / re-login viable.

## The `thin/codes` cert (separate concern)

`thin/codes` also needs the launcher's client certificate — a **separate** blocker
from the blackbox, tracked in [protocol.md → Certificate](./protocol.md#certificate).
It's a _static, extract-once_ credential, **not** a per-session runtime hook
(GflessClient ships one as a committed file) — but our Metin2 launcher's current cert
must be extracted from it once (NosTale's bundled cert is stale for Metin2). With the
blackbox reproduced, this is the remaining piece for `thin/codes`.
