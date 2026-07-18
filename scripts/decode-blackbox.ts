#!/usr/bin/env bun
// Decode a `tra:…` blackbox back to its 30 named fields — the inverse of
// blackbox/generate.ts, for debugging what a real (or generated) blackbox carries.
//
//   bun scripts/decode-blackbox.ts "tra:JVqczf8k…"     # decode one raw blackbox
//   bun scripts/decode-blackbox.ts --capture scripts/captures/gf-….jsonl
//        ↑ pull the iovation blackbox and the (decrypted) thin/codes one from a
//          capture (see gf-capture.py) and print both, side by side with the diff.

import { decryptBlackbox } from "../src/core/blackbox/encrypt.ts";

// game1's positional field order (see blackbox/generate.ts fingerprintValues).
const FIELD_NAMES = [
  "schemaVersion",
  "timeZone",
  "osName",
  "browserName",
  "browserVendor",
  "deviceMemoryGb",
  "hardwareConcurrency",
  "languages",
  "pluginsHash",
  "webglVendorRenderer",
  "fontProbeHash",
  "audioContextHash",
  "screenAvailWidth",
  "screenAvailHeight",
  "videoCodecHash",
  "audioCodecHash",
  "mediaDeviceKindsHash",
  "permissionStatesHash",
  "offlineAudioFingerprint",
  "webglPixelHash",
  "canvasFingerprint",
  "generatedAtIso",
  "clientId",
  "collectionDurationMs",
  "osVersion",
  "vecSignatureB64",
  "userAgent",
  "serverDateIso",
  "extraPayload",
  "automationFlags",
];

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_=";

function b64urlDecode(s: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i += 4) {
    const c = [0, 1, 2, 3].map((k) => (s[i + k] === undefined ? 0 : B64URL.indexOf(s[i + k])));
    const n = (c[0] << 18) | (c[1] << 12) | (c[2] << 6) | c[3];
    const avail = Math.min(3, s.length - i - 1);
    if (avail >= 1) bytes.push((n >> 16) & 255);
    if (avail >= 2) bytes.push((n >> 8) & 255);
    if (avail >= 3) bytes.push(n & 255);
  }
  return Uint8Array.from(bytes);
}

/** Reverse the `tra:` encoding: base64url → undo the running byte sum → JSON. */
export function decodeBlackbox(bb: string): unknown[] {
  const sum = b64urlDecode(bb.replace(/^tra:/, ""));
  const enc = new Uint8Array(sum.length);
  enc[0] = sum[0];
  for (let i = 1; i < sum.length; i++) enc[i] = (sum[i] - sum[i - 1]) & 255;
  return JSON.parse(decodeURIComponent(String.fromCharCode(...enc))) as unknown[];
}

function print(label: string, fields: unknown[]): void {
  console.log(`\n=== ${label} (${fields.length} fields) ===`);
  fields.forEach((v, i) =>
    console.log(`[${String(i).padStart(2)}] ${FIELD_NAMES[i] ?? "?"} = ${JSON.stringify(v)}`),
  );
}

const [arg, arg2] = Bun.argv.slice(2);

if (!import.meta.main) {
  // imported as a module (decodeBlackbox) — skip the CLI
} else if (arg === "--capture") {
  if (!arg2) throw new Error("usage: decode-blackbox.ts --capture <file.jsonl>");
  const lines = (await Bun.file(arg2).text())
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const iov = lines.find((e) => e.url.includes("/auth/iovation") && e.method === "POST");
  const codes = lines.find((e) => e.url.includes("/thin/codes") && e.method === "POST");
  if (iov) print("iovation blackbox", decodeBlackbox(JSON.parse(iov.req_body).blackbox));
  if (codes) {
    const c = JSON.parse(codes.req_body);
    print(
      "thin/codes blackbox (decrypted)",
      decodeBlackbox(decryptBlackbox(c.blackbox, c.gsid, c.platformGameAccountId)),
    );
  }
  if (!iov && !codes) console.log("no iovation or thin/codes call found in the capture");
} else if (arg?.startsWith("tra:")) {
  print("blackbox", decodeBlackbox(arg));
} else {
  console.error('usage: decode-blackbox.ts "tra:…"  |  decode-blackbox.ts --capture <file.jsonl>');
  process.exit(1);
}
