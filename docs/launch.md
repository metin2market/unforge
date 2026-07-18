# Launch — spawning the game client

Once a [`GfSession`](../src/app/gf-session.ts) mints a `thin/codes` login code, `launch` spawns the game
client from the region's game dir and hands it that code over a named pipe, so the client logs itself
in. The wire-level detail of that exchange is [handoff.md](./handoff.md); this doc is the surrounding
Windows machinery — finding the client, spawning it, elevation, and config.

This is the **Windows-only** half of unforge; the auth half is cross-platform ([design.md](./design.md)).
[`spawnClient`](../src/launch/index.ts) is the library API; the application layer
([`src/app/app.ts`](../src/app/app.ts)) composes it with the auth flow, exposed as
`unforge launch <game-account>` and the `serve` UI's Launch button.

## The command line

```
metin2client.exe --gf          # cwd: the region's game dir
```

That is the whole command line — `--gf` and nothing else. The session travels via the
`_TNT_SESSION_ID` / `_TNT_CLIENT_APPLICATION_ID` environment variables and the
`GameforgeClientJSONRPC` pipe, **not** the argv. See [handoff.md](./handoff.md) for the pipe protocol,
which is what actually logs the client in.

- **Run from the region's game dir** (e.g. `…/metin2/pt-PT`) — the client reads its auth server from
  the local config, and the code's `gameId.<region>` must match that region.
- **Requires administrator.** `metin2client.exe`'s manifest is `requestedExecutionLevel
requireAdministrator` (anti-cheat), so a non-elevated `spawn` fails `EACCES`. `spawnClient` tries a
  plain spawn (which works, with a pid, when unforge is already elevated) and on `EACCES` relaunches
  via ShellExecute `runas` — a UAC prompt if not elevated, silent if it is. The client also re-execs
  itself once for the same reason, so expect two `metin2client.exe` processes per launch.
- **The UAC relaunch must carry `_TNT_SESSION_ID` itself.** `Start-Process -Verb RunAs` elevates via
  ShellExecute, which does **not** pass the caller's environment across the elevation boundary — point
  it straight at the client and the client starts with no session id, so `queryAuthorizationCode` finds
  nothing and it hangs on the pipe. So `buildElevatedCommand` elevates a **PowerShell** that sets the
  env in its own process and then `Start-Process`es the client as a child (which inherits it), shipping
  the inner script as a base64 `-EncodedCommand`.
- **Run unforge elevated** for multibox: launches then neither prompt nor risk an integrity mismatch on
  the pipe.

## The cert

The `thin/codes` cert is bundled ([`src/core/gameforge-cert.pem`](../src/core/gameforge-cert.pem)),
so nothing needs configuring. A PEM at `~/unforge-materials/cert.pem` overrides it
([`src/app/cert.ts`](../src/app/cert.ts)) — the route to take if GameForge rotates
it. What the cert is: [protocol.md → Certificate](./protocol.md#certificate).

## Configuring the game dir

The per-region game dir is genuinely machine-specific, so `launch` needs
`unforge config set game-dir <path> [--region <r>]`; `account code` needs nothing.

The command **resolves and stores** the real location, so `config list` shows where the client actually
is. [`discoverGameDirs`](../src/launch/index.ts) expands a leading `~`, finds `metin2client.exe`, and —
pointed at the install **root** (`…/metin2`) or any **language dir** (`…/metin2/pt-PT`, whose parent it
then scans) — **fills every language folder** it finds (`pt-PT`, `en-GB`, …), inferring each region from
the folder name. `--region` is only needed for a non-standard layout where the region can't be inferred.

## Injecting automation

[`hatz2/GflessClient`](https://github.com/hatz2/GflessClient) (Injector + Launcher) is the reference
for the CreateProcess-suspended → inject → resume pattern.
Injection is **post-login** UI automation (server/channel/character) only — it has no part in auth.

## Driving the real launcher (a non-path)

Letting the real launcher log in and _harvesting_ the code it hands the client is **not needed** —
clientless auth mints the code directly, and it wouldn't help a blocked account anyway (a
red-barred account red-bars the launcher too). Keep it only as a manual last resort.
