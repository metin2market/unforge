// Turn any error into a frontend-agnostic description — a human `summary`, the structured
// field rejections when GF returned them, and a coarse `kind`. Both the CLI and the web UI
// render this, so the knowledge of GameForge's error shapes lives here once, not per frontend.
// GF's raw JSON stays the developer trail (UnexpectedResponseError.body); this is for people.

import {
  AttestationRejectedError,
  CodeNotAllowedError,
  InvalidCredentialsError,
  NetworkError,
  PipeInUseError,
  RateLimitedError,
  ResponseShapeError,
  UnauthorizedError,
  UnexpectedResponseError,
} from "../core/index.ts";

export type ErrorKind =
  | "validation"
  | "rate-limited"
  | "captcha-failed"
  | "network"
  | "invalid-credentials"
  | "code-not-allowed"
  | "attestation-rejected"
  | "pipe-in-use"
  | "unauthorized"
  | "response-shape"
  | "unknown";

export interface ErrorDescription {
  /** A concise, human summary line — a frontend can show it as-is. */
  summary: string;
  /** Coarse classification, so a UI can add an affordance (retry timer, focus a field, …). */
  kind: ErrorKind;
  /** GF's per-field rejections (a `400`'s `validationErrors`), for a form UI to flag inline. */
  fields?: { parameter: string; detail: string }[];
  /** How long to wait, when the server said so — lets a UI run a countdown instead of guessing. */
  retryAfterMs?: number;
}

/** "45 seconds" / "12 minutes" — a wait a person can act on, not a millisecond count. */
function formatWait(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 90) return `${seconds} seconds`;
  return `${Math.ceil(seconds / 60)} minutes`;
}

export function describeError(err: unknown): ErrorDescription {
  // Nothing reached GameForge — say so plainly, so this never reads as a rejection.
  if (err instanceof NetworkError) {
    return {
      kind: "network",
      summary: err.timedOut
        ? "GameForge didn't respond in time. Check your connection and try again — if it keeps timing out, GameForge may be having trouble."
        : "Couldn't reach GameForge. Check your internet connection and try again.",
    };
  }

  // Core's typed errors state what GameForge did; the guidance for a human lives here.
  // GF's 403 names no cause, but two of them are visible in the account itself. Lead with those
  // when they apply — sending someone to wait 18 minutes for a wrong region never resolves.
  if (err instanceof CodeNotAllowedError) {
    const ctx = err.context;
    if (ctx?.regionMismatch) {
      const asked = ctx.gameId.split(".").pop();
      return {
        kind: "code-not-allowed",
        summary:
          `GameForge filed this game account under "${ctx.accountGroup}", but unforge asked to ` +
          `play it as ${asked}. Waiting won't help — install the "${ctx.accountGroup}" client and ` +
          `point unforge at it (\`config set game-dir\`), then sign in again so the account picks ` +
          `up its own region.`,
      };
    }
    if (ctx?.retired) {
      return {
        kind: "code-not-allowed",
        summary:
          "GameForge has this game account deleted or scheduled for deletion, so it can't be " +
          "played. Pick another game account on this login.",
      };
    }
    return {
      kind: "code-not-allowed",
      summary:
        "GameForge won't issue a login code for this account. Either a code from an earlier " +
        "launch is still outstanding (~18 minutes), or this GameForge login is temporarily " +
        "blocked — or, if you only just registered it, its email isn't verified yet. Don't " +
        "retry: a block is a cooldown that every attempt restarts, so retrying is what keeps " +
        "it going. Leave it a few hours; to tell them apart, try an account on a different " +
        "GameForge login, once.",
    };
  }
  if (err instanceof AttestationRejectedError) {
    return {
      kind: "attestation-rejected",
      summary:
        "GameForge refused the device check for this account. It gives no reason and often " +
        "clears by itself — wait a moment and try again, or try another account on this login " +
        "to see whether it's account-specific.",
    };
  }
  if (err instanceof InvalidCredentialsError) {
    return {
      kind: "invalid-credentials",
      summary: "GameForge rejected the email or password for this login.",
    };
  }
  if (err instanceof PipeInUseError) {
    return { kind: "pipe-in-use", summary: err.message };
  }
  // A 429 with a Retry-After can say *how long*; without one, all we honestly have is "a while".
  if (err instanceof RateLimitedError) {
    return {
      kind: "rate-limited",
      retryAfterMs: err.retryAfterMs,
      summary:
        err.retryAfterMs === undefined
          ? "GameForge is rate-limiting these requests — wait a while before trying again."
          : `GameForge is rate-limiting these requests — try again in ${formatWait(err.retryAfterMs)}.`,
    };
  }
  // Bare "unauthorized" tells a user nothing; a stored token going stale is the usual cause.
  if (err instanceof UnauthorizedError) {
    return {
      kind: "unauthorized",
      summary: "GameForge rejected the saved session for this login — sign in again.",
    };
  }

  // The one failure retrying can't fix: GameForge's payload changed, so unforge is the thing
  // that has to. Say that outright — a user who reads "try again" here will just try again.
  if (err instanceof ResponseShapeError) {
    return {
      kind: "response-shape",
      fields: err.issues.map((issue) => ({ parameter: err.url, detail: issue })),
      summary:
        "GameForge sent a response unforge doesn't understand — their API has most likely " +
        `changed, so this needs a fix in unforge rather than a retry. Details: ${err.issues.join("; ")}`,
    };
  }

  if (err instanceof UnexpectedResponseError && err.spark) {
    const { validationErrors, errorTypes = [], message } = err.spark;

    if (validationErrors?.length) {
      const fields = validationErrors.map((v) => ({
        parameter: v.affectedParameter,
        detail: v.details,
      }));
      const inline = fields.map((f) => `${f.parameter} — ${f.detail}`).join("; ");
      return { kind: "validation", fields, summary: `GameForge rejected the input: ${inline}` };
    }
    if (errorTypes.includes("TOO_MANY_REQUESTS")) {
      return {
        kind: "rate-limited",
        summary: "GameForge is rate-limiting these requests — wait a while before trying again.",
      };
    }
    if (errorTypes.includes("CHALLENGE_VERIFICATION_FAILED")) {
      return {
        kind: "captcha-failed",
        summary: "The captcha challenge failed verification — try again in a moment.",
      };
    }
    if (message) return { kind: "unknown", summary: `GameForge: ${message} (HTTP ${err.status}).` };
  }
  return { kind: "unknown", summary: err instanceof Error ? err.message : String(err) };
}
