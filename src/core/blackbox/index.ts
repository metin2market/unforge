// Blackbox — the iovation device fingerprint. The raw `tra:…` value is generated
// natively (no browser) by reproducing game1.js's field set + encoding; the
// encrypted form for thin/codes is derived from it. See docs/blackbox.md.

export { encryptBlackbox, decryptBlackbox } from "./encrypt.ts";
export {
  generateBlackbox,
  createBlackboxSequence,
  encodeBlackboxBody,
  type BlackboxRequest,
  type GenerateBlackboxOptions,
  type GeneratedBlackbox,
  type BlackboxSequence,
  type BlackboxSequenceOptions,
} from "./generate.ts";
export { LAUNCHER_BROWSER_FIELDS, generateDeviceProfile, type DeviceProfile } from "./device.ts";
export { createDeviceIdentity, driftVector, type DeviceIdentity } from "./identity.ts";
