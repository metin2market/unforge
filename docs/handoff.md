# The handoff — giving the client its session

How the GameForge launcher hands a logged-in session to the game client, and how unforge reproduces
it. This is what makes the launch **launcher-less**: the client logs itself in, and we never touch the
game's encrypted TCP protocol.

The auth half ([protocol.md](./protocol.md)) ends with a one-time `thin/codes` login **code**. This doc
is what happens next: the code is handed to the client over a **named pipe**, and the client turns it
into a login token itself.

## The shape

The launcher spawns the client with a single flag and two environment variables, then answers the
client's JSON-RPC calls on a named pipe it hosts:

```
gfclient.exe  (hosts \\.\pipe\GameforgeClientJSONRPC)
    └─ metin2client.exe --gf          env: _TNT_SESSION_ID, _TNT_CLIENT_APPLICATION_ID
           └─ metin2client.exe --gf   (re-execs itself once, for the admin its manifest requires)
                  │
                  └─ connects back to the pipe and asks who it is + what code to log in with
```

**The flag is `--gf`** — that is the entire command line. The session is _not_ on the argv; it travels
via `_TNT_SESSION_ID` + the pipe. (NosTale's client takes a positional `gf <langCode>` instead;
Metin2's does not. [`hatz2/GflessClient`](https://github.com/hatz2/GflessClient) is the NosTale-side
reference for the same `gameforge_api.dll` mechanism.)

| Input                        | Value                                                                 |
| ---------------------------- | --------------------------------------------------------------------- |
| argv                         | `--gf`                                                                |
| cwd                          | the region's game dir (e.g. `…/metin2/pt-PT`)                         |
| `_TNT_SESSION_ID`            | a GUID we generate; identifies this launch on the pipe                |
| `_TNT_CLIENT_APPLICATION_ID` | the game UUID from `gsl.ini` (`fab180a3-cd65-4b7e-bd0e-2ef77fd0c258`) |
| pipe                         | `\\.\pipe\GameforgeClientJSONRPC` — we host it, the client connects   |

> `gsl_metin2.exe` is **not** part of this path — it never runs on a launch. It is the install/update
> Game Specific Launcher only. Its `/startedFromGsl`, `/host=`, `/msgId=` strings belong to that
> separate flow and are a dead end for the handoff.

## The protocol

JSON-RPC over the named pipe. Two properties that matter:

- **One connection per call.** The client opens the pipe, sends a single request, reads the reply, and
  closes — then reopens for the next method. Don't hold state on the connection.
- **No framing.** Requests are bare JSON objects on the wire, with no length prefix, so a reader must
  scan for balanced braces rather than assume one object per read.

Every request carries the `sessionId` we passed in `_TNT_SESSION_ID`; every reply echoes the request's
`id` and `jsonrpc`:

```jsonc
// ← client                                                    // → us
{"id":1,"jsonrpc":"2.0","method":"ClientLibrary.initSession",
 "params":{"sessionId":"dc7ecd9b-…"}}                          {"id":1,"jsonrpc":"2.0","result":"dc7ecd9b-…"}
```

| Method (`ClientLibrary.*`)  | Params        | Result                  | Notes                                                    |
| --------------------------- | ------------- | ----------------------- | -------------------------------------------------------- |
| `initSession`               | `{sessionId}` | the `sessionId`, echoed | string                                                   |
| `queryAuthorizationCode`    | `{sessionId}` | our `thin/codes` code   | **string** — the whole point                             |
| `queryGameAccountName`      | `{sessionId}` | the game account's name | string (`displayName`; `usernames[]` is typically empty) |
| `queryGameAccountNumericId` | `{sessionId}` | `accountNumericId`      | **JSON number, not a string**                            |
| `isClientRunning`           | —             | `"true"`                | NosTale asks; Metin2's client does not                   |

`accountNumericId` comes from `/user/accounts` (see [protocol.md](./protocol.md)) — a separate field
from the account `id`, which is a UUID. The auth flow already lists accounts on its way to
`thin/codes`, so it costs no extra call.

Answer these and the client logs itself in — no username/password screen; it goes to character
selection. The handshake **is** the login: it replaces the credentials a human would type, and it is
spent on the account, not on picking a character or entering a server (that's the game's own protocol,
which unforge never touches).

### Timing — the second batch is human-triggered

The client connects **twice**, and what separates them is a **person**, not loading:

```
spawn → intros → initSession (~2.5s, automatic)
      → server + channel screen        ← the user sits here. Nothing is asked.
      → user clicks Join               ← code + name + numericId fire together, in one burst
      → character selection
```

So the wait before the calls that matter is **unbounded** — it's however long someone takes to pick a
server. (Measured 11 s and 48 s for the same client on the same machine; a load time wouldn't vary 4×.)

**And the client keeps expecting a responder afterwards.** Go back to server selection with the pipe
gone and it fails with _"the launcher is no longer working"_ — so the handshake is not a one-shot
startup step, and a served code is not permission to hang up. Whether the client also probes during
play is **untested**; assume it might.

The consequence: **there is no safe timeout.** Any cap is a guess about a human, and closing early
fails silently and confusingly. Host the pipe for as long as the client runs — `launchAccount` leaves
a self-hosted pipe open, so the process lives as long as the session and is ended by stopping it.

A caller that launches repeatedly, or wants the pipe to outlive any one client, should own a
long-lived server instead and pass it in.

## Concurrency and multibox

**The pipe is a singleton** — one process owns `\\.\pipe\GameforgeClientJSONRPC` machine-wide. That is
the central design constraint, and it cuts both ways:

- **The real launcher must not be running.** `gfclient.exe` owns the pipe; unforge cannot bind it while
  the launcher is up. Being launcher-less means _replacing_ the launcher, not running beside it.
  (`gfservice.exe` / `GameforgeClientService` is a different pipe — the launcher's install/update
  plumbing, unrelated to the handoff. Leave it running.)
- **One server serves every client.** Because each call carries its `sessionId`, a single pipe server
  multiplexes any number of concurrent clients: keep a `sessionId → {code, name, numericId}` registry,
  spawn each client with its own GUID, and answer per session. This is what makes multibox work, and it
  is why the launch API cannot be a self-contained fire-and-forget spawn.

## Constraints worth designing around

- **Administrator.** `metin2client.exe`'s manifest is `requestedExecutionLevel requireAdministrator`
  (anti-cheat), and the pipe must be at the client's integrity level. Run unforge elevated; otherwise
  each launch needs a UAC prompt and the pipe may be unreachable.
- **A code must be consumed.** An unconsumed code stays outstanding for roughly **18 minutes**, and
  GameForge refuses to mint another meanwhile — `403 {"error":{"message":"Not allowed to create code"}}`.
  A launch that dies before the client finishes the handoff therefore locks the account out of a retry
  for that long. Mint only when committed to spawning.
- **Don't strand a session.** Force-killing a live client (or tree-killing `gfclient`, whose child the
  client is) leaves its session hanging server-side and produces the same 403. Close clients cleanly.
- **Pace the logins.** Each attempt is a full `sessions` → `iovation` → `thin/codes` cycle; that churn
  is what trips GameForge's risk scoring. See [design.md → Operational note](./design.md#operational-note).

## Verifying it

[`scripts/gsl-launch-test.ts`](../scripts/gsl-launch-test.ts) is the observation harness: it hosts the
pipe, spawns the client, logs every JSON-RPC call (unknown methods included), and answers from a real
minted code. `UNFORGE_PROBE_DRY=1` validates resolution and config without touching the launcher, the
pipe, or an auth.

[`scripts/capture-launch.ps1`](../scripts/capture-launch.ps1) captures ground truth from a **real**
launcher Play: it polls `Win32_Process` and dumps each `metin2client` command line as it appears. Run
it elevated (a non-elevated CIM query returns a blank `CommandLine` for the admin client) and start it
_before_ clicking Play. When the observed behaviour and a binary's strings disagree, this is the
tiebreaker — trust the capture.
