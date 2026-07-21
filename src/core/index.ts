// unforge core — the reverse-engineering layer: what GameForge does, reproduced.
//
// Endpoints, the account hash, the iovation blackbox, the handoff wire protocol. Every
// step is granular and composable, because reproducing the flow yourself is a legitimate
// thing to want. The rule that keeps this layer honest:
//
//   core knows GameForge. It does not know unforge.
//
// So there is no workflow, no persistence, no policy, and no default that encodes a
// choice of ours. Anything true because *we* decided it — one device per account, cached
// sessions, minting a code only when the client asks — lives in src/app.
//
// Each network step is a pair: a pure `build*Request` and the call that sends it. The
// pure half is the artifact — it's what gets asserted byte-for-byte against a captured
// launcher request (test/requests.capture.test.ts), and what a reader compares to
// docs/protocol.md.

export {
  createSession,
  buildSessionRequest,
  logout,
  buildLogoutRequest,
} from "./spark/sessions.ts";
export type { CreateSessionOptions } from "./spark/sessions.ts";
// Headless registration: POST /users, solving the PoW captcha in-flow. See docs/captcha.md.
export { createGfAccount, buildCreateGfAccountRequest } from "./spark/create-gf-account.ts";
export type { CreateGfAccountOptions } from "./spark/create-gf-account.ts";
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
export type { CreateGameAccountOptions, CreatedGameAccount } from "./spark/create-account.ts";
export { attestDevice, buildAttestRequest } from "./spark/iovation.ts";
export type { AttestDeviceOptions } from "./spark/iovation.ts";
export { requestLoginCode, buildCodeRequest, codeRefusal } from "./spark/codes.ts";
export { regionForGroup, groupForRegion, isRegion, assertRegion, knownRegions } from "./regions.ts";
export type { AccountGroup, Region } from "./regions.ts";
export type { RequestCodeOptions } from "./spark/codes.ts";
export { sparkFetch } from "./http.ts";
export type { SparkRequest } from "./http.ts";

export { GAMEFORGE_CERT_PEM } from "./cert.ts";
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
  driftVector,
  encodeBlackboxBody,
  LAUNCHER_BROWSER_FIELDS,
  generateDeviceProfile,
  DeviceProfile,
  DeviceIdentity,
} from "./blackbox/index.ts";
export type {
  BlackboxRequest,
  GenerateBlackboxOptions,
  GeneratedBlackbox,
  BlackboxSequence,
  BlackboxSequenceOptions,
} from "./blackbox/index.ts";

export * from "./errors.ts";
export type { ClientVersion, Credentials, GameAccount, LoginCode } from "./types.ts";
