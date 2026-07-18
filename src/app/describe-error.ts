// Turn any error into a frontend-agnostic description — a human `summary`, the structured
// field rejections when GF returned them, and a coarse `kind`. Both the CLI and the web UI
// render this, so the knowledge of GameForge's error shapes lives here once, not per frontend.
// GF's raw JSON stays the developer trail (UnexpectedResponseError.body); this is for people.

import { UnexpectedResponseError } from "../core/index.ts";

export type ErrorKind = "validation" | "rate-limited" | "captcha-failed" | "unknown";

export interface ErrorDescription {
  /** A concise, human summary line — a frontend can show it as-is. */
  summary: string;
  /** Coarse classification, so a UI can add an affordance (retry timer, focus a field, …). */
  kind: ErrorKind;
  /** GF's per-field rejections (a `400`'s `validationErrors`), for a form UI to flag inline. */
  fields?: { parameter: string; detail: string }[];
}

export function describeError(err: unknown): ErrorDescription {
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
