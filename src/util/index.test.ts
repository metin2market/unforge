import { describe, expect, test } from "bun:test";
import { errnoCode, errorMessage, isRecord, parseJson, stringField } from "./index.ts";

describe("isRecord", () => {
  test("accepts plain objects, rejects the things that also typeof as object", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    // The two that make a bare `typeof x === "object"` check wrong.
    expect(isRecord(null)).toBe(false);
    expect(isRecord([1, 2])).toBe(false);
    expect(isRecord("s")).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});

describe("parseJson", () => {
  test("returns undefined instead of throwing on junk", () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseJson("<html>nope</html>")).toBeUndefined();
    expect(parseJson("")).toBeUndefined();
  });
});

describe("errorMessage", () => {
  test("reads Errors, and stringifies whatever else was thrown", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage(new TypeError("bad type"))).toBe("bad type");
    expect(errorMessage("a bare string")).toBe("a bare string");
    expect(errorMessage(undefined)).toBe("undefined");
    expect(errorMessage({ nope: true })).toBe("[object Object]");
  });
});

describe("errnoCode", () => {
  test("reads the code off a system error", () => {
    const err = Object.assign(new Error("denied"), { code: "EACCES" });
    expect(errnoCode(err)).toBe("EACCES");
  });

  test("undefined when there is no code — the case an assertion would hide", () => {
    // `(err as ErrnoException).code !== "EACCES"` treats every one of these as
    // "some other errno" rather than "not a system error at all".
    expect(errnoCode(new Error("plain"))).toBeUndefined();
    expect(errnoCode({ code: 42 })).toBeUndefined();
    expect(errnoCode("EACCES")).toBeUndefined();
    expect(errnoCode(null)).toBeUndefined();
  });
});

describe("field readers", () => {
  test("stringField returns the value only when it really is a string", () => {
    expect(stringField({ a: "x" }, "a")).toBe("x");
    expect(stringField({ a: 1 }, "a")).toBeUndefined();
    expect(stringField({}, "a")).toBeUndefined();
    expect(stringField(null, "a")).toBeUndefined();
  });
});
