// Where records go (log.ts), which network records exist (trace.ts), and what's allowed in them
// (trace-scrub.ts) — one concern, since the request trace is a log level like any other.
// See docs/logging.md.

export { configureLogging, type ConfigureLoggingOptions } from "./log.ts";
export { installFetchTrace } from "./trace.ts";
