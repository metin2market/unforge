# Logging

Structured logging on [LogTape](https://logtape.org). The library only ever _emits_ records
(`getLogger(["unforge", …]).info(…)`); each entry point (the CLI and `serve`) calls
`configureLogging()` once at startup to decide where they go. Categories root under `["unforge"]` so
one config line sets the level + sinks for every subsystem, and an embedding app can route unforge's
records apart from its own. If nothing configures LogTape the calls are no-ops, so `core` stays pure
and imposes no I/O on embedders.

## Levels

Four: `debug` (per-step progress), `info` (milestones — code minted, client launched), `warn`
(handled-but-unexpected: red bar, PoW challenge, retries), `error` (the operation failed).

## Sinks

Two sinks are always on, wired by `configureLogging`:

- **console** (stderr, so stdout stays clean — `account code` still prints only the code). Shows
  `info`+ by default; `--verbose` drops it to `debug`+ (everything).
- **file** — a rotating trail that always captures **everything** (`debug`+), regardless of the
  console threshold. Default `%LOCALAPPDATA%\unforge\logs\unforge.log`; override with
  `$UNFORGE_LOG_FILE`. Rotates at 5 MB, keeping the last 5 files. Written unbuffered so a one-shot
  CLI run still leaves a complete trail.

## Request trace

The redacted trail above is the wrong tool for diagnosing a GameForge refusal: it hides the very
fields — blackbox, token, code, `gameId` — a diagnosis turns on. `--trace` wraps `fetch` and writes
one JSONL line per request/response, **un-redacted**, to a per-run
`%LOCALAPPDATA%\unforge\logs\trace-<stamp>.jsonl` (`--trace-file` or `$UNFORGE_TRACE` to choose the
path). The CLI prints where it wrote, because the file holds live secrets and has to be scrubbed
before it's shared. Its shape matches the captured launcher traffic, so the same tools read both.

`--trace` is a **boolean**, and deliberately so: as `--trace <file>` it swallowed the subcommand —
`--trace launch` parsed as "write to a file named `launch`, run no command" and silently opened the
web UI instead of launching.

`bun dev` passes `--verbose --trace`, so development runs are always fully recorded.

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
