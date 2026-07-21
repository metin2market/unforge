# The red bar

> The strip across the top of the GameForge launcher — _"The game is currently unavailable to you.
> Please contact Support."_ **Play** does nothing.

A **login-layer** block, server-side. It fires before you reach a server, and it is not in-game
anti-cheat. `unforge` calls the same APIs, so it **does not bypass it**.

Most of what circulates about the red bar is untested, and the block clears on its own in ~12–24 h —
so any single trial credits whatever was done last. This page keeps the two apart: what is
**verified** first, what is **inferred** after, and what nobody knows at the end.

## Where it hits

| Call                     | What you see                                             |
| ------------------------ | -------------------------------------------------------- |
| `POST …/auth/iovation`   | the Play button itself — a failure here **is** the bar   |
| `POST …/auth/thin/codes` | `403 {"error":{"message":"Not allowed to create code"}}` |

GameForge also runs a separate in-game behavioural flag, set by gameplay, which surfaces as the same
strip at your _next_ login. That is why the two get conflated.

## What GameForge receives — verified

| Signal                    | Channel                                                                        | Verified                    |
| ------------------------- | ------------------------------------------------------------------------------ | --------------------------- |
| **blackbox**              | request body of `sessions` / `iovation` / `thin/codes`                         | ✅ byte-for-byte vs captures |
| **clientId + vector**     | fields _inside_ the blackbox (game1 keeps them in localStorage)                | ✅                           |
| **InstallationId**        | `TNT-Installation-Id` + `gf-installation-id` headers; the `thin/codes` UA hash | ✅ captures                  |
| **Client cert + version** | the `thin/codes` account hash in the User-Agent                                | ✅                           |
| **IP**                    | transport                                                                      | —                           |
| **HardwareId** (registry) | **never observed in any captured request**                                     | ❌                           |

**Registry and fingerprint are two separate channels.** The blackbox is computed **in the browser**:
`game1.js` runs in the launcher's embedded CEF page and reads `navigator`, screen, WebGL, canvas,
audio — it cannot read the registry. The registry reaches GameForge only because the _native_
launcher reads `InstallationId` and attaches it as headers. So a cleanup that wipes registry keys
and a fingerprint change are not the same act.

## What the evidence supports

| Variant            | Keyed on           | Clears with                     |
| ------------------ | ------------------ | ------------------------------- |
| **Account (soft)** | the account        | **time** (~12–24 h), by itself  |
| **IP**             | your address       | a different IP                  |
| **Account (hard)** | the account        | nothing local — support         |
| **HWID / device**  | local device state | a device reset — _if it exists_ |

**The observed bar is account-keyed.** The launcher stores **one `InstallationId` per machine**,
shared by every account, so a blocklisted installation would fail _all_ accounts. What is observed is
the opposite: a spare account logs in and plays normally on the same machine, same IP, same
`InstallationId`, while the flagged one stays barred.

**So the diagnostic is: try a spare account, once.** It works → the device state is fine by
construction, and cleaning can only add churn. It fails too → the shared id or the IP is implicated,
and a reset is worth trying.

**Don't retry while blocked.** Two measured recoveries: a login refused at 21:03 minted normally by
22:26 (~82 min) untouched; a second, refused after a burst of attempts, recovered ~37 min after they
stopped. Both looked persistent while probing continued. Whether attempts restart the counter or
time alone runs out is unresolved — a retry has no upside either way. (The ~18-minute figure belongs
to an outstanding login _code_, [protocol.md](./protocol.md#4-code--mint-the-one-time-login-code) —
a different mechanism.) Unverified but consistent with an error we hit: account _creation_ is also
refused while a login is blocked, which would explain a `409 ACCOUNT_CREATION_FAILED` with no
per-login account limit.

## The cleanup script

[`scripts/gfclear.bat`](../scripts/gfclear.bat) resets local GameForge state. What each wipe
actually changes on the wire:

| Wipe                                                       | Effect on what GF sees                                                                 |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `%LocalAppData%\Gameforge4d`                               | **Real** — the CEF profile holds game1's clientId + vector, and the cached web session |
| registry `InstallationId`                                  | **Real** — a new id on every header and on the `thin/codes` hash                       |
| registry `HardwareId`                                      | **Unknown** — never seen on the wire                                                   |
| `GPUCache`, Prefetch, `%TEMP%`, WER, `UserData` / `syserr` | **None** — nothing in the login path reads these                                       |

Its honest use is forcing a **fresh-login capture** ([capturing-traffic.md](./capturing-traffic.md)).

> ⚠️ **It is not free.** Every run mints a brand-new device identity, and a device that looks new at
> every login is _more_ anomalous to a fingerprinting system, not less. Run it deliberately, once,
> after the spare-account test — never on a schedule, and never in a red-bar loop.

## What unforge does instead

It never reads the launcher's registry or CEF profile. It generates and persists its own installation
id, device profile, and identity — **one set per GameForge account**:

- **Contained.** One id per account, not per machine, so per-installation reputation — _if_ GF keeps
  any — cannot spread across accounts the way the launcher's shared id can.
- **Stable by default.** Each account keeps a continuous device across logins. Devices already minted
  keep what they were born with; nothing is rewritten in place.
- **Surgical when a reset is needed.** `unforge auth device regen` rolls one account's device and
  leaves every other account's continuity intact.
- **Coherent, not accurate.** Synthetic fingerprints pass, so the bar is only whether the device
  _could exist_ ([blackbox.md](./blackbox.md)). The opaque hashes stay random per device, which keeps
  two accounts from reading as the same machine.

> ⚠️ **This does not make accounts unlinkable.** Every account still leaves from one IP, and the IP
> already links them. Whether many distinct devices on one IP is better or worse than the launcher's
> one-device-many-accounts is reasoning, not something measured here.

## What nobody knows

- Whether GameForge scores reputation on `InstallationId` **at all**.
- What `HardwareId` is for, given it never appears in a request.
- The weights: how relaunch rate, login rate, IP, and device age combine.
- Whether a launcher-less login and a launcher login score identically. Field reports claim direct
  login sometimes works while the launcher red-bars the same account — unverified, and plausibly just
  the 12–24 h clock.

## Sources

- elitepvpers, the 2022 login-protocol RE (iovation / blackbox, `auth/iovation` + `thin/codes`):
  [Red bar metin2](https://www.elitepvpers.com/forum/metin2/4988984-red-bar-metin2.html) ·
  [Metin2 – Redbar](https://www.elitepvpers.com/forum/metin2/5268205-metin2-redbar.html)
- Community field reports contradict each other within the same weeks (_"deleted appdata, I'm in
  now"_ vs _"it's server-side, deleting appdata won't help"_) — the signature of the self-clearing
  window, not of a fix. Hunt2's staff (a bot vendor) describe it as temporary, caused by logging in
  too often or a flagged IP, clearing in ~12–24 h, unaffected by manual login.
- Cross-game: the same `spark.gameforge.com` gate fronts every GameForge title, and other
  communities hit it identically (OGame calls it _"Login Forbidden"_, also ~24 h).
  [`hatz2/GflessClient`](https://github.com/hatz2/GflessClient) mitigates it as we do — a distinct
  identity and installation id per account.
