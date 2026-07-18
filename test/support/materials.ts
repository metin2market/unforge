// Loader for the extracted client certificate the account-hash test needs. The
// cert is private (gitignored, kept in ~/unforge-materials/) so this returns
// undefined when absent and the tests that need it skip. Override the path with
// UNFORGE_CERT_PEM (same env var smoke.ts uses).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The launcher's PEM certificate, or undefined if not present locally. */
export function loadCertPem(): string | undefined {
  const path = process.env.UNFORGE_CERT_PEM || join(homedir(), "unforge-materials", "cert.pem");
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}
