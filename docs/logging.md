# Logging

Structured logging on [LogTape](https://logtape.org). The library only ever _emits_ records
(`getLogger(["unforge", …]).info(…)`); each entry point (the CLI and `serve`) calls
`configureLogging()` once at startup to decide where they go. Categories root under `["unforge"]` so
one config line sets the level + sinks for every subsystem, and an embedding app can route unforge's
records apart from its own. If nothing configures LogTape the calls are no-ops, so `core` stays pure
and imposes no I/O on embedders.

## Levels

Five: `trace` (every HTTP call — see below), `debug` (per-step progress), `info` (milestones — code
minted, client launched), `warn` (handled-but-unexpected: red bar, PoW challenge, retries), `error`
(the operation failed).

## Sinks

Two sinks are always on, wired by `configureLogging`:

- **console** (stderr, so stdout stays clean — `account code` still prints only the code). Shows
  `info`+ by default; `--verbose` drops it to `debug`+ — never `trace`.
- **file** — a rotating trail that always captures **everything** (`trace`+, bodies included),
  regardless of the console threshold. Default `%LOCALAPPDATA%\unforge\logs\unforge.log`; override
  with `$UNFORGE_LOG_FILE`. Rotates at 20 MB, keeping the last 10 files — sized for the request
  trace. Written unbuffered so a one-shot CLI run still leaves a complete trail.

## Request trace

Every run wraps `fetch` and logs each call as a normal record at **`trace`** — one `→` before
dispatch (so a hung call still leaves a mark) and one `←` with status and duration. No flag, no
separate file: the network sits inline with the steps that made it, in `unforge.log`, read top to
bottom. Always on because the failures worth diagnosing are one-shot — a spent challenge or a
cooldown can't be reproduced on demand.

`trace` is below `debug`, so bodies reach the file sink and never the console, `--verbose` or not.

`trace-scrub.ts` masks credentials before they're logged: `password` → a constant (nothing is
diagnosable from one), `token`/`code`/`Authorization` → a truncated SHA-256, which keeps "same token
as the last call?" answerable and is safe only because those are high-entropy. Blackbox, installation
ids, cookies and email stay raw — that _is_ the diagnosis, and it's why bodies are logged as strings:
`redactByField` walks record fields and would strip exactly those. The log stays
device-identifying — local, gitignored, never pasted in public.

unforge opens only the GameForge calls the auth flow needs — there is no telemetry sink in the tool.
An embedding consumer can pass its own sinks to `configureLogging({ sinks })` to forward records
elsewhere (e.g. serve's planned live-view over the heartbeat WebSocket).

## Redaction

Secrets flow through this code (passwords, tokens, login codes, blackbox, installation ids). Every
sink wraps redaction via `@logtape/redaction`; secret fields never serialize raw. Pass secrets as
named fields, never interpolate them into a message string.

## Launch elevation

`metin2client.exe` requires administrator ([launch.md](./launch.md)), so a non-elevated launch goes
through a UAC relaunch that runs synchronously and throws on failure (a bad command, or the user
declining UAC) rather than failing silently.
