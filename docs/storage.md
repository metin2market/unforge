# Storage — the account store

`core` is stateless: credentials in, login code out, no disk touched. But any real deployment has to
_remember_ accounts between runs — which game account maps to which region, the per-account identity
that must stay stable, a reusable token, and for unattended use the credentials themselves. That is
a **separate layer** in [`src/storage/`](../src/storage), above `core` and never imported by it.

Consumers depend on the `AccountStore` interface, not on where the bytes land. The implementation is
a **single DPAPI-sealed JSON file**: the dataset is tiny (tens of accounts) and we do our own
encryption, so a database earns nothing.

## What persists

A GameForge login can hold **several game accounts** ([cli.md](./cli.md#the-two-entities)), so the
store is a collection of GF accounts, each owning its game accounts:

| Field              | Secret?              | Notes                                                                                                        |
| ------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------ |
| `email`            | no                   | the GF login                                                                                                 |
| `alias`            | no                   | optional short handle; absent → derived from the email                                                       |
| `gameAccounts`     | no                   | `{accountId, displayName, accountGroup}` — GameForge's fields verbatim, region derived                       |
| `secrets.password` | **yes**              | used only at the `sessions` step; the durable re-mint key                                                    |
| `secrets.device`   | sensitive            | the whole [`Device`](../src/storage/device.ts). Its vector **drifts**, so it is written back after every run |
| `secrets.token`    | sensitive, revocable | cached `{token, expiresAt}` — reuse to avoid re-auth churn                                                   |

**Secrets are nested under one key, not mixed in.** `list()` returns accounts without it and `get()`
with it, so dropping the key is all it takes to make a value safe to hand to a UI or a log — a
"summary" supertype can't promise that, because the secret-bearing type would be assignable to it.

**Never share a `Device` across GF accounts.** Identical identity across logins is a fingerprinting
red flag ([blackbox.md](./blackbox.md)), so the store mints a distinct one when a caller adds an
account without a device. There is no shared default to fall back on.

## Store the password, cache the token

The password is touched once — the `sessions` call — which returns a bearer token every later call
uses. There is **no refresh endpoint**, so when the token expires the only way to mint a new one is
another `sessions` call, which needs the password again. And `sessions` sends it as **raw plaintext**
over TLS, so storing a hash is impossible: whatever we persist must recover to plaintext. Hence
sealed, not hashed.

That shapes two modes. **Interactive:** cache only the token and re-prompt when it expires; nothing
credential-grade on disk. **Unattended / multibox:** no human is present, so the password must be
retrievable locally — which makes the deployment token-lifetime-agnostic, dropping the token to a
pure optimisation (fewer `sessions` calls = less churn = lower risk score).

The current shape serves the unattended path: `password` is required. The token-only interactive
variant would make it optional; not built.

## One DPAPI-sealed file

The whole account set is `JSON.stringify`'d and **sealed as a single blob**, written to one file at
`%LOCALAPPDATA%\unforge\accounts.dat` (per-user by ACL; the exact path isn't load-bearing). Load =
read → unseal → parse; save = stringify → seal → atomic write. Because the data is tiny,
decrypt-all/encrypt-all costs nothing — so **everything is encrypted at rest**: email,
`installationId`, and secrets alike. Nothing readable sits on disk (a test scans the file for every
plaintext value). Sealing one blob is also safer than per-secret sealing: one unseal per load, one
seal per save, and no risk of forgetting a newly-added sensitive field.

**Don't hold a key — let Windows.** DPAPI's `ProtectedData.Protect`/`Unprotect` (reachable from Bun
via a short PowerShell call) encrypts with a key derived from the machine/user credentials and
managed by the OS: no key file, no passphrase, works unattended, survives reboot. The thin
`sealSecret()`/`unsealSecret()` wrapper is the only place that touches it, and it **pipes secrets
over stdin** — argv is visible to other processes and can land in logs.

**The seal binds to the machine + Windows user, not the program** — the right binding, since
`unforge` is a public binary anyone can run, so program-identity binding would let every copy unseal
the blob. Two consequences: any process running as the same Windows user can `Unprotect` too, and a
sealed blob is **non-portable**, so restoring a backup onto a fresh box makes every secret dead.
That non-portability is the feature — it is what defeats file theft.

**Debug escape hatch:** `UNFORGE_STORE_PLAINTEXT=1` writes the blob as readable JSON behind a marker
line instead of sealing it (reads auto-detect the marker). It warns, and is debug-only.

**Not a database.** A login reads one account by id (a `.find`); a UI lists them (a `.map`). SQLite
would add migrations, a native-lib-vs-`--compile` fight, and WAL sidecars for no benefit. The one
real upgrade over DPAPI-user, if disk-theft-with-known-password ever matters, is a **TPM-sealed
key** — a future option, not the plan (it does nothing for the live-box case).

### Threat model

An unattended box must be able to decrypt itself, so the key is reachable on the box. Sealing at
rest therefore **defeats** the realistic leaks — a grabbed store file, a backup, a synced folder, a
slip into git — and **does not defeat** a compromised live box running as the same user. That is
inherent to unattended decryption, not a fixable flaw. Shrink the blast radius by other means:
throwaway accounts, a distinct device per GF account so one flag doesn't cascade, paced logins,
tight file permissions, never logging a secret. The real "revoke" is changing the password
server-side, which invalidates outstanding tokens.

## Shape

```
src/storage/
  paths.ts         — the <localAppData>\unforge data folder
  atomic-write.ts  — safe whole-file write (temp + rename), shared with config
  seal.ts          — sealSecret / unsealSecret (DPAPI over stdin)
  device.ts        — the Device type + createDevice()
  store-file.ts    — load/save the sealed blob, the lock, shape validation
  account-store.ts — the AccountStore over an in-memory copy
  config.ts        — the plain (unsealed) machine config, a sibling module
```

A stored account is the field table above plus `id` and `createdAt`/`lastUsedAt` (epoch-ms metadata,
for debugging which account was added or ran when).

```ts
interface AccountStore {
  list(): GfAccount[]; // no secrets
  get(id: string): GfAccountWithSecrets | undefined; // secrets guaranteed present
  add(account: NewGfAccount): Promise<GfAccountWithSecrets>;
  save(id: string, patch: AccountPatch): Promise<void>; // merge under the lock
  remove(id: string): Promise<void>;
  onChange(fn: (accounts: GfAccount[]) => void): () => void;
}
```

Reads are **sync** (served from the in-memory copy loaded at open); writes are **async** because
sealing shells out to DPAPI. `onChange` exists for the long-lived host, which must push store
changes to connected clients and cannot poll a sealed file.

**One write path, not a family of mutators.** `save` takes a patch of exactly the mutable fields (an
absent key is left alone; `alias: null` clears). The read-modify-write under the lock is the store's
job either way, so a single merging write says what special-purpose setters said without also
offering a whole-account `put` that bypasses them.

Composition stays one-directional: a consumer `get`s a GF account, runs a
[`GfSession`](../src/app/gf-session.ts), then `save`s the drifted device **and** the fresh token
together — one write of the whole blob, so a crash can't desync them.

### Concurrency

The intended model is **single-writer** (the host process owns the store), with a light guard for
the rest. Reads serve from memory. Writes take an exclusive **lock file** next to the store, then
reload → mutate → seal → **atomic write** (temp file, then rename over). Reloading under the lock
means a concurrent writer can't be lost; the atomic rename means a crash mid-write can't corrupt the
file. A stale lock (crashed holder) is stolen after a timeout.

### No schema version, and no migrations

A shape change means deleting `accounts.dat` and logging in again — cheaper than carrying upgrade
code and a test for every past shape. Revisit when there are stores we don't own.

That only works if a stale store is _detected_, so `loadState` validates the whole blob against the
`StoreState` schema and refuses a mismatch, naming the field. Being our own data is not a reason to
trust it: a store written before a field existed reads fine field-by-field and then encodes
`undefined` into a blackbox, which GameForge refuses for reasons that point nowhere near here.

**What a reset costs decides whether stale is fatal.** `gameAccounts` is a cache of GameForge's
list, so it empties and `account sync` refills it. `secrets` — password, token, and above all
`device` — exists nowhere else, so it refuses. The config takes the `gameAccounts` line throughout:
it holds only paths, so a malformed entry is dropped rather than blocking a launch.

The store file and its temp/lock siblings are gitignored alongside `.env*`, `*.p12` and `*.pem`, so
a real store can't be committed by accident.
