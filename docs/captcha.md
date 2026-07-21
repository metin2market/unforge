# The proof-of-work captcha

GameForge guards privileged actions with a hashcash puzzle plus an `instrumentation` payload, both
reproduced **headless, no browser** ([`challenge.ts`](../src/core/spark/challenge.ts),
[`instrumentation.ts`](../src/core/spark/instrumentation.ts)). The `instrumentation` is not a blob
to reverse: **GameForge sends us the code to run.**

Served from `pow-captcha.gameforge.com`, it post-dates every public GF-auth reference and replaced
the older image-drop captcha. **Registration always triggers it; login triggers it under
risk-scoring** — and both serve the same challenge (`sha-256`, 10 × 20-bit puzzles + 15 ops).

## The scheme

`gf-challenge-id` is a **general** mechanism: any spark action can answer `409` "solve a challenge
first", and you retry it once solved.

1. **Trigger** — the action (e.g. `POST /api/v2/users`) returns `409` with a `gf-challenge-id`
   header and `{"errorTypes":["CHALLENGE_REQUIRED"],"challengeId":…}`.
2. **Fetch** — `GET pow-captcha.gameforge.com/api/challenge/{id}` → `{"pow":{…},
"instrumentation":"[…]"}` — the hash puzzles **and** the ops.
3. **Solve** — per puzzle, brute-force the least `nonce` where `sha256(salt + nonce)` hex starts
   with `target` (`"00000"` = 20 bits ≈ 1M hashes; ~7 s for a batch of 10).
4. **Run the ops** — eval each, collect its number.
5. **Submit** — `POST …/api/challenge/{id}` with `{pow, instrumentation, metrics}` →
   `{"status":"solved"}`. GF validates all three: absent `instrumentation` is
   `400 MISSING_PARAMETER`; one that doesn't answer _this_ challenge's ops is
   `409 CHALLENGE_VERIFICATION_FAILED`.
6. **Retry** — repeat the original action with header `gf-challenge-id: {id}`.

**The header's `;{host}` suffix is a red herring.** It names `https://challenge.gameforge.com`,
which serves a page titled _"Challenge test"_ and 404s on `/api/challenge/{id}`. The real API is
only `pow-captcha.gameforge.com`.

## The `instrumentation` is server-sent code

The challenge's `instrumentation` field is a JSON-encoded string of ops, `[{id, type, code}]`. GF's
own bundle does nothing clever with them — it evals each in a throwaway iframe and posts the numbers
back:

```js
var fn = new Function(ops[i].code);
results.push(fn() || 0);
```

So there is no vendor JS to reimplement (unlike the blackbox's `game1.js`): we run the same ops
against a minimal DOM shim. Four `type`s observed, and the mix varies per challenge:

| `type`      | What the code does                                    | How we answer it                       |
| ----------- | ----------------------------------------------------- | -------------------------------------- |
| `bitwise`   | pure integer arithmetic (`v = (v << 3) \| 0; …`)       | evals as-is                            |
| `prototype` | `typeof document/window/eval/setTimeout…` XOR accum.  | the shim's globals exist               |
| `dom`       | build a hidden div, read `clientWidth`/`offsetHeight` | content-box math over the inline style |
| `canvas`    | `fillText` → `getImageData` → hash the pixels         | **0** — see below                      |

**The `canvas` op returns 0 and GF accepts it.** It's a real fingerprint we can't compute headless,
but a null context makes the op throw, which GF's own `fn() || 0` maps to `0` — exactly what a
canvas-blocked browser submits. The deterministic ops are the actual check: server-verifiable proof
a real JS engine evaluated the code.

**Unverified:** whether `canvas` → 0 is _always_ accepted, or feeds risk-scoring even when accepted.
A future op type the shim can't answer would yield 0 and fail `CHALLENGE_VERIFICATION_FAILED` —
that's the main drift risk, and the capture test below is what catches it.

## Where it's wired in

- [`solvePow`](../src/core/spark/challenge.ts) — the SHA-256 solver. Equivalent to GF's own
  `pow-solver-js`: least nonce ascending from 0 over `sha256(utf8(salt) + ascii(decimal nonce))`,
  prefix-compared at **bit** granularity — identical to our hex `startsWith` because targets are
  always whole nibbles.
- [`runInstrumentation`](../src/core/spark/instrumentation.ts) — evals the ops behind the shim.
- `solveChallenge` — the fetch → solve → run → submit round-trip. `sendWithChallenge` is the generic
  `409 → solve → retry` loop used by `createSession`, `createGfAccount`, and `createGameAccount`;
  `createSession` therefore absorbs a login-time challenge (~8 s of CPU) and retries the login. A
  challenge that survives the retry raises `CaptchaRequiredError` rather than looping.

## Testing it

- [`instrumentation.capture.test.ts`](../test/instrumentation.capture.test.ts) is the strongest
  check: a real launcher capture holds both the ops GF sent and the numbers **real CEF** answered,
  and our shim reproduces them **15/15 exactly**, offline. If the shim drifts from a real browser,
  this fails before a live submit does.
- [`instrumentation.test.ts`](../src/core/spark/instrumentation.test.ts) covers each op type and the
  `fn() || 0` fallback, no network, no captures.
- A live challenge can be triggered and read without creating anything — the `409` precedes
  registration.

> ### Never debug the captcha against `POST /users`
>
> Each probe is a failed registration from your IP, and **~10 probes in ~20 minutes earns
> `429 TOO_MANY_REQUESTS`**, after which no challenge is issued at all.
>
> **The trap:** _before_ the hard `429`, a rate-limited `POST /users` still hands out challenges —
> but they **fail verification no matter what you submit**. That reads exactly like a bug in your
> solver. It cost a full investigation: identical instrumentation values, cookies and body, passing
> from one script and failing from another, because the difference was only how rate-limited each
> challenge's issuer was.
>
> A **login** challenge is the clean probe — free (it rides your own login), same scheme, and it is
> what proved the library correct. If a submit fails verification, check for rate-limiting first.
