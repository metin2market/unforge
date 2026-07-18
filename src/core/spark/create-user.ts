// Register a new GameForge account. POST /api/v2/users {email,password,locale,blackbox}.
// The first attempt returns 409 + a `gf-challenge-id` (the PoW captcha); we solve it
// (challenge.ts) and retry with the solved id in the header, yielding 201 + userId.
// Login works immediately after — no email verification is needed to authenticate
// (verified from a capture). See docs/protocol.md.

import {
  BROWSER_USER_AGENT,
  readJson,
  SPARK_BASE,
  SPARK_ORIGIN,
  type SparkRequest,
} from "../http.ts";
import { sendWithChallenge } from "./challenge.ts";
import type { Credentials } from "../types.ts";

export interface CreateUserOptions extends Credentials {
  installationId: string;
  /** iovation "blackbox" (`tra:…`), generated natively (see blackbox/generate.ts). */
  blackbox: string;
  /** GF locale, `^[a-z]{2}-[A-Z]{2}$` — e.g. "en-GB", "pt-PT". */
  locale?: string;
  /** Solved PoW id, set on the retry after a 409 (see {@link solveChallenge}). */
  challengeId?: string;
}

export interface CreatedUser {
  userId: string;
}

/** Build the account-registration request (pure — no network). */
export function buildCreateUserRequest(opts: CreateUserOptions): SparkRequest {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": BROWSER_USER_AGENT,
    Origin: SPARK_ORIGIN,
    "TNT-Installation-Id": opts.installationId,
    "gf-installation-id": opts.installationId,
  };
  // The retry after a solved captcha carries the challenge id (absent on attempt 1).
  if (opts.challengeId) headers["gf-challenge-id"] = opts.challengeId;
  return {
    url: `${SPARK_BASE}/api/v2/users`,
    method: "POST",
    headers,
    // Key order mirrors the launcher's request (email-first, unlike `sessions`).
    body: JSON.stringify({
      email: opts.email,
      password: opts.password,
      locale: opts.locale ?? "en-GB",
      blackbox: opts.blackbox,
    }),
  };
}

/** Register an account, solving the PoW captcha the first attempt always triggers. */
export async function createUser(opts: CreateUserOptions): Promise<CreatedUser> {
  const res = await sendWithChallenge(
    (challengeId) => buildCreateUserRequest({ ...opts, challengeId }),
    opts.locale ?? "en-GB",
  );
  const data = await readJson<{ userCreated?: boolean; userId: string }>(res);
  return { userId: data.userId };
}
