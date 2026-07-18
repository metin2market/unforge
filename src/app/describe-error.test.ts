import { describe, expect, test } from "bun:test";
import { describeError } from "./describe-error.ts";
import { CodeNotAllowedError, UnexpectedResponseError } from "../core/index.ts";

const spark = (status: number, body: unknown) =>
  new UnexpectedResponseError(status, "Bad Request", JSON.stringify(body));

describe("describeError", () => {
  test("classifies a validation failure and returns the rejected fields", () => {
    const d = describeError(
      spark(400, {
        message: "Invalid parameter(s)",
        errorTypes: ["INPUT_VALIDATION_FAILURE", "SERVICE_ERROR"],
        validationErrors: [
          { affectedParameter: "password", details: "must match format 'password'" },
        ],
      }),
    );
    expect(d.kind).toBe("validation");
    expect(d.fields).toEqual([{ parameter: "password", detail: "must match format 'password'" }]);
    expect(d.summary).toContain("password — must match format 'password'");
  });

  test("classifies a rate limit", () => {
    const d = describeError(spark(429, { errorTypes: ["TOO_MANY_REQUESTS", "SERVICE_ERROR"] }));
    expect(d.kind).toBe("rate-limited");
    expect(d.summary).toMatch(/rate-limiting/);
  });

  test("classifies a failed captcha verification", () => {
    const d = describeError(spark(409, { errorTypes: ["CHALLENGE_VERIFICATION_FAILED"] }));
    expect(d.kind).toBe("captcha-failed");
    expect(d.summary).toMatch(/captcha challenge failed/i);
  });

  test("falls back to GF's message for an unmapped error type", () => {
    const d = describeError(
      spark(409, { message: "Something odd", errorTypes: ["SOME_NEW_TYPE"] }),
    );
    expect(d.kind).toBe("unknown");
    expect(d.summary).toBe("GameForge: Something odd (HTTP 409).");
  });

  test("passes typed and plain errors through by their message", () => {
    expect(describeError(new CodeNotAllowedError()).summary).toMatch(/won't issue a login code/);
    expect(describeError(new Error("boom")).summary).toBe("boom");
    expect(describeError("just a string").summary).toBe("just a string");
  });

  test("a non-JSON body yields no fields and the raw message", () => {
    const d = describeError(new UnexpectedResponseError(502, "Bad Gateway", "<html>nope</html>"));
    expect(d.kind).toBe("unknown");
    expect(d.fields).toBeUndefined();
    expect(d.summary).toMatch(/502 Bad Gateway/);
  });
});
