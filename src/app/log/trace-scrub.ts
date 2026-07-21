// Scrubbing for the request trace. The trace exists *because* the log trail redacts too much
// (docs/architecture.md → Logging), so this removes credentials only — the material a GameForge diagnosis
// actually reads (blackbox, installation ids, challenge ids, pow, cookies, email) stays raw.
//
// LogTape's `redactByField` can't do this job: it wraps a *sink* and matches structured record
// fields, whereas these secrets live inside HTTP bodies and header strings the trace writes
// itself. Same intent, different reach.

import { sha256 } from "../../core/index.ts";

/** Replaces a password outright — there is no diagnosis that needs one, not even to correlate. */
const PASSWORD_MASK = "«password»";

/**
 * Credentials keep a digest rather than vanish: "is this the same token as the previous call"
 * is a real question a trace has to answer (the iovation bug was a *replayed* value, and the
 * only way to see that is a stable fingerprint). Safe because these are high-entropy — a
 * truncated digest of a bearer token is not guessable the way one of a password is.
 */
const fingerprint = (value: string): string => `«${sha256(value).slice(0, 12)}»`;

const PASSWORD_FIELDS = new Set(["password", "newPassword", "oldPassword"]);
const CREDENTIAL_FIELDS = new Set(["token", "accessToken", "refreshToken", "code", "secret"]);

/** Walk a decoded JSON body, masking credential fields at any depth. */
function scrubValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => {
      if (PASSWORD_FIELDS.has(k)) return [k, PASSWORD_MASK];
      if (CREDENTIAL_FIELDS.has(k) && typeof v === "string") return [k, fingerprint(v)];
      return [k, scrubValue(v)];
    }),
  );
}

/**
 * Scrub a JSON body, or return it unchanged when it isn't JSON. Non-JSON bodies are left
 * alone on purpose: the only ones the flow sends are the captcha landing page and form posts
 * carrying no credential, and a half-parsed rewrite would corrupt the very thing being read.
 */
export function scrubBody(body: string | undefined): string | undefined {
  if (!body) return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  return JSON.stringify(scrubValue(parsed));
}

/**
 * Scrub headers. Only `authorization` carries a credential — the cookies here are the captcha
 * ingress/session pins, which are diagnostic (a 404'd challenge is read off them) and grant
 * nothing on their own.
 */
export function scrubHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => {
      if (k.toLowerCase() !== "authorization") return [k, v];
      const [scheme, ...rest] = v.split(" ");
      const credential = rest.join(" ");
      return [k, credential ? `${scheme} ${fingerprint(credential)}` : fingerprint(v)];
    }),
  );
}
