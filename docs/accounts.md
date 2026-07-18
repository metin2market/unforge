# Account storage & the state layer

**In one line:** `core` never touches disk; this optional layer (`src/storage/`) remembers
your accounts between runs in **one file, encrypted by Windows (DPAPI)** — so a multibox
host can re-login unattended. Independent of the auth flow itself
([status.md](./status.md)); this page is its design and threat model.

`core` is stateless by design — credentials in, login code out, no disk touched
(see [design.md](./design.md)). But any real deployment has to _remember_ accounts
between runs: which game account maps to which server, the per-account identity that
must stay stable, a reusable session token, and — for unattended or multibox use —
the credentials themselves. That persistence is a **separate layer** in `src/storage/`, above `core` and never
imported by it — `core` stays credentials-in, code-out. This doc is its design.

`store` is an **abstraction over data storage**: consumers depend on the
`AccountStore` interface (below), not on where the bytes land. The implementation is a
**single DPAPI-sealed JSON file** — chosen because the dataset is tiny (tens of
accounts) and we do our own encryption, so a database earns nothing here. The interface
is what a stateful application layer or an external consumer builds on.

## What must persist

A GameForge login can hold **several game accounts** (the multibox lever — see
[protocol.md → Creating a game account](./protocol.md#creating-a-game-account)), so
the store is a collection of **GF accounts**, each owning its game accounts:

| Field            | Secret?              | Notes                                                                                                                               |
| ---------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `email`          | no                   | the GF login                                                                                                                        |
| `alias`          | no                   | optional short handle for refs/pickers (`auth alias`); absent → derived from the email (local part or `+tag`)                       |
| `password`       | **yes**              | only used at the `sessions` step; the durable re-mint key                                                                           |
| `installationId` | sensitive            | **distinct per GF account**, stable forever ([protocol.md → Installation id](./protocol.md#installation-id))                        |
| `deviceIdentity` | sensitive            | `{clientId, vector, vectorUpdatedAt}`; the vector **drifts**, so it is written back after every auth ([blackbox.md](./blackbox.md)) |
| `deviceProfile`  | sensitive            | the fingerprint (canvas/audio/WebGL/screen hashes); **distinct per GF account**, stable. Absent → a freshly generated distinct one  |
| `session`        | sensitive, revocable | cached `{token, expiresAt}` — reuse to avoid re-auth churn                                                                          |
| game accounts    | no                   | `{accountId, username, region, server?, character?}` per child                                                                      |

**Never share `installationId`, `deviceIdentity`, or `deviceProfile` across GF accounts.**
Identical identity across logins is a fingerprinting red flag — one **stable, distinct**
identity per GF account (generated once, reused every run) is the whole point of the
stable-distinct-identity rule in [design.md](./design.md).

## Secrets: store the password, cache the token

The password is touched **once** — the `sessions` call — which returns a bearer
token; every later call (list accounts, attest device, mint code, create accounts)
authenticates with just that token. There is **no refresh endpoint** in the protocol,
so when the token expires the only way to mint a new one is another `sessions` call,
which needs the password again.

`sessions` sends the password as **raw plaintext** in a JSON body over TLS — no
client-side hashing or challenge-response ([protocol.md → Session](./protocol.md#1-session--credentials-to-bearer-token)).
So storing a hash is impossible: GF expects the actual string and a hash can't be
reversed to it. Whatever we persist must recover to plaintext, which is why the
password is **sealed**, not hashed.

That shapes two modes:

- **Interactive (single user).** You can decline to store the password: cache only the
  token, and re-prompt when it expires. Nothing credential-grade sits on disk.
- **Unattended / multibox host.** No human is present to retype anything, so the
  password **must** be retrievable locally to re-mint after expiry. Storing it makes
  the deployment **token-lifetime-agnostic** — the token drops to a pure optimization
  (fewer `sessions` calls = less churn = lower risk score), and re-auth Just Works
  whenever the token dies.

The current shape serves the unattended path: `password` is required, so an account
always stores it (sealed with everything else). The token-only interactive variant —
caching just the token and re-prompting — would make the password optional; it's a
later addition, not yet built. The sealing that the stored password needs is next.

## Where secrets live: one DPAPI-sealed JSON file

The whole account set is `JSON.stringify`'d and **sealed as a single blob** (see
`sealSecret` below), written to one file. Load = read → unseal → parse; save =
stringify → seal → atomic write. Because the data is tiny, decrypt-all-on-load and
encrypt-all-on-save cost nothing — so **everything is encrypted at rest**: email,
`installationId`, and secrets alike, not just a few columns. Nothing readable
sits on disk. (Confirmed by a test that scans the file for every plaintext value.)

**Debug escape hatch:** `UNFORGE_STORE_PLAINTEXT=1` writes the blob as readable JSON behind a
marker line instead of sealing it (reads auto-detect the marker, so a plaintext store still
opens without the flag). It prints a warning and is **debug-only** — never leave it on for real
secrets.

This is deliberately **not a database**. SQLite would only pay off with real queries,
large data, or if we leaned on it for encryption (SQLCipher / SQLite3MultipleCiphers) —
none apply. A login reads one account by id (a `.find`); a UI lists them (a `.map`). A
DB would add migrations, a native-lib-vs-`--compile` fight, and WAL sidecar files for
no benefit. A versioned JSON blob (`{ version, accounts }`) evolves in code instead of
migrations. Sealing one blob is also **simpler and safer than per-secret sealing** — one
unseal per load, one seal per save, and no risk of forgetting to seal a newly-added
sensitive field.

**Key management: don't hold a key — let Windows.** The awkward part of local
encryption is _where the key lives_. DPAPI answers it: `ProtectedData.Protect` /
`Unprotect` (reachable from Bun via a short PowerShell call) encrypt with a key derived
from the machine/user credentials and managed by the OS — no key file, no passphrase,
works unattended, survives reboot. A thin `sealSecret()` / `unsealSecret()` wrapper is
the only place that touches it.

**What the seal is bound to: the machine + Windows user, not the program.** This is
the right binding, and it's worth being precise about, because "only _this program_ can
decrypt" is both impossible and undesirable here — `unforge` is a public binary anyone
can run, so program-identity binding would let every copy unseal the blob. DPAPI binds
to something _not_ public (your machine/user) instead. The consequence: any process
running as the same Windows user can `Unprotect` too (see threat model), and a sealed
blob is **non-portable** — it can't be moved to another machine or user, so a
backup/restore onto a fresh box makes every sealed secret dead and passwords must be
re-entered. That non-portability is the feature (it's what defeats file theft), not a
bug.

**Pass secrets to PowerShell over stdin, never on the command line** — argv is visible
to other processes (`Get-CimInstance Win32_Process`) and can land in logs. `sealSecret`
/ `unsealSecret` pipe the value through stdin.

The one real upgrade over DPAPI-user, if disk-theft-with-known-password ever becomes a
concern, is a **TPM-sealed key** — the key never leaves the chip, so a stolen drive is
useless even to someone with the Windows password. It does nothing for the live-box
case (an unattended program that can ask the TPM means a same-user attacker can too) and
costs real engineering, so it's a documented future option, not the plan.

## Threat model (be honest about it)

Whatever the container, an unattended box must be able to decrypt itself, so the key
is reachable on the box. Sealing at rest therefore:

- **Defeats** the realistic leaks — someone grabs the store file, a backup, a synced
  folder, or it slips into git. The sealed blob is useless without the OS user.
- **Does not defeat** a fully compromised live box running as the same user — it can
  `Unprotect` too. That is inherent to unattended decryption, not a fixable flaw.

Shrink the blast radius by other means: throwaway accounts only, a distinct
`installationId` + `deviceIdentity` per GF account so one flag doesn't
cascade, paced logins ([design.md → Operational note](./design.md#operational-note)),
tight file permissions, and never logging a secret. The real "revoke" is changing the
password server-side, which invalidates outstanding tokens.

## Concurrency & location

A multibox host can have more than one process touching the file (the owning host
process plus launches), but writes are rare — a token re-mint, a drifted vector, a new
account — not a hot path. The intended model is **single-writer** (the host process owns
the store), and a light guard covers the rest:

- **Reads** serve from an in-memory copy loaded once at open — no per-call unseal.
- **Writes** take an exclusive **lock file** next to the store, then reload → mutate →
  seal → **atomic write** (temp file, then rename over). Reloading under the lock means a
  concurrent writer can't be lost; the atomic rename means a crash mid-write can't
  corrupt the file (the old one stays intact until the rename). A stale lock (crashed
  holder) is stolen after a timeout.

The file lives at `%LOCALAPPDATA%\unforge\accounts.dat` (already per-user by ACL) — the
exact path isn't load-bearing, only that it's per-user and not world-readable.

## Shape

A `store` module, separate from `core`, living in `src/storage/` — the folder for everything
that persists to the data folder:

```
src/storage/
  paths.ts         — the <localAppData>\unforge data folder + unforgeDataFile(...)
  atomic-write.ts  — safe whole-file write (temp + rename), shared with config
  seal.ts          — sealSecret / unsealSecret (DPAPI Protect/Unprotect over stdin)
  store-file.ts    — load/save the sealed blob, the lock; the store shape
  account-store.ts — the AccountStore over an in-memory copy
  config.ts        — the plain (unsealed) machine config, a sibling module
```

The sealed blob is one versioned JSON document (timestamps are epoch-ms metadata for
debugging which account was added/ran when):

```ts
interface StoreState {
  version: number; // evolve the shape in code — no migrations
  accounts: StoredGfAccount[];
}

interface StoredGfAccount {
  id: string;
  email: string;
  password: string; // plaintext inside the sealed blob
  installationId: string; // distinct per GF account
  deviceIdentity: DeviceIdentity; // {clientId, vector, vectorUpdatedAt}
  session?: Session; // {token, expiresAt} — cached, absent until first auth
  gameAccounts: StoredGameAccount[]; // {accountId, username, region, server?, character?}
  createdAt: number;
  lastUsedAt?: number;
}
```

Reads are **sync** (served from the in-memory copy); writes are **async** because
sealing shells out to DPAPI. `list` returns secret-free summaries; `get` returns the one
account (with secrets) a login needs:

```ts
interface AccountStore {
  list(): GfAccountSummary[]; // no secrets
  get(id: string): GfAccount | undefined; // includes secrets
  put(account: GfAccountInput): Promise<string>; // returns id
  remove(id: string): Promise<void>;
  recordAuth(id: string, r: { session: Session; deviceIdentity: DeviceIdentity }): Promise<void>;
  touch(id: string, now?: number): Promise<void>; // stamp last_used_at
}
```

Composition stays one-directional: a consumer `get`s a GF account, calls
`core.authenticate()`, then `recordAuth` writes the fresh token **and** drifted
`deviceIdentity` back together (one write of the whole blob, so a crash can't desync
identity from session). `core` imports nothing from `store`; the store knows nothing
about who calls it, so a stateful application layer sits above it as thin frontends
(CLI, UI) over the same interface.

## Gitignore

The store file and any key material never leave the machine. `.gitignore` excludes
`accounts.dat` and its `accounts.dat.*` temp/lock siblings (alongside `.env*`, `*.p12`,
`*.pem`) so a real accounts store can't be committed by accident.
