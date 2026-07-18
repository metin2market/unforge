// A virtual device: the fields iovation's `game1.js` collects from a real browser.
// We don't run a browser — we describe a plausible, *stable* device and let the
// generator encode it. The values need only be well-formed and consistent per
// account (a churny fingerprint is a red-bar trigger); they are not verified by GF
// against a real device. Field set + order are pinned to game1.js (see
// docs/blackbox.md); the hashes are opaque device-derived digests.
//
// There is deliberately NO ready-made default device: a shared fingerprint correlates
// every account that uses it, so callers always mint a distinct one via
// {@link generateDeviceProfile}. Only the browser-*class* fields every genuine launcher
// reports identically are a fixed constant ({@link LAUNCHER_BROWSER_FIELDS}).

import { randomBytes, randomInt } from "node:crypto";
import { z } from "zod";
import { BROWSER_USER_AGENT } from "../http.ts";

/**
 * A schema rather than an interface because a profile is **persisted and then re-read** to
 * generate blackboxes. A field missing from an older store would otherwise encode as
 * `undefined` into the fingerprint — a malformed blackbox GameForge refuses, with the refusal
 * pointing anywhere but here.
 */
export const DeviceProfile = z.object({
  /** IANA zone, e.g. "Europe/London". */
  timeZone: z.string(),
  osName: z.string(),
  /** OS version string as the browser reports it, e.g. "10". */
  osVersion: z.string(),
  browserName: z.string(),
  /** `navigator.vendor`, e.g. "Google Inc.". */
  browserVendor: z.string(),
  userAgent: z.string(),
  /** `navigator.deviceMemory` (GB). */
  deviceMemoryGb: z.number(),
  hardwareConcurrency: z.number(),
  /** `navigator.languages` joined by ",", e.g. "en-US,en". */
  languages: z.string(),
  screenAvailWidth: z.number(),
  screenAvailHeight: z.number(),
  /** WebGL "vendor,renderer", e.g. "Google Inc. (NVIDIA),ANGLE (NVIDIA, …)". */
  webglVendorRenderer: z.string(),

  // Opaque device-derived digests. game1.js computes them from live browser
  // signals (SHA-256 hex for the *Hash fields; numeric sums for the audio/canvas
  // fingerprints). For a virtual device they are fixed, plausible constants.
  pluginsHash: z.string(),
  fontProbeHash: z.string(),
  audioContextHash: z.string(),
  videoCodecHash: z.string(),
  audioCodecHash: z.string(),
  mediaDeviceKindsHash: z.string(),
  permissionStatesHash: z.string(),
  webglPixelHash: z.string(),
  offlineAudioFingerprint: z.number(),
  canvasFingerprint: z.number(),
});
export type DeviceProfile = z.infer<typeof DeviceProfile>;

/**
 * The browser-*class* fields every genuine GF launcher (CEF/Chrome-72) reports identically —
 * protocol facts, not a choice: the UA, `pluginsHash` = SHA-256 of `[]` (CEF's empty plugin
 * list), OS, and vendor. The UA is the same string we send as a header, imported so the two
 * can't drift; a mismatch between them is a tell.
 *
 * A `DeviceProfile` is these fields plus the synthetic per-device fields
 * {@link generateDeviceProfile} mints. Exposed as a `Pick` on purpose: it is **not** a usable
 * profile, so there's no canned device to fall back on. (`timeZone`/`languages` are held fixed
 * here too — GF doesn't check them, and per-account locale variation is a possible later refinement.)
 */
export const LAUNCHER_BROWSER_FIELDS: Pick<
  DeviceProfile,
  | "timeZone"
  | "osName"
  | "osVersion"
  | "browserName"
  | "browserVendor"
  | "userAgent"
  | "languages"
  | "pluginsHash"
> = {
  timeZone: "Europe/London",
  osName: "Windows",
  osVersion: "10",
  browserName: "Chrome",
  browserVendor: "Google Inc.",
  userAgent: BROWSER_USER_AGENT,
  languages: "en-GB,en",
  pluginsHash: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
};

// GPUs a real Windows/Chrome desktop plausibly reports through ANGLE. One is picked
// per generated profile; the string shape matches game1's `webglVendorRenderer`.
const GPU_RENDERERS = [
  "Google Inc.,ANGLE (NVIDIA GeForce RTX 3060 Ti Direct3D11 vs_5_0 ps_5_0)",
  "Google Inc.,ANGLE (AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0)",
  "Google Inc.,ANGLE (Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0)",
  "Google Inc.,ANGLE (NVIDIA GeForce GTX 1660 Ti Direct3D11 vs_5_0 ps_5_0)",
] as const;

/**
 * Mint a plausible-but-**distinct** device profile — one per GameForge account, so
 * separate accounts never emit byte-identical fingerprints (which would correlate
 * them). Persist it and reuse it for that account forever — a fingerprint that
 * changes between logins is itself a flag.
 *
 * **Varies** the device-derived hashes and the hardware they describe — GPU, screen,
 * RAM, cores (GF doesn't verify these against a real device; they only need to be
 * well-formed and stable per account). **Keeps constant** the
 * {@link LAUNCHER_BROWSER_FIELDS} — `userAgent`, `browserName`, OS, locale, and
 * `pluginsHash`: every genuine GF launcher is the same CEF/Chrome-72 build reporting
 * the same empty plugin list, so varying those would be the tell, not the reverse —
 * and the UA must match the header we send.
 */
export function generateDeviceProfile(): DeviceProfile {
  const hex = (): string => randomBytes(32).toString("hex");
  const pick = <T>(a: readonly T[]): T => a[randomInt(a.length)];
  return {
    ...LAUNCHER_BROWSER_FIELDS,
    deviceMemoryGb: pick([8, 16, 32]),
    hardwareConcurrency: pick([4, 8, 12, 16, 24]),
    screenAvailWidth: pick([1920, 2560, 3440, 1536]),
    screenAvailHeight: pick([1080, 1392, 1440, 864]),
    webglVendorRenderer: pick(GPU_RENDERERS),
    fontProbeHash: hex(),
    audioContextHash: hex(),
    videoCodecHash: hex(),
    audioCodecHash: hex(),
    mediaDeviceKindsHash: hex(),
    permissionStatesHash: hex(),
    webglPixelHash: hex(),
    offlineAudioFingerprint: 124 + Math.random(),
    canvasFingerprint: randomInt(2 ** 31),
  };
}
