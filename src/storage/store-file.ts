// The on-disk half of the store: the entire account set as one JSON blob, DPAPI-sealed
// as a whole (see seal.ts). Everything is encrypted at rest — email, installId,
// secrets — not just secret columns. Affordable because the dataset is tiny (tens of
// accounts), so we decrypt-all on load and encrypt-all on save. Design: docs/accounts.md.

import { closeSync, openSync, statSync, unlinkSync } from "node:fs";
import type { DeviceIdentity, DeviceProfile } from "../core/index.ts";
import { atomicWrite } from "./atomic-write.ts";
import { unforgeDataFile } from "./paths.ts";
import { sealSecret, unsealSecret } from "./seal.ts";

/** A game account under a GF login — no secrets. */
export interface StoredGameAccount {
  accountId: string;
  username: string;
  /** Friendly name from `/user/accounts` (`displayName`); the everyday ref for launch. */
  displayName?: string;
  region: string;
  server?: string;
  character?: string;
}

/** A cached bearer token from the `sessions` call. */
export interface Session {
  token: string;
  /** Epoch ms; past this, re-auth from the password. */
  expiresAt: number;
}

/** One GF account as it lives on disk (inside the sealed blob, so secrets are plaintext here). */
export interface StoredGfAccount {
  id: string;
  email: string;
  /** Short human handle for refs/pickers. Absent → a handle is derived from the email. */
  alias?: string;
  password: string;
  installationId: string;
  deviceIdentity: DeviceIdentity;
  /** The device fingerprint (canvas/audio/WebGL/screen), persisted so each account keeps a
   * stable, *distinct* fingerprint (no cross-account churn). Always present — minted per account. */
  deviceProfile: DeviceProfile;
  session?: Session;
  gameAccounts: StoredGameAccount[];
  /** Epoch-ms metadata for debugging which account was added/ran when. */
  createdAt: number;
  lastUsedAt?: number;
}

/** The whole persisted set. `version` lets us evolve the shape in code (no migrations). */
export interface StoreState {
  version: number;
  accounts: StoredGfAccount[];
}

export const STORE_VERSION = 1;

const LOCK_STALE_MS = 15_000;
const LOCK_TIMEOUT_MS = 10_000;

/** `%LOCALAPPDATA%\unforge\accounts.dat` — the default sealed store. */
export function defaultStorePath(): string {
  return unforgeDataFile("accounts.dat");
}

/** Read + unseal + parse the store, or an empty state if the file doesn't exist yet. */
export async function loadState(path: string): Promise<StoreState> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { version: STORE_VERSION, accounts: [] };
  const json = await unsealSecret(await file.bytes());
  const state = JSON.parse(json) as StoreState;
  // Room to upgrade older shapes here as STORE_VERSION grows.
  return state;
}

/** Serialize + seal + write the whole store atomically. */
export async function saveState(path: string, state: StoreState): Promise<void> {
  await atomicWrite(path, await sealSecret(JSON.stringify(state)));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` holding an exclusive lock file next to the store, so concurrent writers on
 * a multibox host serialise instead of clobbering. Steals a stale lock (a crashed
 * holder) after {@link LOCK_STALE_MS}; gives up after {@link LOCK_TIMEOUT_MS}.
 */
export async function withStoreLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  const start = Date.now();
  for (;;) {
    try {
      closeSync(openSync(lockPath, "wx")); // exclusive create — fails if held
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        // lock vanished between calls — retry the acquire
      }
      if (Date.now() - start > LOCK_TIMEOUT_MS) throw new Error(`store lock busy: ${lockPath}`);
      await sleep(30 + Math.random() * 40);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // already gone
    }
  }
}
