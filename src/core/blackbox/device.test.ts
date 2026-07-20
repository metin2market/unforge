import { expect, test } from "bun:test";
import { generateDeviceProfile, LAUNCHER_BROWSER_FIELDS } from "./device.ts";

test("generateDeviceProfile keeps the launcher-constant fields", () => {
  const p = generateDeviceProfile();
  // Every genuine GF launcher is the same CEF/Chrome-72 build, so these must not vary.
  expect(p.userAgent).toBe(LAUNCHER_BROWSER_FIELDS.userAgent);
  expect(p.browserName).toBe(LAUNCHER_BROWSER_FIELDS.browserName);
  expect(p.osName).toBe(LAUNCHER_BROWSER_FIELDS.osName);
  // CEF ships no plugins, so every genuine launcher reports SHA-256 of "[]" here
  // (pinned to a real capture in test/blackbox.capture.test.ts). A per-account value
  // would be a fingerprint no real launcher emits.
  expect(p.pluginsHash).toBe(LAUNCHER_BROWSER_FIELDS.pluginsHash);
});

test("the clock and languages come from the host", () => {
  const { timeZone, locale } = Intl.DateTimeFormat().resolvedOptions();
  const p = generateDeviceProfile();
  expect(p.timeZone).toBe(timeZone);
  // `navigator.languages`: the full tag, its bare language, then Chrome's en fallback for a
  // non-English UI. A tag with no zone beside it is the mismatch the host read avoids.
  expect(p.languages.startsWith(`${locale},${locale.split("-")[0].toLowerCase()}`)).toBe(true);
});

test("a profile describes a machine that could exist", () => {
  for (let i = 0; i < 50; i++) {
    const p = generateDeviceProfile();
    // Screen dimensions are a pair, not two independent draws. Picking them separately made
    // most generated devices impossible — 3440 wide by 864 tall is not a monitor.
    expect(["3440x1392", "2560x1392", "1920x1032", "1536x816", "1366x720"]).toContain(
      `${p.screenAvailWidth}x${p.screenAvailHeight}`,
    );
    expect(p.webglVendorRenderer).toContain("ANGLE");
    expect(p.deviceMemoryGb).toBe(8); // spec-clamped; 16 or 32 is a value no Chrome emits
    expect(p.hardwareConcurrency).toBeGreaterThan(0);
  }
});

test("no two profiles are the same device, even on the same hardware", () => {
  // Accounts *will* draw the same hardware — the pool is short — but they must never come out as
  // the same device, or iovation gets the link between them for free.
  const seen = new Set<string>();
  for (let i = 0; i < 80; i++) {
    const p = generateDeviceProfile();
    const fingerprint = [p.webglPixelHash, p.canvasFingerprint, p.fontProbeHash].join("|");
    expect(seen.has(fingerprint)).toBe(false);
    seen.add(fingerprint);
  }
});

test("hashes and fingerprints keep game1's shape", () => {
  const p = generateDeviceProfile();
  for (const h of [p.webglPixelHash, p.fontProbeHash, p.audioContextHash, p.videoCodecHash]) {
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  }
  expect(p.canvasFingerprint).toBeGreaterThanOrEqual(0);
  expect(p.canvasFingerprint).toBeLessThan(2 ** 31);
  // game1 reports this as ~124.0x.
  expect(p.offlineAudioFingerprint).toBeGreaterThanOrEqual(124);
  expect(p.offlineAudioFingerprint).toBeLessThan(125);
});
