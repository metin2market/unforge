// Shared constants and response handling for the Spark HTTP API.

import type { z } from "zod";
import {
  NetworkError,
  RateLimitedError,
  ResponseShapeError,
  shapeIssues,
  UnauthorizedError,
  UnexpectedResponseError,
} from "./errors.ts";
import { parseJson } from "../util/index.ts";

/**
 * Every outbound call is bounded. Spark answers in well under a second in practice; the cap
 * only exists so a black-holed connection can't hang a launch forever, holding its handoff
 * pipe (and the code it already minted) open with it.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

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
  return sendRequest(req.url, { method: req.method, headers: req.headers, body: req.body });
}

/**
 * `fetch` with a timeout, and every transport failure normalised to {@link NetworkError}.
 * Use this for *any* outbound request — raw `fetch` rejects with a bare `TypeError` whose
 * message varies by runtime and platform, which is not something a frontend can classify.
 */
export async function sendRequest(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    // AbortSignal.timeout rejects with a DOMException named "TimeoutError"; everything else
    // (DNS, refused, reset, TLS) arrives as a TypeError.
    const timedOut = cause instanceof Error && cause.name === "TimeoutError";
    throw new NetworkError(url, timedOut, cause);
  }
}

/**
 * Parse and **validate** a JSON body on success; map common failures to typed errors.
 *
 * Every caller passes the schema for its endpoint, so a body that isn't what GameForge used to
 * send fails here, naming the field — rather than flowing on as `undefined` and failing later
 * as something it isn't (see {@link ResponseShapeError}). Two distinct failures: unparseable
 * (a proxy's HTML interstitial answering 2xx) is an `UnexpectedResponseError`; parseable but
 * the wrong shape is a `ResponseShapeError`.
 *
 * Schemas are non-strict on purpose. GameForge adds fields to these payloads over time and
 * unknown keys are simply dropped, so only a change to a field *we depend on* is an error —
 * which is what makes this signal worth acting on rather than noise to be suppressed.
 */
export async function readJson<S extends z.ZodType>(res: Response, schema: S): Promise<z.infer<S>> {
  if (res.ok) {
    const text = await safeText(res);
    const parsed = parseJson(text ?? "");
    if (parsed === undefined) throw new UnexpectedResponseError(res.status, res.statusText, text);
    const result = schema.safeParse(parsed);
    if (!result.success) throw new ResponseShapeError(res.url, shapeIssues(result.error), text);
    return result.data;
  }
  if (res.status === 401) throw new UnauthorizedError();
  if (res.status === 429) throw new RateLimitedError(retryAfterMs(res), await safeText(res));
  throw new UnexpectedResponseError(res.status, res.statusText, await safeText(res));
}

/**
 * Read a body as text, yielding undefined rather than throwing if it can't be read — **except**
 * when the read was aborted. The timeout stays armed while the body streams, so a stall after
 * the headers arrive would otherwise be swallowed here and re-reported as a malformed `200`
 * body. It's a transport failure, and it has to keep saying so.
 */
export async function safeText(res: Response): Promise<string | undefined> {
  try {
    return await res.text();
  } catch (cause) {
    const name = cause instanceof Error ? cause.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new NetworkError(res.url, name === "TimeoutError", cause);
    }
    return undefined;
  }
}

/**
 * `Retry-After` in either RFC 9110 form — delay-seconds (`120`) or an HTTP-date — as a
 * duration from now. Undefined when absent or unparseable; a negative date means "now".
 */
export function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}
