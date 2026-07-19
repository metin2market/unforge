import { describe, expect, test } from "bun:test";
import { scrubBody, scrubHeaders } from "./trace-scrub.ts";

describe("trace scrubbing", () => {
  test("masks the password and keeps the protocol material raw", () => {
    const body = JSON.stringify({
      email: "a@b.c",
      password: "hunter2",
      locale: "en-GB",
      blackbox: "tra:AbCdEf",
    });
    const out = JSON.parse(scrubBody(body)!);
    expect(out.password).toBe("«password»");
    expect(out.password).not.toContain("hunter2");
    // The whole point of the trace: a diagnosis reads these.
    expect(out.blackbox).toBe("tra:AbCdEf");
    expect(out.email).toBe("a@b.c");
    expect(out.locale).toBe("en-GB");
  });

  test("fingerprints credentials so they stay correlatable", () => {
    const a = JSON.parse(scrubBody(JSON.stringify({ token: "eyJhbGciOi.aaa" }))!);
    const same = JSON.parse(scrubBody(JSON.stringify({ token: "eyJhbGciOi.aaa" }))!);
    const other = JSON.parse(scrubBody(JSON.stringify({ token: "eyJhbGciOi.bbb" }))!);
    expect(a.token).not.toContain("eyJhbGciOi");
    expect(a.token).toBe(same.token); // "is this the same token?" survives scrubbing
    expect(a.token).not.toBe(other.token);
  });

  test("masks credentials nested at any depth", () => {
    const out = JSON.parse(scrubBody(JSON.stringify({ data: [{ code: "SECRET-CODE" }] }))!);
    expect(out.data[0].code).not.toContain("SECRET-CODE");
    expect(out.data[0].code).toMatch(/^«[0-9a-f]{12}»$/);
  });

  test("leaves a non-JSON body untouched rather than corrupting it", () => {
    expect(scrubBody("<html>challenge page</html>")).toBe("<html>challenge page</html>");
    expect(scrubBody(undefined)).toBeUndefined();
  });

  test("fingerprints the bearer token but keeps the scheme and the cookies", () => {
    const out = scrubHeaders({
      authorization: "Bearer abc.def.ghi",
      cookie: "GTPINGRESSCOOKIE=44f9f871",
      "tnt-installation-id": "inst-1",
    });
    expect(out.authorization).toMatch(/^Bearer «[0-9a-f]{12}»$/);
    expect(out.authorization).not.toContain("abc.def.ghi");
    // Sticky-LB cookies are how a "challenge not found" gets read — never masked.
    expect(out.cookie).toBe("GTPINGRESSCOOKIE=44f9f871");
    expect(out["tnt-installation-id"]).toBe("inst-1");
  });
});
