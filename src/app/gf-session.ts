// An authenticated GameForge session — where core's Spark calls become workflows.
//
// It binds what every call needs (the bearer token, the device, the cert
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
  assertRegion,
  createSession,
  codeRefusal,
  DEFAULT_CLIENT_VERSION,
  groupForRegion,
  listGameAccounts,
  logout,
  requestLoginCode,
  type BlackboxSequence,
  type ClientVersion,
  type CreatedGameAccount,
  type Credentials,
  type GameAccount,
  type LoginCode,
  type Region,
} from "../core/index.ts";
import type { Device } from "../storage/index.ts";

const log = getLogger(["unforge", "spark"]);

/**
 * The GF interface locale: error text and the captcha page. A captured launcher constant, not a
 * setting — see docs/cli.md on why it isn't derived from a region.
 */
const GF_LOCALE = "en-GB";

/**
 * Policy applied to every call on the session — bound once, never per-step. No region and no
 * locale: a region belongs to one game account, so every call that needs one takes it.
 */
export interface GfSessionPolicy {
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
  createGameAccount(displayName: string, region: Region): Promise<CreatedGameAccount>;
  /**
   * Attest the device, then mint a one-time login code for one game account. Refuses a region
   * the account doesn't live in without calling GameForge — see {@link CodeNotAllowedError}.
   */
  mintCode(account: GameAccount, region: Region): Promise<LoginCode>;
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

    // `async` so the guard rejects rather than throwing synchronously, as `mintCode`'s does.
    async createGameAccount(displayName, region) {
      // GF files by group ("pt"), not region tag ("pt-PT") — always through the table, never by
      // splitting the tag (core/regions.ts). The guard is for JavaScript callers: `openGfSession`
      // is public API and a creation is permanent.
      assertRegion(region);
      const accountGroup = groupForRegion(region);
      log.debug("users/me/accounts: creating '{displayName}' in {region} [{accountGroup}]", {
        displayName,
        region,
        accountGroup,
      });
      return createGameAccount({
        token,
        installationId,
        displayName,
        blackbox: blackbox.next(),
        // The launcher sends the group in both fields; they are different dimensions that
        // coincide for Metin2's communities (see CreateGameAccountOptions.gfLang).
        gfLang: accountGroup,
        accountGroup,
        // Only the captcha's language if a PoW fires — unrelated to where the account lives,
        // but the region is a valid locale and the language whoever is creating it reads.
        locale: region,
      });
    },

    async mintCode(account, region) {
      const sessionId = crypto.randomUUID();

      // The one refusal readable from the account, and a refusal may arm the per-login cooldown
      // (docs/protocol.md) — so it's decided off the wire. Core owns the question and the error,
      // so a local refusal is indistinguishable from GameForge's.
      const refusal = codeRefusal(account, region);
      if (refusal) throw refusal;
      // Not ours to refuse — GF sometimes still mints for a pre-deleted account — but the
      // redacted trail should say why if it doesn't.
      if (account.retired) {
        log.warning("'{name}' is deleted or pending deletion — GameForge won't allow a code", {
          name: account.displayName,
        });
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
    locale: GF_LOCALE,
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
    locale: GF_LOCALE,
  });

  log.debug("sessions: authenticating the new account");
  const token = await createSession({
    ...credentials,
    installationId: device.installationId,
    blackbox: blackbox.next(),
    locale: GF_LOCALE,
  });
  return session(token, device, blackbox, policy);
}

/** Resume from a cached token, skipping `sessions` — fewer re-auths is lower risk scoring. */
export function resumeGfSession(token: string, device: Device, policy: GfSessionPolicy): GfSession {
  const blackbox = createBlackboxSequence({ profile: device.profile, identity: device.identity });
  return session(token, device, blackbox, policy);
}
