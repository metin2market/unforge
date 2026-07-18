import { describe, expect, test } from "bun:test";
import { describeError } from "./describe-error.ts";
import {
  AttestationRejectedError,
  CodeNotAllowedError,
  InvalidCredentialsError,
  NetworkError,
  UnexpectedResponseError,
} from "../core/index.ts";

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

  test("explains a refused login code, leading with the outstanding-code cause", () => {
    const d = describeError(new CodeNotAllowedError());
    expect(d.kind).toBe("code-not-allowed");
    expect(d.summary).toMatch(/won't issue a login code/);
    // The likely cause must come before the rarely-applicable email one.
    expect(d.summary.indexOf("outstanding")).toBeLessThan(d.summary.indexOf("email"));
    // It must tell the user NOT to retry: if the cause is a login block, every attempt
    // restarts the cooldown, so the obvious response is the one that prolongs it.
    expect(d.summary).toMatch(/[Dd]on't retry/);
  });

  test("explains a refused device attestation without blaming the caller", () => {
    const d = describeError(new AttestationRejectedError("acct-1"));
    expect(d.kind).toBe("attestation-rejected");
    expect(d.summary).toMatch(/device check/i);
  });

  test("classifies rejected credentials", () => {
    expect(describeError(new InvalidCredentialsError()).kind).toBe("invalid-credentials");
  });

  // A transport failure must never read as GameForge rejecting something.
  test("distinguishes an unreachable host from a timeout", () => {
    const down = describeError(
      new NetworkError("https://spark.gameforge.com", false, new Error("x")),
    );
    expect(down.kind).toBe("network");
    expect(down.summary).toMatch(/internet connection/i);

    const slow = describeError(new NetworkError("https://spark.gameforge.com", true));
    expect(slow.kind).toBe("network");
    expect(slow.summary).toMatch(/didn't respond in time/i);
  });

  test("passes plain errors through by their message", () => {
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
