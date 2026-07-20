// Step 2: list the game accounts bound to the GF login.
// GET /api/v1/user/accounts → object keyed by account id.

import { z } from "zod";
import {
  BROWSER_USER_AGENT,
  readJson,
  SPARK_BASE,
  sparkFetch,
  type SparkRequest,
} from "../http.ts";
import type { GameAccount } from "../types.ts";

// Only the fields we read. GF adds fields over time; unknown keys are dropped rather than
// rejected — but every key named here is required, at the shape GF was observed to send. A
// field we depend on going missing is a contract change, and it should fail here naming the
// field rather than downstream as a mystery. `accountGroup` and the deletion stamps matter
// more than they look: both are reasons `thin/codes` answers "Not allowed to create code",
// and its body names neither.
const RawGameAccount = z.object({
  id: z.string(),
  accountNumericId: z.number(),
  displayName: z.string(),
  usernames: z.array(z.string()),
  gameId: z.string(),
  /** Which localized community + server group the account belongs to, e.g. "pt". */
  accountGroup: z.string(),
  /** Deletion stamps: a timestamp once scheduled, explicit `null` while the account is live. */
  deleted: z.string().nullable(),
  preDeleted: z.string().nullable(),
  guls: z.object({
    game: z.string(),
  }),
});

/** The response has no envelope — it's an object keyed by account id. */
const AccountsResponse = z.record(z.string(), RawGameAccount);

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

  const data = await readJson(res, AccountsResponse);
  return Object.values(data).map((acc) => ({
    id: acc.id,
    numericId: acc.accountNumericId,
    displayName: acc.displayName,
    usernames: acc.usernames,
    gameId: acc.gameId,
    gameName: acc.guls.game,
    accountGroup: acc.accountGroup,
    // `deleted`/`preDeleted` are timestamps; only their presence is meaningful to us.
    retired: Boolean(acc.deleted ?? acc.preDeleted),
  }));
}
