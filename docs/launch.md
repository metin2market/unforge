# Launch — spawning the client and handing it the session

This is the **Windows-only** half of unforge. The auth half ([protocol.md](./protocol.md)) ends
with a one-time login code; this is what happens next — the client is spawned, connects back to a
**named pipe** we host, asks who it is and what code to log in with, and logs _itself_ in. That is
what makes the launch launcher-less: we never touch the game's encrypted TCP protocol.

[`spawnClient`](../src/launch/index.ts) is the library API; `src/app/` composes it with the auth
flow behind `unforge launch <game-account>` and the `serve` UI's Launch button.

## The shape

```
unforge   (hosts \\.\pipe\GameforgeClientJSONRPC — the launcher's pipe, by the launcher's name)
    └─ metin2client.exe --gf          env: _TNT_SESSION_ID, _TNT_CLIENT_APPLICATION_ID
           └─ metin2client.exe --gf   (re-execs itself once, for the admin its manifest requires)
                  │
                  └─ connects back to the pipe and asks who it is + what code to log in with
```

| Input                        | Value                                                                 |
| ---------------------------- | --------------------------------------------------------------------- |
| argv                         | `--gf` — that is the entire command line                              |
| cwd                          | the region's game dir (e.g. `…/metin2/pt-PT`)                         |
| `_TNT_SESSION_ID`            | a GUID we generate; identifies this launch on the pipe                |
| `_TNT_CLIENT_APPLICATION_ID` | the game UUID from `gsl.ini` (`fab180a3-cd65-4b7e-bd0e-2ef77fd0c258`) |
| pipe                         | `\\.\pipe\GameforgeClientJSONRPC` — we host it, the client connects   |

The session is **not** on the argv. (NosTale's client takes a positional `gf <langCode>` instead;
Metin2's does not. `hatz2/GflessClient` is the NosTale-side reference for the same
`gameforge_api.dll` mechanism.)

> `gsl_metin2.exe` is **not** part of this path — it never runs on a launch. It is the
> install/update Game Specific Launcher only, and its `/startedFromGsl`, `/host=`, `/msgId=`
> strings belong to that separate flow.

## Spawning

- **Run from the region's game dir.** The client reads its auth server from the local config, and
  the code's `gameId.<region>` must match that region ([regions.md](./regions.md)).
- **Administrator is required.** `metin2client.exe`'s manifest is
  `requestedExecutionLevel requireAdministrator` (anti-cheat), so a non-elevated spawn fails
  `EACCES`. `spawnClient` tries a plain spawn and on `EACCES` relaunches via ShellExecute `runas` —
  a UAC prompt if not elevated, silent if it is. The client also re-execs itself once, so expect
  two `metin2client.exe` processes per launch.
- **The UAC relaunch must carry `_TNT_SESSION_ID` itself.** ShellExecute does **not** pass the
  caller's environment across the elevation boundary — point it straight at the client and the
  client starts with no session id, so `queryAuthorizationCode` finds nothing and it hangs on the
  pipe. So `buildElevatedCommand` elevates a **PowerShell** that sets the env in its own process and
  then `Start-Process`es the client as a child (which inherits it), shipping the inner script as a
  base64 `-EncodedCommand`. The relaunch runs synchronously and throws on failure (bad command,
  declined UAC) rather than failing silently.
- **Run unforge elevated for multibox** — launches then neither prompt nor risk an integrity
  mismatch on the pipe.

### The game dir

The per-region game dir is genuinely machine-specific, so `launch` needs
`unforge config set game-dir <path> [--region <r>]` (`account code` needs nothing). The command
**resolves and stores** the real location. [`discoverGameDirs`](../src/launch/index.ts) expands a
leading `~`, finds `metin2client.exe`, and — pointed at the install **root** (`…/metin2`) or any
**region dir** (`…/metin2/pt-PT`, whose parent it then scans) — **fills every region folder** it
finds, inferring each region from the folder name. `--region` is only needed for a non-standard
layout where that inference fails.

Each install also records a region in its `gsl.ini` (`region=pt-PT`), and the two can disagree —
the GameForge launcher appears to stamp that key from its own setting rather than the download's.
`findClientDir` does not read it.

## The pipe protocol

JSON-RPC over the named pipe, with two properties that matter:

- **One connection per call.** The client opens the pipe, sends a single request, reads the reply,
  and closes — then reopens for the next method. Don't hold state on the connection.
- **No framing.** Requests are bare JSON objects on the wire with no length prefix, so a reader must
  scan for balanced braces rather than assume one object per read.

Every request carries the `sessionId` we passed in `_TNT_SESSION_ID`; every reply echoes the
request's `id` and `jsonrpc`:

```jsonc
// ← client                                                    // → us
{"id":1,"jsonrpc":"2.0","method":"ClientLibrary.initSession",
 "params":{"sessionId":"dc7ecd9b-…"}}                          {"id":1,"jsonrpc":"2.0","result":"dc7ecd9b-…"}
```

| Method (`ClientLibrary.*`)  | Params        | Result                   | Notes                                                    |
| --------------------------- | ------------- | ------------------------ | -------------------------------------------------------- |
| `initSession`               | `{sessionId}` | the `sessionId`, echoed  | string                                                   |
| `queryAuthorizationCode`    | `{sessionId}` | our `thin/codes` code    | **string** — the whole point                             |
| `queryGameAccountName`      | `{sessionId}` | the game account's name  | string (`displayName`; `usernames[]` is typically empty) |
| `queryGameAccountNumericId` | `{sessionId}` | the account's numeric id | **JSON number, not a string**                            |
| `isClientRunning`           | —             | `"true"`                 | NosTale asks; Metin2's client does not                   |

The numeric id is `guls.user` from `/user/accounts`, which the auth flow already lists on its way to
`thin/codes`, so it costs no extra call. Answer these and the client goes straight to character
selection: **the handshake _is_ the login.** It is spent on the account, not on picking a character
or entering a server — that's the game's own protocol, which unforge never touches.

The wire protocol is core (`src/core/handoff/`, pure and unit-tested); the server that binds the
machine-wide pipe is app ([`handoff-server.ts`](../src/app/handoff-server.ts)).

## Timing — the second batch is human-triggered

The client connects **twice**, and what separates them is a person, not loading:

```
spawn → intros → initSession (~2.5s, automatic)
      → server + channel screen        ← the user sits here. Nothing is asked.
      → user clicks Join               ← code + name + numericId fire together, in one burst
      → character selection
```

So the wait before the calls that matter is **unbounded** — however long someone takes to pick a
server (measured 11 s and 48 s for the same client on the same machine; a load time wouldn't vary
4×).

**The client keeps expecting a responder afterwards.** Go back to server selection with the pipe
gone and it fails with _"the launcher is no longer working"_ — the handshake is not a one-shot
startup step, and a served code is not permission to hang up. Whether it also probes during play is
untested; assume it might.

**Every entry asks again, and needs a _new_ code.** Rejoining replays the whole burst and the
previous code is spent, so a responder that holds one code and echoes it answers the second entry
with a dead credential — failing in-game while the pipe looks healthy, every call answered. Hence
`LaunchTicket.mintCode` mints **per call** and `launches.start` mints nothing, only resolving the
account for its `numericId`. That also keeps a code from sitting outstanding across the wait at the
server screen, where an unconsumed one would hold the account for ~18 minutes
([protocol.md](./protocol.md#4-code--mint-the-one-time-login-code)).

**So there is no safe timeout.** Any cap is a guess about a human, and closing early fails silently
and confusingly. The pipe's lifetime is therefore the _app's_: one server from the first launch
until `close()`, and `launches.start` only registers on it.

That is also why `start` doesn't wait for the handoff. It returns as soon as the client process
exists, and the rest is reported as [`LaunchStatus`](../src/app/launches.ts) — `awaiting-client` →
`connected` (the client called `initSession`) → `logged-in` (it took its code), driven by the pipe
traffic itself. Blocking until the handoff completes would mean blocking on a person, which a
caller running several clients cannot do. Holding the process open afterwards is a frontend's
choice: the CLI keeps its window alive and says so; the web UI doesn't need to.

The status **stops at `logged-in`**. The client re-execs itself for elevation, so the pid we spawned
exits almost immediately and means nothing — there is no honest signal for "the game closed", and
inventing one would be worse than its absence.

## Concurrency and multibox

**The pipe is a singleton** — one process owns `\\.\pipe\GameforgeClientJSONRPC` machine-wide. That
is the central design constraint, and it cuts both ways:

- **The real launcher must not be running.** `gfclient.exe` owns the pipe; unforge cannot bind it
  while the launcher is up. Being launcher-less means _replacing_ the launcher, not running beside
  it. (`gfservice.exe` / `GameforgeClientService` is a different pipe — install/update plumbing,
  unrelated. Leave it running.)
- **One server serves every client.** Because each call carries its `sessionId`, a single server
  multiplexes any number of concurrent clients: keep a `sessionId → {mintCode, name, numericId}`
  registry, spawn each client with its own GUID, answer per session. This is what makes multibox
  work, and why the launch API cannot be a fire-and-forget spawn.

## Other constraints

- **Don't strand a session.** Force-killing a live client (or tree-killing its parent) leaves the
  session hanging server-side, which produces the same 403 as an unconsumed code — the account is
  locked out of a retry for ~18 minutes. Close clients cleanly.
- **Pace the logins.** Each attempt is a full `sessions` → `iovation` → `thin/codes` cycle, and that
  churn is what trips GameForge's risk scoring ([red-bar.md](./red-bar.md)).

## Verifying it

`unforge launch <game-account>` is the observation path: every JSON-RPC call the client makes is
logged at `debug` (`--verbose` to watch live), unknown methods included, with the auth behind each
minted code in the always-on trace ([architecture.md → Logging](./architecture.md#logging)).

[`scripts/capture-launch.ps1`](../scripts/capture-launch.ps1) captures ground truth from a **real**
launcher Play: it polls `Win32_Process` and dumps each `metin2client` command line as it appears.
Run it elevated (a non-elevated CIM query returns a blank `CommandLine` for the admin client) and
start it _before_ clicking Play. When observed behaviour and a binary's strings disagree, this is
the tiebreaker — trust the capture.

## Injecting automation

`hatz2/GflessClient` (Injector + Launcher) is the reference for the CreateProcess-suspended →
inject → resume pattern. Injection is **post-login** UI automation (server/channel/character) only;
it has no part in auth.
