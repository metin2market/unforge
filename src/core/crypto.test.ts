import { describe, expect, test } from "bun:test";
import { accountHash, firstDigit, sha1, sha256 } from "./crypto.ts";

// Worked example from morsisko/NosTale-Auth (README "Obtaining token example"):
// version C2.1.22.784, installation id a777c5e7-… (first digit 7, odd),
// account id fb50ca7a-…, and the documented intermediate hashes below.
const VERSION = "2.1.22.784";
const INSTALLATION_ID = "a777c5e7-c9ac-407b-99b4-1a5934137f43";
const ACCOUNT_ID = "fb50ca7a-6ba2-11eb-9439-0242ac130002";
const SHA1_CERT = "6a62b8e71fac63afc5abcb927a63f83aaa2ccb5b"; // documented SHA1(Cert)

describe("hash helpers match the documented intermediates", () => {
  test("sha256 of the C-prefixed version", () => {
    expect(sha256(`C${VERSION}`)).toBe(
      "bb3dc2ed5d66d85d099d97513c52fbe699e61e5e8c71f91b9137566514c04e51",
    );
  });

  test("sha1 of the installation id", () => {
    expect(sha1(INSTALLATION_ID)).toBe("8b3c8dbe01fbb1d18ec288b74f072915f8d268b4");
  });

  test("sha256 of the account id", () => {
    expect(sha256(ACCOUNT_ID)).toBe(
      "bcabe70d5883ceead32fe116322824be320b18a98a241a5370a5de5e34763697",
    );
  });
});

describe("account hash (odd branch) reproduces the documented MAGIC", () => {
  // Reconstruct the cascade with the documented SHA1(Cert) to validate the
  // concat order and right-8 slicing independently of the cert bytes.
  test("cascade → fbb506b95a", () => {
    const sum = sha256(
      SHA1_CERT + sha256(`C${VERSION}`) + sha1(INSTALLATION_ID) + sha256(ACCOUNT_ID),
    );
    expect(ACCOUNT_ID.slice(0, 2) + sum.slice(-8)).toBe("fbb506b95a");
  });
});

describe("accountHash()", () => {
  const cert = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

  test("is deterministic and correctly shaped", () => {
    const hash = accountHash({
      cert,
      version: VERSION,
      installationId: INSTALLATION_ID,
      accountId: ACCOUNT_ID,
    });
    expect(hash).toMatch(/^[0-9a-f]{2}[0-9a-f]{8}$/);
    expect(hash.slice(0, 2)).toBe("fb");
    expect(
      accountHash({
        cert,
        version: VERSION,
        installationId: INSTALLATION_ID,
        accountId: ACCOUNT_ID,
      }),
    ).toBe(hash);
  });

  test("even vs odd installation id take different branches", () => {
    const odd = accountHash({
      cert,
      version: VERSION,
      installationId: "1abc",
      accountId: ACCOUNT_ID,
    });
    const even = accountHash({
      cert,
      version: VERSION,
      installationId: "2abc",
      accountId: ACCOUNT_ID,
    });
    expect(odd).not.toBe(even);
  });

  test("throws when the installation id has no digit", () => {
    expect(() =>
      accountHash({ cert, version: VERSION, installationId: "abc", accountId: ACCOUNT_ID }),
    ).toThrow();
  });
});

describe("firstDigit", () => {
  test("finds the first decimal digit", () => {
    expect(firstDigit("a777c5e7")).toBe(7);
    expect(firstDigit("2abc")).toBe(2);
    expect(firstDigit("abc")).toBeUndefined();
  });
});
