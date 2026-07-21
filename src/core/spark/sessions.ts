// Step 1: exchange credentials (+ iovation blackbox) for a bearer token.
// POST /api/v2/authProviders/credentials/sessions.
//
// The blackbox is the iovation device fingerprint (see docs/blackbox.md), passed
// in as an input here. On 409 GameForge either demands a captcha — solved and retried
// here (docs/captcha.md) — or rejects the credentials.

import { z } from "zod";
import {
  BROWSER_USER_AGENT,
  readJson,
  safeText,
  SPARK_BASE,
  SPARK_ORIGIN,
  sparkFetch,
  type SparkRequest,
} from "../http.ts";
import {
  CaptchaRequiredError,
  InvalidCredentialsError,
  UnexpectedResponseError,
} from "../errors.ts";
import { stringArrayField } from "../../util/index.ts";
import { sendWithChallenge } from "./challenge.ts";
import type { Credentials } from "../types.ts";

export interface CreateSessionOptions extends Credentials {
  installationId: string;
  /** iovation "blackbox" (`tra:…`), generated natively (see blackbox/generate.ts). */
  blackbox: string;
  /**
   * GF interface locale, `^[a-z]{2}-[A-Z]{2}$` — error text and the captcha page. `string`, not
   * a region: GF's set is its platform-wide UI languages, far wider than Metin2's 13 and not
   * ours to enumerate (docs/protocol.md). Required: a default here would be ours, not GF's.
   */
  locale: string;
  /** Solved PoW id, set on the retry after a 409 (see {@link solveChallenge}). */
  challengeId?: string;
}

const SessionResponse = z.object({ token: z.string() });

/** Build the `sessions` request (pure — no network). */
export function buildSessionRequest(opts: CreateSessionOptions): SparkRequest {
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
    url: `${SPARK_BASE}/api/v2/authProviders/credentials/sessions`,
    method: "POST",
    headers,
    // Key order mirrors the launcher's request (blackbox first) — verified against
    // a capture in requests.capture.test.ts.
    body: JSON.stringify({
      blackbox: opts.blackbox,
      email: opts.email,
      password: opts.password,
      locale: opts.locale,
    }),
  };
}

/**
 * Authenticate and return the bearer token used by later steps. Login is captcha-gated
 * under risk-scoring: a `409` carrying a `gf-challenge-id` is solved and the login retried
 * (~8s of CPU for the PoW). A `409` that is *not* a challenge is a real conflict.
 */
export async function createSession(opts: CreateSessionOptions): Promise<string> {
  const res = await sendWithChallenge(
    (challengeId) => buildSessionRequest({ ...opts, challengeId }),
    opts.locale,
  );

  if (res.status === 409) throw await classifyConflict(res);
  if (res.status === 403)
    throw new InvalidCredentialsError("credentials rejected (HTTP 403 Forbidden)");

  // A token that isn't there would otherwise become `Bearer undefined` and fail as a 401 on
  // the *next* endpoint, blaming the wrong call.
  const data = await readJson(res, SessionResponse);
  return data.token;
}

/** Build the logout request (pure — no network). DELETE /api/v1/auth/sessions. */
export function buildLogoutRequest(token: string, installationId: string): SparkRequest {
  return {
    url: `${SPARK_BASE}/api/v1/auth/sessions`,
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: SPARK_ORIGIN,
      "User-Agent": BROWSER_USER_AGENT,
      "TNT-Installation-Id": installationId,
    },
  };
}

/**
 * Invalidate the session server-side. GameForge returns 202 Accepted with an empty body, so
 * this checks the status directly rather than going through `readJson` — there is no JSON to
 * read, and a 401 here (the token is already dead) means the goal is met, not that we failed.
 */
export async function logout(token: string, installationId: string): Promise<void> {
  const res = await sparkFetch(buildLogoutRequest(token, installationId));
  if (res.ok || res.status === 401) return;
  throw new UnexpectedResponseError(res.status, res.statusText, await safeText(res));
}

// 409 means either a captcha gate (carried in the gf-challenge-id header) or
// bad credentials (flagged in the body's errorTypes).
async function classifyConflict(res: Response): Promise<Error> {
  const challenge = res.headers.get("gf-challenge-id");
  if (challenge) return new CaptchaRequiredError(challenge.split(";")[0]);

  const body: unknown = await res.json().catch(() => ({}));
  if (stringArrayField(body, "errorTypes")?.includes("CREDENTIALS_INVALID")) {
    return new InvalidCredentialsError("credentials rejected (HTTP 409 CREDENTIALS_INVALID)");
  }
  return new UnexpectedResponseError(res.status, res.statusText, JSON.stringify(body));
}
