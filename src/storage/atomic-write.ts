// Write a file without risking a torn/partial result: write a temp sibling, then rename over the
// target (rename is atomic on the same volume). Shared by the account store and the config — the
// two things that persist a whole file at once.

import { renameSync } from "node:fs";

/** Write `data` to `path` atomically via a temp file + rename. */
export async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${path}.tmp`;
  await Bun.write(tmp, data);
  renameSync(tmp, path);
}
