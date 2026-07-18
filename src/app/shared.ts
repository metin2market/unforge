// Shared helpers for the application layer: resolve the user-typed refs the CLI/UI
// pass (a GameForge-account ref, a game-account ref) to concrete store records, and
// map a core `GameAccount` onto the stored shape. Kept tiny and pure so the command
// handlers stay thin.

import type { GameAccount } from "../core/index.ts";
import type {
  AccountStore,
  GfAccount,
  GfAccountSummary,
  StoredGameAccount,
} from "../storage/index.ts";

/** How long we treat a freshly-minted bearer token as good (GF exposes no real expiry). */
export const SESSION_TTL_MS = 55 * 60 * 1000;

/**
 * How the user invoked us, for command hints in error text: `bun dev` when running from
 * source (argv[1] is a .ts/.js entry), else `unforge` (the installed/compiled binary).
 */
export function binName(): string {
  return /\.[cm]?[jt]sx?$/.test(process.argv[1] ?? "") ? "bun dev" : "unforge";
}

/** Region stamped onto discovered game accounts when none is known yet. */
export const DEFAULT_REGION = "pt-PT";

/**
 * Derive a short handle from an email: the local part, then — for a `+tag` address
 * (Gmail-style) — the tag after the `+`. So `crbgames1+unclear2@gmail.com` → `unclear2`,
 * and a bare `crbgames1@gmail.com` → `crbgames1`.
 */
export function gfAlias(email: string): string {
  const local = email.split("@")[0] ?? email;
  const plus = local.indexOf("+");
  return plus === -1 ? local : local.slice(plus + 1);
}

/** The handle to show/accept for a GF account: its stored alias, else the derived one. */
export function gfHandle(a: { email: string; alias?: string }): string {
  return a.alias ?? gfAlias(a.email);
}

/**
 * Validate a proposed alias for `selfId`: non-empty, no whitespace, not purely numeric
 * (so it can't collide with a picker's row numbers), and not already resolving to a
 * *different* account. Throws with a clear reason; returns the trimmed alias.
 */
export function validateAlias(store: AccountStore, selfId: string, alias: string): string {
  const value = alias.trim();
  if (!value) throw new Error("alias cannot be empty");
  if (/\s/.test(value)) throw new Error("alias cannot contain whitespace");
  if (/^\d+$/.test(value)) throw new Error("alias cannot be purely numeric");
  const lc = value.toLowerCase();
  const clash = store
    .list()
    .find(
      (a) =>
        a.id !== selfId &&
        (a.email.toLowerCase() === lc ||
          gfHandle(a).toLowerCase() === lc ||
          gfAlias(a.email).toLowerCase() === lc),
    );
  if (clash) throw new Error(`alias "${value}" already refers to ${clash.email}`);
  return value;
}

/** A resolved game account plus the GameForge account (with secrets) that owns it. */
export interface ResolvedGameAccount {
  gf: GfAccount;
  game: StoredGameAccount;
}

/**
 * Resolve a GameForge-account ref — an exact email or handle (its stored alias or the one
 * derived from the email; both case-insensitive), a full id, or an unambiguous id prefix.
 * Throws on no match or an ambiguous one.
 */
export function resolveGfAccount(store: AccountStore, ref: string): GfAccountSummary {
  const lc = ref.toLowerCase();
  const matches = store
    .list()
    .filter(
      (a) =>
        a.email.toLowerCase() === lc ||
        gfHandle(a).toLowerCase() === lc ||
        gfAlias(a.email).toLowerCase() === lc ||
        a.id === ref ||
        a.id.startsWith(ref),
    );
  if (matches.length === 0) throw new Error(`no GameForge account matches "${ref}"`);
  if (matches.length > 1) {
    throw new Error(`"${ref}" matches ${matches.length} GameForge accounts — use the full email`);
  }
  return matches[0]!;
}

/**
 * Resolve a game-account ref — its username or displayName (case-insensitive), or its
 * account id (full or an unambiguous prefix) — across every GameForge login. Game
 * accounts are globally unique, so no GF context is needed. Throws on no/ambiguous match.
 */
export function resolveGameAccount(store: AccountStore, ref: string): ResolvedGameAccount {
  const lc = ref.toLowerCase();
  const hits: { gfId: string; game: StoredGameAccount }[] = [];
  for (const summary of store.list()) {
    for (const game of summary.gameAccounts) {
      if (
        game.username.toLowerCase() === lc ||
        game.displayName?.toLowerCase() === lc ||
        game.accountId === ref ||
        game.accountId.startsWith(ref)
      ) {
        hits.push({ gfId: summary.id, game });
      }
    }
  }
  if (hits.length === 0) throw new Error(`no game account matches "${ref}"`);
  if (hits.length > 1) {
    throw new Error(`"${ref}" matches ${hits.length} game accounts — be more specific`);
  }
  const gf = store.get(hits[0]!.gfId)!;
  return { gf, game: hits[0]!.game };
}

/**
 * Map a core `GameAccount` (from `/user/accounts`) onto the stored shape, preserving any
 * region/server/character we already knew for this account id (the API doesn't return them).
 */
export function toStoredGameAccount(
  account: GameAccount,
  region: string,
  prior?: GfAccount,
): StoredGameAccount {
  const previous = prior?.gameAccounts.find((g) => g.accountId === account.id);
  return {
    accountId: account.id,
    username: account.usernames[0] ?? account.displayName,
    displayName: account.displayName,
    region: previous?.region ?? region,
    server: previous?.server,
    character: previous?.character,
  };
}
