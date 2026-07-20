// The proof-of-work captcha (`pow-captcha.gameforge.com`). GameForge answers a
// privileged action (registration always; login/others under risk-scoring) with
// `409` + a `gf-challenge-id`; the client fetches a batch of hash puzzles, solves
// them, submits, then retries the action with the solved `gf-challenge-id` header.
//
// Both halves of the submit are reproduced headless: the puzzle is plain hashcash
// (`solvePow`), and the `instrumentation` payload is just ops GF itself sends us to
// eval (instrumentation.ts). See docs/pow-captcha.md.

import { getLogger } from "@logtape/logtape";
import { z } from "zod";
import {
  BROWSER_USER_AGENT,
  readJson,
  sendRequest,
  sparkFetch,
  type SparkRequest,
} from "../http.ts";
import { sha256 } from "../crypto.ts";
import { stringField } from "../../util/index.ts";
import { UnexpectedResponseError, UnforgeError } from "../errors.ts";
import {
  parseInstrumentationOps,
  runInstrumentation,
  type InstrumentationOp,
} from "./instrumentation.ts";

const log = getLogger(["unforge", "spark"]);

export const POW_CAPTCHA_BASE = "https://pow-captcha.gameforge.com";

/** One hashcash puzzle: least `nonce` with sha256(`salt`+nonce) prefixed by `target`. */
export const PowSubChallenge = z.object({
  salt: z.string(),
  /** Required hex prefix of the digest, e.g. "00000" (5 nibbles = 20 bits). */
  target: z.string(),
});
export type PowSubChallenge = z.infer<typeof PowSubChallenge>;

export const PowChallenge = z.object({
  /** Only "sha-256" is known; anything else throws rather than guess. */
  algorithm: z.string(),
  challenges: z.array(PowSubChallenge),
});
export type PowChallenge = z.infer<typeof PowChallenge>;

/** The challenge body: the puzzles plus the instrumentation ops, JSON-encoded in a string. */
export const Challenge = z.object({
  pow: PowChallenge,
  instrumentation: z.string(),
});
export type Challenge = z.infer<typeof Challenge>;

/** A solved sub-challenge: the salt echoed back with the winning nonce. */
export interface PowSolution {
  salt: string;
  nonce: string;
}

/** Self-reported solver timings (GF cross-checks these against the instrumentation). */
export interface PowMetrics {
  solver: { path: string; totalMs: number; challengeMs: number[] };
}

/**
 * The full challenge submit body. GF validates all three: an absent `instrumentation` is
 * `400 MISSING_PARAMETER`, and one that doesn't answer *this* challenge's ops (the ops are
 * generated per challenge, so a replayed payload never matches) is
 * `409 CHALLENGE_VERIFICATION_FAILED`.
 */
export interface PowSubmission {
  pow: PowSolution[];
  /** One number per op, in order — see {@link runInstrumentation}. */
  instrumentation: number[];
  metrics: PowMetrics;
}

// Guard against a malformed/unsatisfiable target hanging the process. A real target is a
// few hex nibbles (the observed one is 5 = 20 bits); this cap is far above any plausible
// difficulty, so it only ever trips on a bad target, not a legitimately hard one.
const MAX_SOLVE_ITERATIONS = 1 << 26;

/** Brute-force one sub-challenge: the least n ≥ 0 with sha256(salt+n) starting `target`. */
export function solveSubChallenge(salt: string, target: string): string {
  if (!/^[0-9a-f]*$/.test(target)) {
    throw new UnforgeError(`invalid PoW target (expected lowercase hex): "${target}"`);
  }
  for (let n = 0; n < MAX_SOLVE_ITERATIONS; n++) {
    if (sha256(salt + n).startsWith(target)) return String(n);
  }
  throw new UnforgeError(`PoW target unsatisfied after ${MAX_SOLVE_ITERATIONS} tries: "${target}"`);
}

/** Solve every sub-challenge (pure CPU, no I/O). */
export function solvePow(pow: PowChallenge): PowSolution[] {
  if (pow.algorithm !== "sha-256") {
    throw new UnforgeError(`unsupported PoW algorithm: ${pow.algorithm}`);
  }
  return pow.challenges.map((c) => ({ salt: c.salt, nonce: solveSubChallenge(c.salt, c.target) }));
}

// The captcha web app loads under this URL; its Referer is echoed on the API calls.
const referer = (challengeId: string, locale: string) =>
  `${POW_CAPTCHA_BASE}/?challengeId=${challengeId}&locale=${locale}&parentOrigin=null`;

/** Build the challenge-fetch request (pure — no network). */
export function buildFetchChallengeRequest(challengeId: string, locale: string): SparkRequest {
  return {
    url: `${POW_CAPTCHA_BASE}/api/challenge/${challengeId}`,
    method: "GET",
    headers: {
      "User-Agent": BROWSER_USER_AGENT,
      Accept: "*/*",
      Referer: referer(challengeId, locale),
    },
  };
}

/** Build the solution-submit request (pure — no network). */
export function buildSubmitChallengeRequest(
  challengeId: string,
  locale: string,
  submission: PowSubmission,
): SparkRequest {
  return {
    url: `${POW_CAPTCHA_BASE}/api/challenge/${challengeId}`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": BROWSER_USER_AGENT,
      Origin: POW_CAPTCHA_BASE,
      Accept: "*/*",
      Referer: referer(challengeId, locale),
    },
    body: JSON.stringify(submission),
  };
}

// The challenge API sits behind the captcha web session, so its calls carry the
// cookies the landing page sets (an ingress LB cookie + `pc_idt`). A tiny jar
// mirrors that: warm the page, then reuse the cookies for GET/POST.
class CookieJar {
  private cookies = new Map<string, string>();
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size) {
      headers.set("Cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    }
    const res = await sendRequest(url, { ...init, headers, redirect: "manual" });
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const pair = sc.split(";", 1)[0];
      const i = pair.indexOf("=");
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    return res;
  }
}

/**
 * Fetch, solve, and submit a PoW challenge headless. Warms the captcha landing page for
 * its cookies, GETs the puzzle batch + instrumentation ops, brute-forces the SHA-256
 * hashes, evaluates the ops, and POSTs the submission. Resolves once GameForge marks it
 * `solved`; the caller then retries the original action carrying the `gf-challenge-id`
 * header.
 */
export async function solveChallenge(challengeId: string, locale: string): Promise<void> {
  const jar = new CookieJar();
  await jar.fetch(referer(challengeId, locale), {
    headers: { "User-Agent": BROWSER_USER_AGENT, Accept: "text/html" },
  });

  const get = buildFetchChallengeRequest(challengeId, locale);
  const gres = await jar.fetch(get.url, { method: "GET", headers: get.headers });
  const challenge = await readJson(gres, Challenge);
  const ops: InstrumentationOp[] = parseInstrumentationOps(challenge.instrumentation);
  log.debug("captcha: fetched {pow} pow puzzles + {ops} instrumentation ops", {
    pow: challenge.pow.challenges.length,
    ops: ops.length,
  });

  const startedAt = Date.now();
  const solution = solvePow(challenge.pow);
  const totalMs = Date.now() - startedAt;
  log.debug("captcha: solved pow in {ms}ms, submitting", { ms: totalMs });
  const submission: PowSubmission = {
    pow: solution,
    instrumentation: runInstrumentation(ops),
    metrics: {
      solver: {
        path: "js",
        totalMs,
        challengeMs: solution.map((_, i) => Math.round((totalMs * (i + 1)) / solution.length)),
      },
    },
  };

  const post = buildSubmitChallengeRequest(challengeId, locale, submission);
  const pres = await jar.fetch(post.url, {
    method: "POST",
    headers: post.headers,
    body: post.body,
  });
  const result: unknown = await pres.json().catch(() => ({}));
  if (stringField(result, "status") !== "solved") {
    throw new UnexpectedResponseError(pres.status, pres.statusText, JSON.stringify(result));
  }
  log.debug("captcha: challenge {id} solved", { id: challengeId });
}

/** Read a challenge id from a 409 (header first, then body); undefined if it's not a captcha. */
async function challengeIdFrom(res: Response): Promise<string | undefined> {
  const header = res.headers.get("gf-challenge-id");
  if (header) return header.split(";")[0];
  const body: unknown = await res
    .clone()
    .json()
    .catch(() => ({}));
  return stringField(body, "challengeId");
}

/**
 * Send a spark request that may be captcha-gated. Fires it; on a `409` carrying a
 * PoW challenge it solves the challenge and retries with the `gf-challenge-id`
 * header. A `409` that is *not* a challenge (a genuine conflict) is returned
 * unchanged for the caller to handle. `build` receives the solved challenge id on
 * the retry (undefined on the first attempt).
 */
export async function sendWithChallenge(
  build: (challengeId?: string) => SparkRequest,
  locale: string,
): Promise<Response> {
  const res = await sparkFetch(build());
  if (res.status !== 409) return res;
  const challengeId = await challengeIdFrom(res);
  if (!challengeId) {
    // A genuine 409 (e.g. NAME_TAKEN), not a captcha — handed back to the caller as-is.
    log.debug("409 without a gf-challenge-id — not a captcha, returning to caller");
    return res;
  }
  log.warn("captcha challenge required ({id}); solving", { id: challengeId });
  await solveChallenge(challengeId, locale);
  const retry = await sparkFetch(build(challengeId));
  // A retry that's *still* 409 means the solved challenge didn't clear the gate — the caller
  // surfaces the body, but log it here so the flow shows solve-succeeded-yet-action-failed.
  if (retry.status === 409) {
    log.warn("action still 409 after a solved challenge — challenge did not clear the gate");
  } else {
    log.debug("action retried after solved challenge: {status}", { status: retry.status });
  }
  return retry;
}
