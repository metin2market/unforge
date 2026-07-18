import { afterEach, describe, expect, test } from "bun:test";
import { buildCreateGfAccountRequest, createGfAccount } from "./create-gf-account.ts";

const INSTALL = "5814f474-9054-4215-99fe-9a30baf46370";
const BB = "tra:AAAAExampleRawBlackbox";
const base = { email: "a@b.c", password: "pw", blackbox: BB, installationId: INSTALL };

describe("buildCreateGfAccountRequest", () => {
  test("POSTs /api/v2/users with both installation-id headers + Origin", () => {
    const req = buildCreateGfAccountRequest(base);
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://spark.gameforge.com/api/v2/users");
    expect(req.headers["TNT-Installation-Id"]).toBe(INSTALL);
    expect(req.headers["gf-installation-id"]).toBe(INSTALL);
    expect(req.headers["Origin"]).toBe("spark://www.gameforge.com");
  });

  test("body is email-first (not blackbox-first like sessions), locale defaults en-GB", () => {
    // Key order matters — the capture test asserts byte-identity against the launcher.
    expect(buildCreateGfAccountRequest(base).body).toBe(
      JSON.stringify({ email: "a@b.c", password: "pw", locale: "en-GB", blackbox: BB }),
    );
  });

  test("gf-challenge-id header is absent on attempt 1, present on the retry", () => {
    expect("gf-challenge-id" in buildCreateGfAccountRequest(base).headers).toBe(false);
    expect(
      buildCreateGfAccountRequest({ ...base, challengeId: "chal-1" }).headers["gf-challenge-id"],
    ).toBe("chal-1");
  });
});

describe("createGfAccount (409 → solve PoW → retry)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("solves the captcha the first attempt triggers and returns the new userId", async () => {
    let userPosts = 0;
    let retryHadChallengeHeader = false;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/v2/users") && method === "POST") {
        userPosts++;
        if (userPosts === 1) {
          return new Response(
            JSON.stringify({ errorTypes: ["CHALLENGE_REQUIRED"], challengeId: "chal-1" }),
            {
              status: 409,
              headers: { "gf-challenge-id": "chal-1" },
            },
          );
        }
        retryHadChallengeHeader = new Headers(init?.headers).get("gf-challenge-id") === "chal-1";
        return new Response(JSON.stringify({ userCreated: true, userId: "user-1" }), {
          status: 201,
        });
      }
      if (url.includes("/api/challenge/") && method === "GET") {
        // A trivial one-nonce puzzle so the real solver runs but returns instantly,
        // plus the instrumentation ops GF always sends alongside it.
        return new Response(
          JSON.stringify({
            pow: { algorithm: "sha-256", challenges: [{ salt: "aa", target: "0" }] },
            instrumentation: JSON.stringify([{ id: "op-1", type: "bitwise", code: "return 1;" }]),
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/challenge/") && method === "POST") {
        return new Response(JSON.stringify({ status: "solved" }), { status: 200 });
      }
      return new Response("<html></html>", {
        status: 200,
        headers: { "set-cookie": "pc_idt=x; Path=/" },
      });
    }) as unknown as typeof fetch;

    const created = await createGfAccount({ ...base, locale: "pt-PT" });
    expect(created.userId).toBe("user-1");
    expect(userPosts).toBe(2); // attempt + retry
    expect(retryHadChallengeHeader).toBe(true); // retry carried the solved challenge id
  });

  test("no captcha (direct 201) → returns userId without touching the challenge API", async () => {
    let challengeCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/api/challenge/")) challengeCalls++;
      if (url.endsWith("/api/v2/users") && (init?.method ?? "GET") === "POST") {
        return new Response(JSON.stringify({ userCreated: true, userId: "user-2" }), {
          status: 201,
        });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    expect((await createGfAccount(base)).userId).toBe("user-2");
    expect(challengeCalls).toBe(0);
  });
});
