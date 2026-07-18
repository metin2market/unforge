import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFetchTrace } from "./trace.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("records each request/response as JSONL and restores fetch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "unforge-trace-"));
  const file = join(dir, "trace.jsonl");
  try {
    const mockFetch = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    globalThis.fetch = mockFetch;

    const restore = installFetchTrace(file);
    // Installing swaps fetch for the tracing wrapper, not the mock.
    expect(globalThis.fetch).not.toBe(mockFetch);
    const res = await fetch("https://spark.gameforge.com/api/v2/users", {
      method: "POST",
      headers: { "TNT-Installation-Id": "inst-1" },
      body: JSON.stringify({ email: "a@b.c" }),
    });
    // The wrapped fetch still returns a readable body (clone, not consume).
    expect(await res.json()).toEqual({ ok: true });
    restore();

    // After restore, the wrapped-over fetch (the mock) is back.
    expect(globalThis.fetch).toBe(mockFetch);

    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.method).toBe("POST");
    expect(entry.url).toBe("https://spark.gameforge.com/api/v2/users");
    expect(entry.req_headers["tnt-installation-id"]).toBe("inst-1");
    expect(entry.req_body).toBe(JSON.stringify({ email: "a@b.c" }));
    expect(entry.status).toBe(201);
    expect(JSON.parse(entry.resp_body)).toEqual({ ok: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
