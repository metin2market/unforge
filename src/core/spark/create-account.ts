// Create a new game account under the logged-in GF account.
// POST /api/v2/users/me/accounts → the account the code flow then logs into.
// Useful for multibox: one GF login can mint several game accounts.

import { z } from "zod";
import { readJson, SPARK_BASE, sparkHeaders, type SparkRequest } from "../http.ts";
import { METIN2_GAME_ENVIRONMENT_ID, METIN2_GAME_ID } from "../metin2.ts";
import type { AccountGroup } from "../regions.ts";
import { sendWithChallenge } from "./challenge.ts";

export interface CreateGameAccountOptions {
  token: string;
  installationId: string;
  /** The account's display name. */
  displayName: string;
  /** The `tra:…` iovation blackbox (same one used for `sessions`). */
  blackbox: string;
  gameId?: string;
  gameEnvironmentId?: string;
  /**
   * The localized community, e.g. "pt" — the dimension behind `<gfLang>.metin2.gameforge.com`.
   * The launcher sends it equal to {@link accountGroup}, but its value set is wider (`all`, and
   * communities Metin2 has no group for), so `string`: nothing enumerates it to narrow against.
   */
  gfLang: string;
  /** Where the account lives, permanently. Required — a wrong one can't be corrected later. */
  accountGroup: AccountGroup;
  /**
   * GF interface locale, `^[a-z]{2}-[A-Z]{2}$`. Never reaches the body — only the captcha page,
   * if a PoW fires. Callers pass the region the account is being created in, which is a valid
   * locale and the language whoever is creating it will be reading.
   */
  locale: string;
  /** Solved PoW id, set on the retry after a 409 (see {@link sendWithChallenge}). */
  challengeId?: string;
}

export const CreatedGameAccount = z.object({
  accountId: z.string(),
  displayName: z.string(),
  gameId: z.string(),
  guls: z.object({
    game: z.string(),
    server: z.string(),
    user: z.string(),
    lang: z.string(),
  }),
});
export type CreatedGameAccount = z.infer<typeof CreatedGameAccount>;

/** Build the account-creation request (pure — no network). */
export function buildCreateAccountRequest(opts: CreateGameAccountOptions): SparkRequest {
  return {
    url: `${SPARK_BASE}/api/v2/users/me/accounts`,
    method: "POST",
    headers: sparkHeaders(opts),
    body: JSON.stringify({
      displayName: opts.displayName,
      gameId: opts.gameId ?? METIN2_GAME_ID,
      gameEnvironmentId: opts.gameEnvironmentId ?? METIN2_GAME_ENVIRONMENT_ID,
      gfLang: opts.gfLang,
      accountGroup: opts.accountGroup,
      blackbox: opts.blackbox,
    }),
  };
}

/** Create a game account, solving the PoW captcha if one fires; returns the created account. */
export async function createGameAccount(
  opts: CreateGameAccountOptions,
): Promise<CreatedGameAccount> {
  const res = await sendWithChallenge(
    (challengeId) => buildCreateAccountRequest({ ...opts, challengeId }),
    opts.locale,
  );
  return readJson(res, CreatedGameAccount);
}
