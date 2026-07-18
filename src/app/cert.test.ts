import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const pem = await resolveCertPem({ defaultPath: def, embedded: "BAKED" });
  expect(pem).toBe(CERT);
});

test("falls back to the baked-in cert when the default path is missing", async () => {
  const pem = await resolveCertPem({
    defaultPath: join(dir, "missing.pem"),
    embedded: "BAKED-INTO-BINARY",
  });
  expect(pem).toBe("BAKED-INTO-BINARY");
});

test("throws when neither the default path nor a baked cert is available", () => {
  expect(resolveCertPem({ defaultPath: join(dir, "missing.pem"), embedded: "" })).rejects.toThrow(
    /no cert available/,
  );
});
