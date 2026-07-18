# The red bar

> The strip across the top of the GameForge launcher — _"The game is currently unavailable to
> you. Please contact Support."_ **Play** does nothing.

**`unforge` does not bypass it.** The block is server-side and `unforge` calls the same APIs,
so a flagged account fails here too. This page exists because the folklore around the red bar
is large and the verified part is small — it separates the two.

## Where it hits the flow

- `POST …/auth/iovation` `{accountId, blackbox, type:"play_now"}` — this call **is** the Play
  button. A failure here is the bar.
- `POST …/auth/thin/codes` — a flagged account gets
  `403 {"error":{"message":"Not allowed to create code"}}`.

It is a **login-layer** check. It is not an in-game anti-cheat, and it fires before you ever
reach a server. (GameForge does also run a separate in-game behavioural flag; that one is set
by gameplay and surfaces as the same strip at your _next_ login, which is why the two get
conflated.)

## What GameForge actually receives

Every signal in the login, and how it gets there — see [protocol.md](./protocol.md) and
[blackbox.md](./blackbox.md) for the mechanics:

| Signal                    | Channel                                                                        | Verified                     |
| ------------------------- | ------------------------------------------------------------------------------ | ---------------------------- |
| **blackbox**              | request body of `sessions` / `iovation` / `thin/codes`                         | ✅ byte-for-byte vs captures |
| **clientId + vector**     | fields _inside_ the blackbox (`game1.js` keeps them in localStorage)           | ✅                           |
| **InstallationId**        | `TNT-Installation-Id` + `gf-installation-id` headers; the `thin/codes` UA hash | ✅ captures                  |
| **Client cert + version** | the `thin/codes` account hash in the User-Agent                                | ✅                           |
| **IP**                    | transport                                                                      | —                            |
| **HardwareId** (registry) | **never observed in any captured request**                                     | ❌                           |

**The load-bearing detail:** the blackbox is computed **in the browser**. `game1.js` runs in the
launcher's embedded CEF page and reads `navigator`, screen, WebGL, canvas, audio — it **cannot
read the registry**. The registry reaches GameForge only because the _native_ launcher reads
`InstallationId` and attaches it to the requests as headers.

So the registry and the fingerprint are **two separate channels**, not one.

## What people assume

The canonical community explanation — the one that ships with the cleanup scripts passed around
the Metin2 forums and Discords — is roughly:

> GF fingerprints your machine, writes `HWID` and `InstallationId` into the registry to remember
> it, and cleaning those refreshes the state so the API passes again.

**Half right.** `InstallationId` is real, is transmitted, and is a plausible reputation key.
But `HardwareId` shows up in **no** captured request, and the scripts wipe a great deal that
touches nothing in the login: Prefetch, `%TEMP%`, WER archives, `USOShared`, `GPUCache`, and the
game's own `UserData`/`syserr`.

The field reports also **contradict each other**, within the same communities and the same weeks
— _"deleted appdata, I'm in now"_ alongside _"it's server-side; deleting appdata or moving to
another PC won't help."_ Both are sincere. That pattern is the signature of a **confound**, not
of a fix: the soft bar clears on its own in ~12–24 h, so every single-trial anecdote credits
whatever was done last.

## What the evidence supports

| Variant            | Keyed on           | Clears with                     |
| ------------------ | ------------------ | ------------------------------- |
| **Account (soft)** | the account        | **time** (~12–24 h), by itself  |
| **IP**             | your address       | a different IP                  |
| **Account (hard)** | the account        | nothing local — support         |
| **HWID / device**  | local device state | a device reset — _if it exists_ |

**The test that separates them.** The launcher stores **one `InstallationId` per machine**,
shared by every account you log in with. So if GameForge blocklisted an installation, that is an
**all-accounts-fail** signature.

What is actually observed is the opposite: a spare account logs in and plays normally on the
**same machine, same IP, same `InstallationId`**, while the flagged one stays barred. That bar is
**account-keyed** — and nothing local can touch it.

So: **try a spare account first.** It works → the device state is fine by construction; cleaning
can only add churn. It fails too → now the shared ID or the IP is implicated, and a reset is
worth trying.

## The cleanup script

[`scripts/gfclear.bat`](../scripts/gfclear.bat) resets local GameForge state. Honestly, per wipe:

| Wipe                                                       | Effect on what GF sees                                                                   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `%LocalAppData%\Gameforge4d`                               | **Real** — the CEF profile holds `game1`'s clientId + vector, and the cached web session |
| registry `InstallationId`                                  | **Real** — a new id on every header and on the `thin/codes` hash                         |
| registry `HardwareId`                                      | **Unknown** — never seen on the wire                                                     |
| `GPUCache`, Prefetch, `%TEMP%`, WER, `UserData` / `syserr` | **None** — nothing in the login path reads these                                         |

Its honest use is the **fresh-login capture** (clearing the cached session forces a real
`sessions` call — [capturing-traffic.md](./capturing-traffic.md)).

⚠️ **It is not free.** Every run mints a brand-new device identity, and a device that looks new
at every login is _more_ anomalous to a fingerprinting system, not less. Running it in a
red-bar loop manufactures exactly the churn that reputation scoring penalises. Run it
deliberately, once, after the spare-account test — never on a schedule.

## What `unforge` does instead

`unforge` never reads the launcher's registry or CEF profile. It generates and persists its own
**`InstallationId`, device profile, and identity — one set per GameForge account**
([accounts.md](./accounts.md)):

- **Contained.** One id per account, not one per machine, so per-installation reputation — _if_
  GF keeps any — cannot spread across your accounts the way the launcher's shared id can.
- **Stable by default.** Each account keeps a continuous device across logins, which is the
  thing you actually want.
- **Surgical when you do need a reset.** `unforge auth device regen` rolls one account's device
  and leaves every other account's continuity intact — the cleaner's intent, without the
  collateral.

## What nobody knows

Stated plainly, because the community's confidence here outruns its evidence:

- Whether GameForge scores reputation on `InstallationId` **at all**.
- What `HardwareId` is for, given it never appears in a request.
- The weights: how relaunch rate, login rate, IP, and device age actually combine.
- Whether a launcher-less login and a launcher login score **identically**. Field reports claim
  direct login sometimes works while the launcher red-bars the same account. Unverified, and
  plausibly just the 12–24 h clock.

The self-clearing window makes every single trial uninterpretable. Treat any claim built on one
anecdote — including the ones above — as untested.

## Sources

- elitepvpers, the 2022 login-protocol RE (iovation / blackbox, `auth/iovation` + `thin/codes`):
  [Red bar metin2](https://www.elitepvpers.com/forum/metin2/4988984-red-bar-metin2.html) ·
  [Metin2 – Redbar](https://www.elitepvpers.com/forum/metin2/5268205-metin2-redbar.html)
- Cross-game: the same `spark.gameforge.com` gate fronts every GameForge title, and other
  titles' communities hit it identically (OGame calls it _"Login Forbidden"_, also ~24 h).
  [`hatz2/GflessClient`](https://github.com/hatz2/GflessClient) mitigates it the same way we do
  — a distinct identity and installation id per account.
