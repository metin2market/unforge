import { describe, expect, test } from "bun:test";
import {
  LAUNCHER_BROWSER_FIELDS,
  encryptBlackbox,
  decryptBlackbox,
} from "../src/core/blackbox/index.ts";
import { encodeBlackboxBody } from "../src/core/blackbox/generate.ts";
import { BROWSER_USER_AGENT } from "../src/core/http.ts";
import { decodeBlackbox } from "./support/blackbox-codec.ts";
import { findRequests, hasCaptures } from "./support/captures.ts";

// Ground-truth for the blackbox, checked against every REAL launcher blackbox in
// the captures (gitignored; skips when absent). This is what pins our native
// encoder + cipher to game1 — the byte-for-byte match docs/blackbox.md claims.
// Field indices mirror generate.ts::fingerprintValues. Capture access is inside
// test bodies (bun runs a skipped describe's factory, which would throw on an
// absent capture rather than skip).

const reencode = (tra: string) => "tra:" + encodeBlackboxBody(JSON.stringify(decodeBlackbox(tra)));

/** Every raw iovation `tra:` blackbox in the captures. */
const iovationBlackboxes = () =>
  findRequests("/auth/iovation", { status: 200 }).map(
    (e) => JSON.parse(e.reqBody).blackbox as string,
  );

/** Every thin/codes request body (holds the encrypted blackbox + gsid + account). */
const codesBodies = () =>
  findRequests("/thin/codes").map(
    (e) =>
      JSON.parse(e.reqBody) as { blackbox: string; gsid: string; platformGameAccountId: string },
  );

const d = describe.skipIf(!hasCaptures());

d("real iovation blackboxes (raw tra:)", () => {
  test("each decodes to game1's 30-field array; encoder reproduces it byte-for-byte", () => {
    const all = iovationBlackboxes();
    expect(all.length).toBeGreaterThan(0);
    for (const tra of all) {
      const f = decodeBlackbox(tra);
      expect(f).toHaveLength(30);
      expect(f[0]).toBe(12); // schemaVersion
      expect(f[29]).toBe(73728); // automationFlags — launcher CEF bitmask
      expect(f[27]).toMatch(/\.000Z$/); // serverDate: second precision
      expect(f[28]).toBeNull(); // extraPayload null for iovation
      expect(f[26]).toBe(BROWSER_USER_AGENT); // matches the UA header we send
      expect(reencode(tra)).toBe(tra); // game1 encoder oracle
    }
  });

  // A generated profile's per-device fields (GPU, screen, hashes) are synthetic, so they
  // must NOT equal the captured device — only the browser-*class* fields, which every
  // genuine launcher reports identically, still match. Those are the fixed
  // LAUNCHER_BROWSER_FIELDS; the per-device fields are checked for shape in the next test.
  test("LAUNCHER_BROWSER_FIELDS match the capture's browser-class fields", () => {
    const p = LAUNCHER_BROWSER_FIELDS;
    for (const tra of iovationBlackboxes()) {
      const f = decodeBlackbox(tra);
      expect(f[2]).toBe(p.osName);
      expect(f[3]).toBe(p.browserName);
      expect(f[4]).toBe(p.browserVendor);
      expect(f[8]).toBe(p.pluginsHash); // SHA-256 of "[]" — CEF ships no plugins
      expect(f[24]).toBe(p.osVersion);
      expect(f[26]).toBe(p.userAgent);
    }
  });

  test("per-device fields keep game1's index → field shape", () => {
    const hash = /^[0-9a-f]{64}$/;
    for (const tra of iovationBlackboxes()) {
      const f = decodeBlackbox(tra);
      for (const i of [1, 7, 9]) expect(typeof f[i]).toBe("string"); // timeZone, languages, GPU
      for (const i of [5, 6, 12, 13, 18, 20]) expect(typeof f[i]).toBe("number"); // RAM/cores/screen/audio/canvas
      // deviceMemory oracle: spec-clamped to a power of two ≤ 8, so DEVICE_MEMORY_GB is in range.
      expect([0.25, 0.5, 1, 2, 4, 8]).toContain(f[5] as number);
      for (const i of [10, 11, 14, 15, 16, 17, 19]) expect(f[i]).toMatch(hash); // opaque hashes
    }
  });
});

d("real thin/codes blackboxes (encrypted)", () => {
  test("each decrypts to a 30-field tra:; cipher + encoder reproduce it byte-for-byte", () => {
    const all = codesBodies();
    expect(all.length).toBeGreaterThan(0);
    for (const b of all) {
      const raw = decryptBlackbox(b.blackbox, b.gsid, b.platformGameAccountId);
      expect(raw.startsWith("tra:")).toBe(true);
      expect(decodeBlackbox(raw)).toHaveLength(30);
      expect(encryptBlackbox(raw, b.gsid, b.platformGameAccountId)).toBe(b.blackbox); // cipher oracle
      expect(reencode(raw)).toBe(raw); // game1 encoder oracle

      const extra = decodeBlackbox(raw)[28] as { installation: string; session: string };
      expect(b.gsid).toBe(`${extra.session}-${b.gsid.split("-").at(-1)}`); // session = gsid − suffix
    }
  });
});
