import { describe, expect, test } from "bun:test";
import { generateInstallationId, isValidInstallationId } from "./installation-id.ts";

describe("installation id", () => {
  test("generates a valid, unique id each call", () => {
    const a = generateInstallationId();
    const b = generateInstallationId();
    expect(a).not.toBe(b);
    expect(isValidInstallationId(a)).toBe(true);
  });

  test("rejects non-UUIDs", () => {
    expect(isValidInstallationId("not-a-uuid")).toBe(false);
    expect(isValidInstallationId("")).toBe(false);
  });

  test("rejects a digitless UUID (account hash needs a first digit)", () => {
    expect(isValidInstallationId("abcdefab-cdef-abcd-efab-cdefabcdefab")).toBe(false);
  });
});
