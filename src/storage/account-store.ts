// The AccountStore over a sealed JSON file. This is the state layer above `core`:
// it keeps the whole account set in memory (loaded once), serves reads from it, and on
// every write reloads-under-lock → mutates → seals → atomic-writes, so concurrent
// writers on a multibox host can't clobber each other. `core` never imports this; the
// application layer composes the two. Design: docs/accounts.md.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createDevice, type Device } from "./device.ts";
import {
  defaultStorePath,
  loadState,
  saveState,
  withStoreLock,
  type CachedToken,
  type StoredGameAccount,
  type StoredGfAccount,
  type StoreState,
} from "./store-file.ts";

export type { CachedToken, StoredGameAccount } from "./store-file.ts";

/**
 * A GF account as read out. `list()` omits `secrets`; `get()` includes them — so dropping
 * the key is all it takes to make a value safe to hand to a UI or log.
 */
export interface GfAccount {
  id: string;
  email: string;
  /** Stored short handle, if one was set (else callers derive one from the email). */
  alias?: string;
  gameAccounts: StoredGameAccount[];
  createdAt: number;
  lastUsedAt?: number;
  /** When the cached token expires, if any — lets a UI show session validity. */
  tokenExpiresAt?: number;
  secrets?: {
    password: string;
    device: Device;
    token?: CachedToken;
  };
}

/** What `get()` returns: the same account with its secrets guaranteed present. */
export type GfAccountWithSecrets = GfAccount & { secrets: NonNullable<GfAccount["secrets"]> };

/** A brand-new account to persist. The device is minted here if the caller has none. */
export interface NewGfAccount {
  email: string;
  alias?: string;
  password: string;
  device?: Device;
  token?: CachedToken;
  gameAccounts?: StoredGameAccount[];
}

/**
 * Fields a caller may change. One patch type instead of a family of single-purpose
 * mutators: the read-modify-write under the lock is the store's job either way, and this
 * says exactly what is mutable. An absent key is left alone; `alias: null` clears it.
 */
export interface AccountPatch {
  alias?: string | null;
  password?: string;
  /** Write the drifted device back after a run, so its vector stays current. */
  device?: Device;
  token?: CachedToken;
  gameAccounts?: StoredGameAccount[];
  lastUsedAt?: number;
}

export interface AccountStore {
  /** Every GF account, without secrets. */
  list(): GfAccount[];
  /** One GF account including its secrets, or undefined. */
  get(id: string): GfAccountWithSecrets | undefined;
  add(account: NewGfAccount): Promise<GfAccountWithSecrets>;
  /** Merge a patch into one account under the write lock. Unknown id is a no-op. */
  save(id: string, patch: AccountPatch): Promise<void>;
  remove(id: string): Promise<void>;
  /** Fires after any write — how a long-lived host pushes store changes to its clients. */
  onChange(fn: (accounts: GfAccount[]) => void): () => void;
}

function toSummary(a: StoredGfAccount): GfAccount {
  return {
    id: a.id,
    email: a.email,
    alias: a.alias,
    gameAccounts: a.gameAccounts,
    createdAt: a.createdAt,
    lastUsedAt: a.lastUsedAt,
    tokenExpiresAt: a.secrets.token?.expiresAt,
  };
}

function toFull(a: StoredGfAccount): GfAccountWithSecrets {
  return { ...toSummary(a), secrets: a.secrets };
}

class FileAccountStore implements AccountStore {
  private readonly listeners = new Set<(accounts: GfAccount[]) => void>();

  constructor(
    private readonly path: string,
    private state: StoreState,
  ) {}

  list(): GfAccount[] {
    return this.state.accounts.map(toSummary);
  }

  get(id: string): GfAccountWithSecrets | undefined {
    const a = this.state.accounts.find((x) => x.id === id);
    return a ? toFull(a) : undefined;
  }

  onChange(fn: (accounts: GfAccount[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Reload the latest state under the lock, apply `fn`, persist, refresh the cache, notify. */
  private async mutate(fn: (state: StoreState) => void): Promise<void> {
    this.state = await withStoreLock(this.path, async () => {
      const fresh = await loadState(this.path);
      fn(fresh);
      await saveState(this.path, fresh);
      return fresh;
    });
    const snapshot = this.list();
    for (const listener of this.listeners) listener(snapshot);
  }

  async add(account: NewGfAccount): Promise<GfAccountWithSecrets> {
    const stored: StoredGfAccount = {
      id: crypto.randomUUID(),
      email: account.email,
      alias: account.alias,
      gameAccounts: account.gameAccounts ?? [],
      createdAt: Date.now(),
      secrets: {
        password: account.password,
        // Never a shared default — a fingerprint common to two accounts correlates them.
        device: account.device ?? createDevice(),
        token: account.token,
      },
    };
    await this.mutate((state) => {
      state.accounts.push(stored);
    });
    return toFull(stored);
  }

  async save(id: string, patch: AccountPatch): Promise<void> {
    await this.mutate((state) => {
      const a = state.accounts.find((x) => x.id === id);
      if (!a) return;
      if (patch.alias !== undefined) a.alias = patch.alias ?? undefined;
      if (patch.gameAccounts !== undefined) a.gameAccounts = patch.gameAccounts;
      if (patch.lastUsedAt !== undefined) a.lastUsedAt = patch.lastUsedAt;
      if (patch.password !== undefined) a.secrets.password = patch.password;
      if (patch.device !== undefined) a.secrets.device = patch.device;
      if (patch.token !== undefined) a.secrets.token = patch.token;
    });
  }

  async remove(id: string): Promise<void> {
    await this.mutate((state) => {
      state.accounts = state.accounts.filter((a) => a.id !== id);
    });
  }
}

/** Open the store at `path` (defaults to the per-user location), loading it into memory. */
export async function openAccountStore(path: string = defaultStorePath()): Promise<AccountStore> {
  // First run: the store's folder (e.g. %LOCALAPPDATA%\unforge) may not exist yet.
  // Create it now so the first write's lock file has somewhere to land.
  mkdirSync(dirname(path), { recursive: true });
  return new FileAccountStore(path, await loadState(path));
}
