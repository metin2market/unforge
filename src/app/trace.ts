// Opt-in, in-process request trace for diagnosing the GameForge flow. Wraps the global
// `fetch` and appends one JSONL line per request/response to a file. This is the right tool
// for OUR OWN client: Bun's fetch ignores the Windows system proxy, so mitmproxy can't see
// it, and the logger redacts the very fields (blackbox/token/code) a diagnosis needs.
//
// UN-REDACTED by design — the file holds secrets (password, blackbox, token, login code), so
// keep it local and gitignored. Its shape matches scripts/captures/*.jsonl, so the same tools
// read it. Enable with `UNFORGE_TRACE=<path>` (see installFetchTraceFromEnv).

import { appendFileSync } from "node:fs";

function headersToObject(h: HeadersInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(h ?? {}));
}

/**
 * Wrap `globalThis.fetch` so every call is appended to `filePath` as JSONL. Returns a
 * restore function that puts the original `fetch` back. The response is cloned before its
 * body is read, so callers still get an unconsumed body.
 */
export function installFetchTrace(filePath: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : undefined;
    const url = req ? req.url : String(input);
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
