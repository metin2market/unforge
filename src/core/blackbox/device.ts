// A virtual device: the fields iovation's `game1.js` collects from a real browser. We don't run
// a browser — we describe a plausible, stable device and let the generator encode it. Field set
// + order are pinned to game1.js. See docs/blackbox.md.
//
// GameForge doesn't check these against real hardware, so the bar is coherence, not accuracy:
// a device that couldn't exist is worse than a boring one.
//
// No default device — one is minted per GameForge account and kept forever, since a fingerprint
// that changes between logins is itself a red-bar trigger.

import { randomBytes, randomInt } from "node:crypto";
import { z } from "zod";
import { BROWSER_USER_AGENT } from "../http.ts";

/** A schema, not an interface: profiles are persisted and re-read, and a field missing from an
 * older store would encode as `undefined` into the fingerprint — a blackbox GF refuses, blaming
 * anything but this. */
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

  // Opaque digests game1 computes from live browser signals; random per device here.
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
 * What every genuine GF launcher (CEF/Chrome-72) reports identically — protocol facts, not a
 * choice. `pluginsHash` is SHA-256 of `[]`, CEF's empty plugin list; the UA is imported so it
 * can't drift from the header we send.
 *
 * `timeZone`/`languages` are deliberately absent — they follow the account's region
 * ({@link localeFor}), since a Portuguese IP reporting a London clock is a geo mismatch.
 */
export const LAUNCHER_BROWSER_FIELDS: Pick<
  DeviceProfile,
  "osName" | "osVersion" | "browserName" | "browserVendor" | "userAgent" | "pluginsHash"
> = {
  osName: "Windows",
  osVersion: "10",
  browserName: "Chrome",
  browserVendor: "Google Inc.",
  userAgent: BROWSER_USER_AGENT,
  pluginsHash: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
};

/** Where a device lands when no region is known. Independent of `app`'s default region. */
const FALLBACK_REGION = "pt-PT";

/** IANA zone per region GF runs Metin2 in; unknown regions fall back rather than invent one. */
const TIME_ZONES: Record<string, string> = {
  "pt-PT": "Europe/Lisbon",
  "en-GB": "Europe/London",
  "de-DE": "Europe/Berlin",
  "es-ES": "Europe/Madrid",
  "fr-FR": "Europe/Paris",
  "it-IT": "Europe/Rome",
  "pl-PL": "Europe/Warsaw",
  "tr-TR": "Europe/Istanbul",
  "nl-NL": "Europe/Amsterdam",
  "ro-RO": "Europe/Bucharest",
  "hu-HU": "Europe/Budapest",
  "cs-CZ": "Europe/Prague",
  "da-DK": "Europe/Copenhagen",
  "el-GR": "Europe/Athens",
};

/** The clock and `navigator.languages` for `region`. Chrome appends the `en-US,en` fallback for
 * non-English locales. An unknown region falls back as a unit — a substituted zone beside the
 * original languages would just rebuild the mismatch. */
export function localeFor(region: string): Pick<DeviceProfile, "timeZone" | "languages"> {
  const timeZone = TIME_ZONES[region];
  if (!timeZone) return localeFor(FALLBACK_REGION);
  const lang = region.split("-")[0].toLowerCase();
  return {
    timeZone,
    languages: lang === "en" ? `${region},${lang}` : `${region},${lang},en-US,en`,
  };
}

/** Real (width, availHeight) pairs — panel minus the ~48px taskbar. Kept as pairs because
 * picking width and height independently produced 3440×864, which is not a monitor. */
const SCREENS = [
  [3440, 1392],
  [2560, 1392],
  [1920, 1032],
  [1536, 816],
  [1366, 720],
] as const;

/** `navigator.deviceMemory`: not the machine's RAM — the spec clamps it to a power of two ≤ 8,
 * so every box we model reports the same 8 (pinned to a capture in test/blackbox.capture.test.ts). */
const DEVICE_MEMORY_GB = 8;

/** A GPU with the core count it plausibly ships beside. Any of these drives any SCREEN. */
const GPUS = [
  { gpu: "NVIDIA GeForce RTX 4070", cores: 16 },
  { gpu: "NVIDIA GeForce RTX 4060 Ti", cores: 12 },
  { gpu: "NVIDIA GeForce RTX 4060", cores: 12 },
  { gpu: "NVIDIA GeForce RTX 3070", cores: 12 },
  { gpu: "NVIDIA GeForce RTX 3060", cores: 8 },
  { gpu: "NVIDIA GeForce RTX 2060", cores: 6 },
  { gpu: "NVIDIA GeForce GTX 1660 SUPER", cores: 6 },
  { gpu: "NVIDIA GeForce GTX 1650", cores: 6 },
  { gpu: "AMD Radeon RX 7600", cores: 8 },
  { gpu: "AMD Radeon RX 6700 XT", cores: 12 },
  { gpu: "AMD Radeon RX 6650 XT", cores: 12 },
  { gpu: "AMD Radeon RX 580", cores: 8 },
  { gpu: "Intel(R) Iris(R) Xe Graphics", cores: 8 },
  { gpu: "Intel(R) UHD Graphics 630", cores: 6 },
  { gpu: "Intel(R) UHD Graphics 620", cores: 4 },
] as const;

/**
 * Mint a plausible, distinct device profile — one per GameForge account, persisted and reused
 * forever. The opaque hashes are random: game1 derives them from live browser signals we can't
 * reproduce, and a random value is what stops two accounts reading as the same machine.
 * LAUNCHER_BROWSER_FIELDS stay constant — every genuine launcher is the same CEF build.
 */
export function generateDeviceProfile(region = FALLBACK_REGION): DeviceProfile {
  const { gpu, cores } = GPUS[randomInt(GPUS.length)];
  const [width, height] = SCREENS[randomInt(SCREENS.length)];
  const hex = (): string => randomBytes(32).toString("hex");
  return {
    ...LAUNCHER_BROWSER_FIELDS,
    ...localeFor(region),
    deviceMemoryGb: DEVICE_MEMORY_GB,
    hardwareConcurrency: cores,
    screenAvailWidth: width,
    screenAvailHeight: height,
    webglVendorRenderer: `Google Inc.,ANGLE (${gpu} Direct3D11 vs_5_0 ps_5_0)`,
    fontProbeHash: hex(),
    audioContextHash: hex(),
    videoCodecHash: hex(),
    audioCodecHash: hex(),
    mediaDeviceKindsHash: hex(),
    permissionStatesHash: hex(),
    webglPixelHash: hex(),
    // game1 reports this as ~124.0x.
    offlineAudioFingerprint: 124 + Math.random(),
    canvasFingerprint: randomInt(2 ** 31),
  };
}
