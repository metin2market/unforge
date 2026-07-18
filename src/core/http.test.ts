import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { readJson, sendRequest } from "./http.ts";
import {
  NetworkError,
  RateLimitedError,
  ResponseShapeError,
  UnauthorizedError,
  UnexpectedResponseError,
} from "./errors.ts";

// Stands in for a real endpoint schema: one required field, as `sessions`/`codes` have.
const Body = z.object({ a: z.number() });

// The shared response/transport handling every Spark step funnels through.

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("sendRequest", () => {
  test("a transport failure becomes a NetworkError naming the url, not a bare TypeError", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Unable to connect. Is the computer able to access the url?");
    }) as unknown as typeof fetch;

    const err = await sendRequest("https://spark.gameforge.com/api/v1/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).timedOut).toBe(false);
    expect((err as NetworkError).url).toContain("spark.gameforge.com");
  });

  test("a timeout is flagged as one, so it can be worded differently", async () => {
    globalThis.fetch = (async () => {
      const e = new Error("The operation timed out.");
      e.name = "TimeoutError";
      throw e;
    }) as unknown as typeof fetch;

    const err = await sendRequest("https://spark.gameforge.com/api/v1/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).timedOut).toBe(true);
  });

  test("a caller's own signal is respected rather than overridden by the timeout", async () => {
    let seen: AbortSignal | undefined;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen = init.signal ?? undefined;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const mine = new AbortController().signal;
    await sendRequest("https://spark.gameforge.com/api/v1/x", { signal: mine });
    expect(seen).toBe(mine);
  });
});

describe("readJson", () => {
  test("401 → UnauthorizedError", async () => {
    expect(readJson(new Response("nope", { status: 401 }), Body)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  // A captive portal or proxy answering 200 with HTML must not surface as a SyntaxError
  // from deep inside the parser.
  test("a 2xx carrying non-JSON → UnexpectedResponseError keeping the body", async () => {
    const err = await readJson(new Response("<html>nope</html>", { status: 200 }), Body).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UnexpectedResponseError);
    expect((err as UnexpectedResponseError).body).toContain("<html>");
  });

  test("429 → RateLimitedError carrying Retry-After as a duration", async () => {
    const err = await readJson(
      new Response("slow down", { status: 429, headers: { "retry-after": "120" } }),
      Body,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterMs).toBe(120_000);
  });

  test("429 without a Retry-After leaves the wait unknown rather than inventing one", async () => {
    const err = await readJson(new Response("slow down", { status: 429 }), Body).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterMs).toBeUndefined();
  });

  // The timeout stays armed while the body streams. A stall after the headers land used to be
  // swallowed and re-reported as a malformed 200 — it has to stay a transport failure.
  test("a timeout mid-body stays a NetworkError, not a bad-200", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start: (c) => c.enqueue(new TextEncoder().encode("{")), // headers sent, body never ends
          }),
          { status: 200 },
        ),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/`, {
        signal: AbortSignal.timeout(300),
      });
      const err = await readJson(res, Body).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NetworkError);
      expect((err as NetworkError).timedOut).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test("a 2xx carrying JSON parses", async () => {
    expect(await readJson(new Response(JSON.stringify({ a: 1 }), { status: 200 }), Body)).toEqual({
      a: 1,
    });
  });

  // The whole point of validating: without it `a` would be `undefined` here and fail somewhere
  // downstream as a different, plausible-looking bug.
  test("a 2xx whose shape moved → ResponseShapeError naming the field", async () => {
    const err = await readJson(new Response(JSON.stringify({ b: 1 }), { status: 200 }), Body).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ResponseShapeError);
    expect((err as ResponseShapeError).issues.join()).toContain("a");
    expect((err as ResponseShapeError).body).toContain('"b"');
  });

  // GameForge accretes fields; only a change to one we read is a problem.
  test("unknown keys are dropped, not rejected", async () => {
    expect(
      await readJson(
        new Response(JSON.stringify({ a: 1, addedLater: "x" }), { status: 200 }),
        Body,
      ),
    ).toEqual({ a: 1 });
  });
});
