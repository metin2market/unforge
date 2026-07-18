import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevice } from "./device.ts";
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

test("add → get roundtrips secrets and device", async () => {
  const device = createDevice();
  const { id } = await store.add({
    email: "scanner@example.com",
    password: "s3cr3t · pä$$",
    device,
    gameAccounts: [{ accountId: "acc-1", username: "hero", region: "pt-PT", server: "Rubinum" }],
  });

  const got = store.get(id);
  expect(got?.secrets.password).toBe("s3cr3t · pä$$");
  expect(got?.secrets.device).toEqual(device);
  expect(got?.gameAccounts).toHaveLength(1);
  expect(got?.gameAccounts[0]?.username).toBe("hero");
  expect(got?.secrets.token).toBeUndefined();
});

test("mints a distinct device when the caller brings none", async () => {
  const a = await store.add({ email: "a@example.com", password: "pw" });
  const b = await store.add({ email: "b@example.com", password: "pw" });
  // A shared fingerprint would correlate the two accounts — the whole point of per-account devices.
  expect(a.secrets.device.installationId).not.toBe(b.secrets.device.installationId);
  expect(a.secrets.device.profile).not.toEqual(b.secrets.device.profile);
});

test("list omits secrets", async () => {
  await store.add({
    email: "a@example.com",
    password: "pw",
    token: { token: "tok", expiresAt: 9_999 },
  });
  const [summary] = store.list();
  expect(summary?.email).toBe("a@example.com");
  expect(summary?.tokenExpiresAt).toBe(9_999);
  expect(summary?.secrets).toBeUndefined();
});

test("everything is encrypted at rest — no plaintext in the file", async () => {
  await store.add({
    email: "scanner@example.com",
    password: "SUPER_SECRET_PW",
    gameAccounts: [{ accountId: "a1", username: "MyHero", region: "pt-PT", server: "Rubinum" }],
  });
  const bytes = readFileSync(path).toString("latin1");
  for (const plaintext of ["scanner@example.com", "SUPER_SECRET_PW", "MyHero", "Rubinum"]) {
    expect(bytes.includes(plaintext)).toBe(false);
  }
});

test("save writes the token and drifted device together", async () => {
  const { id } = await store.add({ email: "a@example.com", password: "pw" });
  const drifted = createDevice();
  await store.save(id, { token: { token: "bearer-xyz", expiresAt: 1_234 }, device: drifted });

  expect(store.get(id)?.secrets.token).toEqual({ token: "bearer-xyz", expiresAt: 1_234 });
  expect(store.get(id)?.secrets.device).toEqual(drifted);
});

test("save merges — an absent key is left alone, alias: null clears", async () => {
  const { id } = await store.add({ email: "a@example.com", password: "pw", alias: "scan1" });
  await store.save(id, { password: "pw2" });
  expect(store.list()[0]?.alias).toBe("scan1");
  expect(store.get(id)?.secrets.password).toBe("pw2");

  await store.save(id, { alias: null });
  expect(store.list()[0]?.alias).toBeUndefined();
});

test("save preserves createdAt", async () => {
  const { id, createdAt } = await store.add({ email: "a@example.com", password: "pw" });
  await new Promise<void>((r) => {
    setTimeout(r, 5);
  });
  await store.save(id, { password: "pw2" });
  expect(store.list()[0]?.createdAt).toBe(createdAt);
});

test("onChange fires after a write, with the secret-free list", async () => {
  const seen: number[] = [];
  store.onChange((accounts) => seen.push(accounts.length));
  const { id } = await store.add({ email: "a@example.com", password: "pw" });
  await store.save(id, { lastUsedAt: 1 });
  expect(seen).toEqual([1, 1]);
});

test("state survives reopen (persisted, not just in memory)", async () => {
  const { id } = await store.add({ email: "a@example.com", password: "pw" });
  const reopened = await openAccountStore(path);
  expect(reopened.get(id)?.secrets.password).toBe("pw");
});

test("remove deletes the account", async () => {
  const { id } = await store.add({
    email: "a@example.com",
    password: "pw",
    gameAccounts: [{ accountId: "acc-1", username: "hero", region: "pt-PT" }],
  });
  await store.remove(id);
  expect(store.list()).toHaveLength(0);
  expect(store.get(id)).toBeUndefined();
});
