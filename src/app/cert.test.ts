import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GAMEFORGE_CERT_PEM } from "../core/index.ts";
import { resolveCertPem } from "./game.ts";

const CERT = "-----BEGIN CERTIFICATE-----\nMIIC...\n-----END CERTIFICATE-----\n";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unforge-cert-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("reads the default local materials path when it exists", async () => {
  const def = join(dir, "materials.pem");
  writeFileSync(def, CERT);
  const pem = await resolveCertPem({ defaultPath: def, bundled: "BUNDLED" });
  expect(pem).toBe(CERT);
});

test("falls back to the bundled cert when the default path is missing", async () => {
  const pem = await resolveCertPem({
    defaultPath: join(dir, "missing.pem"),
    bundled: "BUNDLED",
  });
  expect(pem).toBe("BUNDLED");
});

// A missing text import degrades to an empty string, not a build error — so assert the bytes.
test("the bundled cert is a real certificate", async () => {
  expect(GAMEFORGE_CERT_PEM).toContain("-----BEGIN CERTIFICATE-----");
  expect(GAMEFORGE_CERT_PEM).not.toContain("PRIVATE KEY");
  expect(GAMEFORGE_CERT_PEM.length).toBeGreaterThan(500);
  expect(await resolveCertPem({ defaultPath: join(dir, "missing.pem") })).toBe(GAMEFORGE_CERT_PEM);
});
