import { describe, expect, test } from "bun:test";
import { accountHash } from "../src/core/crypto.ts";
import { findRequests, hasCaptures, header } from "./support/captures.ts";
import { loadCertPem } from "./support/materials.ts";

// The end-to-end account-hash ("MAGIC") proof: recompute the hash the launcher
// embedded in each real thin/codes User-Agent and require an exact match — across
// every captured code request (multiple accounts + installation ids, so both
// even/odd branches get real coverage). Needs the private cert + a capture, so it
// skips without them. crypto.test.ts only pins the cascade math against a
// documented example; this validates cert + algorithm together.

describe.skipIf(!hasCaptures() || !loadCertPem())(
  "account hash vs real launcher User-Agents",
  () => {
    test("reproduces every captured thin/codes UA hash exactly", () => {
      const entries = findRequests("/thin/codes");
      expect(entries.length).toBeGreaterThan(0);
      const pem = loadCertPem()!; // accountHash normalises line endings
      for (const entry of entries) {
        const m = header(entry, "user-agent")!.match(/^Chrome\/C(\S+) \(([0-9a-f]+)\)$/);
        expect(m).not.toBeNull();
        const [, version, expected] = m!;
        const hash = accountHash({
          cert: pem,
          version,
          installationId: header(entry, "tnt-installation-id")!,
          accountId: JSON.parse(entry.reqBody).platformGameAccountId,
        });
        expect(hash).toBe(expected);
      }
    });
  },
);
