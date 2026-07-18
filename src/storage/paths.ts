// Where unforge keeps its per-user files. The sealed account store, the config, and the logs all
// nest under `<localAppData>\unforge\`; this is the one place that resolves that root, so the
// convention lives in a single spot. Safe writing to these files lives next door in atomic-write.ts.

import { join } from "node:path";

/** `%LOCALAPPDATA%` (or `%USERPROFILE%\AppData\Local` when it's unset) — always a path. */
function localAppDataDir(): string {
  return process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? ".", "AppData", "Local");
}

/** `<localAppData>\unforge` — the per-user data root every unforge file nests under. */
export function unforgeDataDir(): string {
  return join(localAppDataDir(), "unforge");
}

/** A path under {@link unforgeDataDir}, e.g. `unforgeDataFile("accounts.dat")`. */
export function unforgeDataFile(...segments: string[]): string {
  return join(unforgeDataDir(), ...segments);
}
