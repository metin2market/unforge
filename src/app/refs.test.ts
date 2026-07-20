// refs is pure over a plain account list, so these need no store, no disk, and no mocking.

import { expect, test } from "bun:test";
import type { GameAccount } from "../core/index.ts";
import type { GfAccount } from "../storage/index.ts";
import {
  gfAlias,
  gfHandle,
  resolveGameAccount,
  resolveGfAccount,
  soleGfAccount,
  toStoredGameAccount,
  validateAlias,
} from "./refs.ts";

const account = (id: string, email: string, extra: Partial<GfAccount> = {}): GfAccount => ({
  id,
  email,
  gameAccounts: [],
  createdAt: 0,
  ...extra,
});

const accounts: GfAccount[] = [
  account("aaaa1111-0000-4000-8000-000000000001", "alpha@example.com", {
    gameAccounts: [
      { accountId: "g-100", displayName: "Hero One", accountGroup: "pt" },
      { accountId: "g-101", displayName: "Hero Two", accountGroup: "pt" },
    ],
  }),
  account("bbbb2222-0000-4000-8000-000000000002", "beta@example.com", {
    gameAccounts: [{ accountId: "g-200", displayName: "Mage", accountGroup: "de" }],
  }),
];

const alphaId = accounts[0].id;
const betaId = accounts[1].id;

test("resolveGfAccount matches by email, full id, and id prefix", () => {
  expect(resolveGfAccount(accounts, "alpha@example.com").id).toBe(alphaId);
  expect(resolveGfAccount(accounts, "ALPHA@EXAMPLE.COM").id).toBe(alphaId);
  expect(resolveGfAccount(accounts, alphaId).id).toBe(alphaId);
  expect(resolveGfAccount(accounts, alphaId.slice(0, 8)).id).toBe(alphaId);
});

test("resolveGfAccount throws on no match", () => {
  expect(() => resolveGfAccount(accounts, "nobody@example.com")).toThrow(/no GameForge account/);
});

test("gfAlias derives the local part, or the +tag for a plus-address", () => {
  expect(gfAlias("crbgames1+unclear2@gmail.com")).toBe("unclear2");
  expect(gfAlias("crbgames1@gmail.com")).toBe("crbgames1");
  expect(gfAlias("a+b+c@x.com")).toBe("b+c"); // everything after the first +
});

test("resolveGfAccount matches a derived alias and a stored alias, case-insensitively", () => {
  const plus = [account("id-1", "crbgames1+unclear2@gmail.com")];
  expect(resolveGfAccount(plus, "unclear2").id).toBe("id-1");
  expect(resolveGfAccount(plus, "UNCLEAR2").id).toBe("id-1");

  // A stored alias also resolves, and doesn't shadow the derived one.
  const aliased = [account("id-1", "crbgames1+unclear2@gmail.com", { alias: "main" })];
  expect(resolveGfAccount(aliased, "main").id).toBe("id-1");
  expect(resolveGfAccount(aliased, "unclear2").id).toBe("id-1");
  expect(gfHandle(aliased[0])).toBe("main");
});

test("validateAlias rejects empty, whitespace, numeric, and colliding handles", () => {
  const pair = [account("a", "crbgames1+one@gmail.com"), account("b", "crbgames1+two@gmail.com")];
  expect(() => validateAlias(pair, "a", "  ")).toThrow(/empty/);
  expect(() => validateAlias(pair, "a", "has space")).toThrow(/whitespace/);
  expect(() => validateAlias(pair, "a", "42")).toThrow(/numeric/);
  // "two" is b's derived alias — assigning it to a would make the handle ambiguous.
  expect(() => validateAlias(pair, "a", "two")).toThrow(/already refers to/);
  // Its own derived alias is fine, and it trims.
  expect(validateAlias(pair, "a", "  one  ")).toBe("one");
});

test("resolveGameAccount finds by name and account id — globally, case-insensitively", () => {
  expect(resolveGameAccount(accounts, "Hero One").gfId).toBe(alphaId);
  expect(resolveGameAccount(accounts, "hero one").gameAccount.accountId).toBe("g-100");
  expect(resolveGameAccount(accounts, "g-200").gfId).toBe(betaId);
  expect(resolveGameAccount(accounts, "MAGE").gameAccount.accountId).toBe("g-200");
});

test("resolveGameAccount throws on no match", () => {
  expect(() => resolveGameAccount(accounts, "ghost")).toThrow(/no game account/);
});

test("soleGfAccount refuses to guess when there's more than one login", () => {
  expect(soleGfAccount([accounts[0]]).id).toBe(alphaId);
  expect(() => soleGfAccount(accounts)).toThrow(/multiple GameForge accounts/);
  expect(() => soleGfAccount([])).toThrow(/no GameForge account/);
});

// ── stamping ────────────────────────────────────────────────────────────────────
// A stored account is GameForge's answer copied verbatim — see core/regions.test.ts for the
// group-to-region table it is read through.

const liveAccount = (extra: Partial<GameAccount> = {}): GameAccount => ({
  id: "acc-1",
  numericId: 1,
  displayName: "neu418x",
  usernames: [],
  gameId: "fab180a3-cd65-4b7e-bd0e-2ef77fd0c258",
  gameName: "metin2",
  accountGroup: "pt",
  retired: false,
  ...extra,
});

test("stores GameForge's three fields verbatim, under GameForge's names", () => {
  expect(toStoredGameAccount(liveAccount({ accountGroup: "tr" }))).toEqual({
    accountId: "acc-1",
    displayName: "neu418x",
    accountGroup: "tr",
  });
});
