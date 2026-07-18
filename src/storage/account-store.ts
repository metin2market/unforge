// The AccountStore over a sealed JSON file. This is the state layer above `core`:
// it keeps the whole account set in memory (loaded once), serves reads from it, and on
// every write reloads-under-lock → mutates → seals → atomic-writes, so concurrent
// writers on a multibox host can't clobber each other. `core` never imports this; a
// stateful application layer (CLI, UI) composes the two. Design: docs/accounts.md.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { generateDeviceProfile, type DeviceIdentity, type DeviceProfile } from "../core/index.ts";
import {
  defaultStorePath,
  loadState,
  saveState,
  STORE_VERSION,
  withStoreLock,
  type Session,
  type StoredGameAccount,
  type StoredGfAccount,
  type StoreState,
} from "./store-file.ts";

export type { Session, StoredGameAccount } from "./store-file.ts";

/** A GF account without its secrets — safe to list. */
export interface GfAccountSummary {
  id: string;
  email: string;
  /** Stored short handle, if one was set (else callers derive one from the email). */
  alias?: string;
  installationId: string;
  gameAccounts: StoredGameAccount[];
  createdAt: number;
  lastUsedAt?: number;
  /** When the cached token expires, if any — lets a UI show session validity. */
  tokenExpiresAt?: number;
}

/** A GF account with its secrets — what a login actually needs. */
export interface GfAccount extends GfAccountSummary {
  password: string;
  deviceIdentity: DeviceIdentity;
  deviceProfile: DeviceProfile;
  session?: Session;
}

/** New/updated account to persist. `id` is generated when absent. */
export interface GfAccountInput {
  id?: string;
  email: string;
  /** Short handle; keeps the existing one on update when omitted. */
  alias?: string;
  password: string;
  installationId: string;
  deviceIdentity: DeviceIdentity;
  /** Omit to mint a fresh **distinct** one (never a shared default). Callers persisting a real
   * account should pass the account's own profile so its fingerprint stays stable. */
  deviceProfile?: DeviceProfile;
  session?: Session;
  gameAccounts?: StoredGameAccount[];
}

export interface AccountStore {
  /** Every GF account, without secrets. */
  list(): GfAccountSummary[];
  /** One GF account including its secrets, or undefined. */
  get(id: string): GfAccount | undefined;
  /** Insert or replace an account (and its game accounts). Returns its id. */
  put(account: GfAccountInput): Promise<string>;
  /** Delete an account and its game accounts. */
  remove(id: string): Promise<void>;
  /** Set (or, with `undefined`, clear) an account's short handle. */
  setAlias(id: string, alias?: string): Promise<void>;
  /** Write a fresh token + drifted identity together (the post-auth write-back). */
  recordAuth(
    id: string,
    result: { session: Session; deviceIdentity: DeviceIdentity },
  ): Promise<void>;
  /** Stamp last-used, for debugging which account ran when. */
  touch(id: string, now?: number): Promise<void>;
}

function toSummary(a: StoredGfAccount): GfAccountSummary {
  return {
    id: a.id,
    email: a.email,
    alias: a.alias,
    installationId: a.installationId,
    gameAccounts: a.gameAccounts,
    createdAt: a.createdAt,
    lastUsedAt: a.lastUsedAt,
    tokenExpiresAt: a.session?.expiresAt,
  };
}

function toAccount(a: StoredGfAccount): GfAccount {
  return {
    ...toSummary(a),
    password: a.password,
    deviceIdentity: a.deviceIdentity,
    deviceProfile: a.deviceProfile,
    session: a.session,
  };
}

class FileAccountStore implements AccountStore {
  constructor(
    private readonly path: string,
    private state: StoreState,
  ) {}

  list(): GfAccountSummary[] {
    return this.state.accounts.map(toSummary);
  }

  get(id: string): GfAccount | undefined {
    const a = this.state.accounts.find((x) => x.id === id);
    return a ? toAccount(a) : undefined;
  }

  /** Reload the latest state under the lock, apply `fn`, then persist and refresh the cache. */
  private async mutate(fn: (state: StoreState) => void): Promise<void> {
    this.state = await withStoreLock(this.path, async () => {
      const fresh = await loadState(this.path);
      fn(fresh);
      await saveState(this.path, fresh);
      return fresh;
    });
  }

  async put(account: GfAccountInput): Promise<string> {
    const id = account.id ?? crypto.randomUUID();
    await this.mutate((state) => {
      const existing = state.accounts.find((a) => a.id === id);
      const stored: StoredGfAccount = {
        id,
        email: account.email,
        // Keep the existing handle on update; set it only when the caller supplies one.
        alias: account.alias ?? existing?.alias,
        password: account.password,
        installationId: account.installationId,
        deviceIdentity: account.deviceIdentity,
        // Keep the existing profile on update; mint a distinct one only for a brand-new account
        // that arrived without one — never fall back to a shared constant.
        deviceProfile: account.deviceProfile ?? existing?.deviceProfile ?? generateDeviceProfile(),
        session: account.session,
        gameAccounts: account.gameAccounts ?? [],
        createdAt: existing?.createdAt ?? Date.now(),
        lastUsedAt: existing?.lastUsedAt,
      };
      const i = state.accounts.findIndex((a) => a.id === id);
      if (i === -1) state.accounts.push(stored);
      else state.accounts[i] = stored;
    });
    return id;
  }

  async remove(id: string): Promise<void> {
    await this.mutate((state) => {
      state.accounts = state.accounts.filter((a) => a.id !== id);
    });
  }

  async setAlias(id: string, alias?: string): Promise<void> {
    await this.mutate((state) => {
      const a = state.accounts.find((x) => x.id === id);
      if (a) a.alias = alias;
    });
  }

  async recordAuth(
    id: string,
    result: { session: Session; deviceIdentity: DeviceIdentity },
  ): Promise<void> {
    await this.mutate((state) => {
      const a = state.accounts.find((x) => x.id === id);
      if (!a) return;
      a.session = result.session;
      a.deviceIdentity = result.deviceIdentity;
      a.lastUsedAt = Date.now();
    });
  }

  async touch(id: string, now: number = Date.now()): Promise<void> {
    await this.mutate((state) => {
      const a = state.accounts.find((x) => x.id === id);
      if (a) a.lastUsedAt = now;
    });
  }
}

/** Open the store at `path` (defaults to the per-user location), loading it into memory. */
export async function openAccountStore(path: string = defaultStorePath()): Promise<AccountStore> {
  // First run: the store's folder (e.g. %LOCALAPPDATA%\unforge) may not exist yet.
  // Create it now so the first write's lock file has somewhere to land.
  mkdirSync(dirname(path), { recursive: true });
  const state = await loadState(path);
  if (state.version !== STORE_VERSION) {
    throw new Error(
      `unforge store version ${state.version} is newer than supported ${STORE_VERSION}`,
    );
  }
  return new FileAccountStore(path, state);
}
