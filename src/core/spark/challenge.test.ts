import { afterEach, describe, expect, test } from "bun:test";
import {
  buildFetchChallengeRequest,
  buildSubmitChallengeRequest,
  POW_CAPTCHA_BASE,
  sendWithChallenge,
  solvePow,
  solveSubChallenge,
  type PowChallenge,
} from "./challenge.ts";
import type { SparkRequest } from "../http.ts";
import { sha256 } from "../crypto.ts";
import { UnforgeError } from "../errors.ts";

// The PoW is plain hashcash: sha256(salt+nonce) must start with `target`. These
// use tiny targets so the brute force is instant; the real 20-bit challenge is
// exercised against a live capture in test/requests.capture.test.ts.

describe("solveSubChallenge / solvePow", () => {
  test("finds a nonce whose sha256(salt+nonce) starts with the target", () => {
    const nonce = solveSubChallenge("deadbeef", "00");
    expect(sha256("deadbeef" + nonce).startsWith("00")).toBe(true);
  });

  test("returns the LEAST such nonce (deterministic)", () => {
    const salt = "abc123";
    const nonce = Number(solveSubChallenge(salt, "0"));
    for (let n = 0; n < nonce; n++) expect(sha256(salt + n).startsWith("0")).toBe(false);
    expect(sha256(salt + nonce).startsWith("0")).toBe(true);
  });

  test("solves every sub-challenge in a batch", () => {
    const pow: PowChallenge = {
      algorithm: "sha-256",
      challenges: [
        { salt: "aa", target: "00" },
        { salt: "bb", target: "0" },
        { salt: "cc", target: "00" },
      ],
    };
    const sol = solvePow(pow);
    expect(sol.map((s) => s.salt)).toEqual(["aa", "bb", "cc"]);
    for (let i = 0; i < sol.length; i++) {
      expect(sha256(sol[i].salt + sol[i].nonce).startsWith(pow.challenges[i].target)).toBe(true);
    }
  });

  test("throws on an unknown algorithm rather than guessing", () => {
    expect(() => solvePow({ algorithm: "scrypt", challenges: [] })).toThrow(UnforgeError);
  });

  test("rejects a non-hex target instead of looping forever", () => {
    expect(() => solveSubChallenge("salt", "zz")).toThrow(/invalid PoW target/);
    expect(() => solveSubChallenge("salt", "00FF")).toThrow(/invalid PoW target/);
  });
});

describe("challenge request builders", () => {
  const id = "de1b2085-5e00-41d5-9f68-9223440945b0";

  test("fetch is a GET to /api/challenge/<id> with the launcher UA + Referer", () => {
    const req = buildFetchChallengeRequest(id, "pt-PT");
    expect(req.method).toBe("GET");
    expect(req.url).toBe(`${POW_CAPTCHA_BASE}/api/challenge/${id}`);
    expect(req.headers["Referer"]).toBe(
      `${POW_CAPTCHA_BASE}/?challengeId=${id}&locale=pt-PT&parentOrigin=null`,
    );
    expect(req.body).toBeUndefined();
  });

  test("submit POSTs {pow, instrumentation, metrics} with the captcha Origin", () => {
    const submission = {
      pow: [{ salt: "aa", nonce: "7" }],
      instrumentation: [1, 2, 3],
      metrics: { solver: { path: "js", totalMs: 5, challengeMs: [5] } },
    };
    const req = buildSubmitChallengeRequest(id, "pt-PT", submission);
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${POW_CAPTCHA_BASE}/api/challenge/${id}`);
    expect(req.headers["Origin"]).toBe(POW_CAPTCHA_BASE);
    expect(JSON.parse(req.body!)).toEqual(submission);
  });
});

describe("sendWithChallenge (the generic 409 → solve → retry loop)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const action = (challengeId?: string): SparkRequest => ({
    url: "https://spark.gameforge.com/api/v2/users/me/accounts",
    method: "POST",
    headers: challengeId ? { "gf-challenge-id": challengeId } : {},
    body: "{}",
  });

  test("solves the captcha a 409 demands and retries with the challenge header", async () => {
    let attempts = 0;
    const retry: { challenge: string | null } = { challenge: null };
    let submitted: { instrumentation?: number[] } = {};
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/accounts") && method === "POST") {
        attempts++;
        if (attempts === 1) {
          return new Response("{}", { status: 409, headers: { "gf-challenge-id": "chal-9" } });
        }
        retry.challenge = new Headers(init?.headers).get("gf-challenge-id");
        return new Response(JSON.stringify({ accountId: "acc-1" }), { status: 201 });
      }
      if (url.includes("/api/challenge/") && method === "GET") {
        return new Response(
          JSON.stringify({
            pow: { algorithm: "sha-256", challenges: [{ salt: "z", target: "0" }] },
            // GF sends the instrumentation ops as a JSON-encoded string of code to eval.
            instrumentation: JSON.stringify([{ id: "op-1", type: "bitwise", code: "return 42;" }]),
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/challenge/")) {
        submitted = JSON.parse(init!.body as string);
        return new Response(JSON.stringify({ status: "solved" }), { status: 200 });
      }
      return new Response("", { status: 200, headers: { "set-cookie": "pc_idt=x" } });
    }) as unknown as typeof fetch;

    const res = await sendWithChallenge(action, "pt-PT");
    expect(res.status).toBe(201);
    expect(attempts).toBe(2);
    expect(retry.challenge).toBe("chal-9");
    // The submit must answer the challenge's own ops — GF rejects an absent or
    // stale instrumentation, and dropping the field is the bug this pins down.
    expect(submitted.instrumentation).toEqual([42]);
  });

  test("a 409 that is NOT a challenge is returned unchanged (no solve, no retry)", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      return new Response(JSON.stringify({ errorTypes: ["NAME_TAKEN"] }), { status: 409 });
    }) as unknown as typeof fetch;

    const res = await sendWithChallenge(action, "pt-PT");
    expect(res.status).toBe(409);
    expect(attempts).toBe(1); // fired once, not retried
  });
});
