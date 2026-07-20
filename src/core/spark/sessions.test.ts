import { afterEach, describe, expect, test } from "bun:test";
import { createSession } from "./sessions.ts";
import { CaptchaRequiredError, InvalidCredentialsError } from "../errors.ts";

// Exercises how createSession maps GF's responses to typed errors, by stubbing
// the network with constructed Response objects (no real request).

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stub(res: Response): void {
  globalThis.fetch = (async () => res) as unknown as typeof fetch;
}

const opts = {
  email: "a@b.c",
  password: "pw",
  blackbox: "tra:AAAA",
  installationId: "5814f474-9054-4215-99fe-9a30baf46370",
  locale: "pt-PT",
} as const;

describe("createSession response handling", () => {
  test("201 → returns the bearer token", async () => {
    stub(new Response(JSON.stringify({ token: "the-token" }), { status: 201 }));
    expect(await createSession(opts)).toBe("the-token");
  });

  // Login is captcha-gated under risk-scoring, so a challenge is solved and the login
  // retried rather than surfaced — see docs/pow-captcha.md.
  test("409 with gf-challenge-id → solves the captcha and retries the login", async () => {
    let logins = 0;
    const retry: { challenge: string | null } = { challenge: null };
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/sessions") && method === "POST") {
        logins++;
        if (logins === 1) {
          return new Response(JSON.stringify({ errorTypes: ["CHALLENGE_REQUIRED"] }), {
            status: 409,
            headers: { "gf-challenge-id": "abc-challenge;dropdead" },
          });
        }
        retry.challenge = new Headers(init?.headers).get("gf-challenge-id");
        return new Response(JSON.stringify({ token: "the-token" }), { status: 201 });
      }
      if (url.includes("/api/challenge/") && method === "GET") {
        return new Response(
          JSON.stringify({
            pow: { algorithm: "sha-256", challenges: [{ salt: "z", target: "0" }] },
            instrumentation: JSON.stringify([{ id: "op-1", type: "bitwise", code: "return 1;" }]),
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/challenge/"))
        return new Response(JSON.stringify({ status: "solved" }), { status: 200 });
      return new Response("<html></html>", { status: 200 });
    }) as unknown as typeof fetch;

    expect(await createSession(opts)).toBe("the-token");
    expect(logins).toBe(2);
    expect(retry.challenge).toBe("abc-challenge");
  });

  test("a challenge that survives the retry → CaptchaRequiredError (not a silent loop)", async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/sessions") && method === "POST") {
        return new Response(JSON.stringify({ errorTypes: ["CHALLENGE_REQUIRED"] }), {
          status: 409,
          headers: { "gf-challenge-id": "abc-challenge;dropdead" },
        });
      }
      if (url.includes("/api/challenge/") && method === "GET") {
        return new Response(
          JSON.stringify({
            pow: { algorithm: "sha-256", challenges: [{ salt: "z", target: "0" }] },
            instrumentation: JSON.stringify([{ id: "op-1", type: "bitwise", code: "return 1;" }]),
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/challenge/"))
        return new Response(JSON.stringify({ status: "solved" }), { status: 200 });
      return new Response("<html></html>", { status: 200 });
    }) as unknown as typeof fetch;

    const err = await createSession(opts).catch((e) => e);
    expect(err).toBeInstanceOf(CaptchaRequiredError);
    expect((err as CaptchaRequiredError).challengeId).toBe("abc-challenge");
  });

  test("409 CREDENTIALS_INVALID (no challenge header) → InvalidCredentialsError", async () => {
    stub(new Response(JSON.stringify({ errorTypes: ["CREDENTIALS_INVALID"] }), { status: 409 }));
    const err = await createSession(opts).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidCredentialsError);
  });

  test("403 → InvalidCredentialsError", async () => {
    stub(new Response("", { status: 403 }));
    const err = await createSession(opts).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidCredentialsError);
  });
});
