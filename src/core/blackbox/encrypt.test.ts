import { describe, expect, test } from "bun:test";
import { decryptBlackbox, encryptBlackbox } from "./encrypt.ts";

// The thin/codes blackbox cipher (XOR against sha512(gsid-accountId)) is
// symmetric and verified against a captured launcher request (decrypting the
// real thin/codes blackbox yields a `tra:…` string). Here we round-trip it.
describe("blackbox encrypt/decrypt", () => {
  const gsid = "4f6b7f5a-ffcf-419a-a7be-f32422f7c1af-5487";
  const accountId = "5814f474-9054-4215-99fe-9a30baf46370";
  const raw = "tra:JVqczf8kExampleRawBlackboxPayload==";

  test("encrypt → base64, decrypt is the inverse", () => {
    const enc = encryptBlackbox(raw, gsid, accountId);
    expect(enc).not.toBe(raw);
    expect(enc).toMatch(/^[A-Za-z0-9+/]+=*$/); // base64
    expect(decryptBlackbox(enc, gsid, accountId)).toBe(raw);
  });

  test("wrong gsid/account does not decrypt back", () => {
    const enc = encryptBlackbox(raw, gsid, accountId);
    expect(decryptBlackbox(enc, gsid, "00000000-0000-0000-0000-000000000000")).not.toBe(raw);
  });
});
