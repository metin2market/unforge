import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GAMEFORGE_CERT_PEM } from "../core/index.ts";
import { resolveCertPem } from "./cert.ts";

const CERT = "-----BEGIN CERTIFICATE-----\nMIIC...\n-----END CERTIFICATE-----\n";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unforge-cert-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("reads the local materials path when it exists", async () => {
  const path = join(dir, "materials.pem");
  writeFileSync(path, CERT);
  expect(await resolveCertPem(path)).toBe(CERT);
});

test("falls back to the bundled cert when the path is missing", async () => {
  expect(await resolveCertPem(join(dir, "missing.pem"))).toBe(GAMEFORGE_CERT_PEM);
});

// A missing text import degrades to an empty string, not a build error — so assert the bytes.
test("the bundled cert is a real certificate", () => {
  expect(GAMEFORGE_CERT_PEM).toContain("-----BEGIN CERTIFICATE-----");
  expect(GAMEFORGE_CERT_PEM).not.toContain("PRIVATE KEY");
  expect(GAMEFORGE_CERT_PEM.length).toBeGreaterThan(500);
});
