// Device-attestation step, sent right before minting a code.
// POST /api/v1/auth/iovation with the `tra:…` blackbox → { status: "ok" }.
// The launcher does this on "play now"; skipping it may get the code refused.
//
// IMPORTANT: pass a FRESH blackbox, not the one used for `sessions`. GF rejects a
// byte-identical (replayed) blackbox here with a 403 — mint a new one (drifted
// identity) per call. Reusing the sessions blackbox was the old "iovation is walled" bug.

import {
  BROWSER_USER_AGENT,
  readJson,
  SPARK_BASE,
  SPARK_ORIGIN,
  sparkFetch,
  type SparkRequest,
} from "../http.ts";

export interface AttestDeviceOptions {
  token: string;
  installationId: string;
  accountId: string;
  /** A FRESH `tra:…` blackbox — must NOT be the one sent to `sessions` (replays 403). */
  blackbox: string;
}

/** Build the `iovation` attestation request (pure — no network). */
export function buildAttestRequest(opts: AttestDeviceOptions): SparkRequest {
  return {
    url: `${SPARK_BASE}/api/v1/auth/iovation`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.token}`,
      Origin: SPARK_ORIGIN,
      "User-Agent": BROWSER_USER_AGENT,
      "TNT-Installation-Id": opts.installationId,
    },
    body: JSON.stringify({
      accountId: opts.accountId,
      blackbox: opts.blackbox,
      type: "play_now",
    }),
  };
}

/** Attest the device for an account. Resolves when GF returns `status: "ok"`. */
export async function attestDevice(opts: AttestDeviceOptions): Promise<void> {
  const res = await sparkFetch(buildAttestRequest(opts));
  await readJson<{ status: string }>(res);
}
