// An authenticated GameForge session — where core's Spark calls become workflows.
//
// It binds what every call needs (the bearer token, the device, the region/locale/cert
// policy) once, so no step restates it, and it owns the rule that is easiest to get wrong:
// **every privileged call sends its own fresh, vector-advanced blackbox**. Reusing one
// across `sessions` + `iovation` was the long-standing "clientless is blocked" bug. No
// method here takes a blackbox, so a caller cannot replay one — the guarantee is structural
// rather than documented. See docs/protocol.md and docs/blackbox.md.
//
// The device's vector drifts as the session is used: read `device` when you're done and
// persist it, or the account's fingerprint goes stale.

import { getLogger } from "@logtape/logtape";
import {
  attestDevice,
  createBlackboxSequence,
  createGameAccount,
  createGfAccount,
  createSession,
  DEFAULT_CLIENT_VERSION,
  listGameAccounts,
  logout,
  regionMismatch as codeRegionMismatch,
  requestLoginCode,
  type BlackboxSequence,
  type ClientVersion,
  type CreatedGameAccount,
  type Credentials,
  type GameAccount,
  type LoginCode,
} from "../core/index.ts";
import type { Device } from "../storage/index.ts";

const log = getLogger(["unforge", "spark"]);

/** Policy applied to every call on the session — bound once, never per-step. */
export interface GfSessionPolicy {
  /** GF locale, `^[a-z]{2}-[A-Z]{2}$`. */
  locale: string;
  /** Server region for a minted code's `gameId`, e.g. "pt-PT". */
  region: string;
  /** The launcher's client-cert PEM, for the `thin/codes` account-hash UA. */
  certificatePem: string;
  clientVersion?: ClientVersion;
}

export interface GfSession {
  readonly token: string;
  /** The device as it now stands — its vector has drifted. Persist this. */
  readonly device: Device;
  /** Every game account on this login. */
  accounts(): Promise<GameAccount[]>;
  /**
   * Create a game account under this login — the multibox lever. `region` is where the account
   * will live permanently, and the only region it can later be launched in.
   */
  createGameAccount(displayName: string, opts?: { region?: string }): Promise<CreatedGameAccount>;
  /** Attest the device, then mint a one-time login code for one game account. */
  mintCode(account: GameAccount, opts?: { region?: string }): Promise<LoginCode>;
  /** Invalidate the session server-side. Best-effort. */
  close(): Promise<void>;
}

function session(
  token: string,
  device: Device,
  blackbox: BlackboxSequence,
  policy: GfSessionPolicy,
): GfSession {
  const { installationId } = device;
  return {
    token,
    get device(): Device {
      return { ...device, identity: blackbox.identity };
    },

    accounts() {
      log.debug("user/accounts: listing game accounts");
      return listGameAccounts(token, installationId);
    },

    createGameAccount(displayName, opts = {}) {
      // The region an account is *created in* is the region it can be played in, forever — GF
      // files it under the group and `thin/codes` is then only valid there. So it has to come
      // from the caller's choice, not a process-wide default.
      const accountRegion = opts.region ?? policy.region;
      // GF wants the bare group ("pt"), not the region tag ("pt-PT"), in two fields.
      // NOTE: this is the region→group direction, where the subtag is right for every group
      // Metin2 uses. The reverse needs a translation table (see refs.ts CLIENT_LOCALE) — a
      // `da-DK` region would have to be created as group `dk`, which this does not yet handle.
      const accountGroup = accountRegion.split("-")[0].toLowerCase();
      log.debug("users/me/accounts: creating '{displayName}' in {region} [{accountGroup}]", {
        displayName,
        region: accountRegion,
        accountGroup,
      });
      return createGameAccount({
        token,
        installationId,
        displayName,
        blackbox: blackbox.next(),
        gfLang: accountGroup,
        accountGroup,
        // Only the captcha's language if a PoW fires — unrelated to where the account lives.
        locale: policy.locale,
      });
    },

    async mintCode(account, opts = {}) {
      const sessionId = crypto.randomUUID();
      const region = opts.region ?? policy.region;

      // The two states that make `thin/codes` fail for a reason its 403 never names. Logged
      // before the call, so the redacted trail says *why* without anyone opening the trace.
      if (account.retired) {
        log.warning("'{name}' is deleted or pending deletion — GameForge won't allow a code", {
          name: account.displayName,
        });
      }
      if (codeRegionMismatch(region, account.accountGroup)) {
        log.warning(
          "'{name}' is in group '{accountGroup}' but we're asking for region '{region}'",
          {
            name: account.displayName,
            accountGroup: account.accountGroup,
            region,
          },
        );
      }

      log.debug("iovation: attesting device");
      await attestDevice({
        token,
        installationId,
        accountId: account.id,
        blackbox: blackbox.next(),
      });

      log.debug("thin/codes: minting {gameId} for account {accountId}", {
        gameId: `${account.gameId}.${region}`,
        accountId: account.id,
      });
      const code = await requestLoginCode({
        token,
        account,
        installationId,
        clientVersion: policy.clientVersion ?? DEFAULT_CLIENT_VERSION,
        certificatePem: policy.certificatePem,
        sessionId,
        rawBlackbox: blackbox.next({ installation: installationId, session: sessionId }),
        region,
      });
      log.info("login code minted");
      return code;
    },

    async close() {
      try {
        await logout(token, installationId);
      } catch {
        // Best-effort: a dead token still ends the run, and nothing downstream depends on it.
      }
    },
  };
}

/** Authenticate a GameForge account. Solves the PoW captcha in-flow if one fires. */
export async function openGfSession(
  credentials: Credentials,
  device: Device,
  policy: GfSessionPolicy,
): Promise<GfSession> {
  const blackbox = createBlackboxSequence({ profile: device.profile, identity: device.identity });
  log.debug("sessions: credentials to bearer token");
  const token = await createSession({
    ...credentials,
    installationId: device.installationId,
    blackbox: blackbox.next(),
    locale: policy.locale,
  });
  return session(token, device, blackbox, policy);
}

/**
 * Register a NEW GameForge account, then authenticate it on the SAME device — registration
 * and its first login must not churn the fingerprint, so one blackbox sequence spans both.
 * Always PoW-gated (~8s of CPU). The new login authenticates immediately but can't mint a
 * code until its email is verified.
 */
export async function registerGfSession(
  credentials: Credentials,
  device: Device,
  policy: GfSessionPolicy,
): Promise<GfSession> {
  const blackbox = createBlackboxSequence({ profile: device.profile, identity: device.identity });
  log.debug("users: registering {email} headless", { email: credentials.email });
  await createGfAccount({
    ...credentials,
    installationId: device.installationId,
    blackbox: blackbox.next(),
    locale: policy.locale,
  });

  log.debug("sessions: authenticating the new account");
  const token = await createSession({
    ...credentials,
    installationId: device.installationId,
    blackbox: blackbox.next(),
    locale: policy.locale,
  });
  return session(token, device, blackbox, policy);
}

/** Resume from a cached token, skipping `sessions` — fewer re-auths is lower risk scoring. */
export function resumeGfSession(token: string, device: Device, policy: GfSessionPolicy): GfSession {
  const blackbox = createBlackboxSequence({ profile: device.profile, identity: device.identity });
  return session(token, device, blackbox, policy);
}
