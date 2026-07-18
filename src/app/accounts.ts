// GameForge-account operations for the CLI's `auth` namespace and the web UI: log in
// (authenticate + mint a device + discover game accounts), list, forget, and inspect
// or roll the device. Composes `core` (the auth flow) with `store` (persistence).

import {
  createBlackboxSequence,
  createDeviceIdentity,
  createSession,
  createUser,
  generateDeviceProfile,
  generateInstallationId,
  listGameAccounts,
  logout,
  type BlackboxSequence,
  type DeviceProfile,
} from "../core/index.ts";
import type { AccountStore, GfAccountSummary, StoredGameAccount } from "../storage/index.ts";
import { getLogger } from "@logtape/logtape";
import {
  DEFAULT_REGION,
  gfHandle,
  resolveGfAccount,
  SESSION_TTL_MS,
  toStoredGameAccount,
  validateAlias,
} from "./shared.ts";

const log = getLogger(["unforge", "auth"]);

export interface RegisterAccountOptions {
  store: AccountStore;
  email: string;
  password: string;
  /** Optional short handle to store for this account (else one is derived from the email). */
  alias?: string;
  /** Region stamped onto newly-discovered game accounts. Default {@link DEFAULT_REGION}. */
  region?: string;
  locale?: string;
}

export interface RegisterAccountResult {
  id: string;
  email: string;
  /** True when this email wasn't already stored (a fresh device was minted). */
  isNew: boolean;
  gameAccounts: StoredGameAccount[];
}

/** The device a GameForge account presents on the wire: installation id + fingerprint. */
interface Device {
  installationId: string;
  deviceProfile: DeviceProfile;
}

/**
 * The shared tail of `auth login` and `auth register`: authenticate over `blackbox` (`sessions`),
 * discover its game accounts (`user/accounts`), and persist. The caller passes a
 * {@link BlackboxSequence} so its freshness rule holds whether or not a privileged call (e.g.
 * `createUser`) already ran in this flow — the sequence advances the vector itself.
 */
async function authenticateAndStore(
  opts: RegisterAccountOptions,
  device: Device,
  blackbox: BlackboxSequence,
): Promise<RegisterAccountResult> {
  const { store, email, password } = opts;
  const existing = store.list().find((a) => a.email.toLowerCase() === email.toLowerCase());
  const prior = existing ? store.get(existing.id) : undefined;

  log.debug("sessions: authenticating {email} ({device} device)", {
    email,
    device: prior ? "existing" : "new",
  });
  const token = await createSession({
    email,
    password,
    installationId: device.installationId,
    blackbox: blackbox.next(),
    locale: opts.locale,
  });

  const region = opts.region ?? prior?.gameAccounts[0]?.region ?? DEFAULT_REGION;
  log.debug("user/accounts: listing game accounts");
  const discovered = await listGameAccounts(token, device.installationId);
  log.info("found {count} game account(s)", { count: discovered.length });
  const gameAccounts = discovered.map((a) => toStoredGameAccount(a, region, prior));

  const id = await store.put({
    id: existing?.id,
    email,
    alias: opts.alias,
    password,
    installationId: device.installationId,
    deviceIdentity: blackbox.identity,
    deviceProfile: device.deviceProfile,
    session: { token, expiresAt: Date.now() + SESSION_TTL_MS },
    gameAccounts,
  });

  return { id, email, isNew: !existing, gameAccounts };
}

/**
 * `auth login` — authenticate a GameForge account and persist it. Mints a stable,
 * distinct device (installation id + identity + fingerprint profile) the first time an
 * email is seen and reuses it forever after, so the account's fingerprint never churns.
 * Actually calls `sessions` (proving the credentials) and `user/accounts` (populating
 * the game-account list) rather than recording the account blind.
 */
export async function registerAccount(
  opts: RegisterAccountOptions,
): Promise<RegisterAccountResult> {
  const existing = opts.store
    .list()
    .find((a) => a.email.toLowerCase() === opts.email.toLowerCase());
  const prior = existing ? opts.store.get(existing.id) : undefined;

  const device: Device = {
    installationId: prior?.installationId ?? generateInstallationId(),
    deviceProfile: prior?.deviceProfile ?? generateDeviceProfile(),
  };
  // Seed from the stored identity (undefined → the sequence mints a fresh one) so an existing
  // account keeps its stable, drifting fingerprint.
  const blackbox = createBlackboxSequence({
    profile: device.deviceProfile,
    identity: prior?.deviceIdentity,
  });
  return authenticateAndStore(opts, device, blackbox);
}

/**
 * `auth register` — create a NEW GameForge account (`POST /users`, solving the PoW captcha
 * in-flow; ~8s of CPU), then authenticate + record it exactly as `auth login` does. The
 * device that registers is the **same** one that logs in and is persisted — registration
 * and its immediate login must not churn the fingerprint. Login works right after
 * registration with no email verification ([status.md](../../docs/status.md)).
 */
export async function createGfAccount(
  opts: RegisterAccountOptions,
): Promise<RegisterAccountResult> {
  const { email, password } = opts;
  if (opts.store.list().some((a) => a.email.toLowerCase() === email.toLowerCase())) {
    throw new Error(`already have a GameForge account for ${email} — use \`auth login\``);
  }

  const device: Device = {
    installationId: generateInstallationId(),
    deviceProfile: generateDeviceProfile(),
  };

  // One sequence spans registration + the login that follows: the `createUser` blackbox is its
  // first call, and every `authenticateAndStore` call after it advances the vector automatically.
  const blackbox = createBlackboxSequence({ profile: device.deviceProfile });
  log.debug("users: registering {email} headless", { email });
  await createUser({
    email,
    password,
    installationId: device.installationId,
    blackbox: blackbox.next(),
    locale: opts.locale,
  });

  return authenticateAndStore(opts, device, blackbox);
}

/** `auth list` — every GameForge account with its session validity (no secrets). */
export function listGfAccounts(store: AccountStore): GfAccountSummary[] {
  return store.list();
}

/**
 * `auth alias <gf> [alias]` — set (or, with `undefined`, clear back to the derived handle)
 * a GameForge account's short handle. Validates uniqueness so a handle never resolves to
 * two accounts. Returns the account's email and its effective handle after the change.
 */
export async function setGfAlias(
  store: AccountStore,
  ref: string,
  alias?: string,
): Promise<{ email: string; handle: string }> {
  const summary = resolveGfAccount(store, ref);
  const value = alias === undefined ? undefined : validateAlias(store, summary.id, alias);
  await store.setAlias(summary.id, value);
  return { email: summary.email, handle: gfHandle({ email: summary.email, alias: value }) };
}

export interface DeviceInfo {
  email: string;
  installationId: string;
  clientId: string;
  vectorUpdatedAt: number;
  deviceProfile: DeviceProfile;
}

/** `auth device show <gf>` — the device a GameForge account presents. */
export function deviceInfo(store: AccountStore, ref: string): DeviceInfo {
  const summary = resolveGfAccount(store, ref);
  const acc = store.get(summary.id)!;
  return {
    email: acc.email,
    installationId: acc.installationId,
    clientId: acc.deviceIdentity.clientId,
    vectorUpdatedAt: acc.deviceIdentity.vectorUpdatedAt,
    deviceProfile: acc.deviceProfile,
  };
}

/**
 * `auth device regen <gf>` — roll a brand-new device (installation id + identity +
 * fingerprint profile) for a GameForge account. The whole device turns over at once, so
 * the old fingerprint is fully retired. Keeps the cached session (the bearer token is
 * account-level, not device-bound).
 */
export async function regenDevice(store: AccountStore, ref: string): Promise<DeviceInfo> {
  const summary = resolveGfAccount(store, ref);
  const acc = store.get(summary.id)!;

  const installationId = generateInstallationId();
  const deviceProfile = generateDeviceProfile();
  const deviceIdentity = createDeviceIdentity();

  await store.put({
    id: acc.id,
    email: acc.email,
    password: acc.password,
    installationId,
    deviceIdentity,
    deviceProfile,
    session: acc.session,
    gameAccounts: acc.gameAccounts,
  });

  return {
    email: acc.email,
    installationId,
    clientId: deviceIdentity.clientId,
    vectorUpdatedAt: deviceIdentity.vectorUpdatedAt,
    deviceProfile,
  };
}

/**
 * `auth logout <gf>` — forget a GameForge account (like `gh auth logout`): best-effort
 * server-side session invalidation, then drop it from the store. Returns the email.
 */
export async function logoutAccount(store: AccountStore, ref: string): Promise<{ email: string }> {
  const summary = resolveGfAccount(store, ref);
  const acc = store.get(summary.id)!;
  if (acc.session && acc.session.expiresAt > Date.now()) {
    try {
      await logout(acc.session.token, acc.installationId);
    } catch {
      // Best-effort: a dead/expired token still lets us forget the account locally.
    }
  }
  await store.remove(acc.id);
  return { email: acc.email };
}
