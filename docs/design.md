# Design & architecture

How `unforge` is shaped, and how its two halves — **authenticate** and **launch** —
fit together. The wire-level detail lives in [protocol.md](./protocol.md) (auth) and
[handoff.md](./handoff.md) (client); current progress in [status.md](./status.md);
this is the structure above them.

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
Linux/Mac user can still generate codes.

Note the halves are asymmetric in lifetime: auth is a request/response the caller
awaits, but the handoff pipe is a **singleton, machine-wide, and shared by every
concurrent client** — so launch is a long-lived server, not a fire-and-forget spawn
([handoff.md → Concurrency and multibox](./handoff.md#concurrency-and-multibox)).

## Principles

- **Library + CLI, granular _and_ complete.** Every step is callable on its own
  (`unforge auth` → login code) and the whole flow is one command (`unforge launch`
  → auth + spawn). Library consumers import the same functions the CLI uses.
- **Stateless core, optional persistence.** Core functions take everything as input;
  an opt-in state layer handles session reuse, per-account `InstallationId`, the
  cert, and the device fingerprint ([accounts.md](./accounts.md)). **Never re-mint a
  session per call** — re-auth churn is a risk-scoring trigger.
- **Stable, distinct identities.** The `InstallationId` and the device fingerprint
  are generated once per account and persisted — never fresh-per-launch (churn) and
  never shared across accounts (correlation). See
  [protocol.md → Installation id](./protocol.md#installation-id) and
  [blackbox.md](./blackbox.md).
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
