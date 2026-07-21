// The account-hash ("MAGIC") that GameForge's launcher embeds in the User-Agent
// of privileged requests. Deterministic SHA cascade over the cert, client
// version, installation id and account id, branched on the installation id's
// first digit. Ported from zakuciael/gf-login + morsisko/NosTale-Auth (see the
// protocol doc: https://github.com/morsisko/NosTale-Auth).

import type { ClientVersion } from "./types.ts";

export const sha1 = (data: string | Uint8Array): string =>
  new Bun.CryptoHasher("sha1").update(data).digest("hex");
export const sha256 = (data: string | Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(data).digest("hex");

/** First decimal digit in a string, or undefined if it has none. */
export function firstDigit(str: string): number | undefined {
  const match = str.match(/\d/);
  return match ? Number.parseInt(match[0], 10) : undefined;
}

/**
 * Inputs to {@link accountHash}. `cert` is the launcher's embedded PEM certificate
 * (GF-shared/public); `accountHash` normalises its line endings before hashing, so
 * pass it however it comes off disk.
 */
export interface AccountHashInput {
  cert: string;
  version: ClientVersion["version"];
  installationId: string;
  accountId: string;
}

/**
 * The "third type" account hash — the one that authorises `thin/codes`. Even
 * first-digit takes the left 8 chars of one cascade; odd takes the right 8 of
 * the mirror cascade (sha1/sha256 swapped). Prefixed with the account id's
 * first two chars.
 */
export function accountHash({
  cert,
  version,
  installationId,
  accountId,
}: AccountHashInput): string {
  const digit = firstDigit(installationId);
  if (digit === undefined) {
    throw new Error("installation id has no digit; cannot derive account hash");
  }
  const prefix = accountId.slice(0, 2);
  const cVersion = `C${version}`;
  const pem = normalizeCertPem(cert);

  if (digit % 2 === 0) {
    const sum = sha256(sha256(pem) + sha1(cVersion) + sha256(installationId) + sha1(accountId));
    return prefix + sum.slice(0, 8);
  }
  const sum = sha256(sha1(pem) + sha256(cVersion) + sha1(installationId) + sha256(accountId));
  return prefix + sum.slice(-8);
}

// GF hashes the PEM with LF endings and a trailing newline; normalise to match, or the
// account hash won't line up with the launcher's. (The cert is GF-shared/public — its
// SHA-256 matches the constant stdLemon/nostale-auth hardcodes.)
function normalizeCertPem(pem: string): string {
  const lf = pem.replace(/\r\n|\r/g, "\n");
  return lf.endsWith("\n") ? lf : `${lf}\n`;
}
