// How a region reads to a person. Every frontend goes through it (the CLI, the picker, and the
// web UI via serve/wire.ts), so none can describe the same account differently.

import { regionForGroup } from "../core/index.ts";

/** Takes the group so an unmapped one can name itself instead of rendering as a blank. */
export function regionLabel(accountGroup: string): string {
  return regionForGroup(accountGroup) ?? `group ${accountGroup} (no region)`;
}
