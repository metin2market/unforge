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
  /** The account's numeric id — what the client asks for as `queryGameAccountNumericId`. */
  accountNumericId: number;
  displayName: string;
  usernames: string[];
  gameId: string;
  /** Human game name from `guls.game`, e.g. "metin2". */
  gameName: string;
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
