// Shared public types for the GameForge (Spark) auth flow.

/** GameForge account login credentials. */
export interface Credentials {
  email: string;
  password: string;
}

/**
 * A game account bound to a GameForge account (one GF login can hold several).
 * The Metin2 account is the one whose `gameId` is Metin2's.
 */
export interface GameAccount {
  /** `platformGameAccountId` — the id passed to `thin/codes`. A UUID. */
  id: string;
  /** GF's `accountNumericId` — what the client asks for as `queryGameAccountNumericId`. */
  numericId: number;
  displayName: string;
  usernames: string[];
  gameId: string;
  /** Human game name from `guls.game`, e.g. "metin2". */
  gameName: string;
  /**
   * GameForge's **account group** — which localized community and server group this account
   * belongs to. Observed values for Metin2:
   * `es ro pl en it fr dk pt hu cz tr nl de`.
   *
   * Deliberately keeps GameForge's own name, because it is *not* a language: `dk` and `cz` are
   * country codes (Danish is `da`, Czech is `cs`). Calling it a language would be wrong for 3 of
   * the 13, and would license deriving it from a locale tag — which is how `en` becomes `en-EN`.
   * It is also distinct from `gfLang`, a separate field that travels beside it and can be `all`.
   *
   * This is the authority on where the account can play: `thin/codes` sends `gameId.<region>`,
   * and a region that disagrees is refused with the same generic "not allowed to create code" as
   * an outstanding one. Absent on responses that omit it.
   */
  accountGroup?: string;
  /** Server number from `guls.server`, when GF sent one. */
  server?: string;
  /** GF has this account deleted or scheduled for deletion — it can be listed but not played. */
  retired: boolean;
}

/**
 * GameForge client version triple, parsed from the launcher exe's file version.
 * Feeds the `thin/codes` account-hash User-Agent (`Chrome/C<version>`).
 */
export interface ClientVersion {
  /** Dotted version without the "C" prefix, e.g. "2.1.22.784". */
  version: string;
  branch: string;
  commitId: string;
}

/** One-time login code handed to `metin2client.exe`. */
export type LoginCode = string;
