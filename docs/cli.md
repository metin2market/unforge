# The CLI & state layer — vocabulary, command surface, design

The auth chain works ([status.md](./status.md)); this doc covers the layer built on top that
turns a proven flow into a tool you operate: **stable per-account devices, a consistent CLI, and
the launch wiring**. It fixes the vocabulary first (so nothing gets conflated), then lays out the
command surface and the deliberate design decisions behind it.

## The two entities — GameForge account vs game account

This is inherently confusing because it's confusing on GameForge's side too. Anchor to what
the real launcher shows:

- Open the launcher's **profile** → it says **GameForge account**. That's the email + password
  — the top-level login, shared across all GF titles (OGame, NosTale, Metin2).
- Open a **specific game** → it lists **game accounts**. Those are the per-game logins that own
  characters/servers. One GameForge account can hold **several** game accounts (this is the
  multibox lever).

So the hierarchy is **GameForge account → owns → game accounts → own → characters**. In prose we
always use the full names **"GameForge account"** and **"game account"** — never a bare "account"
for either, never "user." In the **CLI**, though, the noun `account` defaults to the **game
account**, because that's what ~90% of users mean by "account" (most people have one GameForge
login and several game accounts, and touch the game accounts daily). The GameForge account is the
rarely-touched credential, so it lives under `auth` — exactly like `gh`, where the entity is "your
GitHub account" but the command namespace is `auth`.

## Vocabulary — one name per concept (lock this)

| Concept                                  | Prose name             | CLI home                     | What it is                                                                           |
| ---------------------------------------- | ---------------------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| Email + password top-level login         | **GameForge account**  | `auth` (`<gf>` ref)          | authenticate once; owns game accounts; carries the device                            |
| Per-game child login                     | **game account**       | `account` (the default noun) | from `/user/accounts`; has `region` + `server`; you launch into one; globally unique |
| Virtual hardware (GPU/screen/RAM/hashes) | **device profile**     | `auth device`                | one per GameForge account, distinct across them                                      |
| clientId + drifting vector               | part of the **device** | `auth device`                | game1's `x-game` / `x-vec`, persisted per GameForge account                          |
| `TNT-Installation-Id` UUID               | **installation id**    | `auth device`                | one per GameForge account; must contain a digit                                      |
| Machine-level per-region game dir        | **config**             | `config`                     | not per account; where you installed the client (`launch` needs it)                  |

A GameForge account **owns a device** (installation id + identity + hardware profile bundled),
minted once and reused forever — that's what keeps its fingerprint stable and distinct. The device
sits at the GameForge-account layer (that's where the blackbox is presented), and all game accounts
under one login already share it, so distinctness only matters **across GameForge accounts**. See
[blackbox.md](./blackbox.md) for why stable-distinct matters.

## CLI shape — noun → verb, `auth` + `account` split

Mature CLIs (`docker`, `gh`, `gcloud`) converge on the same rules:

1. **Two levels: `<noun> <verb>`** — `docker container create`, not `docker create-container`.
2. **`auth` is a noun namespace, not a loose verb** — `gh auth login/logout/status`. The GameForge
   account (the credential) lives here, set up once and then forgotten.
3. **Consistent verbs across nouns** (`list`, `logout`, `show`).
4. **One bare hot-path verb is OK** — `docker run` is top-level though it's "really"
   `docker container run`, because it's the product's whole point. `launch` earns the same.

```
# launch — the product's whole point; top-level like `docker run`
unforge launch [game-account]      # auth + spawn the client (picks the account if omitted)

# account — game accounts, the everyday noun (bare "account" = game account)
unforge account list [--gf <gf>]   # game accounts across your GameForge logins
unforge account create [name]      # create one under a login (picks/prompts if omitted) — the multibox lever
unforge account code <game-account># mint + print a one-time login code (test / diagnostic)

# auth — your GameForge account(s); authenticate once, then forgotten (mirrors `gh auth`)
unforge auth register              # create a GF account via the API (solves the captcha in-flow) + record
unforge auth login                 # authenticate a GF account; mint its device; discover its game accounts
unforge auth list                  # GameForge accounts (handle · email · sessions)  (like `gh auth status`)
unforge auth alias <gf> [alias]    # set/clear a short handle (omit to clear back to the email-derived one)
unforge auth logout <gf>           # confirms first (--yes to skip)
unforge auth device show <gf>      # inspect the device: profile, installation id, identity
unforge auth device regen <gf>     # roll a NEW device profile for this account (confirms first; --yes)

# config — machine-level, set once (the cert needs no config: it's read from
# ~/unforge-materials/cert.pem or baked into the build)
unforge config set game-dir <path>   # finds the client, fills every language it sees
unforge config list

# the web UI (already works)
unforge serve
```

Deliberate design decisions:

- **No `auth switch` / active account.** `gh` needs it because its commands run in an ambient
  context (the current repo implies the account). Here every command takes an explicit,
  **globally-unique** game-account ref, so there's no ambient state to switch. The one command that
  can't use a game-account ref is `account create` (the account doesn't exist yet) — it takes the
  owning login by `--gf`, defaulting to your sole login or an interactive picker. Revisit only if we
  ever support multiple games.
- **GF accounts are addressed by a short handle, not just the email.** A **handle** is a stored alias
  (`auth alias`) if set, else derived from the email — the local part, or the `+tag` of a Gmail
  plus-address (`crbgames1+unclear2@gmail.com` → `unclear2`). Any `<gf>`/`--gf` ref accepts the
  handle, the full email, or an id/prefix; ambiguity is rejected. So multibox never means typing
  full emails.
- **Prompts and confirmations run through [@clack/prompts](https://github.com/bombshell-dev/clack)**
  (`src/cli/prompts.ts`): one style for text, secrets, yes/no, and pick-one. A missing required value
  is prompted **only** with a TTY — non-interactive use falls back to flags (so scripts are
  unaffected), and destructive actions (`logout`, `device regen`) confirm first unless `--yes`.
- **`launch` is top-level, not duplicated under `account`.** One obvious home beats two. The
  lower-level `code` (raw login code) stays under `account` as a diagnostic — hot path bare,
  plumbing namespaced, same split as docker.
- **`auth login` persists the password, unlike `gh`'s token.** GF has no refresh endpoint, so
  unattended re-auth needs the password again ([accounts.md](./accounts.md)) — the help text must
  say so honestly. `login` should also _actually authenticate_ (validate credentials + populate the
  game-account list in one shot), so it proves the account works instead of recording it blind.
- **`auth register` creates the account via the API and records it.** `createGfAccount` calls
  `POST /users` (solving the captcha in-flow, [pow-captcha.md](./pow-captcha.md)), then the same
  authenticate + persist as `auth login`, with the **same device** throughout so registration and its
  immediate login don't churn the fingerprint. Mirrors `login`'s options (`--email/--password/
--region/--locale`).
- **`auth device` is a mild semantic stretch** (a device is identity, not strictly auth) but beats a
  third top-level noun. Keep it two words; if `device` grows, promote it to its own namespace rather
  than nesting deeper.

## How it's wired

A thin **application layer** ([`src/app/`](../src/app/)) composes `core` + `store` + `config` +
`launch`, and both frontends — the CLI ([`src/cli/`](../src/cli/index.ts)) and the `serve` web UI —
call into it, so command logic lives in one place, not duplicated per frontend.

| Piece                                                        | Where                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `core.authenticate()` — auth → login code                    | `src/core/authenticate.ts`                                                      |
| `generateDeviceProfile()` — distinct device per GF account   | `src/core/blackbox/device.ts`                                                   |
| `store` — sealed per-account JSON (device + game accounts)   | `src/storage/` (account-store.ts)                                               |
| cert PEM — `~/unforge-materials/cert.pem` → build-baked      | `resolveCertPem` (`src/app/game.ts`) + `src/core/embedded-cert.ts` (gitignored) |
| `config` — per-region game dirs                              | `src/storage/config.ts`                                                         |
| `spawnClient()` — the Windows client spawn                   | `src/launch/`                                                                   |
| app layer — `registerAccount` / `mintCode` / `launchAccount` | `src/app/`                                                                      |
| CLI (`auth`/`account`/`launch`/`config`/`serve`)             | `src/cli/`                                                                      |

**The device primitive** — `generateDeviceProfile()` is what makes distinct-per-account real. It
**varies** the fields that differ between real machines (GPU, screen, RAM, cores, every opaque
`*Hash`/`*Fingerprint`) and **keeps constant** `userAgent`/`browserName`/schema/`automationFlags`
(every genuine GF launcher is the same CEF/Chrome-72 build — varying those would be the tell). It's
minted once when a GameForge account is first authenticated (`registerAccount`) and reused forever;
`auth device regen` rolls the whole device (installation id + identity + profile) at once.

Where the project goes from here — multibox at scale and the open product questions — lives in
[status.md → What's next](./status.md).
