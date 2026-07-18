// Shared constants and response handling for the Spark HTTP API.

import { UnauthorizedError, UnexpectedResponseError } from "./errors.ts";

export const SPARK_BASE = "https://spark.gameforge.com";

// The launcher rides on an embedded Chromium; most requests carry its UA.
// Matches the value the real launcher sends (gfclient 2.8.5).
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/72.0.3626.121 Safari/537.36";

// The launcher's web app runs under this origin; the auth API expects it.
export const SPARK_ORIGIN = "spark://www.gameforge.com";

/**
 * A fully-described Spark HTTP request. Each `spark/*` step builds one of these
 * as a pure function of its inputs (no I/O), so the exact URL, headers, and body
 * we send can be asserted against a captured launcher request without a network
 * call. {@link sparkFetch} dispatches it.
 */
export interface SparkRequest {
  url: string;
  method: "GET" | "POST" | "DELETE";
  headers: Record<string, string>;
  body?: string;
}

/** Dispatch a {@link SparkRequest} — the single place every Spark call hits the network. */
export function sparkFetch(req: SparkRequest): Promise<Response> {
  return fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
}

/** Parse a JSON body on success; map common failures to typed errors. */
export async function readJson<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  if (res.status === 401) throw new UnauthorizedError();
  throw new UnexpectedResponseError(res.status, res.statusText, await safeText(res));
}

async function safeText(res: Response): Promise<string | undefined> {
  try {
    return await res.text();
  } catch {
    return undefined;
  }
}
