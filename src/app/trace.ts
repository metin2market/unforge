// Opt-in, in-process request trace for diagnosing the GameForge flow. Wraps the global
// `fetch` and appends one JSONL line per request/response to a file. This is the right tool
// for OUR OWN client: Bun's fetch ignores the Windows system proxy, so mitmproxy can't see
// it, and the logger redacts the very fields (blackbox/token/code) a diagnosis needs.
//
// UN-REDACTED by design — the file holds secrets (password, blackbox, token, login code), so
// keep it local and gitignored. Its shape matches scripts/captures/*.jsonl, so the same tools
// read it. Enable with `UNFORGE_TRACE=<path>` (see installFetchTraceFromEnv).

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { unforgeDataFile } from "../storage/index.ts";

/**
 * Where `--trace` writes when no path is given: one timestamped file per run, next to the log.
 * Per-run rather than appended, so two runs never interleave into an unreadable trail, and so
 * "the trace of the launch that failed" is a file you can point at.
 */
export function traceFilePath(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "");
  return unforgeDataFile("logs", `trace-${stamp}.jsonl`);
}

function headersToObject(h: HeadersInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(h ?? {}));
}

/**
 * Wrap `globalThis.fetch` so every call is appended to `filePath` as JSONL. Returns a
 * restore function that puts the original `fetch` back. The response is cloned before its
 * body is read, so callers still get an unconsumed body.
 */
export function installFetchTrace(filePath: string): () => void {
  const dir = dirname(filePath);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const original = globalThis.fetch;
  // Swapping `globalThis.fetch` means claiming its type; the wrapper is ours, not a payload.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : undefined;
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? req?.method ?? "GET";
    const reqHeaders = headersToObject(init?.headers ?? req?.headers);
    const reqBody = typeof init?.body === "string" ? init.body : undefined;
    const time = new Date().toISOString();

    const res = await original(input, init);
    let respBody: string | undefined;
    try {
      respBody = await res.clone().text();
    } catch {
      respBody = undefined; // body already consumed or not text — leave it out
    }

    try {
      const line = JSON.stringify({
        time,
        method,
        url,
        req_headers: reqHeaders,
        req_body: reqBody,
        status: res.status,
        resp_headers: Object.fromEntries(res.headers),
        resp_body: respBody,
      });
      appendFileSync(filePath, `${line}\n`);
    } catch {
      // A trace write must never break the actual request.
    }
    return res;
  }) as typeof fetch;

  return () => {
    globalThis.fetch = original;
  };
}

/** Install the trace if `UNFORGE_TRACE` names a file; a no-op otherwise. */
export function installFetchTraceFromEnv(): void {
  const path = process.env.UNFORGE_TRACE;
  if (path) installFetchTrace(path);
}
