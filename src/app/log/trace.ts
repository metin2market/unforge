// The request trace: every GameForge call, emitted into the normal log at `trace` level so the
// network sits inline with the steps that made it — one file, one chronology, read top to bottom.
// Wrapping `fetch` is the only way to see it: Bun's fetch ignores the Windows system proxy, so
// mitmproxy can't.
//
// Always on for the CLI — GF refusals are usually only diagnosable from the run that hit one, and
// there is no re-running a spent challenge. `trace` is below `debug`, so bodies reach the file sink
// and never the console, even under --verbose. Credentials are scrubbed (trace-scrub.ts); the
// protocol material a diagnosis reads stays raw, which keeps the log device-identifying.

import { getLogger } from "@logtape/logtape";
import { scrubBody, scrubHeaders } from "./trace-scrub.ts";

const log = getLogger(["unforge", "http"]);

function headersToObject(h: HeadersInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(h ?? {}));
}

/**
 * Wrap `globalThis.fetch` so every call is logged. Returns a restore function that puts the
 * original `fetch` back. The response is cloned before its body is read, so callers still get an
 * unconsumed body.
 *
 * The request is logged *before* dispatch, not folded into the response record: a call that hangs
 * or throws has to leave a mark, and the ordering is what makes the trail readable.
 */
export function installFetchTrace(): () => void {
  const original = globalThis.fetch;
  // Swapping `globalThis.fetch` means claiming its type; the wrapper is ours, not a payload.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : undefined;
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? req?.method ?? "GET";
    const startedAt = Date.now();

    // Every field is interpolated, not just carried: the text formatter renders the message
    // template and drops the rest, so a property left out of the template is a property that
    // never reaches the file.
    log.trace("→ {method} {url} {headers} {body}", {
      method,
      url,
      headers: JSON.stringify(scrubHeaders(headersToObject(init?.headers ?? req?.headers))),
      body: scrubBody(typeof init?.body === "string" ? init.body : undefined),
    });

    const res = await original(input, init);
    let body: string | undefined;
    try {
      body = await res.clone().text();
    } catch {
      body = undefined; // body already consumed or not text — leave it out
    }

    log.trace("← {status} {method} {url} ({ms}ms) {headers} {body}", {
      status: res.status,
      method,
      url,
      ms: Date.now() - startedAt,
      headers: JSON.stringify(scrubHeaders(Object.fromEntries(res.headers))),
      body: scrubBody(body),
    });
    return res;
  }) as typeof fetch;

  return () => {
    globalThis.fetch = original;
  };
}
