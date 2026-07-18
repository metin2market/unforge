// unforge core — the pure, cross-platform GameForge (Spark) auth logic.
// No CLI, no Windows launch, no I/O beyond the network calls: credentials in,
// login code out. The `launch` (spawn the client) and CLI layers build on this.

export { authenticate } from "./authenticate.ts";
export type { AuthenticateOptions, AuthenticateResult } from "./authenticate.ts";

export {
  createSession,
  buildSessionRequest,
  logout,
  buildLogoutRequest,
} from "./spark/sessions.ts";
// Headless registration: POST /users, solving the PoW captcha in-flow. See docs/pow-captcha.md.
export { createUser, buildCreateUserRequest } from "./spark/create-user.ts";
export type { CreateUserOptions, CreatedUser } from "./spark/create-user.ts";
export {
  solveChallenge,
  sendWithChallenge,
  solvePow,
  solveSubChallenge,
  buildFetchChallengeRequest,
  buildSubmitChallengeRequest,
  POW_CAPTCHA_BASE,
} from "./spark/challenge.ts";
export type {
  PowChallenge,
  PowSubChallenge,
  PowSolution,
  PowSubmission,
  PowMetrics,
} from "./spark/challenge.ts";
export { listGameAccounts, buildAccountsRequest } from "./spark/accounts.ts";
export {
  createGameAccount,
  buildCreateAccountRequest,
  METIN2_GAME_ID,
  METIN2_GAME_ENVIRONMENT_ID,
} from "./spark/create-account.ts";
export { attestDevice, buildAttestRequest } from "./spark/iovation.ts";
export { requestLoginCode, buildCodeRequest } from "./spark/codes.ts";
export type { SparkRequest } from "./http.ts";

export { EMBEDDED_CERT_PEM } from "./embedded-cert.ts";
export { generateInstallationId, isValidInstallationId } from "./installation-id.ts";
export { DEFAULT_CLIENT_VERSION, parseClientVersion } from "./client-version.ts";
export { accountHash, firstDigit, sha1, sha256 } from "./crypto.ts";
export type { AccountHashInput } from "./crypto.ts";
export {
  encryptBlackbox,
  decryptBlackbox,
  generateBlackbox,
  createBlackboxSequence,
  createDeviceIdentity,
  LAUNCHER_BROWSER_FIELDS,
  generateDeviceProfile,
} from "./blackbox/index.ts";
export type {
  BlackboxRequest,
  GenerateBlackboxOptions,
  GeneratedBlackbox,
  BlackboxSequence,
  BlackboxSequenceOptions,
  DeviceProfile,
  DeviceIdentity,
} from "./blackbox/index.ts";

export * from "./errors.ts";
export type { ClientVersion, Credentials, GameAccount, LoginCode } from "./types.ts";
