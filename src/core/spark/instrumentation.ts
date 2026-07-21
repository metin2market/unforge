// The captcha's `instrumentation` payload. GameForge does NOT compute this in its
// obfuscated bundle — it SENDS the code: the challenge response carries a JSON string
// of ops `[{id,type,code}]`, and captcha.74f5.js just evals each one in a throwaway
// iframe and returns the numbers:
//
//   var fn = new Function(ops[i].code); results.push(fn() || 0);
//
// So there is nothing to reverse — we run the same ops against a minimal DOM. Verified
// against a real launcher capture: its own 15 ops replay through this shim to the exact
// results CEF submitted. See docs/captcha.md.

import { z } from "zod";
import { parseJson } from "../../util/index.ts";
import { ResponseShapeError, shapeIssues } from "../errors.ts";

/** One server-sent op. `type` is informational — GF only reads the returned number. */
export const InstrumentationOp = z.object({
  id: z.string(),
  /** Observed: "bitwise" | "canvas" | "dom" | "prototype". Unknown types still just eval. */
  type: z.string(),
  code: z.string(),
});
export type InstrumentationOp = z.infer<typeof InstrumentationOp>;

/**
 * Parse the challenge's `instrumentation` field (GF sends it JSON-encoded in a string).
 *
 * All-or-nothing on purpose: the answers are **positional**, one number per op in the order
 * sent, so dropping an op we can't read would submit a short array and fail verification with
 * no hint as to why. A malformed op that still parses is fine — {@link runInstrumentation}
 * answers 0 for anything that throws, which keeps the position.
 */
export function parseInstrumentationOps(field: string): InstrumentationOp[] {
  const parsed = z.array(InstrumentationOp).safeParse(parseJson(field));
  if (!parsed.success) {
    throw new ResponseShapeError("captcha instrumentation", shapeIssues(parsed.error), field);
  }
  return parsed.data;
}

const pxOf = (value: string | undefined): number => parseInt(value ?? "", 10) || 0;

/**
 * The element the `dom` ops measure. They set width/height/padding and read a box
 * metric, so content-box math over the inline style reproduces Chrome exactly (the
 * ops never attach stylesheets, and the div is `position:absolute` + hidden).
 */
function createElement() {
  const style: Record<string, string> = {};
  const box = (dim: "width" | "height") => pxOf(style[dim]) + 2 * pxOf(style.padding);
  return {
    style,
    appendChild() {},
    removeChild() {},
    get clientWidth() {
      return box("width");
    },
    get clientHeight() {
      return box("height");
    },
    get offsetWidth() {
      return box("width");
    },
    get offsetHeight() {
      return box("height");
    },
    // The `canvas` ops hash rendered pixels — a real fingerprint we can't compute
    // headless. A null context makes the op throw, which GF's own `fn() || 0` maps to
    // 0, exactly as for a browser with canvas blocked. Accepted live (see docs).
    getContext() {
      return null;
    },
  };
}

/** The globals the ops probe. `prototype` ops only `typeof` these; `dom` ops build divs. */
function createEnvironment() {
  const document = {
    createElement,
    body: { appendChild() {}, removeChild() {} },
  };
  const navigator = { userAgent: "", hardwareConcurrency: 8 };
  const requestAnimationFrame = (cb: () => void) => setTimeout(cb, 16);
  const window = { document, navigator, requestAnimationFrame, setTimeout };
  return { document, navigator, requestAnimationFrame, window };
}

/**
 * Evaluate every op and return its number, mirroring GF's `fn() || 0` — a throwing or
 * falsy op yields 0 rather than failing the batch, which is what a real browser submits.
 */
export function runInstrumentation(ops: InstrumentationOp[]): number[] {
  const env = createEnvironment();
  return ops.map((op) => {
    try {
      // Evaluating GF's ops *is* the mechanism: `instrumentation` is JS the server sends for the
      // client to run, so there is nothing to precompute. The code is GF's own, run against the
      // stub environment above — never attacker-chosen input.
      // `new Function` is typed `(...args: any[]) => any`; the ops return numbers, and the
      // caller checks that at the call site below.
      // oxlint-disable-next-line typescript/no-implied-eval, typescript/no-unsafe-type-assertion
      const fn = new Function(
        "document",
        "window",
        "navigator",
        "requestAnimationFrame",
        "self",
        op.code,
      ) as (...args: unknown[]) => unknown;
      const result = fn(
        env.document,
        env.window,
        env.navigator,
        env.requestAnimationFrame,
        env.window,
      );
      return typeof result === "number" ? result || 0 : 0;
    } catch {
      return 0;
    }
  });
}
