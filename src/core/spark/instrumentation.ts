// The captcha's `instrumentation` payload. GameForge does NOT compute this in its
// obfuscated bundle — it SENDS the code: the challenge response carries a JSON string
// of ops `[{id,type,code}]`, and captcha.74f5.js just evals each one in a throwaway
// iframe and returns the numbers:
//
//   var fn = new Function(ops[i].code); results.push(fn() || 0);
//
// So there is nothing to reverse — we run the same ops against a minimal DOM. Verified
// against a real launcher capture: its own 15 ops replay through this shim to the exact
// results CEF submitted. See docs/pow-captcha.md.

/** One server-sent op. `type` is informational — GF only reads the returned number. */
export interface InstrumentationOp {
  id: string;
  /** Observed: "bitwise" | "canvas" | "dom" | "prototype". Unknown types still just eval. */
  type: string;
  code: string;
}

/** Parse the challenge's `instrumentation` field (GF sends it JSON-encoded in a string). */
export function parseInstrumentationOps(field: string): InstrumentationOp[] {
  const ops = JSON.parse(field) as InstrumentationOp[];
  if (!Array.isArray(ops)) throw new TypeError("instrumentation is not an array of ops");
  return ops;
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
      // oxlint-disable-next-line typescript/no-implied-eval
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
      return (result as number) || 0;
    } catch {
      return 0;
    }
  });
}
