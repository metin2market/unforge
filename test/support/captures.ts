// Loader for the real launcher captures (scripts/captures/*.jsonl) that the
// capture-backed tests diff against. Those files are gitignored — they hold live
// tokens, the account password, and the device fingerprint — so this returns
// empty when they're absent (a clean clone / CI), letting tests `skip` instead
// of fail. Nothing here is committed with real data.
//
// A capture is mitmproxy's JSONL: one request/response per line. Header casing is
// the proxy's, so all lookups here are case-insensitive.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const CAPTURES_DIR = resolve(import.meta.dir, "../../scripts/captures");

export interface CaptureEntry {
  file: string;
  time: number;
  method: string;
  url: string;
  /** Request headers with lowercased keys (proxy casing is not the launcher's). */
  reqHeaders: Record<string, string>;
  reqBody: string;
  status: number;
  respBody: string;
}

interface RawLine {
  time: number;
  method: string;
  url: string;
  req_headers: Record<string, string>;
  req_body: string;
  status: number;
  resp_body: string;
}

function lowerKeys(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) out[k.toLowerCase()] = v;
  return out;
}

let cache: CaptureEntry[] | undefined;

/** All request/response entries across every capture file (newest file first). */
export function loadCaptureEntries(): CaptureEntry[] {
  if (cache) return cache;
  if (!existsSync(CAPTURES_DIR)) return (cache = []);
  const files = readdirSync(CAPTURES_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .toSorted()
    .toReversed();
  const entries: CaptureEntry[] = [];
  for (const file of files) {
    const text = readFileSync(join(CAPTURES_DIR, file), "utf8");
    for (const line of text.trim().split("\n")) {
      if (!line) continue;
      const raw = JSON.parse(line) as RawLine;
      // Captures also hold non-HTTP records (e.g. `clienthello` TLS diagnostics)
      // with no url/method — skip them; only request/response entries are diffable.
      if (!raw.url || !raw.method) continue;
      entries.push({
        file,
        time: raw.time,
        method: raw.method,
        url: raw.url,
        reqHeaders: lowerKeys(raw.req_headers),
        reqBody: raw.req_body,
        status: raw.status,
        respBody: raw.resp_body,
      });
    }
  }
  return (cache = entries);
}

/** True when at least one capture file is present locally. */
export function hasCaptures(): boolean {
  return loadCaptureEntries().length > 0;
}

/** Every entry matching a URL substring + method (default POST). */
export function findRequests(
  urlIncludes: string,
  opts: { method?: string; status?: number } = {},
): CaptureEntry[] {
  const method = opts.method ?? "POST";
  return loadCaptureEntries().filter(
    (e) =>
      e.url.includes(urlIncludes) &&
      e.method === method &&
      (opts.status === undefined || e.status === opts.status),
  );
}

/** First entry matching a URL substring + method (default POST). */
export function findRequest(
  urlIncludes: string,
  opts: { method?: string; status?: number } = {},
): CaptureEntry | undefined {
  return findRequests(urlIncludes, opts)[0];
}

/** Case-insensitive request-header lookup. */
export function header(entry: CaptureEntry, name: string): string | undefined {
  return entry.reqHeaders[name.toLowerCase()];
}
