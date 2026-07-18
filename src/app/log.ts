// Logging setup for the entry points. `core` and the app layer emit through LogTape
// (`getLogger(["unforge", …])`); the CLI and `serve` call `configureLogging` once at
// startup to wire the sinks. Unconfigured, every log call is a no-op, so `core` stays
// pure. See docs/logging.md.

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { configure, getConsoleSink, withFilter, type LogLevel, type Sink } from "@logtape/logtape";
import { getRotatingFileSink } from "@logtape/file";
import { redactByField } from "@logtape/redaction";
import { unforgeDataFile } from "../storage";

// Fields that carry secrets — never serialized raw, whichever sink they hit.
const SECRET_FIELDS = ["password", "token", "code", "blackbox", "installationId"];

/** Wrap a sink so secret fields are redacted before it sees them. */
const redacted = (sink: Sink): Sink => redactByField(sink, SECRET_FIELDS);

/** `%LOCALAPPDATA%\unforge\logs\unforge.log` — the always-on trail; $UNFORGE_LOG_FILE overrides. */
function defaultLogFile(): string {
  return unforgeDataFile("logs", "unforge.log");
}

export interface ConfigureLoggingOptions {
  /** Drop the console threshold to `debug` (the `--verbose` flag). */
  verbose?: boolean;
  /** Console threshold when not verbose. Default `"info"`. */
  consoleLevel?: LogLevel;
  /** Override the always-on log file. Default {@link defaultLogFile} / `$UNFORGE_LOG_FILE`. */
  logFile?: string;
  /** Extra sinks beyond console + file — e.g. serve's WebSocket sink. */
  sinks?: Sink[];
}

/**
 * Wire LogTape's sinks. Call once per process, before the work starts. Two sinks are
 * always on: the stderr console (thresholded) and a rotating file at {@link defaultLogFile}
 * that captures everything at `debug`+.
 */
export async function configureLogging(opts: ConfigureLoggingOptions = {}): Promise<void> {
  const consoleLevel: LogLevel = opts.verbose ? "debug" : (opts.consoleLevel ?? "info");

  const logFile = opts.logFile ?? process.env.UNFORGE_LOG_FILE ?? defaultLogFile();
  const logDir = dirname(logFile);
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  // bufferSize 0: each line is written straight through, so a one-shot CLI that exits
  // immediately still leaves a complete trail. Rotates at 5 MB, keeping the last 5 files.
  const file = getRotatingFileSink(logFile, {
    maxSize: 5 * 1024 * 1024,
    maxFiles: 5,
    bufferSize: 0,
  });

  const extra = opts.sinks ?? [];
  const extraNames = extra.map((_, i) => `sink${i}`);

  await configure({
    reset: true,
    sinks: {
      console: withFilter(redacted(getConsoleSink()), consoleLevel),
      file: redacted(file),
      ...Object.fromEntries(extra.map((s, i) => [extraNames[i], redacted(s)])),
    },
    loggers: [
      { category: ["unforge"], lowestLevel: "debug", sinks: ["console", "file", ...extraNames] },
      { category: ["logtape", "meta"], lowestLevel: "warning", sinks: [] },
    ],
  });
}
