// Decoder for a `tra:…` blackbox — the inverse of blackbox/generate.ts, used by
// the capture-backed tests to read what a *real* launcher blackbox carries and to
// prove our encoder reproduces it. (Production has no need to decode; this stays
// in test support.)

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_=";

/** base64url (no padding) → bytes, dropping the bytes for absent trailing chars. */
function b64urlDecode(body: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i += 4) {
    const c = [0, 1, 2, 3].map((k) => B64URL.indexOf(body[i + k] ?? "A"));
    const n = (c[0] << 18) | (c[1] << 12) | (c[2] << 6) | c[3];
    bytes.push((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  }
  const rem = body.length % 4 ? (body.length % 4) - 1 : 0;
  return rem ? bytes.slice(0, bytes.length - (3 - rem)) : bytes;
}

/** Reverse the body cipher: base64url → undo the running byte sum → URL-decode. */
export function decodeBlackboxBody(body: string): string {
  const sum = b64urlDecode(body);
  let uri = String.fromCharCode(sum[0]);
  for (let i = 1; i < sum.length; i++) {
    uri += String.fromCharCode((sum[i] - sum[i - 1] + 0x100) & 0xff);
  }
  return decodeURIComponent(uri);
}

/** Decode a full `tra:…` blackbox to its positional field array. */
export function decodeBlackbox(tra: string): unknown[] {
  return JSON.parse(decodeBlackboxBody(tra.replace(/^tra:/, ""))) as unknown[];
}
