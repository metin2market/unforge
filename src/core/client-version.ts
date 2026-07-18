// The GameForge launcher advertises a client version (e.g. "2.1.22.784") that
// the auth flow must echo. The launcher reads it from its own exe's file
// version; we parse that string, and keep a known fallback for headless use.

import type { ClientVersion } from "./types.ts";

// Refresh when GF ships a new launcher — a stale version can be rejected.
// Read from gfclient.exe's FileVersion: "2.8.5.1959 (master@eda2b413)".
export const DEFAULT_CLIENT_VERSION: ClientVersion = {
  version: "2.8.5.1959",
  branch: "master",
  commitId: "eda2b413",
};

// Matches the launcher exe's FileVersion, e.g. "2.1.22.784 (default@6a28914b)".
const FILE_VERSION_RE = /(\d{1,2}\.\d{1,2}\.\d{1,2}\.\d{1,5}) \(((?:\w|-)+)@(\w+)\)/;

/** Parse a launcher FileVersion string, or undefined if it doesn't match. */
export function parseClientVersion(fileVersion: string): ClientVersion | undefined {
  const match = fileVersion.match(FILE_VERSION_RE);
  if (!match) return undefined;
  return { version: match[1], branch: match[2], commitId: match[3] };
}
