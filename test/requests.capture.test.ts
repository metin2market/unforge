import { describe, expect, test } from "bun:test";
import { buildLogoutRequest, buildSessionRequest } from "../src/core/spark/sessions.ts";
import { buildCreateGfAccountRequest } from "../src/core/spark/create-gf-account.ts";
import { solvePow, solveSubChallenge, type PowChallenge } from "../src/core/spark/challenge.ts";
import { buildAttestRequest } from "../src/core/spark/iovation.ts";
import { buildCreateAccountRequest } from "../src/core/spark/create-account.ts";
import { buildCodeRequest } from "../src/core/spark/codes.ts";
import { decryptBlackbox } from "../src/core/blackbox/index.ts";
import { GAMEFORGE_CERT_PEM, groupForRegion, isRegion } from "../src/core/index.ts";
import { sha256 } from "../src/core/crypto.ts";
import type { SparkRequest } from "../src/core/http.ts";
import type { GameAccount } from "../src/core/types.ts";
import { type CaptureEntry, findRequests, hasCaptures, header } from "./support/captures.ts";

const pathIs = (p: string) => (e: CaptureEntry) => new URL(e.url).pathname === p;

// Given the SAME inputs a real launcher used, our builders must produce the SAME
// request bytes. Every captured request of each kind is checked (different
// accounts, sessions, timestamps), not just the first. Skips without captures
// (gitignored). Capture access stays inside test bodies — bun runs a skipped
// describe's factory, so a factory-level touch of an absent capture would throw.

const bearer = (e: CaptureEntry) => header(e, "authorization")!.replace(/^Bearer /, "");

/** Assert every header our builder sets matches the captured launcher value. */
function expectHeadersMatch(built: SparkRequest, entry: CaptureEntry): void {
  for (const [k, v] of Object.entries(built.headers)) expect(header(entry, k)).toBe(v);
}

const d = describe.skipIf(!hasCaptures());

d("sessions requests match the launcher", () => {
  // GF ignores JSON key order: the normal login serializes blackbox-first, but the
  // post-registration login is email-first — both get 201. So fields must match every
  // capture, and our canonical (blackbox-first) bytes must match at least the ones
  // that use that order.
  test("fields match every capture + byte-identical for the blackbox-first ones + headers", () => {
    const entries = findRequests("credentials/sessions", { status: 201 });
    expect(entries.length).toBeGreaterThan(0);
    let byteChecked = 0;
    for (const entry of entries) {
      const b = JSON.parse(entry.reqBody);
      const built = buildSessionRequest({
        blackbox: b.blackbox,
        email: b.email,
        password: b.password,
        locale: b.locale,
        installationId: header(entry, "tnt-installation-id")!,
      });
      expect(JSON.parse(built.body!)).toEqual(b);
      expectHeadersMatch(built, entry);
      if (entry.reqBody.startsWith('{"blackbox"')) {
        expect(built.body).toBe(entry.reqBody);
        byteChecked++;
      }
    }
    expect(byteChecked).toBeGreaterThan(0);
  });
});

d("iovation requests match the launcher", () => {
  test("body byte-identical + headers, every capture", () => {
    const entries = findRequests("/auth/iovation", { status: 200 });
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const b = JSON.parse(entry.reqBody);
      const built = buildAttestRequest({
        token: bearer(entry),
        installationId: header(entry, "tnt-installation-id")!,
        accountId: b.accountId,
        blackbox: b.blackbox,
      });
      expect(built.body).toBe(entry.reqBody);
      expectHeadersMatch(built, entry);
    }
  });
});

d("create-account requests match the launcher", () => {
  test("body byte-identical, every capture", () => {
    const entries = findRequests("/v2/users/me/accounts", { status: 201 });
    for (const entry of entries) {
      const b = JSON.parse(entry.reqBody);
      const built = buildCreateAccountRequest({
        token: bearer(entry),
        installationId: header(entry, "tnt-installation-id")!,
        displayName: b.displayName,
        gameId: b.gameId,
        gameEnvironmentId: b.gameEnvironmentId,
        gfLang: b.gfLang,
        accountGroup: b.accountGroup,
        blackbox: b.blackbox,
        // Never reaches this body — only the captcha, if one fires. Any region does.
        locale: "pt-PT",
      });
      expect(built.body).toBe(entry.reqBody);
    }
  });
});

d("create-user (registration) requests match the launcher", () => {
  test("body byte-identical (email-first) + headers, incl. gf-challenge-id on the retry", () => {
    // `/api/v2/users` exactly — not `/api/v2/users/me/accounts` (create-account).
    const entries = findRequests("/api/v2/users").filter(pathIs("/api/v2/users"));
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const b = JSON.parse(entry.reqBody);
      const built = buildCreateGfAccountRequest({
        email: b.email,
        password: b.password,
        locale: b.locale,
        blackbox: b.blackbox,
        installationId: header(entry, "tnt-installation-id")!,
        // present only on the 201 retry; the 409 attempt has no challenge header
        challengeId: header(entry, "gf-challenge-id"),
      });
      expect(built.body).toBe(entry.reqBody);
      expectHeadersMatch(built, entry);
    }
  });
});

d("logout requests match the launcher", () => {
  test("DELETE /auth/sessions with the bearer token + no body", () => {
    const entries = findRequests("/api/v1/auth/sessions", { method: "DELETE", status: 202 });
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const built = buildLogoutRequest(bearer(entry), header(entry, "tnt-installation-id")!);
      expect(built.method).toBe("DELETE");
      expect(built.body).toBeUndefined();
      expectHeadersMatch(built, entry);
    }
  });
});

d("PoW solver solves the launcher's real challenge", () => {
  test("captured nonces validate, and our solver produces valid nonces too", () => {
    const get = findRequests("/api/challenge/", { method: "GET", status: 200 })[0];
    const post = findRequests("/api/challenge/", { method: "POST", status: 200 })[0];
    expect(get).toBeDefined();
    expect(post).toBeDefined();

    const pow = (JSON.parse(get.respBody) as { pow: PowChallenge }).pow;
    const captured = (JSON.parse(post.reqBody) as { pow: { salt: string; nonce: string }[] }).pow;

    // Every nonce the launcher submitted really does hit its target.
    for (let i = 0; i < captured.length; i++) {
      expect(
        sha256(captured[i].salt + captured[i].nonce).startsWith(pow.challenges[i].target),
      ).toBe(true);
    }

    // And our own solver lands a valid nonce for the first (real 20-bit) sub-challenge.
    const first = pow.challenges[0];
    const nonce = solveSubChallenge(first.salt, first.target);
    expect(sha256(first.salt + nonce).startsWith(first.target)).toBe(true);

    // solvePow returns one entry per sub-challenge, salts echoed in order.
    expect(solvePow({ ...pow, challenges: pow.challenges.slice(0, 1) }).map((s) => s.salt)).toEqual(
      [first.salt],
    );
  });
});

describe.skipIf(!hasCaptures())("thin/codes requests match the launcher", () => {
  function build(entry: CaptureEntry): SparkRequest {
    const b = JSON.parse(entry.reqBody);
    const [gameId, region] = (b.gameId as string).split(/\.(?=[a-z]{2}-[A-Z]{2}$)/);
    // Narrowed rather than asserted: the capture is real launcher traffic, so a suffix the table
    // doesn't know means the table is out of date — worth failing loudly on.
    if (!isRegion(region)) throw new Error(`capture carries an unknown region: ${region}`);
    // Only `id` and `gameId` reach the request; the rest are unread placeholders.
    const account: GameAccount = {
      id: b.platformGameAccountId,
      numericId: 0,
      displayName: "",
      usernames: [],
      gameId,
      gameName: "metin2",
      accountGroup: groupForRegion(region),
      retired: false,
    };
    const version = header(entry, "user-agent")!.match(/^Chrome\/C(\S+) /)![1];
    return buildCodeRequest({
      token: bearer(entry),
      account,
      installationId: header(entry, "tnt-installation-id")!,
      clientVersion: { version, branch: "master", commitId: "" },
      certificatePem: GAMEFORGE_CERT_PEM,
      sessionId: b.gsid.replace(/-\d+$/, ""),
      rawBlackbox: decryptBlackbox(b.blackbox, b.gsid, b.platformGameAccountId),
      region,
      gsid: b.gsid,
    });
  }

  test("body byte-identical + UA hash + no Origin, every capture", () => {
    const entries = findRequests("/thin/codes");
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const built = build(entry);
      expect(built.body).toBe(entry.reqBody);
      expect(built.headers["User-Agent"]).toBe(header(entry, "user-agent")!);
      expect(header(entry, "origin")).toBeUndefined();
      expect("Origin" in built.headers).toBe(false);
    }
  });
});
