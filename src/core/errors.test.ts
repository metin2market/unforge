import { describe, expect, test } from "bun:test";
import { parseSparkErrorBody, UnexpectedResponseError } from "./errors.ts";

describe("parseSparkErrorBody", () => {
  test("parses a validation-failure body", () => {
    const parsed = parseSparkErrorBody(
      JSON.stringify({
        message: "Invalid parameter(s)",
        errorTypes: ["INPUT_VALIDATION_FAILURE"],
        validationErrors: [
          { affectedParameter: "password", details: "must match format 'password'" },
        ],
      }),
    );
    expect(parsed?.errorTypes).toEqual(["INPUT_VALIDATION_FAILURE"]);
    expect(parsed?.validationErrors?.[0]?.affectedParameter).toBe("password");
  });

  test("returns undefined for a non-JSON body or one lacking the known fields", () => {
    expect(parseSparkErrorBody("<html>error</html>")).toBeUndefined();
    expect(parseSparkErrorBody(JSON.stringify({ unrelated: true }))).toBeUndefined();
    expect(parseSparkErrorBody()).toBeUndefined();
  });
});

describe("UnexpectedResponseError", () => {
  test("exposes the parsed spark body and keeps the raw body in the message", () => {
    const err = new UnexpectedResponseError(
      400,
      "Bad Request",
      JSON.stringify({ message: "Invalid parameter(s)", errorTypes: ["INPUT_VALIDATION_FAILURE"] }),
    );
    expect(err.spark?.errorTypes).toEqual(["INPUT_VALIDATION_FAILURE"]);
    expect(err.message).toContain("Invalid parameter(s)");
  });

  test("truncates an overlong body in the message", () => {
    const err = new UnexpectedResponseError(500, "Server Error", "x".repeat(900));
    expect(err.message.length).toBeLessThan(560);
    expect(err.message.endsWith("…")).toBe(true);
  });
});
