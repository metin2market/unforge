import { expect, test } from "bun:test";
import { CodeNotAllowedError, type GameAccount, type Region } from "../core/index.ts";
import { createDevice } from "../storage/index.ts";
import { failOnFetch } from "../../test/support/fail-on-fetch.ts";
import { resumeGfSession } from "./gf-session.ts";

const session = () =>
  resumeGfSession("tok", createDevice(), {
    certificatePem: "-----TEST-----",
  });

const account = (accountGroup: string): GameAccount => ({
  id: "acc-1",
  numericId: 1,
  displayName: "uclt1",
  usernames: ["uclt1"],
  gameId: "fab180a3-cd65-4b7e-bd0e-2ef77fd0c258",
  gameName: "metin2",
  accountGroup,
  retired: false,
});

test("createGameAccount refuses a region GameForge doesn't run, without calling it", async () => {
  await failOnFetch(async () => {
    // A creation is permanent, so an unmappable region must never reach the wire as a guess.
    await expect(session().createGameAccount("Hero", "xx-XX" as Region)).rejects.toThrow(
      /not a Metin2 region/,
    );
  });
});

// The store can disagree with GameForge — a region resolved on an earlier login, a client
// uninstalled since. Accounts are re-fetched on every launch, so the last word belongs here.
test("mintCode refuses a region the account doesn't live in, without calling GameForge", async () => {
  await failOnFetch(async () => {
    const err = await session()
      .mintCode(account("tr"), "pt-PT")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodeNotAllowedError);
    expect((err as CodeNotAllowedError).context).toMatchObject({
      accountGroup: "tr",
      regionMismatch: true,
      gameId: "fab180a3-cd65-4b7e-bd0e-2ef77fd0c258.pt-PT",
    });
  });
});
