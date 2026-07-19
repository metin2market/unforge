// unforge app — the complete workflows, over core + storage.
//
// `openApp()` is the entry point: it binds the store, the config, and the policy once and
// exposes `auth`, `accounts`, and `launches`. Both frontends (the CLI, the `serve` web UI)
// drive that one object, so command logic lives here rather than per frontend — and a
// long-lived host can re-expose it as-is, since nothing here assumes it owns the process.

export { openApp, DEFAULT_LOCALE, DEFAULT_REGION } from "./app.ts";
export type {
  App,
  AppEvent,
  AppOptions,
  AppSnapshot,
  AccountsApi,
  AuthApi,
  GameAccountRow,
  LaunchApi,
} from "./app.ts";

export type { LaunchState, LaunchStatus } from "./launches.ts";

// The GameForge session — for a consumer that brings its own persistence.
export { openGfSession, registerGfSession, resumeGfSession } from "./gf-session.ts";
export type { GfSession, GfSessionPolicy } from "./gf-session.ts";

export { createHandoffServer } from "./handoff-server.ts";
export type { HandoffServer, HandoffServerOptions } from "./handoff-server.ts";

export { resolveCertPem, DEFAULT_CERT_PATH } from "./cert.ts";
export { binName, gfAlias, gfHandle, resolveGameAccount, resolveGfAccount } from "./refs.ts";
export type { ResolvedGameAccount } from "./refs.ts";

export { configureLogging, installFetchTrace, type ConfigureLoggingOptions } from "./log/index.ts";
export { describeError, type ErrorDescription, type ErrorKind } from "./describe-error.ts";
export { openUrl } from "./open-url.ts";
