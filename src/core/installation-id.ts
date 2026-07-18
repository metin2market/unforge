// The per-account `InstallationId` (a UUID). GameForge's launcher stores one in
// the registry; we generate + persist our own. It must be **stable per account
// and distinct across accounts** — fresh-per-launch churn or a shared id are
// both red-bar triggers (see docs/protocol.md → Installation id).

import { firstDigit } from "./crypto.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Generate a new installation id. Persist it — never mint one per launch. */
export function generateInstallationId(): string {
  return crypto.randomUUID();
}

/**
 * A usable installation id is a UUID that also contains a digit, since the
 * account hash branches on its first digit ({@link accountHash}).
 */
export function isValidInstallationId(id: string): boolean {
  return UUID_RE.test(id) && firstDigit(id) !== undefined;
}
