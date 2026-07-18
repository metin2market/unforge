import { afterEach, describe, expect, test } from "bun:test";
import { attestDevice } from "./iovation.ts";
import { AttestationRejectedError } from "../errors.ts";

// Exercises how attestDevice reads GF's verdict, by stubbing the network with
// constructed Response objects (no real request).

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stub(res: Response): void {
  globalThis.fetch = (async () => res) as unknown as typeof fetch;
}

const opts = {
  token: "e4839df5-7906-4450-badc-46c0df84af31",
  installationId: "5814f474-9054-4215-99fe-9a30baf46370",
  accountId: "abcd1234-0000-0000-0000-000000000000",
  blackbox: "tra:AAAA",
};

describe("attestDevice response handling", () => {
  test('200 {"status":"ok"} → resolves', async () => {
    stub(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
    await attestDevice(opts);
  });

  // The observed refusal: a 403 whose body carries no message/errorTypes, so it would
  // otherwise surface as a bare "unexpected response 403 Forbidden".
  test('403 {"status":"failed"} → AttestationRejectedError naming the account', async () => {
    stub(new Response(JSON.stringify({ status: "failed" }), { status: 403 }));
    const err = await attestDevice(opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AttestationRejectedError);
    expect((err as AttestationRejectedError).accountId).toBe(opts.accountId);
  });

  // A 2xx is not consent on its own — the endpoint answers with a verdict.
  test("200 with a non-ok status → AttestationRejectedError, not a silent pass", async () => {
    stub(new Response(JSON.stringify({ status: "failed" }), { status: 200 }));
    expect(attestDevice(opts)).rejects.toBeInstanceOf(AttestationRejectedError);
  });
});
