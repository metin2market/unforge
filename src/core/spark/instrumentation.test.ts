import { describe, expect, test } from "bun:test";
import { parseInstrumentationOps, runInstrumentation } from "./instrumentation.ts";

// These mirror the shape of the ops GF actually sends (see the capture-backed diff in
// test/instrumentation.capture.test.ts, which pins us to real CEF's results).

const op = (type: string, code: string) => ({ id: `${type}-1`, type, code });

describe("runInstrumentation", () => {
  test("evaluates a `bitwise` op (pure integer arithmetic)", () => {
    const code = "var v = 3513; v = (v << 3) | 0; v = (v & 48319) | 0; return v;";
    expect(runInstrumentation([op("bitwise", code)])).toEqual([((3513 << 3) | 0) & 48319]);
  });

  test("evaluates a `prototype` op against the shimmed globals", () => {
    const code =
      "var acc = 8562;" +
      "acc = (acc ^ (typeof document !== 'undefined' ? 1 : 0)) | 0;" +
      "acc = (acc ^ (typeof window !== 'undefined' ? 1 : 0)) | 0;" +
      "acc = (acc ^ (typeof navigator !== 'undefined' ? 1 : 0)) | 0;" +
      "acc = (acc ^ (typeof setTimeout === 'function' ? 1 : 0)) | 0;" +
      "acc = (acc ^ (typeof requestAnimationFrame === 'function' ? 1 : 0)) | 0;" +
      "return acc;";
    // Every probe is present, so the accumulator is XOR'd with 1 five times.
    expect(runInstrumentation([op("prototype", code)])).toEqual([8562 ^ 1 ^ 1 ^ 1 ^ 1 ^ 1]);
  });

  test("evaluates a `dom` op as content-box math over the inline style", () => {
    const code =
      "var el = document.createElement('div');" +
      "el.style.width = '100px'; el.style.height = '75px'; el.style.padding = '5px';" +
      "document.body.appendChild(el); var r = el.offsetHeight;" +
      "document.body.removeChild(el); return r;";
    expect(runInstrumentation([op("dom", code)])).toEqual([75 + 2 * 5]);
  });

  test("yields 0 for a `canvas` op, as a canvas-blocked browser does", () => {
    const code =
      "var c = document.createElement('canvas'); var ctx = c.getContext('2d');" +
      "ctx.fillText('x', 0, 0); return 1;";
    expect(runInstrumentation([op("canvas", code)])).toEqual([0]);
  });

  test("maps a throwing or falsy op to 0 instead of failing the batch (GF's `fn() || 0`)", () => {
    expect(runInstrumentation([op("bitwise", "throw new Error('boom')")])).toEqual([0]);
    expect(runInstrumentation([op("bitwise", "return undefined;")])).toEqual([0]);
    expect(runInstrumentation([op("unknown-type", "return 7;")])).toEqual([7]);
  });

  test("returns one result per op, in order", () => {
    const ops = [
      op("bitwise", "return 1;"),
      op("bitwise", "return 2;"),
      op("bitwise", "return 3;"),
    ];
    expect(runInstrumentation(ops)).toEqual([1, 2, 3]);
  });
});

describe("parseInstrumentationOps", () => {
  test("parses the JSON-encoded string GF sends", () => {
    const ops = parseInstrumentationOps('[{"id":"a","type":"bitwise","code":"return 1;"}]');
    expect(ops).toEqual([{ id: "a", type: "bitwise", code: "return 1;" }]);
  });

  test("throws on a non-array rather than silently submitting nothing", () => {
    expect(() => parseInstrumentationOps('{"nope":1}')).toThrow(TypeError);
  });
});
