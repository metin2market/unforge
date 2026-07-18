// Typed errors for the Spark auth flow, so callers can branch on failure kind
// (e.g. surface a captcha to a human) instead of parsing messages.

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
 * generic, so it covers two causes we can't tell apart from the response:
 *   1. The account isn't eligible yet — most often a freshly-registered GF account whose email
 *      hasn't been verified. This persists until the account is activated; waiting won't fix it.
 *   2. A previous code is still outstanding — a launch that died before the client consumed its
 *      code holds it for ~18 min. This one clears on its own; retrying sooner just re-auths for
 *      nothing and feeds GameForge's risk scoring.
 */
export class CodeNotAllowedError extends UnforgeError {
  override name = "CodeNotAllowedError";
  constructor(
    message = "GameForge won't issue a login code for this account — verify its email if it's new, or wait ~18m in case a previous code is still outstanding",
  ) {
    super(message);
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

/** One field GameForge rejected, from a `400`'s `validationErrors` array. */
export interface SparkValidationError {
  affectedParameter: string;
  details: string;
}

/** The standard Spark error JSON: `{message, errorTypes, validationErrors}`. */
export interface SparkErrorBody {
  message?: string;
  errorTypes?: string[];
  validationErrors?: SparkValidationError[];
}

/** Parse a Spark error body into its structured fields; undefined if it isn't that shape. */
export function parseSparkErrorBody(body?: string): SparkErrorBody | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as SparkErrorBody;
    if (parsed && (parsed.message || parsed.errorTypes || parsed.validationErrors)) return parsed;
  } catch {
    // Not JSON (e.g. an HTML error page) — nothing structured to offer.
  }
  return undefined;
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
