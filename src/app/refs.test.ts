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
  type StampRegion,
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
      { accountId: "g-100", username: "hero100", displayName: "Hero One", region: "pt-PT" },
      { accountId: "g-101", username: "hero101", displayName: "Hero Two", region: "pt-PT" },
    ],
  }),
  account("bbbb2222-0000-4000-8000-000000000002", "beta@example.com", {
    gameAccounts: [
      { accountId: "g-200", username: "mage200", displayName: "Mage", region: "de-DE" },
    ],
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

test("resolveGameAccount finds by username, display name, and account id — globally", () => {
  expect(resolveGameAccount(accounts, "hero100").gfId).toBe(alphaId);
  expect(resolveGameAccount(accounts, "Hero One").game.accountId).toBe("g-100");
  expect(resolveGameAccount(accounts, "g-200").gfId).toBe(betaId);
  expect(resolveGameAccount(accounts, "MAGE200").game.accountId).toBe("g-200");
});

test("resolveGameAccount throws on no match", () => {
  expect(() => resolveGameAccount(accounts, "ghost")).toThrow(/no game account/);
});

test("soleGfAccount refuses to guess when there's more than one login", () => {
  expect(soleGfAccount([accounts[0]]).id).toBe(alphaId);
  expect(() => soleGfAccount(accounts)).toThrow(/multiple GameForge accounts/);
  expect(() => soleGfAccount([])).toThrow(/no GameForge account/);
});

// ── region stamping ─────────────────────────────────────────────────────────────
// A region is the account's own property and decides two things at once: which localized client
// launches, and the `gameId.<region>` `thin/codes` is asked for. GameForge only tells us the
// language half, so the country half comes from the clients installed here.

const INSTALLED = ["pt-PT", "en-GB"];

const remote = (extra: Partial<GameAccount> = {}): GameAccount => ({
  id: "acc-1",
  numericId: 1,
  displayName: "neu418x",
  usernames: ["neu418x"],
  gameId: "fab180a3-cd65-4b7e-bd0e-2ef77fd0c258",
  gameName: "metin2",
  retired: false,
  ...extra,
});

const stamp = (game: GameAccount, over: Partial<StampRegion> = {}) =>
  toStoredGameAccount(game, { installed: INSTALLED, fallback: "pt-PT", ...over });

test("resolves the language GameForge reports against the installed clients", () => {
  expect(stamp(remote({ accountGroup: "en" })).region).toBe("en-GB");
  expect(stamp(remote({ accountGroup: "pt" })).region).toBe("pt-PT");
});

test('never invents a country half — GameForge ships "en" as en-GB, not en-EN', () => {
  // With no en client installed there is no honest answer, so it falls back rather than guess.
  expect(
    toStoredGameAccount(remote({ accountGroup: "en" }), {
      installed: ["pt-PT"],
      fallback: "pt-PT",
    }).region,
  ).toBe("pt-PT");
});

test("translates the groups whose code is a country, not a language", () => {
  // GF files Danish accounts under "dk" but ships the client as "da" (probed: ?locale=dk returns
  // an empty file list, ?locale=da the real client). Matching "dk" to "da-DK" needs the table.
  expect(stamp(remote({ accountGroup: "dk" }), { installed: ["da-DK"] }).region).toBe("da-DK");
  expect(stamp(remote({ accountGroup: "cz" }), { installed: ["cs-CZ"] }).region).toBe("cs-CZ");
});

test("an explicit region outranks GameForge — that one came from a person", () => {
  expect(stamp(remote({ accountGroup: "pt" }), { explicit: "en-GB" }).region).toBe("en-GB");
});

test("GameForge overrides a region we guessed wrong on an earlier login", () => {
  const prior = account("gf-1", "a@b.c", {
    gameAccounts: [
      { accountId: "acc-1", username: "neu418x", displayName: "neu418x", region: "pt-PT" },
    ],
  });
  // Without this, a login stamped once with the wrong region stays unlaunchable forever.
  expect(stamp(remote({ accountGroup: "en" }), { prior }).region).toBe("en-GB");
});

test("keeps the stored region when GameForge sends no group", () => {
  const prior = account("gf-1", "a@b.c", {
    gameAccounts: [
      { accountId: "acc-1", username: "neu418x", displayName: "neu418x", region: "tr-TR" },
    ],
  });
  expect(stamp(remote(), { prior }).region).toBe("tr-TR");
});

test("falls back to the default when nothing else says", () => {
  expect(stamp(remote()).region).toBe("pt-PT");
});
