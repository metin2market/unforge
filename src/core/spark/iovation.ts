// Device-attestation step, sent right before minting a code.
// POST /api/v1/auth/iovation with the `tra:…` blackbox → { status: "ok" }.
// The launcher does this on "play now"; skipping it may get the code refused.
//
// IMPORTANT: pass a FRESH blackbox, not the one used for `sessions`. GF rejects a
// byte-identical (replayed) blackbox here with a 403 — mint a new one (drifted
// identity) per call. Reusing the sessions blackbox was the old "iovation is walled" bug.

import { z } from "zod";
import { readJson, SPARK_BASE, sparkFetch, sparkHeaders, type SparkRequest } from "../http.ts";
import { AttestationRejectedError } from "../errors.ts";

const AttestResponse = z.object({ status: z.string() });

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
    headers: sparkHeaders({ ...opts, gfInstallationId: false }),
    body: JSON.stringify({
      accountId: opts.accountId,
      blackbox: opts.blackbox,
      type: "play_now",
    }),
  };
}

/** Attest the device for an account. Resolves only when GF returns `status: "ok"`. */
export async function attestDevice(opts: AttestDeviceOptions): Promise<void> {
  const res = await sparkFetch(buildAttestRequest(opts));
  // A refusal is a 403 carrying `{"status":"failed"}` — no `message`/`errorTypes`, so it would
  // otherwise surface as a bare "unexpected response 403". The status is also checked on a 2xx:
  // the endpoint answers with a verdict, and only "ok" is one we can proceed on.
  if (res.status === 403) throw new AttestationRejectedError(opts.accountId);
  // Validated, so a renamed field can't masquerade as a refusal: `undefined !== "ok"` would
  // throw AttestationRejectedError and send you hunting a blackbox bug that isn't there.
  const { status } = await readJson(res, AttestResponse);
  if (status !== "ok") throw new AttestationRejectedError(opts.accountId);
}
