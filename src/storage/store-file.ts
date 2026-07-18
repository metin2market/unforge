// The on-disk half of the store: the entire account set as one JSON blob, DPAPI-sealed
// as a whole (see seal.ts). Everything is encrypted at rest — email, installId,
// secrets — not just secret columns. Affordable because the dataset is tiny (tens of
// accounts), so we decrypt-all on load and encrypt-all on save. Design: docs/accounts.md.

import { closeSync, openSync, statSync, unlinkSync } from "node:fs";
import { z } from "zod";
import { shapeIssues } from "../core/index.ts";
import { errnoCode, parseJson } from "../util/index.ts";
import { atomicWrite } from "./atomic-write.ts";
import { Device } from "./device.ts";
import { unforgeDataFile } from "./paths.ts";
import { sealSecret, unsealSecret } from "./seal.ts";

/** A game account under a GF login — no secrets. */
export const StoredGameAccount = z.object({
  accountId: z.string(),
  username: z.string(),
  /** Friendly name from `/user/accounts` (`displayName`); the everyday ref for launch. */
  displayName: z.string().optional(),
  region: z.string(),
  server: z.string().optional(),
  character: z.string().optional(),
});
export type StoredGameAccount = z.infer<typeof StoredGameAccount>;

/** A cached bearer token from the `sessions` call. */
export const CachedToken = z.object({
  token: z.string(),
  /** Epoch ms; past this, re-auth from the password. */
  expiresAt: z.number(),
});
export type CachedToken = z.infer<typeof CachedToken>;

/**
 * One GF account as it lives on disk (inside the sealed blob, so secrets are plaintext here).
 * Secrets sit under one key so a caller can drop it and be *structurally* sure nothing leaked —
 * a "summary" supertype can't promise that, since the secret-bearing type is assignable to it.
 */
export const StoredGfAccount = z.object({
  id: z.string(),
  email: z.string(),
  /** Short human handle for refs/pickers. Absent → a handle is derived from the email. */
  alias: z.string().optional(),
  gameAccounts: z.array(StoredGameAccount),
  /** Epoch-ms metadata for debugging which account was added/ran when. */
  createdAt: z.number(),
  lastUsedAt: z.number().optional(),
  secrets: z.object({
    password: z.string(),
    device: Device,
    token: CachedToken.optional(),
  }),
});
export type StoredGfAccount = z.infer<typeof StoredGfAccount>;

/**
 * The whole persisted set. No schema version: unforge isn't released, so a shape change means
 * deleting the store and logging in again rather than carrying migration code forever — which
 * only works if a stale shape is *detected*, hence the schema.
 */
export const StoreState = z.object({
  accounts: z.array(StoredGfAccount),
});
export type StoreState = z.infer<typeof StoreState>;

const LOCK_STALE_MS = 15_000;
const LOCK_TIMEOUT_MS = 10_000;

/** `%LOCALAPPDATA%\unforge\accounts.dat` — the default sealed store. */
export function defaultStorePath(): string {
  return unforgeDataFile("accounts.dat");
}

/** Read + unseal + parse the store, or an empty state if the file doesn't exist yet. */
export async function loadState(path: string): Promise<StoreState> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { accounts: [] };
  // A store that isn't the shape we wrote is corrupt, not empty — say so, naming the field,
  // rather than silently starting fresh over someone's accounts or letting a stale shape
  // through to fail deep in a getter (or worse, encode `undefined` into a blackbox).
  const parsed = StoreState.safeParse(parseJson(await unsealSecret(await file.bytes())));
  if (!parsed.success) {
    throw new Error(
      `unforge store at ${path} isn't in the current format (${shapeIssues(parsed.error).join("; ")}) — ` +
        "delete it and run `unforge auth login` again",
    );
  }
  return parsed.data;
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
      if (errnoCode(err) !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        // lock vanished between calls — retry the acquire
      }
      if (Date.now() - start > LOCK_TIMEOUT_MS)
        throw new Error(`store lock busy: ${lockPath}`, { cause: err });
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
