// Reading an `unknown` instead of asserting it.
//
// `catch (err)` and `JSON.parse` both hand back `unknown`/`any`, and the tempting move is
// `err as Error` / `JSON.parse(x) as T`. That's an assertion, not a check: a value that
// doesn't match becomes a type the compiler has been told to trust, and the failure surfaces
// somewhere else as a `TypeError` on a field that was never there. These read the value
// instead. Generic TypeScript, no GameForge in it — hence its own module rather than `core`.

/** A JSON object, as far as anything can tell before looking at its fields. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `JSON.parse` that yields `unknown` — the caller narrows rather than asserts. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The message off a thrown value, whatever it turned out to be. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : String(err);
}

/**
 * The `code` off a Node system error (`EACCES`, `EEXIST`, `EADDRINUSE`, …). Undefined when the
 * thrown value carries none, which is the case worth distinguishing — a bare `!== "EACCES"`
 * over an asserted type silently treats *every* unexpected throw as the branch not taken.
 */
export function errnoCode(err: unknown): string | undefined {
  return isRecord(err) && typeof err.code === "string" ? err.code : undefined;
}

/** A string field off an unknown object — for the one field a value is being probed for. */
export function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}
