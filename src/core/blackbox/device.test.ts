import { expect, test } from "bun:test";
import { generateDeviceProfile, LAUNCHER_BROWSER_FIELDS } from "./device.ts";

test("generateDeviceProfile keeps the launcher-constant fields", () => {
  const p = generateDeviceProfile();
  // Every genuine GF launcher is the same CEF/Chrome-72 build, so these must not vary.
  expect(p.userAgent).toBe(LAUNCHER_BROWSER_FIELDS.userAgent);
  expect(p.browserName).toBe(LAUNCHER_BROWSER_FIELDS.browserName);
  expect(p.osName).toBe(LAUNCHER_BROWSER_FIELDS.osName);
  expect(p.languages).toBe(LAUNCHER_BROWSER_FIELDS.languages);
  // CEF ships no plugins, so every genuine launcher reports SHA-256 of "[]" here
  // (pinned to a real capture in test/blackbox.capture.test.ts). A per-account value
  // would be a fingerprint no real launcher emits.
  expect(p.pluginsHash).toBe(LAUNCHER_BROWSER_FIELDS.pluginsHash);
});

test("generateDeviceProfile varies the machine-distinct fields per account", () => {
  const a = generateDeviceProfile();
  const b = generateDeviceProfile();
  // The opaque hashes are 32 random bytes each → collision is astronomically unlikely.
  expect(a.webglPixelHash).not.toBe(b.webglPixelHash);
  expect(a.fontProbeHash).not.toBe(b.fontProbeHash);
  expect(a.canvasFingerprint).not.toBe(b.canvasFingerprint);
  // Hashes are well-formed 64-char lowercase hex.
  expect(a.webglPixelHash).toMatch(/^[0-9a-f]{64}$/);
});

test("generateDeviceProfile produces well-formed hardware values", () => {
  const p = generateDeviceProfile();
  expect(p.webglVendorRenderer).toContain("ANGLE");
  expect(p.deviceMemoryGb).toBeGreaterThan(0);
  expect(p.hardwareConcurrency).toBeGreaterThan(0);
  expect(p.screenAvailWidth).toBeGreaterThan(0);
});
