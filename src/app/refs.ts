// Refs — turning what a user types into a stored account.
//
// Every command takes a ref rather than an id: a GameForge account by handle, email, or id
// prefix; a game account by username, display name, or id prefix. Game accounts are globally
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
  game: StoredGameAccount;
}

/**
 * Resolve a game-account ref — its username or displayName (case-insensitive), or its
 * account id (full or an unambiguous prefix) — across every GameForge login. Game
 * accounts are globally unique, so no GF context is needed. Throws on no/ambiguous match.
 */
export function resolveGameAccount(accounts: GfAccount[], ref: string): ResolvedGameAccount {
  const lc = ref.toLowerCase();
  const hits: ResolvedGameAccount[] = [];
  for (const account of accounts) {
    for (const game of account.gameAccounts) {
      if (
        game.username.toLowerCase() === lc ||
        game.displayName?.toLowerCase() === lc ||
        game.accountId === ref ||
        game.accountId.startsWith(ref)
      ) {
        hits.push({ gfId: account.id, game });
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

/**
 * The account groups whose code is a **country**, not a language — GameForge's client locales
 * use the language, so these two namespaces disagree and the group can't be used as-is.
 *
 * Established by probing the patching endpoint, which answers for every locale but returns an
 * empty file list for one that isn't real: `?locale=dk` → `{"entries":[]}`, `?locale=da` → the
 * full client. Same for `cz` vs `cs`. The other eleven Metin2 groups
 * (`es ro pl en it fr pt hu tr nl de`) map to themselves, each verified the same way.
 *
 * (`gr` → `el` behaves identically but is not among the groups GameForge lists for Metin2, so
 * it is deliberately absent — this table records what was observed, not what was extrapolated.)
 */
const CLIENT_LOCALE: Record<string, string> = { dk: "da", cz: "cs" };

/**
 * An account's region, given the client regions installed on this machine.
 *
 * GameForge reports only an `accountGroup` ("pt", "en", "dk"); a region is the full tag
 * ("pt-PT", "en-GB") — the client's folder name *and* the `gameId` suffix. The country half
 * can't be synthesised from the group: GameForge ships "en" as **en-GB**, so doubling the subtag
 * invents "en-EN", which exists nowhere. So the group is translated to its client locale and
 * matched against the first subtag of each installed region.
 *
 * An unmatched group returns undefined and the caller falls back — safe, but a fallback, so a
 * wrong region can still reach `thin/codes` and be refused. {@link regionMismatch} reports that.
 */
export function regionForAccountGroup(
  accountGroup: string | undefined,
  installed: string[],
): string | undefined {
  if (!accountGroup) return undefined;
  const group = accountGroup.toLowerCase();
  const locale = CLIENT_LOCALE[group] ?? group;
  return installed.find((r) => r.split("-")[0].toLowerCase() === locale);
}

export interface StampRegion {
  /** A region the caller asked for outright (`--region`) — a decision, so it wins. */
  explicit?: string;
  /** Client regions installed on this machine, e.g. `["pt-PT", "en-GB"]`. */
  installed: string[];
  /** Where to land when nothing else says: the app's default region. */
  fallback: string;
  /** The login as we last stored it, for the per-account region/server/character we knew. */
  prior?: GfAccount;
}

/**
 * Map a core `GameAccount` (from `/user/accounts`) onto the stored shape.
 *
 * The region is the account's own property, and it decides two things at once: which localized
 * client gets launched, and the `<gameId>.<region>` that `thin/codes` is asked for. Getting it
 * wrong fails the mint with a 403 that blames nothing, so each account is stamped with the
 * region GameForge filed *it* under — stamping one login-wide default across every account is
 * precisely how a multi-region login becomes unlaunchable.
 *
 * GameForge's answer also outranks what we already stored, which is the unusual call here: a
 * stored region that contradicts it is a guess *we* made on an earlier login, and leaving it
 * sticky means the account stays unlaunchable no matter how many times the user logs in again.
 * Only an explicit region beats it — that one came from a person.
 */
export function toStoredGameAccount(
  account: GameAccount,
  { explicit, installed, fallback, prior }: StampRegion,
): StoredGameAccount {
  const previous = prior?.gameAccounts.find((g) => g.accountId === account.id);
  const fromGf = regionForAccountGroup(account.accountGroup, installed);
  return {
    accountId: account.id,
    username: account.usernames[0] ?? account.displayName,
    displayName: account.displayName,
    region: explicit ?? fromGf ?? previous?.region ?? fallback,
    server: previous?.server ?? account.server,
    character: previous?.character,
  };
}
