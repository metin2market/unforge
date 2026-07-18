import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAccountStore, type AccountStore, type ConfigStore } from "../storage/index.ts";
import { openApp, type App } from "./app.ts";

let dir: string;
let store: AccountStore;
let app: App;

/** In-memory config — `launch` is the only thing that reads it, and these tests don't launch. */
function stubConfig(gameDirs: Record<string, string> = {}): ConfigStore {
  return {
    get: () => ({ version: 1, gameDirs }),
    gameDir: (region) => gameDirs[region],
    setGameDir: async (region, path) => {
      gameDirs[region] = path;
    },
  };
}

async function seed(): Promise<{ alphaId: string; betaId: string }> {
  const alpha = await store.add({
    email: "alpha@example.com",
    password: "pw-a",
    gameAccounts: [
      { accountId: "g-100", username: "hero100", displayName: "Hero One", region: "pt-PT" },
      { accountId: "g-101", username: "hero101", displayName: "Hero Two", region: "pt-PT" },
    ],
  });
  const beta = await store.add({
    email: "beta@example.com",
    password: "pw-b",
    gameAccounts: [
      { accountId: "g-200", username: "mage200", displayName: "Mage", region: "de-DE" },
    ],
  });
  return { alphaId: alpha.id, betaId: beta.id };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "unforge-app-"));
  store = await openAccountStore(join(dir, "accounts.dat"));
  // A literal cert keeps openApp off the filesystem; only the account hash consumes it.
  app = await openApp({ store, config: stubConfig(), certificatePem: "-----TEST-----" });
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

test("accounts.list flattens across logins and can filter to one", async () => {
  const { alphaId } = await seed();
  expect(app.accounts.list()).toHaveLength(3);
  const onlyAlpha = app.accounts.list(alphaId);
  expect(onlyAlpha).toHaveLength(2);
  expect(onlyAlpha.every((r) => r.gfEmail === "alpha@example.com")).toBe(true);
});

test("auth.setAlias sets then clears back to the derived handle", async () => {
  const added = await store.add({ email: "crbgames1+unclear2@gmail.com", password: "pw" });

  const set = await app.auth.setAlias("unclear2", "main");
  expect(set.handle).toBe("main");
  expect(store.get(added.id)?.alias).toBe("main");

  const cleared = await app.auth.setAlias("main", null);
  expect(cleared.handle).toBe("unclear2"); // derived again
  expect(store.get(added.id)?.alias).toBeUndefined();
});

test("auth.regenDevice rolls the whole device but preserves accounts and password", async () => {
  const { alphaId } = await seed();
  const before = app.auth.device(alphaId).device;
  const after = (await app.auth.regenDevice(alphaId)).device;

  expect(after.installationId).not.toBe(before.installationId);
  expect(after.identity.clientId).not.toBe(before.identity.clientId);
  expect(after.profile.canvasFingerprint).not.toBe(before.profile.canvasFingerprint);
  expect(store.get(alphaId)?.gameAccounts).toHaveLength(2);
  expect(store.get(alphaId)?.secrets.password).toBe("pw-a");
});

test("auth.logout without a live session just forgets the account", async () => {
  const { alphaId } = await seed();
  const { email } = await app.auth.logout(alphaId);
  expect(email).toBe("alpha@example.com");
  expect(store.get(alphaId)).toBeUndefined();
  expect(store.list()).toHaveLength(1);
});

test("subscribe emits an accounts event on every store write", async () => {
  const events: string[] = [];
  app.subscribe((e) => events.push(e.type));
  await seed();
  expect(events).toEqual(["accounts", "accounts"]);
});

test("snapshot carries no secrets", async () => {
  await seed();
  const snap = app.snapshot();
  expect(snap.accounts).toHaveLength(2);
  expect(snap.accounts[0]?.secrets).toBeUndefined();
  expect(JSON.stringify(snap)).not.toContain("pw-a");
});

test("accounts.create reuses a valid session, creates, and persists the new account", async () => {
  const alpha = await store.add({
    email: "alpha@example.com",
    password: "pw-a",
    token: { token: "cached-tok", expiresAt: Date.now() + 60_000 },
    gameAccounts: [
      { accountId: "g-100", username: "hero100", displayName: "Hero One", region: "pt-PT" },
    ],
  });

  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);

    if (url.endsWith("/api/v2/users/me/accounts") && method === "POST") {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer cached-tok");
      return new Response(
        JSON.stringify({
          accountId: "g-102",
          displayName: "Hero Three",
          gameId: "metin2",
          guls: { game: "pt-PT", server: "1", user: "hero102", lang: "pt" },
        }),
        { status: 201 },
      );
    }
    if (url.endsWith("/user/accounts")) {
      return new Response(
        JSON.stringify({
          "0": {
            id: "g-100",
            accountNumericId: 1,
            displayName: "Hero One",
            usernames: ["hero100"],
            gameId: "metin2",
            guls: { game: "pt-PT" },
          },
          "1": {
            id: "g-102",
            accountNumericId: 3,
            displayName: "Hero Three",
            usernames: ["hero102"],
            gameId: "metin2",
            guls: { game: "pt-PT" },
          },
        }),
        { status: 200 },
      );
    }
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;

  try {
    const created = await app.accounts.create({ displayName: "Hero Three" });

    expect(created.accountId).toBe("g-102");
    expect(created.region).toBe("pt-PT");
    // No re-auth: the cached token was still good, and re-auth churn is a risk-scoring trigger.
    expect(calls.some((c) => c.endsWith("/sessions"))).toBe(false);
    expect(
      store
        .get(alpha.id)
        ?.gameAccounts.map((g) => g.accountId)
        .toSorted(),
    ).toEqual(["g-100", "g-102"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("accounts.create authenticates for a fresh token when the session is expired", async () => {
  const alpha = await store.add({
    email: "alpha@example.com",
    password: "pw-a",
    token: { token: "stale-tok", expiresAt: Date.now() - 1 },
  });

  const originalFetch = globalThis.fetch;
  const createAuthHeaders: (string | null)[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? "GET";

    if (url.endsWith("/sessions") && method === "POST") {
      return new Response(JSON.stringify({ token: "fresh-tok" }), { status: 201 });
    }
    if (url.endsWith("/api/v2/users/me/accounts") && method === "POST") {
      createAuthHeaders.push(new Headers(init?.headers).get("Authorization"));
      return new Response(
        JSON.stringify({
          accountId: "g-300",
          displayName: "Fresh",
          gameId: "metin2",
          guls: { game: "pt-PT", server: "1", user: "fresh", lang: "pt" },
        }),
        { status: 201 },
      );
    }
    if (url.endsWith("/user/accounts")) {
      return new Response(
        JSON.stringify({
          "0": {
            id: "g-300",
            accountNumericId: 9,
            displayName: "Fresh",
            usernames: ["fresh"],
            gameId: "metin2",
            guls: { game: "pt-PT" },
          },
        }),
        { status: 200 },
      );
    }
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;

  try {
    const created = await app.accounts.create({ displayName: "Fresh" });
    expect(created.accountId).toBe("g-300");
    expect(createAuthHeaders).toEqual(["Bearer fresh-tok"]);
    expect(store.get(alpha.id)?.secrets.token?.token).toBe("fresh-tok");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("accounts.create requires --gf when multiple logins exist", async () => {
  await seed();
  await expect(app.accounts.create({ displayName: "Whoever" })).rejects.toThrow(
    /multiple GameForge accounts/,
  );
});

test("auth.register refuses an email that's already stored", async () => {
  await seed();
  await expect(app.auth.register({ email: "ALPHA@example.com", password: "x" })).rejects.toThrow(
    /already have a GameForge account/,
  );
});

test("auth.register registers, then logs in with the SAME device, and persists it", async () => {
  const originalFetch = globalThis.fetch;
  const installIds: Record<string, string> = {};
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? "GET";
    const instId = new Headers(init?.headers).get("TNT-Installation-Id");

    if (url.endsWith("/api/v2/users") && method === "POST") {
      installIds.users = instId!;
      // First attempt → captcha challenge; the retry (with header) → created.
      if (!new Headers(init?.headers).get("gf-challenge-id")) {
        return new Response("{}", { status: 409, headers: { "gf-challenge-id": "chal-1" } });
      }
      return new Response(JSON.stringify({ userId: "u-1" }), { status: 201 });
    }
    if (url.includes("/api/challenge/") && method === "GET") {
      return new Response(
        JSON.stringify({
          pow: { algorithm: "sha-256", challenges: [{ salt: "z", target: "0" }] },
          instrumentation: JSON.stringify([{ id: "op", type: "bitwise", code: "return 1;" }]),
        }),
        { status: 200 },
      );
    }
    if (url.includes("/api/challenge/")) {
      return new Response(JSON.stringify({ status: "solved" }), { status: 200 });
    }
    if (url.endsWith("/sessions") && method === "POST") {
      installIds.sessions = instId!;
      return new Response(JSON.stringify({ token: "tok-1" }), { status: 201 });
    }
    if (url.endsWith("/user/accounts")) {
      return new Response(
        JSON.stringify({
          "0": {
            id: "g-1",
            accountNumericId: 1,
            displayName: "New Hero",
            usernames: ["newhero"],
            gameId: "metin2",
            guls: { game: "pt-PT" },
          },
        }),
        { status: 200 },
      );
    }
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;

  try {
    const account = await app.auth.register({
      email: "new@example.com",
      password: "pw",
      alias: "hero",
    });

    expect(account.gameAccounts).toHaveLength(1);
    // The device that registered is the one that logged in — no fingerprint churn.
    expect(installIds.users).toBe(installIds.sessions);
    // And it's what got persisted, alias included.
    expect(store.get(account.id)?.secrets.device.installationId).toBe(installIds.users);
    expect(store.get(account.id)?.secrets.token?.token).toBe("tok-1");
    expect(store.get(account.id)?.alias).toBe("hero");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
