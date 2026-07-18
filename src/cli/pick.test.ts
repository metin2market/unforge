import { expect, test } from "bun:test";
import type { GameAccountRow } from "../app/index.ts";
import type { GfAccount } from "../storage/index.ts";
import { gameAccountOptions, gfAccountOptions } from "./pick.ts";

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
    summary({ id: "a", email: "crbgames1+unclear2@gmail.com" }),
    summary({
      id: "b",
      email: "crbgames1@gmail.com",
      alias: "main",
      gameAccounts: [
        { accountId: "g", username: "u", region: "pt-PT" },
        { accountId: "g2", username: "u2", region: "pt-PT" },
      ],
    }),
  ]);

  expect(rows[0]).toEqual({
    value: "a",
    label: "unclear2", // derived from the +tag
    hint: "crbgames1+unclear2@gmail.com · 0 game account(s)",
  });
  expect(rows[1]).toEqual({
    value: "b",
    label: "main", // stored alias wins over the derived "crbgames1"
    hint: "crbgames1@gmail.com · 2 game account(s)",
  });
});

test("gameAccountOptions labels by display name and hints with region + owning login", () => {
  const rows: GameAccountRow[] = [
    {
      accountId: "g-1",
      username: "hero100",
      displayName: "Hero One",
      region: "pt-PT",
      gfId: "a",
      gfEmail: "crbgames1@gmail.com",
    },
    {
      accountId: "g-2",
      username: "mage200",
      region: "de-DE",
      gfId: "b",
      gfEmail: "crbgames1+unclear2@gmail.com",
    },
  ];
  expect(gameAccountOptions(rows)).toEqual([
    { value: "g-1", label: "Hero One", hint: "pt-PT · crbgames1@gmail.com" },
    { value: "g-2", label: "mage200", hint: "de-DE · crbgames1+unclear2@gmail.com" }, // falls back to username
  ]);
});
