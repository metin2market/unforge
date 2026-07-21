import { expect, test } from "bun:test";
import type { GameAccountRow } from "../app/index.ts";
import type { GfAccount } from "../storage/index.ts";
import { gameAccountOptions, gfAccountOptions, pickRegion, regionOptions } from "./pick.ts";

function summary(over: Partial<GfAccount> & { email: string }): GfAccount {
  return {
    id: over.id ?? over.email,
    gameAccounts: [],
    createdAt: 0,
    ...over,
  };
}

test("gfAccountOptions labels by handle and hints with email + account count", () => {
  const rows = gfAccountOptions([
    summary({ id: "a", email: "player1+alt2@example.com" }),
    summary({
      id: "b",
      email: "player1@example.com",
      alias: "main",
      gameAccounts: [
        { accountId: "g", displayName: "u", accountGroup: "pt" },
        { accountId: "g2", displayName: "u2", accountGroup: "pt" },
      ],
    }),
  ]);

  expect(rows[0]).toEqual({
    value: "a",
    label: "alt2", // derived from the +tag
    hint: "player1+alt2@example.com · 0 game account(s)",
  });
  expect(rows[1]).toEqual({
    value: "b",
    label: "main", // stored alias wins over the derived "player1"
    hint: "player1@example.com · 2 game account(s)",
  });
});

test("gameAccountOptions labels by name and hints with region + owning login", () => {
  const rows: GameAccountRow[] = [
    {
      accountId: "g-1",
      displayName: "Hero One",
      accountGroup: "pt",
      gfId: "a",
      gfEmail: "player1@example.com",
    },
    {
      accountId: "g-2",
      displayName: "Mage",
      accountGroup: "de",
      gfId: "b",
      gfEmail: "player1+alt2@example.com",
    },
  ];
  expect(gameAccountOptions(rows)).toEqual([
    { value: "g-1", label: "Hero One", hint: "pt-PT · player1@example.com" },
    { value: "g-2", label: "Mage", hint: "de-DE · player1+alt2@example.com" },
  ]);
});

test("an account whose group has no region still picks, and says so", () => {
  // A market with no row yet: still selectable, but the hint mustn't render a blank.
  const rows: GameAccountRow[] = [
    {
      accountId: "g-3",
      displayName: "Ghost",
      accountGroup: "zz",
      gfId: "c",
      gfEmail: "player1@example.com",
    },
  ];
  expect(gameAccountOptions(rows)[0].hint).toBe("group zz (no region) · player1@example.com");
});

test("regionOptions offers the installed regions, in the order config reports them", () => {
  expect(regionOptions(["pt-PT", "de-DE"])).toEqual([
    { value: "pt-PT", label: "pt-PT" },
    { value: "de-DE", label: "de-DE" },
  ]);
});

test("pickRegion takes the sole installed client without asking", async () => {
  expect(await pickRegion(["pt-PT"])).toBe("pt-PT");
});

test("pickRegion names the real problem when no client is installed", async () => {
  // Not "pass --region" — passing one wouldn't help.
  await expect(pickRegion([])).rejects.toThrow(/no game client configured/);
});

test("pickRegion refuses rather than guessing when a script has several to choose from", async () => {
  await expect(pickRegion(["pt-PT", "de-DE"])).rejects.toThrow(/pass --region/);
});
