import { afterEach, describe, expect, test } from "bun:test";
import { requestLoginCode } from "./codes.ts";
import { CodeNotAllowedError, UnexpectedResponseError } from "../errors.ts";
import { METIN2_GAME_ID } from "../metin2.ts";
import type { GameAccount } from "../types.ts";

// Exercises how requestLoginCode maps GF's responses to typed errors, by stubbing
// the network with constructed Response objects (no real request).

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stub(res: Response): void {
  globalThis.fetch = (async () => res) as unknown as typeof fetch;
}

const account: GameAccount = {
  id: "abcd1234-0000-0000-0000-000000000000",
  numericId: 109411749,
  displayName: "test",
  usernames: ["test"],
  gameId: METIN2_GAME_ID,
  gameName: "metin2",
  accountGroup: "pt",
  retired: false,
};

const opts = {
  token: "e4839df5-7906-4450-badc-46c0df84af31",
  account,
  installationId: "5814f474-9054-4215-99fe-9a30baf46370",
  clientVersion: { version: "2.8.5.1959", branch: "master", commitId: "eda2b413" },
  certificatePem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
  sessionId: "4f6b7f5a-ffcf-419a-a7be-f32422f7c1af",
  rawBlackbox: "tra:AAAA",
  region: "pt-PT" as const,
};

describe("requestLoginCode response handling", () => {
  test("201 → returns the login code", async () => {
    stub(new Response(JSON.stringify({ code: "the-code" }), { status: 201 }));
    expect(await requestLoginCode(opts)).toBe("the-code");
  });

  // GF's wording is the only signal; the body carries no errorTypes to match on.
  test('403 "Not allowed to create code" → CodeNotAllowedError', async () => {
    stub(
      new Response(JSON.stringify({ error: { message: "Not allowed to create code" } }), {
        status: 403,
      }),
    );
    expect(requestLoginCode(opts)).rejects.toBeInstanceOf(CodeNotAllowedError);
  });

  // A different 403 must not be flattened into the "wait ~18m" advice.
  test("an unrelated 403 stays an UnexpectedResponseError", async () => {
    stub(new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 }));
    const err = await requestLoginCode(opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnexpectedResponseError);
    expect(err).not.toBeInstanceOf(CodeNotAllowedError);
  });
});
