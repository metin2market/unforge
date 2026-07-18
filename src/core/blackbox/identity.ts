// The bits of the fingerprint game1.js persists in localStorage and mutates over
// time, so the device looks continuous across logins: a stable client id ("x-game")
// and a slowly-drifting 100-char "vector" ("x-vec") that advances by one character
// roughly once a second. We hold them explicitly so the caller can persist one per
// account: a device that looks continuous across logins draws less attention than one
// that appears new every time.

const VECTOR_LENGTH = 100; // game1: a0_0x1c6b63 = 0x64
const VECTOR_STEP_MS = 1000; // game1: advance the vector if older than 0x3e8 ms
const CLIENT_ID_CHUNKS = 3; // game1: a0_0x4c1453(0x3)

export interface DeviceIdentity {
  /** Stable per-device id (game1's "x-game"). */
  clientId: string;
  /** The drifting vector body — VECTOR_LENGTH printable chars (game1's "x-vec"). */
  vector: string;
  /** Epoch ms stamped into the vector; advances when the vector drifts. */
  vectorUpdatedAt: number;
}

/** A printable ASCII char in game1's range: 0x20–0x7d (`0x20 + rand*0x5e`). */
function randomVectorChar(rand: () => number): string {
  return String.fromCharCode(0x20 + ((rand() * 0x5e) | 0));
}

/** game1's client id: CLIENT_ID_CHUNKS × base-36 fragments, concatenated. */
function randomClientId(rand: () => number): string {
  let id = "";
  for (let i = 0; i < CLIENT_ID_CHUNKS; i++) id += rand().toString(36).substring(2, 11);
  return id;
}

/** Mint a fresh identity. Persist it and reuse it for the same account. */
export function createDeviceIdentity(
  now: number = Date.now(),
  rand: () => number = Math.random,
): DeviceIdentity {
  let vector = "";
  for (let i = 0; i < VECTOR_LENGTH; i++) vector += randomVectorChar(rand);
  return { clientId: randomClientId(rand), vector, vectorUpdatedAt: now };
}

/**
 * Advance the vector if it's older than a step, mirroring game1: drop the first
 * char, append a fresh one, restamp to `now`. Returns the identity to persist and
 * the exact string that gets signed into the blackbox (`vector + " " + stamp`).
 *
 * `force` advances regardless of elapsed time. Each privileged call in one flow
 * MUST send a vector that has moved on from the previous call's — GF's `iovation`
 * rejects a non-advanced (replayed) vector — but back-to-back calls land inside the
 * same 1s step, so the flow forces the drift (as game1/the Go reference effectively do).
 */
export function driftVector(
  identity: DeviceIdentity,
  now: number,
  rand: () => number = Math.random,
  force = false,
): { identity: DeviceIdentity; signed: string } {
  let { vector, vectorUpdatedAt } = identity;
  if (force || vectorUpdatedAt + VECTOR_STEP_MS < now) {
    vector = vector.slice(1) + randomVectorChar(rand);
    vectorUpdatedAt = now;
  }
  return {
    identity: { ...identity, vector, vectorUpdatedAt },
    signed: `${vector} ${vectorUpdatedAt}`,
  };
}
