// Step 3: mint the one-time login code for a game account.
// POST /api/v1/auth/thin/codes, authorised by the account-hash User-Agent.
//
// `gsid` = a client session id (any UUID) + "-" + a random 4-digit number.

import { z } from "zod";
import { readJson, SPARK_BASE, sparkFetch, type SparkRequest } from "../http.ts";
import { accountHash } from "../crypto.ts";
import { CodeNotAllowedError } from "../errors.ts";
import { encryptBlackbox } from "../blackbox/index.ts";
import type { ClientVersion, GameAccount, LoginCode } from "../types.ts";

export interface RequestCodeOptions {
  token: string;
  account: GameAccount;
  installationId: string;
  clientVersion: ClientVersion;
  /** The launcher's client-cert PEM (GF-shared/public), for the account-hash UA. */
  certificatePem: string;
  /** Client session id (any UUID); joined with a random suffix to form the `gsid`. */
  sessionId: string;
  /**
   * The raw `tra:…` blackbox (same one used for `sessions`/`iovation`). thin/codes
   * needs it *encrypted* and bound to the full `gsid` + account; since the gsid's
   * random suffix is minted here, we encrypt here too so the two always match.
   */
  rawBlackbox: string;
  /** Server region, e.g. "pt-PT"; the body `gameId` is `<gameId>.<region>`. */
  region: string;
}

const CodeResponse = z.object({ code: z.string() });

/**
 * Build the `thin/codes` request for an already-assembled `gsid` (pure — no
 * network). The blackbox is encrypted against this exact `gsid` + account, and
 * the account-hash rides in the `User-Agent`. Note: **no `Origin` header** here,
 * unlike the other steps — the launcher omits it and GF is sensitive to that.
 */
export function buildCodeRequest(opts: RequestCodeOptions & { gsid: string }): SparkRequest {
  const magic = accountHash({
    cert: opts.certificatePem,
    version: opts.clientVersion.version,
    installationId: opts.installationId,
    accountId: opts.account.id,
  });

  return {
    url: `${SPARK_BASE}/api/v1/auth/thin/codes`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.token}`,
      "TNT-Installation-Id": opts.installationId,
      "User-Agent": `Chrome/C${opts.clientVersion.version} (${magic})`,
    },
    body: JSON.stringify({
      blackbox: encryptBlackbox(opts.rawBlackbox, opts.gsid, opts.account.id),
      gameId: `${opts.account.gameId}.${opts.region}`,
      gsid: opts.gsid,
      platformGameAccountId: opts.account.id,
    }),
  };
}

/**
 * GameForge's account groups whose code is a country rather than a language; its client locales
 * (and so the region tags) use the language. See `CLIENT_LOCALE` in app/refs.ts for how this was
 * established — the two tables describe the same fact from opposite directions.
 */
const GROUP_LOCALE: Record<string, string> = { dk: "da", cz: "cs" };

/**
 * True when the region we're about to play the account in disagrees with the group GameForge
 * filed it under. A region is `pt-PT` and a group `pt`, so only the first subtag can be compared
 * — after translating the groups whose code isn't the language (`dk` lives in `da-DK`). An
 * unknown group contradicts nothing.
 */
export function regionMismatch(region: string, accountGroup?: string): boolean {
  if (!accountGroup) return false;
  const group = accountGroup.toLowerCase();
  return region.split("-")[0].toLowerCase() !== (GROUP_LOCALE[group] ?? group);
}

/** Request the game login code for one account. */
export async function requestLoginCode(opts: RequestCodeOptions): Promise<LoginCode> {
  const gsid = `${opts.sessionId}-${randomFourDigits()}`;
  const res = await sparkFetch(buildCodeRequest({ ...opts, gsid }));

  // GF's generic "not allowed to create code". The body names no cause, so attach what we know
  // about the account — a wrong region or a retired account is diagnosable, the rest isn't.
  if (res.status === 403 && /not allowed to create code/i.test(await res.clone().text())) {
    throw new CodeNotAllowedError({
      gameId: `${opts.account.gameId}.${opts.region}`,
      accountGroup: opts.account.accountGroup,
      regionMismatch: regionMismatch(opts.region, opts.account.accountGroup),
      retired: opts.account.retired,
    });
  }
  // An absent code would travel all the way to the game client over the handoff pipe and
  // surface there as a silent login screen, in another process, with nothing logged.
  const data = await readJson(res, CodeResponse);
  return data.code;
}

function randomFourDigits(): number {
  return Math.floor(1000 + Math.random() * 9000);
}
