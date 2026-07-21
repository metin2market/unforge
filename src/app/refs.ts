// Refs — turning what a user types into a stored account.
//
// Every command takes a ref rather than an id: a GameForge account by handle, email, or id
// prefix; a game account by display name or id prefix. Game accounts are globally
// unique, so neither needs a "current account" to disambiguate against. Ambiguity is always
// rejected rather than guessed at. See docs/cli.md.

// Every function here is pure over a plain account list — no store, no I/O — so a frontend
// can resolve what the user typed without reaching for persistence.

import type { GameAccount } from "../core/index.ts";
import type { GfAccount, StoredGameAccount } from "../storage/index.ts";

/**
 * How the user invoked us, for command hints in error text: `bun dev` when running from
 * source (argv[1] is a .ts/.js entry), else `unforge` (the installed/compiled binary).
 */
export function binName(): string {
  return /\.[cm]?[jt]sx?$/.test(process.argv[1] ?? "") ? "bun dev" : "unforge";
}

/**
 * Derive a short handle from an email: the local part, then — for a `+tag` address
 * (Gmail-style) — the tag after the `+`. So `player1+alt2@example.com` → `alt2`,
 * and a bare `player1@example.com` → `player1`.
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
export function validateAlias(accounts: GfAccount[], selfId: string, alias: string): string {
  const value = alias.trim();
  if (!value) throw new Error("alias cannot be empty");
  if (/\s/.test(value)) throw new Error("alias cannot contain whitespace");
  if (/^\d+$/.test(value)) throw new Error("alias cannot be purely numeric");
  const lc = value.toLowerCase();
  const clash = accounts.find(
    (a) =>
      a.id !== selfId &&
      (a.email.toLowerCase() === lc ||
        gfHandle(a).toLowerCase() === lc ||
        gfAlias(a.email).toLowerCase() === lc),
  );
  if (clash) throw new Error(`alias "${value}" already refers to ${clash.email}`);
  return value;
}

/**
 * Resolve a GameForge-account ref — an exact email or handle (its stored alias or the one
 * derived from the email; both case-insensitive), a full id, or an unambiguous id prefix.
 * Throws on no match or an ambiguous one.
 */
export function resolveGfAccount(accounts: GfAccount[], ref: string): GfAccount {
  const lc = ref.toLowerCase();
  const matches = accounts.filter(
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
  return matches[0];
}

/** A game account and the id of the GameForge login that owns it. */
export interface ResolvedGameAccount {
  gfId: string;
  gameAccount: StoredGameAccount;
}

/**
 * Resolve a game-account ref — its displayName (case-insensitive) or its account id (full or
 * an unambiguous prefix) — across every GameForge login. Game
 * accounts are globally unique, so no GF context is needed. Throws on no/ambiguous match.
 */
export function resolveGameAccount(accounts: GfAccount[], ref: string): ResolvedGameAccount {
  const lc = ref.toLowerCase();
  const hits: ResolvedGameAccount[] = [];
  for (const account of accounts) {
    for (const gameAccount of account.gameAccounts) {
      if (
        gameAccount.displayName.toLowerCase() === lc ||
        gameAccount.accountId === ref ||
        gameAccount.accountId.startsWith(ref)
      ) {
        hits.push({ gfId: account.id, gameAccount });
      }
    }
  }
  if (hits.length === 0) throw new Error(`no game account matches "${ref}"`);
  if (hits.length > 1) {
    throw new Error(`"${ref}" matches ${hits.length} game accounts — be more specific`);
  }
  return hits[0];
}

/** The one-and-only GameForge login, for commands that can't take a game-account ref. */
export function soleGfAccount(accounts: GfAccount[]): GfAccount {
  if (accounts.length === 0) {
    throw new Error(`no GameForge account — run \`${binName()} auth login\` first`);
  }
  if (accounts.length > 1) throw new Error("multiple GameForge accounts — pass --gf <email>");
  return accounts[0];
}

/** Map a core `GameAccount` onto the stored shape. */
export function toStoredGameAccount(account: GameAccount): StoredGameAccount {
  return {
    accountId: account.id,
    displayName: account.displayName,
    accountGroup: account.accountGroup,
  };
}
