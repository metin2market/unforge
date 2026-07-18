// The `thin/codes` blackbox is the raw `tra:…` blackbox encrypted and base64'd.
// The cipher is a symmetric XOR against a key derived from the request's gsid +
// account id — so the same function encrypts and (given base64→bytes) decrypts.
// Verified against a captured launcher request. Ported from GflessClient.

function keyFor(gsid: string, accountId: string): Uint8Array {
  // The key is the *hex string* of the SHA-512, taken as ASCII bytes (128 long).
  const hex = new Bun.CryptoHasher("sha512").update(`${gsid}-${accountId}`).digest("hex");
  return new TextEncoder().encode(hex);
}

function xor(bytes: Uint8Array, key: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const ki = i % key.length;
    out[i] = bytes[i] ^ key[ki] ^ key[key.length - ki - 1];
  }
  return out;
}

/** Encrypt the raw `tra:…` blackbox for a `thin/codes` request → base64. */
export function encryptBlackbox(rawBlackbox: string, gsid: string, accountId: string): string {
  const bytes = Uint8Array.from(rawBlackbox, (c) => c.charCodeAt(0));
  const enc = xor(bytes, keyFor(gsid, accountId));
  return Buffer.from(enc).toString("base64");
}

/** Inverse of {@link encryptBlackbox} — recover the raw `tra:…` blackbox. */
export function decryptBlackbox(encryptedBase64: string, gsid: string, accountId: string): string {
  const bytes = new Uint8Array(Buffer.from(encryptedBase64, "base64"));
  const dec = xor(bytes, keyFor(gsid, accountId));
  return String.fromCharCode(...dec);
}
