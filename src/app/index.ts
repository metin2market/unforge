// unforge app — the application/orchestration layer above core + store + config +
// launch. Thin frontends (the CLI, the web UI) call these operations so command logic
// lives in one place, not duplicated per frontend. Everything here is Windows-capable
// (it can touch the store/DPAPI and spawn the client) — `core` stays pure below it.

export {
  registerAccount,
  createGfAccount,
  listGfAccounts,
  setGfAlias,
  deviceInfo,
  regenDevice,
  logoutAccount,
  type RegisterAccountOptions,
  type RegisterAccountResult,
  type DeviceInfo,
} from "./accounts.ts";
export { openUrl } from "./open-url.ts";
export {
  listAllGameAccounts,
  addGameAccount,
  mintCode,
  launchAccount,
  resolveCertPem,
  DEFAULT_CERT_PATH,
  type GameAccountRow,
  type AddGameAccountOptions,
  type AddGameAccountResult,
  type MintCodeResult,
  type LaunchResult,
} from "./game.ts";
export {
  resolveGfAccount,
  resolveGameAccount,
  gfAlias,
  gfHandle,
  DEFAULT_REGION,
  SESSION_TTL_MS,
  type ResolvedGameAccount,
} from "./shared.ts";
export { configureLogging, type ConfigureLoggingOptions } from "./log.ts";
export { describeError, type ErrorDescription, type ErrorKind } from "./describe-error.ts";
export { installFetchTrace, installFetchTraceFromEnv } from "./trace.ts";
