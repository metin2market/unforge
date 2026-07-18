// Step 2: list the game accounts bound to the GF login.
// GET /api/v1/user/accounts → object keyed by account id.

import {
  BROWSER_USER_AGENT,
  readJson,
  SPARK_BASE,
  sparkFetch,
  type SparkRequest,
} from "../http.ts";
import type { GameAccount } from "../types.ts";

interface RawGameAccount {
  id: string;
  accountNumericId: number;
  displayName: string;
  usernames: string[];
  gameId: string;
  guls: { game: string };
}

/** Build the `user/accounts` request (pure — no network). */
export function buildAccountsRequest(token: string, installationId: string): SparkRequest {
  return {
    url: `${SPARK_BASE}/api/v1/user/accounts`,
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": BROWSER_USER_AGENT,
      "TNT-Installation-Id": installationId,
    },
  };
}

/** Fetch every game account on the GF login. */
export async function listGameAccounts(
  token: string,
  installationId: string,
): Promise<GameAccount[]> {
  const res = await sparkFetch(buildAccountsRequest(token, installationId));

  const data = await readJson<Record<string, RawGameAccount>>(res);
  return Object.values(data).map((acc) => ({
    id: acc.id,
    accountNumericId: acc.accountNumericId,
    displayName: acc.displayName,
    usernames: acc.usernames,
    gameId: acc.gameId,
    gameName: acc.guls.game,
  }));
}
