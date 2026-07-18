import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeviceIdentity, generateDeviceProfile } from "../core/index.ts";
import { openAccountStore, type AccountStore } from "./account-store.ts";

let dir: string;
let path: string;
let store: AccountStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "unforge-store-"));
  path = join(dir, "accounts.dat");
  store = await openAccountStore(path);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("put → get roundtrips secrets and identity", async () => {
  const identity = createDeviceIdentity();
  const id = await store.put({
    email: "scanner@example.com",
    password: "s3cr3t · pä$$",
    installationId: "12345678-abcd",
    deviceIdentity: identity,
    deviceProfile: generateDeviceProfile(),
    gameAccounts: [{ accountId: "acc-1", username: "hero", region: "pt-PT", server: "Rubinum" }],
  });

  const got = store.get(id);
  expect(got?.password).toBe("s3cr3t · pä$$");
  expect(got?.installationId).toBe("12345678-abcd");
  expect(got?.deviceIdentity).toEqual(identity);
  expect(got?.gameAccounts).toHaveLength(1);
  expect(got?.gameAccounts[0]?.username).toBe("hero");
  expect(got?.session).toBeUndefined();
});

test("persists a per-account device profile verbatim", async () => {
  const profile = generateDeviceProfile();
  const id = await store.put({
    email: "a@example.com",
    password: "pw",
    installationId: "id-1",
    deviceIdentity: createDeviceIdentity(),
    deviceProfile: profile,
  });
  expect(store.get(id)?.deviceProfile).toEqual(profile);
});

test("list omits secrets", async () => {
  await store.put({
    email: "a@example.com",
    password: "pw",
    installationId: "id-1",
    deviceIdentity: createDeviceIdentity(),
    session: { token: "tok", expiresAt: 9_999 },
  });
  const [summary] = store.list();
  expect(summary?.email).toBe("a@example.com");
  expect(summary?.tokenExpiresAt).toBe(9_999);
  expect(summary as object).not.toHaveProperty("password");
  expect(summary as object).not.toHaveProperty("session");
});

test("everything is encrypted at rest — no plaintext in the file", async () => {
  await store.put({
    email: "scanner@example.com",
    password: "SUPER_SECRET_PW",
    installationId: "inst-999",
    deviceIdentity: createDeviceIdentity(),
    gameAccounts: [{ accountId: "a1", username: "MyHero", region: "pt-PT", server: "Rubinum" }],
  });
  const bytes = readFileSync(path).toString("latin1");
  for (const plaintext of [
    "scanner@example.com",
    "SUPER_SECRET_PW",
    "inst-999",
    "10.0.0.1",
    "MyHero",
    "Rubinum",
  ]) {
    expect(bytes.includes(plaintext)).toBe(false);
  }
});

test("recordAuth caches the token and drifted identity", async () => {
  const id = await store.put({
    email: "a@example.com",
    password: "pw",
    installationId: "id-1",
    deviceIdentity: createDeviceIdentity(),
  });
  const drifted = createDeviceIdentity();
  await store.recordAuth(id, {
    session: { token: "bearer-xyz", expiresAt: 1_234 },
    deviceIdentity: drifted,
  });

  expect(store.get(id)?.session).toEqual({ token: "bearer-xyz", expiresAt: 1_234 });
  expect(store.get(id)?.deviceIdentity).toEqual(drifted);
});

test("put with an existing id updates and preserves createdAt", async () => {
  const id = await store.put({
    email: "a@example.com",
    password: "pw",
    installationId: "id-1",
    deviceIdentity: createDeviceIdentity(),
  });
  const created = store.list()[0]?.createdAt;
  await new Promise((r) => setTimeout(r, 5));
  await store.put({
    id,
    email: "b@example.com",
    password: "pw2",
    installationId: "id-1",
    deviceIdentity: createDeviceIdentity(),
  });

  const rows = store.list();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.email).toBe("b@example.com");
  expect(rows[0]?.createdAt).toBe(created!);
  expect(store.get(id)?.password).toBe("pw2");
});

test("state survives reopen (persisted, not just in memory)", async () => {
  const id = await store.put({
    email: "a@example.com",
    password: "pw",
    installationId: "id-1",
    deviceIdentity: createDeviceIdentity(),
  });
  const reopened = await openAccountStore(path);
  expect(reopened.get(id)?.password).toBe("pw");
});

test("remove deletes the account", async () => {
  const id = await store.put({
    email: "a@example.com",
    password: "pw",
    installationId: "id-1",
    deviceIdentity: createDeviceIdentity(),
    gameAccounts: [{ accountId: "acc-1", username: "hero", region: "pt-PT" }],
  });
  await store.remove(id);
  expect(store.list()).toHaveLength(0);
  expect(store.get(id)).toBeUndefined();
});
