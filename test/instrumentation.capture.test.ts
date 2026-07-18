// The strongest check we have on the instrumentation shim: a real launcher capture holds
// BOTH the ops GF sent (the challenge GET) and the numbers real CEF answered with (the
// submit POST). Replaying its ops through our shim must reproduce CEF's results exactly —
// if it ever doesn't, the shim has drifted from a real browser and live submits will fail
// with 409 CHALLENGE_VERIFICATION_FAILED.
//
// Captures are gitignored, so this skips on a clean clone. See docs/pow-captcha.md.

import { describe, expect, test } from "bun:test";
import { findRequest, hasCaptures } from "./support/captures.ts";
import { parseInstrumentationOps, runInstrumentation } from "../src/core/spark/instrumentation.ts";
import type { PowChallenge } from "../src/core/spark/challenge.ts";

const captured = () => {
  const get = findRequest("pow-captcha.gameforge.com/api/challenge/", { method: "GET" });
  const post = findRequest("pow-captcha.gameforge.com/api/challenge/", { method: "POST" });
  if (!get || !post) return;
  return {
    challenge: JSON.parse(get.respBody) as { pow: PowChallenge; instrumentation: string },
    submission: JSON.parse(post.reqBody) as {
      pow: { salt: string; nonce: string }[];
      instrumentation: number[];
    },
  };
};

describe.skipIf(!hasCaptures() || !captured())(
  "instrumentation vs. a real launcher capture",
  () => {
    test("our shim reproduces real CEF's results for the launcher's own ops", () => {
      const { challenge, submission } = captured()!;
      const ops = parseInstrumentationOps(challenge.instrumentation);
      expect(ops.length).toBe(submission.instrumentation.length);
      expect(runInstrumentation(ops)).toEqual(submission.instrumentation);
    });

    test("GF sends the ops as code — the payload is not bundle-derived", () => {
      const { challenge } = captured()!;
      const ops = parseInstrumentationOps(challenge.instrumentation);
      for (const op of ops) expect(typeof op.code).toBe("string");
    });
  },
);
