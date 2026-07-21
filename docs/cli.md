# The CLI

The tool you operate: the vocabulary first (so nothing gets conflated), then the command surface.
Both frontends — the CLI and the `serve` web UI — drive the same `openApp()` object
([architecture.md](./architecture.md)), so this surface is where command logic is _named_, not where
it lives.

## The two entities

Inherently confusing, because it is confusing on GameForge's side too. Anchor to the real launcher:
its **profile** says _GameForge account_ (email + password, shared across OGame / NosTale / Metin2);
opening **a game** lists _game accounts_ (the per-game logins that own characters). One GameForge
account can hold several game accounts — **that is the multibox lever**.

So: **GameForge account → owns → game accounts → own → characters.** In prose always use the full
names, never a bare "account" for either and never "user". In the **CLI**, the noun `account`
defaults to the **game account**, because that's what ~90% of users mean: most people have one
GameForge login and several game accounts, and touch the game accounts daily. The GameForge account
is the rarely-touched credential, so it lives under `auth` — exactly like `gh`, where the entity is
"your GitHub account" but the namespace is `auth`.

| Concept                                  | Prose name             | CLI home                     | What it is                                                |
| ---------------------------------------- | ---------------------- | ---------------------------- | --------------------------------------------------------- |
| Email + password top-level login         | **GameForge account**  | `auth` (`<gf>` ref)          | authenticate once; owns game accounts; carries the device |
| Per-game child login                     | **game account**       | `account` (the default noun) | from `/user/accounts`; has a region; globally unique      |
| Virtual hardware (GPU/screen/RAM/hashes) | **device profile**     | `auth device`                | one per GameForge account, distinct across them           |
| clientId + drifting vector               | part of the **device** | `auth device`                | game1's `x-game` / `x-vec`, persisted per GF account      |
| `TNT-Installation-Id` UUID               | **installation id**    | `auth device`                | one per GameForge account; must contain a digit           |
| Machine-level per-region game dir        | **config**             | `config`                     | not per account; where you installed the client           |

A GameForge account **owns a device** (installation id + identity + hardware profile bundled),
minted once and reused forever. It sits at the GameForge-account layer — that's where the blackbox
is presented — so all game accounts under one login share it and distinctness only matters **across**
GameForge accounts.

## The surface

Mature CLIs (`docker`, `gh`, `gcloud`) converge on the same rules: two levels of `<noun> <verb>`,
`auth` as a noun namespace rather than a loose verb, consistent verbs across nouns, and one bare
hot-path verb (`docker run`). `launch` earns that last one.

```sh
# launch — the product's whole point; top-level like `docker run`
unforge launch [game-account]        # auth + spawn the client (picks the account if omitted)

# account — game accounts, the everyday noun
unforge account list [--gf <gf>]     # game accounts across your GameForge logins
unforge account sync [--gf <gf>]     # re-fetch from GameForge, replacing what's stored
unforge account create [name]        # create one under a login — the multibox lever
unforge account code <game-account>  # mint + print a one-time login code (diagnostic)

# auth — your GameForge account(s); authenticate once, then forgotten
unforge auth register                # create a GF account via the API (captcha solved in-flow)
unforge auth login                   # authenticate; mint its device; discover its game accounts
unforge auth list                    # GameForge accounts (handle · email · sessions)
unforge auth alias <gf> [alias]      # set/clear a short handle
unforge auth logout <gf>             # confirms first (--yes to skip)
unforge auth device show <gf>        # inspect the device: profile, installation id, identity
unforge auth device regen <gf>       # roll a NEW device for this account (confirms first)

# config — machine-level, set once (the cert is bundled, so it needs none)
unforge config set game-dir <path>   # finds the client, fills every region it sees
unforge config list

unforge serve                        # the local web UI over the same store + core
```

**Refs, not an active account.** `gh` needs `auth switch` because its commands run in an ambient
context (the current repo implies the account); here every command takes an explicit,
**globally-unique** game-account ref, so there is no ambient state to switch. GF accounts are
addressed by a short **handle** — a stored alias if set, else derived from the email (the local
part, or the `+tag` of a plus-address: `you+alt2@example.com` → `alt2`). Any `<gf>`/`--gf` ref
accepts the handle, the full email, or an id prefix; ambiguity is **rejected, never guessed**
([`refs.ts`](../src/app/refs.ts) is pure, so those rules are testable without I/O). The one command
that can't take a game-account ref is `account create` — the account doesn't exist yet — so it takes
the owning login by `--gf`, defaulting to your sole login or a picker.

**Prompts** run through [@clack/prompts](https://github.com/bombshell-dev/clack)
([`src/cli/prompts.ts`](../src/cli/prompts.ts)): one style for text, secrets, yes/no, pick-one. A
missing required value is prompted **only** with a TTY, so scripts fall back to flags unaffected;
destructive actions (`logout`, `device regen`) confirm first unless `--yes`.

**`--region` appears on exactly two commands**, the two things that genuinely depend on it:
`account create`, where it is the permanent choice, and `config set game-dir`, where it labels a
client dir the folder name doesn't name. Notably not `auth login`/`register` — the device is
region-free. Why, and what the other four region-ish names mean: [regions.md](./regions.md).

**`account sync` exists because the stored game accounts are a cache, not a record.** Login,
`create` and `launch` all re-list them as a side effect; `sync` is that refresh on its own, for an
account made on the website, one deleted or renamed there, or a store that emptied them on a shape
change ([storage.md](./storage.md)). It **replaces** rather than merges — GF's answer is complete,
so anything it doesn't list no longer exists.

**`auth login` persists the password, unlike `gh`'s token.** GF has no refresh endpoint, so
unattended re-auth needs it again ([storage.md](./storage.md)) — and the help text says so honestly.
`login` also _actually authenticates_ (validating credentials and populating the game-account list
in one shot) rather than recording the account blind. `auth register` is the same flow with
`POST /users` in front, reusing **one device** throughout so registration and its immediate login
don't churn the fingerprint.

**`auth device` is a mild semantic stretch** (a device is identity, not strictly auth) but beats a
third top-level noun. Keep it two words; if `device` grows, promote it rather than nest deeper.
`device regen` rolls profile, identity and installation id **at once**, because they are one thing.
