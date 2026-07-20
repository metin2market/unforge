import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRegion } from "../core/index.ts";
import {
  openAccountStore,
  type AccountStore,
  type ConfigStore,
  type GameDirs,
} from "../storage/index.ts";
import { failOnFetch } from "../../test/support/fail-on-fetch.ts";
import { openApp, type App } from "./app.ts";

let dir: string;
let store: AccountStore;
let app: App;

/** In-memory config. A pt-PT client is the baseline — `create` and `launch` both need one. */
function stubConfig(gameDirs: GameDirs = { "pt-PT": "C:/metin2/pt-PT" }): ConfigStore {
  return {
    regions: () => Object.keys(gameDirs).filter(isRegion),
    gameDirs: () => gameDirs,
    gameDir: (region) => gameDirs[region],
    setGameDirs: async (entries) => {
      for (const [region, path] of entries) gameDirs[region] = path;
    },
  };
}

async function seed(): Promise<{ alphaId: string; betaId: string }> {
  const alpha = await store.add({
    email: "alpha@example.com",
    password: "pw-a",
    gameAccounts: [
      { accountId: "g-100", displayName: "Hero One", accountGroup: "pt" },
      { accountId: "g-101", displayName: "Hero Two", accountGroup: "pt" },
    ],
  });
  const beta = await store.add({
    email: "beta@example.com",
    password: "pw-b",
    gameAccounts: [{ accountId: "g-200", displayName: "Mage", accountGroup: "de" }],
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
    gameAccounts: [{ accountId: "g-100", displayName: "Hero One", accountGroup: "pt" }],
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
            accountGroup: "pt",
            deleted: null,
            preDeleted: null,
            guls: { game: "pt-PT" },
          },
          "1": {
            id: "g-102",
            accountNumericId: 3,
            displayName: "Hero Three",
            usernames: ["hero102"],
            gameId: "metin2",
            accountGroup: "pt",
            deleted: null,
            preDeleted: null,
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
    expect(created.accountGroup).toBe("pt");
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
            accountGroup: "pt",
            deleted: null,
            preDeleted: null,
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

test("accounts.sync replaces the stored set with GameForge's, additions and removals alike", async () => {
  const alpha = await store.add({
    email: "alpha@example.com",
    password: "pw-a",
    token: { token: "cached-tok", expiresAt: Date.now() + 60_000 },
    // `Stale` is gone from GameForge; `g-100` is stored under a name it has since changed.
    gameAccounts: [
      { accountId: "g-100", displayName: "Old Name", accountGroup: "pt" },
      { accountId: "g-999", displayName: "Stale", accountGroup: "pt" },
    ],
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/user/accounts")) {
      return new Response(
        JSON.stringify({
          "0": {
            id: "g-100",
            accountNumericId: 1,
            displayName: "Hero One",
            usernames: ["hero100"],
            gameId: "metin2",
            accountGroup: "pt",
            deleted: null,
            preDeleted: null,
            guls: { game: "pt-PT" },
          },
          "1": {
            id: "g-101",
            accountNumericId: 2,
            displayName: "Hero Two",
            usernames: ["hero101"],
            gameId: "metin2",
            accountGroup: "de",
            deleted: null,
            preDeleted: null,
            guls: { game: "de-DE" },
          },
        }),
        { status: 200 },
      );
    }
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;

  try {
    const rows = await app.accounts.sync();
    expect(rows.map((r) => r.accountId).toSorted()).toEqual(["g-100", "g-101"]);
    const stored = store.get(alpha.id)!.gameAccounts;
    expect(stored.map((g) => g.accountId).toSorted()).toEqual(["g-100", "g-101"]);
    expect(stored.find((g) => g.accountId === "g-100")?.displayName).toBe("Hero One");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── region safeguards ───────────────────────────────────────────────────────────
// Knowable from the account plus the config, so these refuse without asking GameForge.

/** A login owning one game account, in whatever group the test needs. */
async function seedOneAccount(group: string): Promise<void> {
  await store.add({
    email: "alpha@example.com",
    password: "pw-a",
    token: { token: "tok", expiresAt: Date.now() + 60_000 },
    gameAccounts: [{ accountId: "g-1", displayName: "uclt1", accountGroup: group }],
  });
}

test("accounts.create refuses a region with no installed client, before any network call", async () => {
  await store.add({ email: "alpha@example.com", password: "pw-a" });
  await failOnFetch(async () => {
    await expect(app.accounts.create({ displayName: "Hero", region: "tr-TR" })).rejects.toThrow(
      /no tr-TR client installed/,
    );
  });
});

test("accounts.create names the real problem when no client is installed at all", async () => {
  // Not "--region is required" — passing one wouldn't help.
  const none = await openApp({
    store,
    config: stubConfig({}),
    certificatePem: "-----TEST-----",
  });
  await store.add({ email: "alpha@example.com", password: "pw-a" });
  try {
    await failOnFetch(async () => {
      await expect(none.accounts.create({ displayName: "Hero" })).rejects.toThrow(
        /no game client configured/,
      );
    });
  } finally {
    await none.close();
  }
});

test("accounts.create demands an explicit region when the machine has several clients", async () => {
  const many = await openApp({
    store,
    config: stubConfig({ "pt-PT": "C:/m/pt", "de-DE": "C:/m/de" }),
    certificatePem: "-----TEST-----",
  });
  await store.add({ email: "alpha@example.com", password: "pw-a" });
  try {
    await failOnFetch(async () => {
      await expect(many.accounts.create({ displayName: "Hero" })).rejects.toThrow(
        /--region is required/,
      );
    });
  } finally {
    await many.close();
  }
});

test("launch refuses an account whose region has no client here, before burning an auth", async () => {
  // The Turkish account on a Portuguese box: its region is known, the client is what's missing —
  // a config question, so GameForge needn't be asked.
  await seedOneAccount("tr");
  await failOnFetch(async () => {
    await expect(app.launches.start("uclt1")).rejects.toThrow(/no game dir for region tr-TR/);
  });
});

test("launch and mint both refuse a group the region table doesn't cover", async () => {
  await seedOneAccount("zz");
  await failOnFetch(async () => {
    await expect(app.launches.start("uclt1")).rejects.toThrow(/no region in core/);
    await expect(app.accounts.mintCode("uclt1")).rejects.toThrow(/no region in core/);
  });
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
            accountGroup: "pt",
            deleted: null,
            preDeleted: null,
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
