import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeviceIdentity } from "../core/index.ts";
import { openAccountStore, type AccountStore } from "../storage/index.ts";
import { createGfAccount, deviceInfo, logoutAccount, regenDevice, setGfAlias } from "./accounts.ts";
import { addGameAccount, listAllGameAccounts } from "./game.ts";
import {
  gfAlias,
  gfHandle,
  resolveGameAccount,
  resolveGfAccount,
  validateAlias,
} from "./shared.ts";

let dir: string;
let store: AccountStore;

async function seed(): Promise<{ alphaId: string; betaId: string }> {
  const alphaId = await store.put({
    email: "alpha@example.com",
    password: "pw-a",
    installationId: "aaaa1111-0000",
    deviceIdentity: createDeviceIdentity(),
    gameAccounts: [
      { accountId: "g-100", username: "hero100", displayName: "Hero One", region: "pt-PT" },
      { accountId: "g-101", username: "hero101", displayName: "Hero Two", region: "pt-PT" },
    ],
  });
  const betaId = await store.put({
    email: "beta@example.com",
    password: "pw-b",
    installationId: "bbbb2222-0000",
    deviceIdentity: createDeviceIdentity(),
    gameAccounts: [
      { accountId: "g-200", username: "mage200", displayName: "Mage", region: "de-DE" },
    ],
  });
  return { alphaId, betaId };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "unforge-app-"));
  store = await openAccountStore(join(dir, "accounts.dat"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("resolveGfAccount matches by email, full id, and id prefix", async () => {
  const { alphaId } = await seed();
  expect(resolveGfAccount(store, "alpha@example.com").id).toBe(alphaId);
  expect(resolveGfAccount(store, "ALPHA@EXAMPLE.COM").id).toBe(alphaId);
  expect(resolveGfAccount(store, alphaId).id).toBe(alphaId);
  expect(resolveGfAccount(store, alphaId.slice(0, 8)).id).toBe(alphaId);
});

test("resolveGfAccount throws on no match", async () => {
  await seed();
  expect(() => resolveGfAccount(store, "nobody@example.com")).toThrow(/no GameForge account/);
});

test("gfAlias derives the local part, or the +tag for a plus-address", () => {
  expect(gfAlias("crbgames1+unclear2@gmail.com")).toBe("unclear2");
  expect(gfAlias("crbgames1@gmail.com")).toBe("crbgames1");
  expect(gfAlias("a+b+c@x.com")).toBe("b+c"); // everything after the first +
});

test("resolveGfAccount matches a derived alias and a stored alias, case-insensitively", async () => {
  const id = await store.put({
    email: "crbgames1+unclear2@gmail.com",
    password: "pw",
    installationId: "i-1",
    deviceIdentity: createDeviceIdentity(),
  });
  // Derived from the +tag.
  expect(resolveGfAccount(store, "unclear2").id).toBe(id);
  expect(resolveGfAccount(store, "UNCLEAR2").id).toBe(id);
  // A stored alias also resolves, and doesn't shadow the derived one.
  await store.setAlias(id, "main");
  expect(resolveGfAccount(store, "main").id).toBe(id);
  expect(resolveGfAccount(store, "unclear2").id).toBe(id);
  expect(gfHandle(resolveGfAccount(store, id))).toBe("main");
});

test("validateAlias rejects empty, whitespace, numeric, and colliding handles", async () => {
  const a = await store.put({
    email: "crbgames1+one@gmail.com",
    password: "pw",
    installationId: "i-a",
    deviceIdentity: createDeviceIdentity(),
  });
  const b = await store.put({
    email: "crbgames1+two@gmail.com",
    password: "pw",
    installationId: "i-b",
    deviceIdentity: createDeviceIdentity(),
  });
  expect(() => validateAlias(store, a, "  ")).toThrow(/empty/);
  expect(() => validateAlias(store, a, "has space")).toThrow(/whitespace/);
  expect(() => validateAlias(store, a, "42")).toThrow(/numeric/);
  // "two" is b's derived alias — assigning it to a would make the handle ambiguous.
  expect(() => validateAlias(store, a, "two")).toThrow(/already refers to/);
  // Its own derived alias is fine, and it trims.
  expect(validateAlias(store, a, "  one  ")).toBe("one");
  expect(b).toBeDefined();
});

test("setGfAlias sets then clears back to the derived handle", async () => {
  const id = await store.put({
    email: "crbgames1+unclear2@gmail.com",
    password: "pw",
    installationId: "i-1",
    deviceIdentity: createDeviceIdentity(),
  });
  const set = await setGfAlias(store, "unclear2", "main");
  expect(set.handle).toBe("main");
  expect(store.get(id)?.alias).toBe("main");

  const cleared = await setGfAlias(store, "main", undefined);
  expect(cleared.handle).toBe("unclear2"); // derived again
  expect(store.get(id)?.alias).toBeUndefined();
});

test("resolveGameAccount finds by username, display name, and account id — globally", async () => {
  const { alphaId, betaId } = await seed();
  expect(resolveGameAccount(store, "hero100").gf.id).toBe(alphaId);
  expect(resolveGameAccount(store, "Hero One").game.accountId).toBe("g-100");
  expect(resolveGameAccount(store, "g-200").gf.id).toBe(betaId);
  // Case-insensitive on username.
  expect(resolveGameAccount(store, "MAGE200").game.accountId).toBe("g-200");
});

test("resolveGameAccount throws on no match", async () => {
  await seed();
  expect(() => resolveGameAccount(store, "ghost")).toThrow(/no game account/);
});

test("listAllGameAccounts flattens across logins and can filter to one", async () => {
  const { alphaId } = await seed();
  expect(listAllGameAccounts(store)).toHaveLength(3);
  const onlyAlpha = listAllGameAccounts(store, alphaId);
  expect(onlyAlpha).toHaveLength(2);
  expect(onlyAlpha.every((r) => r.gfEmail === "alpha@example.com")).toBe(true);
});

test("regenDevice rolls a new device but preserves game accounts", async () => {
  const { alphaId } = await seed();
  const before = deviceInfo(store, alphaId);
  const after = await regenDevice(store, alphaId);

  expect(after.installationId).not.toBe(before.installationId);
  expect(after.clientId).not.toBe(before.clientId);
  expect(after.deviceProfile.canvasFingerprint).not.toBe(before.deviceProfile.canvasFingerprint);
  // Game accounts and the password survive the roll.
  expect(store.get(alphaId)?.gameAccounts).toHaveLength(2);
  expect(store.get(alphaId)?.password).toBe("pw-a");
});

test("logoutAccount without a live session just forgets the account", async () => {
  const { alphaId } = await seed();
  const { email } = await logoutAccount(store, alphaId);
  expect(email).toBe("alpha@example.com");
  expect(store.get(alphaId)).toBeUndefined();
  expect(store.list()).toHaveLength(1);
});

test("addGameAccount reuses a valid session, creates, and persists the new account", async () => {
  const alphaId = await store.put({
    email: "alpha@example.com",
    password: "pw-a",
    installationId: "aaaa1111-0000",
    deviceIdentity: createDeviceIdentity(),
    gameAccounts: [
      { accountId: "g-100", username: "hero100", displayName: "Hero One", region: "pt-PT" },
    ],
    session: { token: "cached-tok", expiresAt: Date.now() + 60_000 },
  });

  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);

    if (url.endsWith("/api/v2/users/me/accounts") && method === "POST") {
      const auth = new Headers(init?.headers).get("Authorization");
      expect(auth).toBe("Bearer cached-tok"); // reused the cached session
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
    const res = await addGameAccount({ store, displayName: "Hero Three" });

    expect(res.account.accountId).toBe("g-102");
    expect(res.account.region).toBe("pt-PT");
    // No re-auth: the cached token was still good.
    expect(calls.some((c) => c.endsWith("/sessions"))).toBe(false);
    // Both the old and the new account are persisted.
    expect(
      store
        .get(alphaId)
        ?.gameAccounts.map((g) => g.accountId)
        .sort(),
    ).toEqual(["g-100", "g-102"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("addGameAccount authenticates for a fresh token when the session is expired", async () => {
  await store.put({
    email: "alpha@example.com",
    password: "pw-a",
    installationId: "aaaa1111-0000",
    deviceIdentity: createDeviceIdentity(),
    gameAccounts: [],
    session: { token: "stale-tok", expiresAt: Date.now() - 1 },
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
    const res = await addGameAccount({ store, displayName: "Fresh" });
    expect(res.account.accountId).toBe("g-300");
    // The stale token was replaced before creating.
    expect(createAuthHeaders).toEqual(["Bearer fresh-tok"]);
    expect(store.get(resolveGfAccount(store, "alpha@example.com").id)?.session?.token).toBe(
      "fresh-tok",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("addGameAccount requires --gf when multiple logins exist", async () => {
  await seed(); // two GF accounts
  await expect(addGameAccount({ store, displayName: "Whoever" })).rejects.toThrow(
    /multiple GameForge accounts/,
  );
});

test("createGfAccount refuses an email that's already stored", async () => {
  await seed();
  await expect(
    createGfAccount({ store, email: "ALPHA@example.com", password: "x" }),
  ).rejects.toThrow(/already have a GameForge account/);
});

test("createGfAccount registers, then logs in with the SAME device, and persists it", async () => {
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
    if (url.includes("/api/challenge/"))
      return new Response(JSON.stringify({ status: "solved" }), { status: 200 });
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
    const res = await createGfAccount({
      store,
      email: "new@example.com",
      password: "pw",
      alias: "hero",
    });

    expect(res.isNew).toBe(true);
    expect(res.gameAccounts).toHaveLength(1);
    // The device that registered is the one that logged in — no fingerprint churn.
    expect(installIds.users).toBe(installIds.sessions);
    // And it's what got persisted, alias included.
    expect(store.get(res.id)?.installationId).toBe(installIds.users);
    expect(store.get(res.id)?.session?.token).toBe("tok-1");
    expect(store.get(res.id)?.alias).toBe("hero");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
