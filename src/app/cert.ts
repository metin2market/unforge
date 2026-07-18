// Resolving the client cert the `thin/codes` account hash needs. A material with a
// lookup policy, so it sits here rather than in core — core just takes the PEM.

import { homedir } from "node:os";
import { join } from "node:path";
import { GAMEFORGE_CERT_PEM } from "../core/index.ts";

/** Overrides the bundled cert — the way to swap one in without a rebuild. */
export const DEFAULT_CERT_PATH = join(homedir(), "unforge-materials", "cert.pem");

/** The cert PEM: a local file if present, else the bundled one. */
export async function resolveCertPem(path: string = DEFAULT_CERT_PATH): Promise<string> {
  const file = Bun.file(path);
  return (await file.exists()) ? file.text() : GAMEFORGE_CERT_PEM;
}
