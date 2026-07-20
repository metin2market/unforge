// `loadState` is the one place a sealed blob becomes typed state. A store that isn't the
// shape we wrote has to fail loudly here — the alternative is a TypeError several frames
// later, in a getter, naming nothing the user can act on.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite } from "./atomic-write.ts";
import { createDevice } from "./device.ts";
import { sealSecret } from "./seal.ts";
import { loadState, saveState } from "./store-file.ts";

let dir: string;
let path: string;

const seal = async (value: unknown): Promise<void> => {
  await atomicWrite(path, await sealSecret(JSON.stringify(value)));
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unforge-storefile-"));
  path = join(dir, "accounts.dat");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("an absent store is an empty state, not an error", async () => {
  expect(await loadState(join(dir, "missing.dat"))).toEqual({ accounts: [] });
});

test("round-trips what saveState wrote", async () => {
  const state = {
    accounts: [
      {
        id: "acc-1",
        email: "a@example.com",
        gameAccounts: [],
        createdAt: 1,
        secrets: { password: "pw", device: createDevice() },
      },
    ],
  };
  await saveState(path, state);
  expect(await loadState(path)).toEqual(state);
});

test("rejects a blob that isn't the shape we wrote", async () => {
  await seal({ nope: true });
  await expect(loadState(path)).rejects.toThrow(/isn't in the current format/);
});

test("stale game accounts empty out, keeping the secrets that can't be re-fetched", async () => {
  const device = createDevice();
  // The pre-group shape: `username` + `region`, no `accountGroup`.
  await seal({
    accounts: [
      {
        id: "acc-1",
        email: "a@example.com",
        gameAccounts: [
          { accountId: "g-1", username: "hero100", displayName: "Hero One", region: "pt-PT" },
        ],
        createdAt: 1,
        secrets: { password: "pw", device },
      },
    ],
  });

  const state = await loadState(path);
  expect(state.accounts[0].gameAccounts).toEqual([]);
  expect(state.accounts[0].secrets.device).toEqual(device);
  expect(state.accounts[0].secrets.password).toBe("pw");
});

test("one unreadable game account empties the set — they re-list together or not at all", async () => {
  await seal({
    accounts: [
      {
        id: "acc-1",
        email: "a@example.com",
        gameAccounts: [
          { accountId: "g-1", displayName: "Good", accountGroup: "pt" },
          { accountId: "g-2", displayName: "Bad" },
        ],
        createdAt: 1,
        secrets: { password: "pw", device: createDevice() },
      },
    ],
  });
  expect((await loadState(path)).accounts[0].gameAccounts).toEqual([]);
});

test("rejects a pre-nesting store rather than crashing later in a getter", async () => {
  // The old flat shape: password/device/session on the account, no `secrets`. This parses
  // fine as an object with an accounts array, so only the per-account check catches it.
  await seal({
    version: 1,
    accounts: [
      {
        id: "acc-1",
        email: "a@example.com",
        password: "pw",
        installationId: "inst-1",
        gameAccounts: [],
        createdAt: 1,
      },
    ],
  });
  await expect(loadState(path)).rejects.toThrow(/delete it and run/);
});
