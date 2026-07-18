// Register a new GameForge account. POST /api/v2/users {email,password,locale,blackbox}.
// The first attempt returns 409 + a `gf-challenge-id` (the PoW captcha); we solve it
// (challenge.ts) and retry with the solved id in the header, yielding 201 + userId.
// The new login authenticates immediately, but can't mint a play code until its email is
// verified — `thin/codes` 403s until then. See docs/protocol.md.

import { z } from "zod";
import {
  BROWSER_USER_AGENT,
  readJson,
  SPARK_BASE,
  SPARK_ORIGIN,
  type SparkRequest,
} from "../http.ts";
import { UnexpectedResponseError } from "../errors.ts";

// Both optional: GF reports the *outcome* in these fields, so a body saying "not created" is a
// verdict to interpret (below), not a broken contract. Requiring them here would turn a
// legible refusal into a shape error.
const CreateUserResponse = z.object({
  userCreated: z.boolean().optional(),
  userId: z.string().optional(),
});
import { sendWithChallenge } from "./challenge.ts";
import type { Credentials } from "../types.ts";

export interface CreateGfAccountOptions extends Credentials {
  installationId: string;
  /** iovation "blackbox" (`tra:…`), generated natively (see blackbox/generate.ts). */
  blackbox: string;
  /** GF locale, `^[a-z]{2}-[A-Z]{2}$` — e.g. "en-GB", "pt-PT". */
  locale?: string;
  /** Solved PoW id, set on the retry after a 409 (see {@link solveChallenge}). */
  challengeId?: string;
}

/** Build the registration request (pure — no network). */
export function buildCreateGfAccountRequest(opts: CreateGfAccountOptions): SparkRequest {
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

/** Register a GameForge account, solving the PoW captcha the first attempt always triggers. */
export async function createGfAccount(opts: CreateGfAccountOptions): Promise<{ userId: string }> {
  const res = await sendWithChallenge(
    (challengeId) => buildCreateGfAccountRequest({ ...opts, challengeId }),
    opts.locale ?? "en-GB",
  );
  const data = await readJson(res, CreateUserResponse);
  // A 2xx is not confirmation on its own — GF reports the outcome in the body, and every
  // later step is keyed by `userId`, so an absent one must fail here rather than downstream.
  if (data.userCreated === false || !data.userId) {
    throw new UnexpectedResponseError(res.status, res.statusText, JSON.stringify(data));
  }
  return { userId: data.userId };
}
