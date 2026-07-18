// The full cross-platform core: credentials → one-time login code. Composes the
// three Spark steps, picks a game account, and mints the iovation blackbox natively.
// Stateless — every input is passed in; the only thing worth persisting is the
// device identity (returned), so its fingerprint stays stable per account.

import { getLogger } from "@logtape/logtape";
import { createSession } from "./spark/sessions.ts";
import { listGameAccounts } from "./spark/accounts.ts";
import { attestDevice } from "./spark/iovation.ts";
import { requestLoginCode } from "./spark/codes.ts";
import {
  createBlackboxSequence,
  type DeviceIdentity,
  type DeviceProfile,
} from "./blackbox/index.ts";
import { UnforgeError } from "./errors.ts";
import { DEFAULT_CLIENT_VERSION } from "./client-version.ts";
import type { ClientVersion, Credentials, GameAccount, LoginCode } from "./types.ts";

export interface AuthenticateOptions extends Credentials {
  installationId: string;
  /** Server region for the code's `gameId`, e.g. "pt-PT". */
  region: string;
  /** The launcher's client-cert PEM (GF-shared/public), for the `thin/codes` UA hash. */
  certificatePem: string;
  clientVersion?: ClientVersion;
  locale?: string;
  /**
   * Virtual device to fingerprint as. Required — core ships no default device (a shared
   * fingerprint correlates accounts); mint one per account with `generateDeviceProfile()` and
   * persist it, so the fingerprint stays stable and distinct.
   */
  deviceProfile: DeviceProfile;
  /**
   * Persisted per-account device identity (client id + drifting vector). A fresh
   * one is minted if omitted; either way the (possibly-drifted) identity is
   * returned to persist — reuse it for this account to keep the fingerprint stable.
   */
  deviceIdentity?: DeviceIdentity;
  /** Pick the game account to log into; defaults to the first one returned. */
  selectAccount?: (accounts: GameAccount[]) => GameAccount;
}

const log = getLogger(["unforge", "spark"]);

export interface AuthenticateResult {
  code: LoginCode;
  account: GameAccount;
  token: string;
  /** The device identity to persist for this account (its vector may have drifted). */
  deviceIdentity: DeviceIdentity;
}

/** Run the whole auth flow and return a login code for one game account. */
export async function authenticate(opts: AuthenticateOptions): Promise<AuthenticateResult> {
  const clientVersion = opts.clientVersion ?? DEFAULT_CLIENT_VERSION;
  const sessionId = crypto.randomUUID();

  // One fresh, vector-advanced blackbox per privileged call — the sequence owns that rule
  // (reusing one was the "clientless is blocked" bug). See {@link createBlackboxSequence}.
  const blackbox = createBlackboxSequence({
    profile: opts.deviceProfile,
    identity: opts.deviceIdentity,
  });

  log.debug("sessions: credentials to bearer token");
  const token = await createSession({
    email: opts.email,
    password: opts.password,
    installationId: opts.installationId,
    blackbox: blackbox.next(),
    locale: opts.locale,
  });

  log.debug("user/accounts: listing game accounts");
  const accounts = await listGameAccounts(token, opts.installationId);
  if (accounts.length === 0) throw new UnforgeError("GF login has no game accounts");
  const account = opts.selectAccount ? opts.selectAccount(accounts) : accounts[0];

  log.debug("iovation: attesting device");
  await attestDevice({
    token,
    installationId: opts.installationId,
    accountId: account.id,
    blackbox: blackbox.next(),
  });

  log.debug("thin/codes: minting login code");
  const code = await requestLoginCode({
    token,
    account,
    installationId: opts.installationId,
    clientVersion,
    certificatePem: opts.certificatePem,
    sessionId,
    rawBlackbox: blackbox.next({ installation: opts.installationId, session: sessionId }),
    region: opts.region,
  });

  return { code, account, token, deviceIdentity: blackbox.identity };
}
