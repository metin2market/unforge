// Generate a raw `tra:…` blackbox natively — no browser, no game1.js at runtime.
//
// game1.js only *collects* device signals then runs a trivial encoding over them.
// We supply the signals (device.ts + identity.ts) and reproduce the encoding:
//
//   values (fixed order) → JSON → encodeURIComponent → cumulative byte sum
//     → base64url (no padding) → prefix "tra:"
//
// The field order is game1's and is load-bearing: the blackbox is a positional
// JSON array, not an object. See docs/blackbox.md for the full derivation.

import type { DeviceProfile } from "./device.ts";
import { createDeviceIdentity, driftVector, type DeviceIdentity } from "./identity.ts";

/**
 * The `extraPayload` object (field 28). Only `thin/codes` carries it; `sessions`
 * and `iovation` send `null` there (verified against captured launcher blackboxes).
 */
export interface BlackboxRequest {
  /** Opaque feature flags; game1 sends `[randomInt]`. */
  features?: number[];
  /** The account's installation id (`TNT-Installation-Id`). */
  installation: string;
  /** The session id (`gsid`) without its `-NNNN` suffix. */
  session?: string;
}

export interface GenerateBlackboxOptions {
  profile: DeviceProfile;
  identity: DeviceIdentity;
  /**
   * Field 28. Omit for `sessions`/`iovation` (they send `null`); pass it only when
   * minting the `thin/codes` blackbox.
   */
  extraPayload?: BlackboxRequest;
  /** Injectable clock (epoch ms). Defaults to `Date.now`. */
  now?: () => number;
  /** Randomness, for the vector drift + collection jitter. Defaults to `Math.random`. */
  rand?: () => number;
  /** Server time to embed; defaults to "now" (game1 reads it from a Date header). */
  serverDate?: Date;
  /**
   * Force the identity vector to advance even if <1s since the last call. Set for
   * every privileged call after the first in a flow, so `iovation`/`thin/codes`
   * never send a vector identical to the previous step's (GF 403s a replayed vector).
   */
  forceVectorDrift?: boolean;
}

const SCHEMA_VERSION = 12; // game1: a0_0x4075f6 = 0xc
// Field 29: game1's environment bitmask from its automation probes (webdriver,
// _phantom, callPhantom, domAutomation, Headless…). 0x12000 is the launcher's CEF
// result — constant for this client, captured from real launcher blackboxes.
const AUTOMATION_FLAGS = 73728;
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_=";

/** base64url without padding, over raw bytes (game1's a0_0x2aa6eb inner encoder). */
function base64UrlNoPad(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63] + B64URL[n & 63];
  }
  const rem = bytes.length % 3;
  return rem > 0 ? out.slice(0, rem - 3) : out; // drop the chars for absent bytes
}

/**
 * The blackbox body cipher: URL-encode, then a running byte sum where each output
 * byte is the previous output byte plus the current input byte (mod 256), then
 * base64url. `encodeURIComponent` output is ASCII, so char codes are bytes.
 */
export function encodeBlackboxBody(json: string): string {
  const enc = encodeURIComponent(json);
  const bytes = new Uint8Array(enc.length);
  let prev = enc.charCodeAt(0);
  bytes[0] = prev;
  for (let i = 1; i < enc.length; i++) {
    prev = (prev + enc.charCodeAt(i)) & 0xff;
    bytes[i] = prev;
  }
  return base64UrlNoPad(bytes);
}

/** The 30 fingerprint values, in game1's exact positional order. */
function fingerprintValues(
  profile: DeviceProfile,
  identity: DeviceIdentity,
  extraPayload: BlackboxRequest | null,
  vecSignatureBase64: string,
  generatedAtIso: string,
  serverDateIso: string,
  collectionDurationMs: number,
): unknown[] {
  return [
    SCHEMA_VERSION,
    profile.timeZone,
    profile.osName,
    profile.browserName,
    profile.browserVendor,
    profile.deviceMemoryGb,
    profile.hardwareConcurrency,
    profile.languages,
    profile.pluginsHash,
    profile.webglVendorRenderer,
    profile.fontProbeHash,
    profile.audioContextHash,
    profile.screenAvailWidth,
    profile.screenAvailHeight,
    profile.videoCodecHash,
    profile.audioCodecHash,
    profile.mediaDeviceKindsHash,
    profile.permissionStatesHash,
    profile.offlineAudioFingerprint,
    profile.webglPixelHash,
    profile.canvasFingerprint,
    generatedAtIso,
    identity.clientId,
    collectionDurationMs,
    profile.osVersion,
    vecSignatureBase64,
    profile.userAgent,
    serverDateIso,
    extraPayload, // null for sessions/iovation; the request object for thin/codes
    AUTOMATION_FLAGS,
  ];
}

export interface GeneratedBlackbox {
  /** The `tra:…` blackbox for `sessions` / `iovation` / account creation. */
  blackbox: string;
  /** The identity to persist (its vector may have drifted). */
  identity: DeviceIdentity;
}

/** Build a fresh raw blackbox and return it with the (possibly drifted) identity. */
export function generateBlackbox(opts: GenerateBlackboxOptions): GeneratedBlackbox {
  const now = opts.now ?? Date.now;
  const rand = opts.rand ?? Math.random;
  const startedAt = now();

  const { identity, signed } = driftVector(opts.identity, startedAt, rand, opts.forceVectorDrift);
  const vecSignatureBase64 = Buffer.from(signed, "latin1").toString("base64");
  // game1 reads server time from the HTTP Date header — second precision, so floor.
  const serverMs = Math.floor((opts.serverDate?.getTime() ?? startedAt) / 1000) * 1000;
  const serverDateIso = new Date(serverMs).toISOString();
  const generatedAtIso = new Date(startedAt).toISOString();
  const collectionDurationMs = 1 + ((rand() * 40) | 0); // game1: real elapsed ms

  const extraPayload: BlackboxRequest | null = opts.extraPayload
    ? {
        features: opts.extraPayload.features ?? [(rand() * 0x7fffffff) | 0],
        installation: opts.extraPayload.installation,
        ...(opts.extraPayload.session !== undefined ? { session: opts.extraPayload.session } : {}),
      }
    : null;

  const values = fingerprintValues(
    opts.profile,
    identity,
    extraPayload,
    vecSignatureBase64,
    generatedAtIso,
    serverDateIso,
    collectionDurationMs,
  );

  return { blackbox: "tra:" + encodeBlackboxBody(JSON.stringify(values)), identity };
}

/**
 * A run of privileged GF calls that share one device. Each call needs its OWN freshly-generated
 * blackbox — never a byte-identical replay. GF's `iovation` 403s a replayed, non-vector-advanced
 * blackbox, and reusing one blackbox across `sessions` + `iovation` was the long-standing
 * "clientless is blocked" bug; `game1.js` re-runs per request and the real launcher mints a new
 * blackbox each time (new timestamps, drifting vector).
 *
 * This owns that rule so callers can't get it wrong: {@link next} advances the vector on every
 * call after the first and threads the identity forward internally. Persist {@link identity} after
 * the run to keep the device stable across logins.
 */
export interface BlackboxSequence {
  /** The next fresh blackbox for this flow. Pass `extraPayload` only when minting `thin/codes`. */
  next(extraPayload?: BlackboxRequest): string;
  /** The device identity to persist — its vector has drifted across the calls. */
  readonly identity: DeviceIdentity;
}

export interface BlackboxSequenceOptions {
  profile: DeviceProfile;
  /** Device identity to start from (persisted per account). A fresh one is minted if omitted. */
  identity?: DeviceIdentity;
  /** Injectable clock, forwarded to each {@link generateBlackbox}. Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable randomness, forwarded to each call. Defaults to `Math.random`. */
  rand?: () => number;
  /** Server time to embed; defaults to "now" per call. */
  serverDate?: Date;
}

/** Start a {@link BlackboxSequence} for one auth flow (see the interface for the freshness rule). */
export function createBlackboxSequence(opts: BlackboxSequenceOptions): BlackboxSequence {
  let identity = opts.identity ?? createDeviceIdentity(opts.now?.(), opts.rand);
  let calls = 0;
  return {
    next(extraPayload) {
      const gen = generateBlackbox({
        profile: opts.profile,
        identity,
        extraPayload,
        // First call rides the natural time-based drift; every call after it MUST advance the
        // vector past the previous one, or GF sees a replay.
        forceVectorDrift: calls > 0,
        now: opts.now,
        rand: opts.rand,
        serverDate: opts.serverDate,
      });
      identity = gen.identity;
      calls += 1;
      return gen.blackbox;
    },
    get identity() {
      return identity;
    },
  };
}
