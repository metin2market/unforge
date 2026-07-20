// Run `body` with `fetch` rigged to throw, so a guard meant to refuse *locally* proves it never
// reached the wire — a guard that asks anyway would pass a plain `rejects.toThrow()`, and a
// refused `thin/codes` may arm the per-login cooldown (docs/protocol.md).

export async function failOnFetch<T>(
  body: () => Promise<T>,
  why = "the refusal should be local",
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error(`network call made — ${why}`);
  }) as unknown as typeof fetch;
  // `try`, not `body().finally()`: a synchronous throw returns no promise, leaking the stub.
  try {
    return await body();
  } finally {
    globalThis.fetch = originalFetch;
  }
}
