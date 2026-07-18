// Generate src/core/embedded-cert.ts — the launcher's public client-cert PEM baked in so
// the CLI works without `unforge config set cert-path`. The file is **gitignored**
// (generated, never committed), so the public repo ships none of GameForge's bytes; the
// compiled binary and `bun dev` read it locally. `bun run build` runs this before
// compiling; a `postinstall` runs it after install (writing an empty stub if no cert is
// found, so imports resolve on a clean clone).
//
// Cert source (first found): --cert <path> | UNFORGE_CERT_PEM | ~/unforge-materials/cert.pem
// Clear it again with: bun scripts/embed-cert.ts --clear
// Run: bun run embed-cert

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TARGET = join(import.meta.dir, "..", "src", "core", "embedded-cert.ts");

const HEADER = `// GENERATED + gitignored — do not commit. Written by scripts/embed-cert.ts.
// The launcher's GF-shared, PUBLIC client-cert PEM: the one input the \`thin/codes\`
// account-hash UA needs (docs/protocol.md → "MAGIC"). It's a public certificate (no
// private key) and constant across GF titles, so baking it in is safe; reference tools
// (stdLemon/nostale-auth) hardcode the same cert. Kept out of the committed source so the
// public repo ships none of GameForge's bytes. Empty → callers fall back to the default
// local materials path (~/unforge-materials/cert.pem).\n`;

function write(pem: string): void {
  writeFileSync(TARGET, `${HEADER}export const EMBEDDED_CERT_PEM = ${JSON.stringify(pem)};\n`);
}

if (Bun.argv.includes("--clear")) {
  write("");
  console.log("cleared embedded cert (EMBEDDED_CERT_PEM is empty)");
  process.exit(0);
}

const argCert = Bun.argv.includes("--cert") ? Bun.argv[Bun.argv.indexOf("--cert") + 1] : undefined;
const candidates = [
  argCert,
  Bun.env.UNFORGE_CERT_PEM,
  join(homedir(), "unforge-materials", "cert.pem"),
].filter((p): p is string => !!p);

const source = candidates.find((p) => existsSync(p));
if (!source) {
  // No materials (e.g. a clean clone): write an empty stub so the import still resolves;
  // the CLI then needs `unforge config set cert-path`.
  write("");
  console.warn(`no cert found (looked at: ${candidates.join(", ")}) — wrote an empty stub`);
  process.exit(0);
}

const pem = readFileSync(source, "utf8");
if (!pem.includes("BEGIN CERTIFICATE")) {
  console.error(`error: ${source} does not look like a PEM certificate`);
  process.exit(1);
}

write(pem);
console.log(`embedded cert from ${source} → src/core/embedded-cert.ts (${pem.length} bytes)`);
