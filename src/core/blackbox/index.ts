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
// `DeviceProfile` / `DeviceIdentity` are each a schema *and* the type it infers — both are
// persisted, so the schema is what validates them back off disk.
export {
  LAUNCHER_BROWSER_FIELDS,
  generateDeviceProfile,
  localeFor,
  DeviceProfile,
} from "./device.ts";
export { createDeviceIdentity, driftVector, DeviceIdentity } from "./identity.ts";
