// Typed errors for the Spark auth flow, so callers can branch on failure kind
// (e.g. surface a captcha to a human) instead of parsing messages.

import { z } from "zod";
import { parseJson } from "../util/index.ts";

/** Base class for every error this library throws. */
export class UnforgeError extends Error {
  override name = "UnforgeError";
}

/** Credentials rejected (HTTP 403, or 409 `CREDENTIALS_INVALID`). */
export class InvalidCredentialsError extends UnforgeError {
  override name = "InvalidCredentialsError";
  constructor(message = "email or password rejected by GameForge") {
    super(message);
  }
}

/**
 * A captcha challenge (HTTP 409 with a `gf-challenge-id`) that survived our automated
 * solve. `sendWithChallenge` solves the PoW and retries in-flow (challenge.ts,
 * instrumentation.ts), so this is the *residual* signal — the retry itself came back
 * challenged again — not the first 409, which callers never see.
 */
export class CaptchaRequiredError extends UnforgeError {
  override name = "CaptchaRequiredError";
  constructor(readonly challengeId: string) {
    super(`captcha challenge required: ${challengeId}`);
  }
}

/** A valid session/token was required but missing or expired (HTTP 401). */
export class UnauthorizedError extends UnforgeError {
  override name = "UnauthorizedError";
  constructor(message = "unauthorized") {
    super(message);
  }
}

/**
 * GameForge refused to mint a login code (HTTP 403, `Not allowed to create code`). The body is
 * generic, so it covers several causes it can't tell apart, in rough order of how often they're
 * the one:
 *   1. The `gameId`'s region disagrees with the account's own group — we asked to play it
 *      somewhere it doesn't exist. Ours to get right, and the one cause we *can* detect: see
 *      {@link CodeNotAllowedContext.regionMismatch}.
 *   2. A previous code is still outstanding — a launch that died before the client consumed its
 *      code holds it for ~18 min. This clears on its own; retrying sooner just re-auths for
 *      nothing and feeds GameForge's risk scoring.
 *   3. The login can't play — a block ("red bar"), which applies to the whole GameForge login
 *      rather than one game account, or an account GF has retired. Do not retry to find out:
 *      attempts may extend a block (docs/red-bar.md).
 *   4. The account isn't activated — a freshly-registered GF account whose email hasn't been
 *      verified. Only applies to new accounts, and waiting won't fix it.
 *
 * The context is attached because the 403 alone sends a user to wait 18 minutes for a cause
 * that waiting never fixes.
 */
export interface CodeNotAllowedContext {
  /** The `gameId` we sent, region suffix included — what GF was actually asked for. */
  gameId: string;
  /** The account's own group per `user/accounts`, when GF sent one. */
  accountGroup?: string;
  /** True when that group and the region we sent disagree — cause 1, and actionable. */
  regionMismatch: boolean;
  /** True when GF has the account deleted or scheduled for deletion — waiting won't fix it. */
  retired: boolean;
}

export class CodeNotAllowedError extends UnforgeError {
  override name = "CodeNotAllowedError";
  constructor(
    readonly context?: CodeNotAllowedContext,
    message = "GameForge refused to issue a login code for this account",
  ) {
    super(message);
  }
}

/**
 * `iovation` refused the device attestation (HTTP 403 `{"status":"failed"}`, or a 200 whose
 * `status` isn't `"ok"`). The body carries no reason. A replayed blackbox — one whose rolling
 * vector hasn't advanced since the previous call — is the cause we know of and have fixed
 * (blackbox/generate.ts), but it is *not* the only one: attestations with a correctly advanced
 * vector are still refused sometimes, so treat this as "GF declined this device right now",
 * not as proof of a client bug.
 */
export class AttestationRejectedError extends UnforgeError {
  override name = "AttestationRejectedError";
  constructor(readonly accountId: string) {
    super(`GameForge rejected the device attestation for account ${accountId}`);
  }
}

/**
 * Something else already owns the handoff pipe — in practice the running GameForge launcher.
 * It has to be closed: the pipe is a machine-wide singleton, so launcher-less means replacing it.
 */
export class PipeInUseError extends UnforgeError {
  override name = "PipeInUseError";
  constructor(readonly path: string) {
    super(`${path} is already in use — close the GameForge launcher (gfclient.exe) and retry`);
  }
}

/**
 * The request never produced an HTTP response: DNS failure, connection reset, TLS error, no
 * route, or our own timeout. Distinct from {@link UnexpectedResponseError}, which means the
 * server *did* answer and we didn't like it — the two want opposite advice ("check your
 * connection" vs "GameForge refused"), so no caller should have to tell them apart by string.
 */
export class NetworkError extends UnforgeError {
  override name = "NetworkError";
  constructor(
    readonly url: string,
    /** True when we aborted it ourselves after the timeout, rather than the connection failing. */
    readonly timedOut: boolean,
    override readonly cause?: unknown,
  ) {
    super(
      timedOut
        ? `request to ${url} timed out`
        : `could not reach ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/**
 * GameForge is rate-limiting us (HTTP 429). Carries `Retry-After` as a duration when the server
 * sent one — RFC 9110 says to honour it exactly, and it's the difference between a UI that can
 * show a countdown and one that can only say "try later". Registration is the endpoint that
 * actually trips this; it can stay limited for a long stretch, so retrying blind is the worst
 * possible response.
 */
export class RateLimitedError extends UnforgeError {
  override name = "RateLimitedError";
  constructor(
    /** From `Retry-After`, in ms from when the response arrived. Undefined if not sent. */
    readonly retryAfterMs?: number,
    readonly body?: string,
  ) {
    super(
      retryAfterMs === undefined
        ? "GameForge is rate-limiting this request"
        : `GameForge is rate-limiting this request; retry after ${Math.ceil(retryAfterMs / 1000)}s`,
    );
  }
}

/** One field GameForge rejected, from a `400`'s `validationErrors` array. */
export const SparkValidationError = z.object({
  affectedParameter: z.string(),
  details: z.string(),
});
export type SparkValidationError = z.infer<typeof SparkValidationError>;

/**
 * The standard Spark error JSON: `{message, errorTypes, validationErrors}`. Every field is
 * optional because GF sends different subsets per endpoint — this is a best-effort read of an
 * error body, not a contract, so a body missing all three is simply "nothing structured here".
 */
export const SparkErrorBody = z.object({
  message: z.string().optional(),
  errorTypes: z.array(z.string()).optional(),
  validationErrors: z.array(SparkValidationError).optional(),
});
export type SparkErrorBody = z.infer<typeof SparkErrorBody>;

/** Parse a Spark error body into its structured fields; undefined if it isn't that shape. */
export function parseSparkErrorBody(body?: string): SparkErrorBody | undefined {
  if (!body) return undefined;
  // Not JSON (an HTML error page) or not this shape — nothing structured to offer.
  const parsed = SparkErrorBody.safeParse(parseJson(body));
  if (!parsed.success) return undefined;
  const { message, errorTypes, validationErrors } = parsed.data;
  if (message === undefined && errorTypes === undefined && validationErrors === undefined) {
    return undefined;
  }
  return parsed.data;
}

/**
 * GameForge answered successfully, in a shape we don't recognise: a field we depend on is
 * missing or changed type. Deliberately distinct from {@link UnexpectedResponseError} — that
 * one means GF said no, this one means **their contract moved**, and the two want opposite
 * responses ("wait and retry" vs "unforge needs updating").
 *
 * It exists because the alternative is a misdiagnosis. Unvalidated, a renamed `status` on
 * `iovation` reads as a rejected device, a missing `token` becomes `Bearer undefined` and
 * surfaces as a `401` on the *next* endpoint, and a missing `code` reaches the game client as
 * `undefined` and shows up as a silent login screen in another process.
 */
export class ResponseShapeError extends UnforgeError {
  override name = "ResponseShapeError";
  constructor(
    readonly url: string,
    /** One line per bad field: `token: Invalid input: expected string, received undefined`. */
    readonly issues: string[],
    readonly body?: string,
  ) {
    super(`unexpected response shape from ${url}: ${issues.join("; ")}`);
  }
}

/** A zod failure as one line per bad field, rooted at the field path. */
export function shapeIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

/** Any other unexpected HTTP response from a Spark endpoint. */
export class UnexpectedResponseError extends UnforgeError {
  override name = "UnexpectedResponseError";
  /** GF's parsed error body, when the response carried the standard Spark error JSON. */
  readonly spark?: SparkErrorBody;
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly body?: string,
  ) {
    // Include the response body in the message — GF's error bodies carry the actual reason
    // (`errorTypes`, e.g. CHALLENGE_VERIFICATION_FAILED vs NAME_TAKEN), and they're not secret.
    // Without it, a bare "409 Conflict" in the log says nothing. Truncated so an HTML error
    // page can't flood the trail. Frontends render `spark` for a human; this is the dev trail.
    const detail = body ? `: ${body.length > 500 ? `${body.slice(0, 500)}…` : body}` : "";
    super(`unexpected response ${status} ${statusText}${detail}`);
    this.spark = parseSparkErrorBody(body);
  }
}
