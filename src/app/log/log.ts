// Logging setup for the entry points. `core` and the app layer emit through LogTape
// (`getLogger(["unforge", …])`); the CLI and `serve` call `configureLogging` once at
// startup to wire the sinks. Unconfigured, every log call is a no-op, so `core` stays
// pure. See docs/architecture.md (Logging).

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { configure, getConsoleSink, withFilter, type LogLevel, type Sink } from "@logtape/logtape";
import { getRotatingFileSink } from "@logtape/file";
import { redactByField } from "@logtape/redaction";
import { unforgeDataFile } from "../../storage/index.ts";

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
}

/**
 * Wire LogTape's sinks. Call once per process, before the work starts. Two sinks are
 * always on: the stderr console (thresholded) and a rotating file at {@link defaultLogFile}
 * that captures everything at `debug`+.
 */
export async function configureLogging(opts: ConfigureLoggingOptions = {}): Promise<void> {
  const consoleLevel: LogLevel = opts.verbose ? "debug" : "info";

  const logFile = process.env.UNFORGE_LOG_FILE ?? defaultLogFile();
  const logDir = dirname(logFile);
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  // bufferSize 0: each line is written straight through, so a one-shot CLI that exits
  // immediately still leaves a complete trail. Sized for the request trace it carries — full
  // request/response bodies are ~10x the volume of the step log, and the point of keeping them
  // is being able to look back at the run that failed, not just the last one.
  const file = getRotatingFileSink(logFile, {
    maxSize: 20 * 1024 * 1024,
    maxFiles: 10,
    bufferSize: 0,
  });

  await configure({
    reset: true,
    sinks: {
      console: withFilter(redacted(getConsoleSink()), consoleLevel),
      file: redacted(file),
    },
    loggers: [
      // `trace` (the request trace) is below `debug`, so it reaches the file but is filtered
      // out of the console by `consoleLevel` — bodies would drown the terminal, --verbose or not.
      { category: ["unforge"], lowestLevel: "trace", sinks: ["console", "file"] },
      { category: ["logtape", "meta"], lowestLevel: "warning", sinks: [] },
    ],
  });
}
