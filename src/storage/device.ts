// The device a GameForge account presents. One concept, one type: the installation id,
// the drifting iovation identity, and the hardware fingerprint are minted together,
// persisted together, and rolled together (`auth device regen`) — so they travel as one.
//
// It lives here rather than in `core` because the bundling is *our* rule, not GameForge's:
// the wire takes the three separately. What makes it a unit is that one GF account owns
// exactly one, stable forever and distinct from every other account's. See docs/blackbox.md.

import { z } from "zod";
import {
  createDeviceIdentity,
  DeviceIdentity,
  DeviceProfile,
  generateDeviceProfile,
  generateInstallationId,
} from "../core/index.ts";

export const Device = z.object({
  /** `TNT-Installation-Id`; must contain a digit — the account hash branches on the first. */
  installationId: z.string(),
  /** game1's `x-game` + `x-vec`; the vector drifts on every privileged call. */
  identity: DeviceIdentity,
  /** The hardware fingerprint (GPU, screen, RAM, and the opaque hashes). */
  profile: DeviceProfile,
});
export type Device = z.infer<typeof Device>;

/**
 * Mint a fresh, distinct device. There is no shared default to fall back on.
 *
 * `region` sets the clock and languages the device reports — a machine playing Portuguese
 * servers from a Portuguese IP should not report a London clock.
 */
export function createDevice(region?: string): Device {
  return {
    installationId: generateInstallationId(),
    identity: createDeviceIdentity(),
    profile: generateDeviceProfile(region),
  };
}
