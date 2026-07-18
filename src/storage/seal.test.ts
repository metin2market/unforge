import { afterEach, expect, test } from "bun:test";
import { sealSecret, unsealSecret } from "./seal.ts";

// The DPAPI round-trip needs Windows/PowerShell and is covered by account-store's
// "encrypted at rest" test. Here we exercise the UNFORGE_STORE_PLAINTEXT debug mode,
// which is pure and portable.

const KEY = "UNFORGE_STORE_PLAINTEXT";
afterEach(() => {
  delete process.env[KEY];
});

test("plaintext debug mode writes readable content and reads it back", async () => {
  process.env[KEY] = "1";
  const sealed = await sealSecret('{"hello":"world"}');
  expect(sealed.toString("utf8")).toContain('{"hello":"world"}');
  expect(await unsealSecret(sealed)).toBe('{"hello":"world"}');
});

test("a plaintext blob stays readable even after the flag is cleared (marker auto-detect)", async () => {
  process.env[KEY] = "1";
  const sealed = await sealSecret("payload");
  delete process.env[KEY];
  expect(await unsealSecret(sealed)).toBe("payload");
});
