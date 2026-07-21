<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/unforge-dark.svg">
  <img src="docs/assets/unforge.svg" alt="unforge" width="96" height="96">
</picture>

# unforge

**Launch GameForge games without the GameForge launcher.**

[![License: MIT](https://img.shields.io/badge/License-MIT-AF2B25.svg)](./LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-A97D3A.svg)](https://bun.sh)
[![Library + CLI](https://img.shields.io/badge/library%20%2B%20CLI-TypeScript-2F2115.svg)](#what-you-get)
[![Status: building in the open](https://img.shields.io/badge/status-building%20in%20the%20open-A97D3A.svg)](#status)

</div>

`unforge` reproduces GameForge's `spark.gameforge.com` login itself and hands you a valid game login
code — then, on Windows, spawns the client and logs it in for you. No launcher window, no Play
button. It's a **TypeScript library** and a **single-binary CLI**, so you can drive it from C++,
Python, a script, or a local web UI. Built for **Metin2**, on the GF-account login shared across
GameForge titles.

The point is **launcher-less multibox**: authenticate any number of accounts and drop each one
straight into the game from one command, with a stable, distinct device identity per account.

> [!WARNING]
> **Not a ban bypass.** Skipping the launcher does **not** un-flag an account. `unforge` calls the
> _same_ GameForge APIs the launcher does, so a server-side–flagged account still can't log in — the
> block follows the account, not the launcher, and no local tool clears it. It removes the launcher
> **UI**, not GameForge's checks. See [docs/red-bar.md](./docs/red-bar.md).

## See it run

<!-- DEMO VIDEO — reserved space.
     To embed: open this file in GitHub's web editor and drag the .mp4 onto the line below;
     GitHub hosts it and turns it into an inline player. Then delete this comment and the
     placeholder image beneath it. -->

<div align="center">
  <img src="docs/assets/demo-placeholder.svg" alt="Demo video coming soon" width="720">
</div>

## Quick start

```sh
# 1. Get the binary — download the latest release, or build it yourself:
bun install && bun run build        # → ./unforge (single binary, Windows)

# 2. Point it at your game install (once)
unforge config set game-dir "C:\GameForge\Metin2\pt-PT"

# 3. Link your GameForge account
unforge auth login

# 4. Launch straight into the game
unforge launch <game-account>
```

That last command walks the whole login chain and spawns the client already logged in. Run it again
with another account name to multibox — sessions are reused, so more accounts doesn't mean more
logins.

| Command                                                  | What it does                                           |
| -------------------------------------------------------- | ------------------------------------------------------ |
| `unforge launch <game-account>`                          | Auth + spawn the client into a game account (Windows). |
| `unforge account list` · `code <game-account>`           | List your game accounts · mint a one-time login code.  |
| `unforge auth register \| login \| list \| logout \| device` | Manage GameForge accounts and their devices.           |
| `unforge config set game-dir`                            | Point it at your game install, set once.               |
| `unforge serve`                                          | A local web UI over the same store + core.             |

Full surface and the account vocabulary: [docs/cli.md](./docs/cli.md).

## What you get

- **Multibox from the CLI.** Add every account once, launch any of them by name. One machine-wide
  handoff pipe serves every concurrent client, so many clients run off one flow.
- **A distinct identity per account.** A stable device fingerprint and installation id, generated
  once per account and persisted — no churn between launches, no correlation across accounts.
- **Library-first, in three layers.** `unforge/core` is the reverse-engineering layer (endpoints,
  hashes, the blackbox, the wire protocol), `unforge/storage` is the sealed account store, and
  `unforge` is the complete workflows over both. The CLI is the library with a face on it.
- **One binary, no runtime.** `bun build --compile` produces a single executable, callable from
  anything that can run a program. The auth half is cross-platform; only `launch` is Windows-only.

## How it works

Four Spark calls turn credentials into a one-time login code — each depends on the one before it —
and then the client is spawned with it:

```
sessions ──▶ user/accounts ──▶ iovation ──▶ thin/codes ──▶ metin2client.exe
  token       game accounts    device        login code      in game
                               attested        minted
```

The auth half is plain request/response and runs anywhere Bun runs. The **launch** half is
Windows-only: it spawns `metin2client.exe` from the region's game dir and hands it the code over a
named pipe, which the client reads to log itself in. Because that pipe is a singleton shared by
every concurrent client, `launch` runs as a long-lived server rather than a fire-and-forget spawn.

## Status

🚧 **Building in the open.** The chain works end-to-end — `sessions` → `user/accounts` → `iovation`
→ `thin/codes` mints a real Metin2 login code headless, and `unforge launch` spawns the client and
hands it that code, dropping you straight into the game with no launcher in the loop. Registering a
GameForge account and creating game accounts work headless too, captcha included.

## Development

```sh
bun install
bun run dev        # the CLI from source, with --verbose
bun test           # unit tests + the known-vector tests
bun run check      # format, lint, typecheck
bun run build      # the single binary
```

The crypto and encoding are pinned to **known vectors** — the account hash, the blackbox encoder,
and the captcha shim are all asserted against real captured launcher values. The `*.capture.test.ts`
tests need those captures, which are gitignored, so they skip on a clean clone; everything else runs
offline.

## The docs

This repo is meant to be as much a **readable explanation of GameForge login** as a tool.

**The login, end to end**

1. [**protocol.md**](./docs/protocol.md) — the flow itself: the four Spark calls, registration,
   account creation, the `thin/codes` "MAGIC" hash, and the materials it needs. _Start here._
2. [**blackbox.md**](./docs/blackbox.md) — the iovation device fingerprint, generated natively with
   no browser, and the freshness rule the whole flow hangs on.
3. [**captcha.md**](./docs/captcha.md) — GameForge's proof-of-work challenge and the server-sent
   `instrumentation` code, solved headless.
4. [**regions.md**](./docs/regions.md) — five confusable names for "where an account lives", and the
   one rule that governs them.
5. [**launch.md**](./docs/launch.md) — the Windows half: spawning the client and handing it the code
   over the named pipe.

**The tool**

6. [**architecture.md**](./docs/architecture.md) — the three layers, the auth/launch split, error
   handling, and logging.
7. [**cli.md**](./docs/cli.md) — the GameForge-vs-game account vocabulary and the command surface.
8. [**storage.md**](./docs/storage.md) — how accounts are kept: one OS-sealed file, and why.

**Working on it**

9. [**capturing-traffic.md**](./docs/capturing-traffic.md) — watching the real launcher, the RE loop
   behind everything above.
10. [**red-bar.md**](./docs/red-bar.md) — the login block: what's verified, what's folklore, and why
    no local cleanup fixes it.

## Credits / prior art

Protocol knowledge stands on [`morsisko/NosTale-Auth`](https://github.com/morsisko/NosTale-Auth),
[`hatz2/GflessClient`](https://github.com/hatz2/GflessClient), and
[`zakuciael/gf-login`](https://github.com/zakuciael/gf-login). The blackbox reimplementation draws on
[`stdLemon/nostale-auth`](https://github.com/stdLemon/nostale-auth),
[`alaingilbert/ogame`](https://github.com/alaingilbert/ogame), and
[`ogame-ninja/ogame_fingerprint`](https://github.com/ogame-ninja/ogame_fingerprint).

## License

MIT — see [LICENSE](./LICENSE).
